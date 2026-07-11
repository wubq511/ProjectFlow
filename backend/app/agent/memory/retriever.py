"""ProjectMemory default retrieval: FTS5 with jieba tokenization + structured fallback.

V1 retrieval returns candidate memory IDs only. Prompt text is built separately by
context_builder so that visibility, expiry, and budget checks happen on the
authoritative ProjectMemory rows.

R4: Two-phase retrieval (strict AND → relaxed OR → merge with token coverage).
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum

import jieba
from sqlalchemy import text
from sqlmodel import Session

from app.agent.memory.query_normalizer import (
    build_relaxed_fts_query,
    build_strict_fts_query,
    compute_substring_coverage,
    compute_token_coverage,
    normalize_query,
)
from app.models import ProjectMemory

logger = logging.getLogger(__name__)


class MemoryBackend(str, Enum):
    vector = "vector"
    fts5 = "fts5"
    sqlite_field = "sqlite_field"
    none = "none"


@dataclass
class RetrievalResult:
    """Result of the retrieval phase (before token-budget truncation)."""

    memory_ids: list[str]
    backend: MemoryBackend
    retrieval_count: int
    latency_ms: float


class MemoryIndexError(RuntimeError):
    """Safe FTS5 indexing error that never includes memory content."""


class MemoryRetriever:
    """SQLite FTS5 retriever with jieba Chinese tokenization.

    Falls back to structured field filtering if FTS5 is unavailable.
    """

    _FTS_TABLE = "project_memory_fts"

    def __init__(self, connection):
        self.connection = connection
        self._fts_available = self._ensure_table()
        self._vector_retriever = None  # lazy singleton

    def _ensure_table(self) -> bool:
        """Create the FTS5 virtual table if it does not exist.

        Returns True if FTS5 is available, False otherwise.
        """
        try:
            self.connection.execute(
                text(
                    f"CREATE VIRTUAL TABLE IF NOT EXISTS {self._FTS_TABLE} USING fts5("
                    "memory_id UNINDEXED, content, rationale"
                    ")"
                )
            )
            return True
        except Exception as exc:
            logger.warning("FTS5 not available, retrieval will fall back to sqlite_field: %s", exc)
            return False

    @staticmethod
    def _tokenize(text_value: str) -> str:
        """Tokenize Chinese text with jieba for FTS5 indexing/searching."""
        if not text_value:
            return ""
        return " ".join(jieba.cut_for_search(text_value.strip()))

    @staticmethod
    def _safe_fts_query(tokens: str) -> str:
        """Wrap each token in double-quotes to prevent FTS5 operator injection."""
        return " ".join(f'"{t}"' for t in tokens.split() if t.strip())

    def index_memory(self, memory: ProjectMemory) -> None:
        """Add or update a memory, raising a safe error on failure."""
        if not self._fts_available:
            raise MemoryIndexError("FTS5 backend unavailable")
        try:
            self.connection.execute(
                text(f"DELETE FROM {self._FTS_TABLE} WHERE memory_id = :memory_id"),
                {"memory_id": memory.id},
            )
            self.connection.execute(
                text(
                    f"INSERT INTO {self._FTS_TABLE} (memory_id, content, rationale) "
                    "VALUES (:memory_id, :content, :rationale)"
                ),
                {
                    "memory_id": memory.id,
                    "content": self._tokenize(memory.content),
                    "rationale": self._tokenize(memory.rationale),
                },
            )
        except Exception as exc:
            raise MemoryIndexError(
                f"FTS5 index failed ({type(exc).__name__})"
            ) from None

    def remove_memory(self, memory_id: str) -> None:
        """Remove a memory from FTS5, raising a safe error on failure."""
        if not self._fts_available:
            raise MemoryIndexError("FTS5 backend unavailable")
        try:
            self.connection.execute(
                text(f"DELETE FROM {self._FTS_TABLE} WHERE memory_id = :memory_id"),
                {"memory_id": memory_id},
            )
        except Exception as exc:
            raise MemoryIndexError(
                f"FTS5 delete failed ({type(exc).__name__})"
            ) from None

    def search(
        self,
        project_id: str,
        query: str,
        *,
        limit: int = 50,
        prefer_vector: bool = False,
    ) -> tuple[list[tuple[str, float]], MemoryBackend]:
        """Search memories and return (memory_id, score) pairs.

        When prefer_vector=True, tries vector retrieval first; on failure
        falls back to FTS5 → sqlite_field → none.
        When prefer_vector=False (default), uses FTS5 → sqlite_field → none.
        """
        # ── Optional vector path ──
        if prefer_vector and query.strip():
            try:
                from app.agent.memory.vector_retriever import VectorBackendError, VectorRetriever

                # Reuse VectorRetriever instance so model is loaded once and cached
                if self._vector_retriever is None:
                    from app.agent.memory.vector_retriever import VectorConfig
                    from app.core.config import settings

                    vec_config = VectorConfig(
                        model_name=settings.memory_vector_model,
                        model_dir=settings.memory_vector_model_dir,
                    )
                    self._vector_retriever = VectorRetriever(self.connection, config=vec_config)
                candidates, _ = self._vector_retriever.search(project_id, query, limit=limit)
                if candidates:
                    return candidates, MemoryBackend.vector
            except VectorBackendError as exc:
                logger.warning("Vector retrieval failed, falling back to FTS5: %s", exc)
            except Exception as exc:
                logger.warning("Vector retrieval unexpected error, falling back to FTS5: %s", exc)

        # ── FTS5 path (R4: two-phase strict+relaxed) ──
        if self._fts_available and query.strip():
            try:
                candidates = self._fts_two_phase_search(project_id, query, limit=limit)
                if candidates:
                    return candidates, MemoryBackend.fts5
            except Exception as exc:
                logger.warning("FTS5 search failed, falling back to sqlite_field: %s", exc)

        # Structured field fallback
        try:
            candidates = self._sqlite_field_search(project_id, query, limit=limit)
            if candidates:
                return candidates, MemoryBackend.sqlite_field
        except Exception:
            logger.exception("sqlite_field fallback search failed")

        return [], MemoryBackend.none

    def _fts_two_phase_search(
        self,
        project_id: str,
        query: str,
        *,
        limit: int,
    ) -> list[tuple[str, float]]:
        """Two-phase FTS5 retrieval: strict AND → relaxed OR → merge.

        Phase 1 (strict): All normalized tokens must match (implicit AND).
        Phase 2 (relaxed): Any token may match (OR), only if strict yields
        fewer than `limit` candidates.
        Merge: strict hits first (by BM25 rank), then relaxed hits sorted
        by combined score (coverage² × substring_coverage × BM25). Dedup by memory_id.
        """
        tokens = normalize_query(query)
        if not tokens:
            # Fallback to raw tokenization if normalizer strips everything
            raw_tokens = self._tokenize(query)
            if not raw_tokens.strip():
                return []
            strict_query = self._safe_fts_query(raw_tokens)
            return self._run_fts_sql(project_id, strict_query, limit=limit)

        # Phase 1: strict AND
        strict_query = build_strict_fts_query(tokens)
        strict_rows = self._run_fts_sql(project_id, strict_query, limit=limit)

        if len(strict_rows) >= limit:
            return strict_rows

        # Phase 2: relaxed OR (only if strict was insufficient)
        relaxed_query = build_relaxed_fts_query(tokens)
        relaxed_rows = self._run_fts_sql(project_id, relaxed_query, limit=limit * 2)

        # Merge: strict first, then relaxed not already in strict
        strict_ids = {mid for mid, _ in strict_rows}
        merged = list(strict_rows)

        # For relaxed results not in strict, re-rank by combined score
        # Load memory text for coverage computation
        # Normalize BM25 scores: find max |score| for relative ranking
        max_bm25 = max((abs(s) for _, s in relaxed_rows), default=1.0)
        if max_bm25 == 0:
            max_bm25 = 1.0

        relaxed_new: list[tuple[str, float, float]] = []
        for mid, score in relaxed_rows:
            if mid in strict_ids:
                continue
            # Load memory text for coverage scoring
            memory = self.connection.execute(
                text("SELECT content, rationale FROM project_memories WHERE id = :id"),
                {"id": mid},
            ).fetchone()
            if memory is None:
                continue
            mem_text = f"{memory[0] or ''} {memory[1] or ''}"
            token_cov = compute_token_coverage(mem_text, tokens)
            substr_cov = compute_substring_coverage(mem_text, query)
            # Combined score: token_coverage² × substring_coverage × normalized_BM25
            # token_coverage² gives strong advantage to high-coverage results
            # substring_coverage captures phrase-level matching
            # normalized_BM25 provides fine-grained ranking within same coverage
            norm_bm25 = abs(score) / max_bm25
            combined = (token_cov ** 2) * (0.3 + 0.7 * substr_cov) * (0.5 + 0.5 * norm_bm25)
            relaxed_new.append((mid, score, combined))

        # Sort by combined score descending (higher = better)
        relaxed_new.sort(key=lambda x: x[2], reverse=True)

        # Add relaxed results up to limit
        for mid, score, _ in relaxed_new:
            if len(merged) >= limit:
                break
            merged.append((mid, score))

        return merged

    def _run_fts_sql(
        self,
        project_id: str,
        fts_query: str,
        *,
        limit: int,
    ) -> list[tuple[str, float]]:
        """Execute a single FTS5 SQL query with project-scoped JOIN."""
        rows = self.connection.execute(
            text(
                f"SELECT f.memory_id, f.rank "
                f"FROM {self._FTS_TABLE} AS f "
                "JOIN project_memories AS pm ON pm.id = f.memory_id "
                "WHERE project_memory_fts MATCH :query "
                "AND pm.project_id = :project_id "
                "AND pm.status = 'active' "
                "ORDER BY f.rank LIMIT :limit"
            ),
            {"query": fts_query, "project_id": project_id, "limit": limit},
        ).fetchall()
        return [(row[0], float(row[1])) for row in rows]

    def _sqlite_field_search(
        self,
        project_id: str,
        query: str,
        *,
        limit: int,
    ) -> list[tuple[str, float]]:
        """Fallback search using ProjectMemory table fields.

        Filters by project and active status, then checks whether any jieba
        token from the query appears in content or rationale.
        """
        tokens = [t for t in jieba.cut_for_search(query.strip()) if t.strip()]
        if not tokens:
            return []

        rows = self.connection.execute(
            text(
                "SELECT id, content, rationale FROM project_memories "
                "WHERE project_id = :project_id AND status = 'active'"
            ),
            {"project_id": project_id},
        ).fetchall()

        candidates: list[tuple[str, float]] = []
        for row in rows:
            memory_id, content, rationale = row
            text_value = f"{content or ''} {rationale or ''}"
            if any(token in text_value for token in tokens):
                # score is arbitrary but stable for fallback
                candidates.append((memory_id, 1.0))
            if len(candidates) >= limit:
                break
        return candidates


def retrieve_memory_ids(
    session: Session,
    project_id: str,
    query: str,
    viewer_user_id: str,
    *,
    limit: int = 50,
    prefer_vector: bool | None = None,
) -> RetrievalResult:
    """Retrieve candidate memory IDs for a viewer.

    Steps:
    1. Search via vector (if prefer_vector), FTS5, or sqlite_field fallback.
    2. Reload each candidate from the authoritative ProjectMemory table.
    3. Filter by project, workspace membership, active status, expiry, and
       visibility.
    4. Return candidate IDs and metadata.

    When prefer_vector is None (default), reads MEMORY_VECTOR_ENABLED from
    settings. Pass True/False to override explicitly.

    This function does NOT format prompt text or apply token budgets; use
    build_memory_context for that.
    """
    start = time.perf_counter()

    # Resolve prefer_vector from settings when not explicitly set
    if prefer_vector is None:
        from app.core.config import settings

        prefer_vector = settings.memory_vector_enabled

    # Validate viewer and load workspace members (reuses memory_service logic)
    from app.services.memory_service import can_view_memory, get_workspace_member_ids, validate_viewer

    project, _ = validate_viewer(session, project_id=project_id, viewer_user_id=viewer_user_id)
    member_ids = get_workspace_member_ids(session, project.workspace_id)

    retriever = MemoryRetriever(session.connection())
    raw_candidates, backend = retriever.search(project_id, query, limit=limit, prefer_vector=prefer_vector)

    now = datetime.now(UTC)
    visible_ids: list[str] = []
    for memory_id, _score in raw_candidates:
        memory = session.get(ProjectMemory, memory_id)
        if memory is None:
            continue
        if memory.project_id != project_id:
            continue
        if memory.status != "active":
            continue
        if memory.valid_until is not None:
            valid_until = memory.valid_until
            if valid_until.tzinfo is None:
                valid_until = valid_until.replace(tzinfo=UTC)
            if valid_until < now:
                continue
        if not can_view_memory(memory, viewer_user_id=viewer_user_id, workspace_member_ids=member_ids):
            continue
        visible_ids.append(memory_id)

    latency_ms = (time.perf_counter() - start) * 1000
    return RetrievalResult(
        memory_ids=visible_ids,
        backend=backend,
        retrieval_count=len(visible_ids),
        latency_ms=round(latency_ms, 2),
    )
