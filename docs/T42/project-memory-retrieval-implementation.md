# T42 ProjectMemory V1 Retrieval & Agent Context Injection

> Implementation of issue #75 (2026-07-06). Builds on top of issue #71/#72/#73 ProjectMemory foundation.

## What was added

1. **Default retrieval runtime** (`backend/app/agent/memory/retriever.py`)
   - SQLite FTS5 virtual table `project_memory_fts` with jieba Chinese tokenization.
   - Returns candidate `memory_id`s only; prompt text is built separately.
   - Falls back to structured field filtering if FTS5 is unavailable.
   - Final fallback: `memory_backend=none`, Agent run continues.

2. **Context builder** (`backend/app/agent/memory/context_builder.py`)
   - Loads visible memories from retrieval candidate IDs.
   - Formats memories as numbered Chinese text.
   - Truncates by token budget (character heuristic) and hard memory count.
   - Returns `MemoryContext` with metadata for observability.

3. **Agent run integration**
   - Legacy `CoordinatorAgent` / `generate_structured_output` injects memory context into prompts.
   - T41 `POST /internal/agent-runs` builds memory context on the FastAPI side and returns it in `RunStartResponse.memory_context`.
   - Sidecar receives memory only through the run context; it has no DB or ProjectMemory read path.

4. **Viewer identity enforcement**
   - `viewer_user_id` is required on legacy conversation messages and T41 run start.
   - Missing/malformed → `400`.
   - Viewer outside project workspace → `404`.
   - Same `validate_viewer` + `can_view_memory` logic reused for JSON list, Markdown export, and Agent injection.

5. **Observability**
   - `AgentEvent.output_snapshot` records `memory_used`, `memory_backend`, `used_memory_ids`, `memory_retrieval_count`, `memory_injected_count`, `memory_latency_ms`.
   - `AgentRunState.side_effects` never records memory usage.

## Files changed

- `backend/app/agent/memory/retriever.py` (new)
- `backend/app/agent/memory/context_builder.py` (new)
- `backend/app/agent/memory/__init__.py`
- `backend/app/agent/prompts.py`
- `backend/app/agent/workflow.py`
- `backend/app/agent/coordinator.py`
- `backend/app/services/memory_service.py`
- `backend/app/services/agent_conversation_service.py`
- `backend/app/services/agent_flow_service.py`
- `backend/app/services/agent_runtime_service.py`
- `backend/app/api/routes_agent_conversations.py`
- `backend/app/api/routes_agent_runtime.py`
- `backend/app/models/agent_run_state.py`
- `backend/app/schemas/agent_conversation.py`
- `backend/app/schemas/runtime.py`
- `backend/pyproject.toml` (adds `jieba`)
- `backend/app/tests/test_memory_retrieval.py` (new)
- `backend/app/tests/test_agent_conversation_flow.py`
- `backend/app/tests/test_agent_runtime_api.py`

## Test results

```text
466 backend tests pass
```

## Architecture invariants

- FastAPI builds memory context; sidecar does not read the database.
- Memory usage is observable metadata, not an `AgentRunState` side effect.
- Retrieval returns IDs; visibility and lifecycle filtering happen on authoritative `ProjectMemory` rows.
