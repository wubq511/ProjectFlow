"""ProjectMemory vector model warmup.

Initializes (and optionally downloads) the configured local embedding model
into a gitignored model directory. Without the memory-vector extra installed,
prints a clear skip message and exits successfully.

Design:
- No-impact default: without memory-vector, exit 0 with skip message
- With memory-vector: init model, download if needed, report success
- On failure: clear error message, exit 1
- FTS5 retrieval remains functional regardless of warmup outcome
"""

from __future__ import annotations

import sys
from pathlib import Path


def _default_model_dir() -> str:
    """Resolve default model directory: backend/data/memory-models/"""
    return str(Path(__file__).resolve().parents[2] / "data" / "memory-models")


def run_warmup(
    *,
    model_name: str = "shibing624/text2vec-base-chinese",
    model_dir: str = "",
) -> bool:
    """Initialize the vector embedding model.

    Args:
        model_name: HuggingFace model identifier.
        model_dir: Directory for model cache. Empty → auto-resolve.

    Returns:
        True if warmup succeeded, False if skipped or failed.

    Raises:
        Nothing — errors are logged, not raised.
    """
    from app.agent.memory.vector_retriever import VectorBackendError, is_vector_available

    if not is_vector_available():
        print(
            "memory-vector extra 未安装，跳过向量模型预热。"
            "默认使用 FTS5 检索。"
        )
        return False

    if not model_dir:
        model_dir = _default_model_dir()

    try:
        from app.agent.memory.vector_retriever import VectorRetriever, VectorConfig

        config = VectorConfig(model_name=model_name, model_dir=model_dir)

        # Delegate model loading to VectorRetriever — single source of truth
        # Use a dummy connection; we only need the model, not the sqlite-vec extension
        import sqlite3

        conn = sqlite3.connect(":memory:")
        from sqlalchemy import create_engine
        from sqlalchemy.pool import StaticPool
        from sqlmodel import Session

        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        with Session(engine) as session:
            vr = VectorRetriever(session.connection(), config=config)
            # Trigger lazy model load by calling embed on a dummy string
            embedding = vr.embed("预热")
            dim = len(embedding)

        print(
            f"向量模型预热成功: {model_name} "
            f"(维度={dim}, 缓存目录={model_dir})"
        )
        return True
    except VectorBackendError as exc:
        print(f"向量模型预热失败: {exc}", file=sys.stderr)
        return False
    except Exception as exc:
        print(f"向量模型预热失败: {exc}", file=sys.stderr)
        return False


def run_warmup_cli() -> None:
    """CLI entry point for `python -m app.memory.warmup`.

    Exit codes:
        0 — success (model loaded) or clean skip (extra not installed)
        1 — init failure (extra installed but model/extension failed)
    """
    # Read config from environment if available
    import os

    model_name = os.environ.get(
        "MEMORY_VECTOR_MODEL", "shibing624/text2vec-base-chinese"
    )
    model_dir = os.environ.get("MEMORY_VECTOR_MODEL_DIR", "")

    success = run_warmup(model_name=model_name, model_dir=model_dir)

    from app.agent.memory.vector_retriever import is_vector_available

    if is_vector_available() and not success:
        # Extra is installed but warmup failed → exit 1
        sys.exit(1)

    # Either skipped (no extra) or succeeded → exit 0
    sys.exit(0)
