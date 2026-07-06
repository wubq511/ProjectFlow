"""ProjectMemory default retrieval: FTS5 with jieba tokenization + structured fallback.

V1 retrieval returns candidate memory IDs only. Prompt text is built separately by
context_builder so that visibility, expiry, and budget checks happen on the
authoritative ProjectMemory rows.
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
        """Add or update a memory in the FTS5 index."""
        if not self._fts_available:
            return
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
        except Exception:
            logger.exception("Failed to index memory %s in FTS5", memory.id)

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

        # ── FTS5 path ──
        if self._fts_available and query.strip():
            try:
                tokens = self._tokenize(query)
                safe_query = self._safe_fts_query(tokens)
                rows = self.connection.execute(
                    text(
                        f"SELECT memory_id, rank FROM {self._FTS_TABLE} "
                        "WHERE project_memory_fts MATCH :query "
                        "ORDER BY rank LIMIT :limit"
                    ),
                    {"query": safe_query, "limit": limit},
                ).fetchall()
                candidates = [(row[0], float(row[1])) for row in rows]
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
