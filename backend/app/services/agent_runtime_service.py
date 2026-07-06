"""T41 Agent Runtime Service.

Manages AgentRun lifecycle, event appending, and tool result persistence.
Implements idempotency key validation and atomic event_seq assignment.
"""

import logging
import uuid
from datetime import datetime, timezone

from sqlmodel import Session, select

logger = logging.getLogger(__name__)

from app.agent.memory.context_builder import build_memory_context
from app.models.agent_run_state import AgentRunEvent, AgentRunV2
from app.models.enums import AgentRunStatus, RuntimeEventType
from app.services.memory_service import validate_viewer
from app.schemas.runtime import (
    AppendRequest,
    AppendResponse,
    EventAppendResponse,
    RuntimeEventRead,
    RunStartRequest,
    RunStartResponse,
    RunStatusResponse,
    ToolResultAppendResponse,
)


class AgentRuntimeService:
    """Service for managing agent run lifecycle and event persistence."""

    # In-process idempotency cache (MVP/dev). Production should use Redis.
    _idempotency_cache: dict[str, AppendResponse] = {}

    # 合法状态转换表（移植自 TS 侧 run-state.ts isValidTransition）
    _VALID_TRANSITIONS: dict[AgentRunStatus, set[AgentRunStatus]] = {
        AgentRunStatus.created: {AgentRunStatus.context_building, AgentRunStatus.cancelling, AgentRunStatus.failed},
        AgentRunStatus.context_building: {AgentRunStatus.model_streaming, AgentRunStatus.cancelling, AgentRunStatus.failed},
        AgentRunStatus.model_streaming: {AgentRunStatus.tool_preparing, AgentRunStatus.completed, AgentRunStatus.cancelling, AgentRunStatus.failed},
        AgentRunStatus.tool_preparing: {AgentRunStatus.tool_running, AgentRunStatus.cancelling, AgentRunStatus.failed},
        AgentRunStatus.tool_running: {AgentRunStatus.persisting_tool_result, AgentRunStatus.cancelling, AgentRunStatus.failed},
        AgentRunStatus.persisting_tool_result: {AgentRunStatus.model_streaming, AgentRunStatus.cancelling, AgentRunStatus.failed},
        AgentRunStatus.completed: set(),
        AgentRunStatus.cancelling: {AgentRunStatus.cancelled, AgentRunStatus.failed},
        AgentRunStatus.cancelled: set(),
        AgentRunStatus.failed: set(),
    }

    def __init__(self, session: Session):
        self.session = session

    def start_run(self, request: RunStartRequest) -> RunStartResponse:
        """Create a new agent run.

        Validates the viewer, stores viewer_user_id on the run record, and builds
        the memory context on the FastAPI side so the sidecar receives it through
        the run input/context without needing DB or ProjectMemory access.
        """
        # Validate viewer identity (required, project must exist and viewer must be member)
        if not request.viewer_user_id or not request.viewer_user_id.strip():
            raise ValueError("viewer_user_id 不能为空")
        validate_viewer(
            self.session,
            project_id=request.project_id,
            viewer_user_id=request.viewer_user_id,
        )

        run = AgentRunV2(
            id=str(uuid.uuid4()),
            conversation_id=request.conversation_id,
            project_id=request.project_id,
            workspace_id=request.workspace_id,
            user_message_id=request.user_message_id,
            viewer_user_id=request.viewer_user_id,
            status=AgentRunStatus.created,
            current_turn=0,
            current_step=0,
            model_provider="",
            model_name="",
            side_effects="[]",
            last_event_seq=0,
            resume_manifest_version=1,
            state_version=0,
        )
        self.session.add(run)
        self.session.commit()
        self.session.refresh(run)

        # Build memory context on the FastAPI side; sidecar receives it via response
        memory_context = self._build_memory_context_for_run(
            request.project_id,
            request.viewer_user_id,
            query=request.user_content,
        )

        return RunStartResponse(
            run_id=run.id,
            status=run.status,
            memory_context=memory_context.to_dict() if memory_context else None,
        )

    def _build_memory_context_for_run(
        self,
        project_id: str,
        viewer_user_id: str,
        query: str,
    ):
        """Build memory context for the sidecar; failures are non-blocking."""
        try:
            return build_memory_context(
                self.session,
                project_id=project_id,
                viewer_user_id=viewer_user_id,
                query=query,
            )
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception:
            logger.exception("Failed to build memory context for run")
            return None

    def get_run_status(self, run_id: str) -> RunStatusResponse | None:
        """Get current run status."""
        run = self.session.get(AgentRunV2, run_id)
        if not run:
            return None

        return RunStatusResponse(
            run_id=run.id,
            status=run.status,
            current_turn=run.current_turn,
            current_step=run.current_step,
            last_event_seq=run.last_event_seq,
            created_at=run.created_at,
            updated_at=run.updated_at,
            completed_at=run.completed_at,
        )

    def list_run_events(self, run_id: str) -> list[RuntimeEventRead] | None:
        """Return persisted runtime events in run-scoped sequence order."""
        run = self.session.get(AgentRunV2, run_id)
        if not run:
            return None

        events = self.session.exec(
            select(AgentRunEvent)
            .where(AgentRunEvent.run_id == run_id)
            .order_by(AgentRunEvent.event_seq)
        ).all()
        return [self._to_event_read(event) for event in events]

    def append_events(
        self,
        run_id: str,
        request: AppendRequest,
    ) -> AppendResponse:
        """Append events and tool results to a run atomically.

        - Validates idempotency key
        - Assigns event_seq monotonically per run_id
        - Applies state patch
        - Persists tool results
        - All in a single transaction
        """
        run = self.session.get(AgentRunV2, run_id)
        if not run:
            raise ValueError(f"Run {run_id} not found")

        # Check idempotency key
        if self._is_duplicate_request(run_id, request.idempotency_key):
            # Return cached response for duplicate request
            return self._get_cached_response(run_id, request.idempotency_key)

        # Apply state patch if provided
        if request.state_patch:
            self._apply_state_patch(run, request.state_patch)

        # Process events and assign event_seq
        # 当 state_patch 非空时，自动插入 run.state_changed 事件（在用户提交的 events 之前）
        if request.state_patch:
            run.last_event_seq += 1
            state_changed_event = AgentRunEvent(
                run_id=run.id,
                conversation_id=run.conversation_id,
                workspace_id=run.workspace_id,
                project_id=run.project_id,
                type=RuntimeEventType.run_state_changed,
                event_seq=run.last_event_seq,
                client_event_id=f"auto:state_changed:{run.last_event_seq}",
                ordering_hint=0,
            )
            # payload 包含 patch 的关键字段
            state_changed_payload: dict = {}
            if "status" in request.state_patch:
                state_changed_payload["status"] = request.state_patch["status"]
            if "current_turn" in request.state_patch:
                state_changed_payload["current_turn"] = request.state_patch["current_turn"]
            if "current_step" in request.state_patch:
                state_changed_payload["current_step"] = request.state_patch["current_step"]
            state_changed_event.set_payload(state_changed_payload)
            state_changed_event.set_trace({})
            self.session.add(state_changed_event)
            # state_changed 事件不返回 EventAppendResponse（它是自动生成的）

        # Process user-submitted events and assign event_seq
        event_responses = []
        for event_item in request.events:
            run.last_event_seq += 1
            event_seq = run.last_event_seq
            runtime_event = AgentRunEvent(
                run_id=run.id,
                conversation_id=run.conversation_id,
                workspace_id=run.workspace_id,
                project_id=run.project_id,
                type=event_item.type,
                event_seq=event_seq,
                client_event_id=event_item.client_event_id,
                ordering_hint=event_item.ordering_hint,
            )
            runtime_event.set_payload(event_item.payload)
            runtime_event.set_trace(event_item.trace)
            self.session.add(runtime_event)

            event_responses.append(EventAppendResponse(
                client_event_id=event_item.client_event_id,
                agent_event_id=runtime_event.id,
                event_seq=event_seq,
            ))

        # Process tool results
        tool_result_responses = []
        for tool_result_item in request.tool_results:
            agent_event_id = str(uuid.uuid4())

            # Update side effects
            side_effects = run.get_side_effects()
            side_effects.append({
                "tool_call_id": tool_result_item.tool_call_id,
                "status": tool_result_item.result.side_effect_status.value,
            })
            run.set_side_effects(side_effects)

            tool_result_responses.append(ToolResultAppendResponse(
                tool_call_id=tool_result_item.tool_call_id,
                agent_event_id=agent_event_id,
                persisted=True,
            ))

        # Update state version only when state changed, always update timestamp
        if request.state_patch:
            run.state_version += 1
        run.updated_at = datetime.now(timezone.utc)

        # Set completion time if run completed
        if run.status in (AgentRunStatus.completed, AgentRunStatus.cancelled, AgentRunStatus.failed):
            run.completed_at = datetime.now(timezone.utc)

        self.session.commit()

        # Cache response for idempotency
        response = AppendResponse(
            state_version=run.state_version,
            events=event_responses,
            tool_results=tool_result_responses,
        )
        self._cache_response(run_id, request.idempotency_key, response)

        return response

    def _apply_state_patch(self, run: AgentRunV2, patch: dict) -> None:
        """Apply state patch to run with validation."""
        if "status" in patch:
            new_status = AgentRunStatus(patch["status"])
            allowed = self._VALID_TRANSITIONS.get(run.status, set())
            if new_status not in allowed:
                raise ValueError(
                    f"非法状态转换: {run.status.value} → {new_status.value}，"
                    f"允许的目标状态: {[s.value for s in allowed]}"
                )
            run.status = new_status
        if "current_turn" in patch:
            run.current_turn = int(patch["current_turn"])
        if "current_step" in patch:
            run.current_step = int(patch["current_step"])
        if "model_provider" in patch:
            run.model_provider = str(patch["model_provider"])
        if "model_name" in patch:
            run.model_name = str(patch["model_name"])
        if "pending_tool_call_id" in patch:
            run.pending_tool_call_id = patch["pending_tool_call_id"]
        if "pending_tool_name" in patch:
            run.pending_tool_name = patch["pending_tool_name"]
        if "pending_tool_version" in patch:
            run.pending_tool_version = int(patch["pending_tool_version"])
        if "pending_idempotency_key" in patch:
            run.pending_idempotency_key = patch["pending_idempotency_key"]
        if "last_event_seq" in patch:
            run.last_event_seq = int(patch["last_event_seq"])

    def _is_duplicate_request(self, run_id: str, idempotency_key: str) -> bool:
        """Check if this is a duplicate request using idempotency key."""
        return self._cache_key(run_id, idempotency_key) in self._idempotency_cache

    def _cache_response(self, run_id: str, idempotency_key: str, response: AppendResponse) -> None:
        """Cache response for idempotency key (in-process, MVP)."""
        self._idempotency_cache[self._cache_key(run_id, idempotency_key)] = response

    def _get_cached_response(self, run_id: str, idempotency_key: str) -> AppendResponse:
        """Get cached response for duplicate request."""
        return self._idempotency_cache[self._cache_key(run_id, idempotency_key)]

    @staticmethod
    def _cache_key(run_id: str, idempotency_key: str) -> str:
        return f"{run_id}:{idempotency_key}"

    @staticmethod
    def _to_event_read(event: AgentRunEvent) -> RuntimeEventRead:
        return RuntimeEventRead(
            id=event.id,
            run_id=event.run_id,
            conversation_id=event.conversation_id,
            workspace_id=event.workspace_id,
            project_id=event.project_id,
            type=event.type,
            event_seq=event.event_seq,
            client_event_id=event.client_event_id,
            ordering_hint=event.ordering_hint,
            payload=event.get_payload(),
            trace=event.get_trace(),
            created_at=event.created_at,
        )


# ─── Singleton accessor ─────────────────────────────────────────────────────

def get_agent_runtime_service(session: Session) -> AgentRuntimeService:
    """Get AgentRuntimeService instance."""
    return AgentRuntimeService(session)
