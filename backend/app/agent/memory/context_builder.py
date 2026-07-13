"""Build the injectable ProjectMemory context for Agent prompts.

Takes candidate memory IDs from the retriever, reloads the authoritative rows,
formats them as numbered Chinese text lines, and truncates to a token budget
using a simple character-based heuristic.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlmodel import Session

from app.agent.memory.retriever import MemoryBackend, retrieve_memory_ids
from app.models import ProjectMemory, User


@dataclass
class MemoryContext:
    """Injectable memory context and usage metadata."""

    text: str
    used_memory_ids: list[str]
    memory_backend: MemoryBackend
    retrieval_count: int
    injected_count: int
    latency_ms: float
    used_memory_types: list[str] = field(default_factory=list)
    guarded_member_names: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "used_memory_ids": self.used_memory_ids,
            "used_memory_types": self.used_memory_types,
            "guarded_member_names": self.guarded_member_names,
            "memory_backend": self.memory_backend.value,
            "retrieval_count": self.retrieval_count,
            "injected_count": self.injected_count,
            "latency_ms": self.latency_ms,
        }


# Simple heuristic: 1 token ≈ 1.5 Chinese characters
_CHARACTERS_PER_TOKEN = 1.5

_MEMORY_TYPE_LABEL = {
    "direction": "方向",
    "boundary": "边界",
    "plan": "计划",
    "assignment": "分工",
    "tradeoff": "取舍",
    "rejection": "拒绝方案",
    "member_constraint": "成员约束",
}


def _format_memory(index: int, memory: ProjectMemory) -> str:
    label = _MEMORY_TYPE_LABEL.get(memory.memory_type, memory.memory_type)
    lines = [f"{index}. [{label}] {memory.content}"]
    if memory.rationale:
        lines.append(f"   理由：{memory.rationale}")
    return "\n".join(lines)


def build_memory_context(
    session: Session,
    project_id: str,
    viewer_user_id: str,
    query: str = "",
    *,
    token_budget: int = 2000,
    max_memories: int = 10,
    prefer_vector: bool = False,
    conversation_visibility: str | None = None,
) -> MemoryContext:
    """Build a memory context string for prompt injection.

    - Loads visible candidate memories from retrieval
    - Formats each memory as numbered Chinese text
    - Truncates by token budget (character heuristic) and hard count limit
    - Header/footer wrapping text is counted against the budget
    - Returns metadata needed for AgentEvent output_snapshot

    Privacy: when conversation_visibility="team", subject_and_owner memories
    are excluded at source to prevent private constraints from entering shared
    conversation context.
    """
    retrieval = retrieve_memory_ids(
        session,
        project_id=project_id,
        query=query,
        viewer_user_id=viewer_user_id,
        limit=max(50, max_memories * 2),
        prefer_vector=prefer_vector,
    )

    # Reserve budget for header/footer wrapping text
    _HEADER = "以下是与当前项目相关的历史记忆，供你参考：\n"
    _FOOTER = "\n请以上述记忆为依据，避免与团队已确认的方向、边界或分工冲突。"
    _MEMBER_CONSTRAINT_FOOTER = (
        _FOOTER
        + "成员约束是跨任务硬约束；如果任务要求与成员可用时间冲突，"
        "不得通过改派到另一项同样冲突的任务来规避。"
    )
    wrap_chars = len(_HEADER) + len(_MEMBER_CONSTRAINT_FOOTER)

    used_memory_ids: list[str] = []
    used_memory_types: list[str] = []
    guarded_member_names: list[str] = []
    lines: list[str] = []
    has_member_constraint = False
    char_budget = int(token_budget * _CHARACTERS_PER_TOKEN) - wrap_chars
    char_count = 0

    for memory_id in retrieval.memory_ids:
        if len(used_memory_ids) >= max_memories:
            break
        memory = session.get(ProjectMemory, memory_id)
        if memory is None:
            continue
        # Privacy: team conversations must not receive subject_and_owner memories
        if conversation_visibility == "team" and memory.visibility == "subject_and_owner":
            continue
        line = _format_memory(len(used_memory_ids) + 1, memory)
        line_chars = len(line)
        if char_count + line_chars > char_budget:
            break
        lines.append(line)
        used_memory_ids.append(memory_id)
        if memory.memory_type not in used_memory_types:
            used_memory_types.append(memory.memory_type)
        if memory.memory_type == "member_constraint" and memory.subject_user_id:
            subject = session.get(User, memory.subject_user_id)
            if subject and subject.display_name not in guarded_member_names:
                guarded_member_names.append(subject.display_name)
        char_count += line_chars
        has_member_constraint = (
            has_member_constraint or memory.memory_type == "member_constraint"
        )

    if lines:
        footer = _MEMBER_CONSTRAINT_FOOTER if has_member_constraint else _FOOTER
        text = _HEADER + "\n".join(lines) + footer
    else:
        text = ""

    return MemoryContext(
        text=text,
        used_memory_ids=used_memory_ids,
        memory_backend=retrieval.backend,
        retrieval_count=retrieval.retrieval_count,
        injected_count=len(used_memory_ids),
        latency_ms=retrieval.latency_ms,
        used_memory_types=used_memory_types,
        guarded_member_names=guarded_member_names,
    )
