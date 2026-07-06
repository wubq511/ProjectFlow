"""Optional vector retrieval backend for ProjectMemory V1.

All vector-only imports (sentence_transformers, sqlite_vec) are kept inside
functions — never at module top level — so the default install never
triggers their import or download.

Usage:
    if is_vector_available():
        vr = VectorRetriever(connection, model_name, model_dir)
        results, backend = vr.search(project_id, query, limit=50)

Design:
- Lazy init: embedding model and sqlite-vec extension loaded on first use
- Fail-fast: VectorBackendError on init failure, caller catches and degrades
- Thread-safe: model loaded once, cached on the instance
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


class VectorBackendError(Exception):
    """Raised when vector backend initialization or operation fails."""

    pass


def is_vector_available() -> bool:
    """Check whether vector-only dependencies are importable.

    Does NOT trigger model downloads or extension loading.
    Returns True only if both sentence_transformers and sqlite_vec can be imported.
    """
    try:
        import sentence_transformers  # noqa: F401
        import sqlite_vec  # noqa: F401

        return True
    except ImportError:
        return False


@dataclass
class VectorConfig:
    """Configuration for the vector retrieval backend."""

    model_name: str = "shibing624/text2vec-base-chinese"
    model_dir: str = ""  # empty → auto-resolve to data/memory-models/
    vec_table: str = "project_memory_vec"


class VectorRetriever:
    """sqlite-vec + sentence-transformers retriever.

    Initialization is lazy: the embedding model and sqlite-vec extension
    are loaded on first call to embed() or search(). If loading fails,
    VectorBackendError is raised and the caller should fall back to FTS5.
    """

    def __init__(
        self,
        connection,
        config: VectorConfig | None = None,
    ):
        self.connection = connection
        self.config = config or VectorConfig()
        self._model = None
        self._vec_loaded = False

    # ── Lazy initialization ────────────────────────────────────────────────

    def _ensure_model(self):
        """Load the sentence-transformers model (lazy, once)."""
        if self._model is not None:
            return

        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as exc:
            raise VectorBackendError(
                "sentence-transformers 未安装。请运行 "
                "pip install -e '.[memory-vector]' 安装向量检索依赖。"
            ) from exc

        model_dir = self.config.model_dir
        if not model_dir:
            # Auto-resolve: backend/data/memory-models/
            model_dir = str(
                Path(__file__).resolve().parents[3] / "data" / "memory-models"
            )

        try:
            model_path = Path(model_dir)
            model_path.mkdir(parents=True, exist_ok=True)
            self._model = SentenceTransformer(
                self.config.model_name,
                cache_folder=str(model_path),
            )
            logger.info(
                "Vector embedding model loaded: %s (cache=%s)",
                self.config.model_name,
                model_dir,
            )
        except Exception as exc:
            raise VectorBackendError(
                f"向量模型初始化失败: {exc}"
            ) from exc

    def _ensure_vec_extension(self):
        """Load the sqlite-vec extension into the connection (lazy, once)."""
        if self._vec_loaded:
            return

        try:
            import sqlite_vec
        except ImportError as exc:
            raise VectorBackendError(
                "sqlite-vec 未安装。请运行 "
                "pip install -e '.[memory-vector]' 安装向量检索依赖。"
            ) from exc

        try:
            db = self.connection.connection.dbapi_connection
            db.enable_load_extension(True)
            sqlite_vec.load(db)
            db.enable_load_extension(False)
            self._vec_loaded = True
            logger.info("sqlite-vec extension loaded successfully")
        except Exception as exc:
            raise VectorBackendError(
                f"sqlite-vec 扩展加载失败: {exc}"
            ) from exc

    def _ensure_vec_table(self, dim: int):
        """Create the sqlite-vec virtual table if it does not exist."""
        from sqlalchemy import text

        try:
            self.connection.execute(
                text(
                    f"CREATE VIRTUAL TABLE IF NOT EXISTS {self.config.vec_table} "
                    f"USING vec0("
                    "memory_id TEXT PRIMARY KEY, "
                    f"embedding float[{dim}]"
                    ")"
                )
            )
        except Exception as exc:
            raise VectorBackendError(
                f"sqlite-vec 虚拟表创建失败: {exc}"
            ) from exc

    # ── Core operations ────────────────────────────────────────────────────

    def embed(self, text_value: str) -> list[float]:
        """Generate embedding vector for a text string.

        Lazy-initializes the model on first call.
        """
        self._ensure_model()
        try:
            vector = self._model.encode(text_value, show_progress_bar=False)
            return vector.tolist()
        except Exception as exc:
            raise VectorBackendError(f"向量编码失败: {exc}") from exc

    def index_memory(self, memory_id: str, embedding: list[float]) -> None:
        """Insert a memory's embedding into the sqlite-vec index.

        Caller is responsible for calling embed() first.
        """
        from sqlalchemy import text

        self._ensure_vec_extension()
        dim = len(embedding)
        self._ensure_vec_table(dim)

        try:
            # Delete existing entry (upsert pattern)
            self.connection.execute(
                text(
                    f"DELETE FROM {self.config.vec_table} WHERE memory_id = :memory_id"
                ),
                {"memory_id": memory_id},
            )
            # Insert new embedding
            import struct

            embedding_bytes = struct.pack(f"{dim}f", *embedding)
            self.connection.execute(
                text(
                    f"INSERT INTO {self.config.vec_table} (memory_id, embedding) "
                    "VALUES (:memory_id, :embedding)"
                ),
                {"memory_id": memory_id, "embedding": embedding_bytes},
            )
        except Exception as exc:
            raise VectorBackendError(
                f"向量索引写入失败 (memory_id={memory_id}): {exc}"
            ) from exc

    def search(
        self,
        project_id: str,
        query: str,
        *,
        limit: int = 50,
    ) -> tuple[list[tuple[str, float]], str]:
        """Search memories by vector similarity.

        Returns (memory_id, distance) pairs. Lower distance = more similar.
        Caller must filter by project_id, visibility, etc. against the
        authoritative ProjectMemory rows.

        Raises VectorBackendError if initialization fails.
        """
        from sqlalchemy import text

        self._ensure_vec_extension()
        query_embedding = self.embed(query)
        dim = len(query_embedding)
        self._ensure_vec_table(dim)

        import struct

        query_bytes = struct.pack(f"{dim}f", *query_embedding)

        try:
            rows = self.connection.execute(
                text(
                    f"SELECT memory_id, distance FROM {self.config.vec_table} "
                    "WHERE embedding MATCH :query "
                    "ORDER BY distance LIMIT :limit"
                ),
                {"query": query_bytes, "limit": limit},
            ).fetchall()

            candidates = [(row[0], float(row[1])) for row in rows]
            return candidates, "vector"
        except Exception as exc:
            raise VectorBackendError(
                f"向量检索失败: {exc}"
            ) from exc
