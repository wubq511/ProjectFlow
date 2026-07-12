"""T41 Agent Runtime Service.

Manages AgentRun lifecycle, event appending, and tool result persistence.
Implements idempotency key validation and atomic event_seq assignment.
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import desc
from sqlmodel import Session, select

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


logger = logging.getLogger(__name__)


class StaleStateVersionError(ValueError):
    """Raised when expected_state_version does not match the run's current state_version."""

    def __init__(self, run_id: str, expected: int, actual: int):
        self.run_id = run_id
        self.expected = expected
        self.actual = actual
        super().__init__(
            f"状态版本冲突: run {run_id} expected {expected}, actual {actual}"
        )


class AgentRuntimeService:
    """Service for managing agent run lifecycle and event persistence."""

    # 合法状态转换表（移植自 TS 侧 run-state.ts isValidTransition）
    _VALID_TRANSITIONS: dict[AgentRunStatus, set[AgentRunStatus]] = {
        AgentRunStatus.created: {AgentRunStatus.context_building, AgentRunStatus.cancelling, AgentRunStatus.failed},
        AgentRunStatus.context_building: {AgentRunStatus.model_streaming, AgentRunStatus.cancelling, AgentRunStatus.failed},
        AgentRunStatus.model_streaming: {
            AgentRunStatus.tool_preparing, AgentRunStatus.tool_running,
            AgentRunStatus.persisting_tool_result, AgentRunStatus.completed,
            AgentRunStatus.cancelling, AgentRunStatus.failed,
        },
        AgentRunStatus.tool_preparing: {
            AgentRunStatus.tool_running, AgentRunStatus.persisting_tool_result,
            AgentRunStatus.model_streaming, AgentRunStatus.completed,
            AgentRunStatus.cancelling, AgentRunStatus.failed,
        },
        AgentRunStatus.tool_running: {
            AgentRunStatus.persisting_tool_result, AgentRunStatus.model_streaming,
            AgentRunStatus.completed, AgentRunStatus.cancelling, AgentRunStatus.failed,
        },
        AgentRunStatus.persisting_tool_result: {
            AgentRunStatus.model_streaming, AgentRunStatus.completed,
            AgentRunStatus.cancelling, AgentRunStatus.cancelled, AgentRunStatus.failed,
        },
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
        project, _ = validate_viewer(
            self.session,
            project_id=request.project_id,
            viewer_user_id=request.viewer_user_id,
        )

        # Verify workspace/project consistency
        if project.workspace_id != request.workspace_id:
            raise ValueError(
                f"项目 {request.project_id} 不属于工作区 {request.workspace_id}"
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

        # R8 evaluation can explicitly disable injection for A while still
        # exercising the same FastAPI run creation and sidecar path.
        memory_context = None
        if request.memory_mode == "enabled":
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

    def get_resume_context(
        self,
        run_id: str,
        viewer_user_id: str,
    ) -> dict[str, Any]:
        """Return authenticated resume context for a run.

        Validates viewer membership and returns fresh workspace facts,
        pending proposals, governed memory context, and viewer identity.
        Failure is blocking — the caller must not proceed without this context.
        """
        run = self.session.get(AgentRunV2, run_id)
        if not run:
            raise ValueError(f"Run {run_id} not found")

        # Validate viewer is a workspace member
        from app.services.memory_service import validate_viewer
        project, _ = validate_viewer(
            self.session,
            project_id=run.project_id,
            viewer_user_id=viewer_user_id,
        )

        # Fetch fresh workspace state (deterministic, no LLM)
        from app.services.workspace_state_service import get_workspace_state
        ws_state = get_workspace_state(
            self.session,
            workspace_id=run.workspace_id,
            project_id=run.project_id,
        )
        workspace_state_dict = ws_state.model_dump(mode="json") if ws_state else {}

        # Fetch pending proposals for this project
        from app.services.agent_proposal_service import list_proposals_by_project, to_proposal_read
        pending = list_proposals_by_project(self.session, run.project_id, status="pending")
        pending_proposals = [to_proposal_read(p).model_dump(mode="json") for p in pending]

        # Build memory context (non-blocking failure)
        memory_context = self._build_memory_context_for_run(
            run.project_id,
            viewer_user_id,
            query="",  # no specific query for resume
        )

        return {
            "run_id": run.id,
            "workspace_id": run.workspace_id,
            "project_id": run.project_id,
            "viewer_user_id": viewer_user_id,
            "conversation_id": run.conversation_id,
            "status": run.status.value if hasattr(run.status, "value") else str(run.status),
            "state_version": run.state_version,
            "last_event_seq": run.last_event_seq,
            "workspace_state": workspace_state_dict,
            "pending_proposals": pending_proposals,
            "memory_context": memory_context.to_dict() if memory_context else None,
        }

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
            state_version=run.state_version,
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

        - Validates idempotency key via durable DB check (client_event_id)
        - Validates expected_state_version for optimistic concurrency
        - Assigns event_seq monotonically per run_id
        - Applies state patch
        - Persists tool results
        - All in a single transaction
        """
        run = self.session.get(AgentRunV2, run_id)
        if not run:
            raise ValueError(f"Run {run_id} not found")

        # Check durable idempotency FIRST (P0-3), before optimistic concurrency.
        # An exact retry with the original expected version after success must
        # return its durable idempotent response, not 409.

        # 1) Check first user-submitted event's client_event_id
        if request.events:
            first_client_event_id = request.events[0].client_event_id
            existing = self.session.exec(
                select(AgentRunEvent)
                .where(AgentRunEvent.run_id == run_id)
                .where(AgentRunEvent.client_event_id == first_client_event_id)
            ).first()
            if existing:
                return self._build_idempotent_response(run, request)

        # 2) Check request idempotency_key against client_event_id
        idempotency_event = self.session.exec(
            select(AgentRunEvent)
            .where(AgentRunEvent.run_id == run_id)
            .where(AgentRunEvent.client_event_id == request.idempotency_key)
        ).first()
        if idempotency_event:
            return self._build_idempotent_response(run, request)

        # 3) Check auto-generated events that store the request idempotency_key
        #    Pure state-patch → auto_client_event_id = "{key}:auto:state_changed"
        #    Tool-result-only → auto_client_event_id = "{key}:auto:tool_result:{tool_call_id}"
        auto_key_candidates = [f"{request.idempotency_key}:auto:state_changed"]
        for tr in request.tool_results:
            auto_key_candidates.append(
                f"{request.idempotency_key}:auto:tool_result:{tr.tool_call_id}"
            )
        for auto_key in auto_key_candidates:
            auto_event = self.session.exec(
                select(AgentRunEvent)
                .where(AgentRunEvent.run_id == run_id)
                .where(AgentRunEvent.client_event_id == auto_key)
            ).first()
            if auto_event:
                return self._build_idempotent_response(run, request)

        # Check optimistic concurrency (P0-4) — AFTER idempotency check.
        # A different request with a stale version must return 409.
        if request.expected_state_version is not None:
            if run.state_version != request.expected_state_version:
                raise StaleStateVersionError(
                    run_id=run_id,
                    expected=request.expected_state_version,
                    actual=run.state_version,
                )

        # Apply state patch if provided
        if request.state_patch:
            self._apply_state_patch(run, request.state_patch)

        # Process events and assign event_seq
        # 当 state_patch 非空时，自动插入 run.state_changed 事件（在用户提交的 events 之前）
        # client_event_id 包含 request idempotency_key 以支持跨重启的幂等检测
        if request.state_patch:
            run.last_event_seq += 1
            state_changed_event = AgentRunEvent(
                run_id=run.id,
                conversation_id=run.conversation_id,
                workspace_id=run.workspace_id,
                project_id=run.project_id,
                type=RuntimeEventType.run_state_changed,
                event_seq=run.last_event_seq,
                client_event_id=f"{request.idempotency_key}:auto:state_changed",
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

        # Durable idempotency marker for tool-result-only requests
        # (no events, no state_patch — only tool_results)
        # Creates a hidden marker event so duplicate requests are detected after restart
        if request.tool_results and not request.events and not request.state_patch:
            for tr_item in request.tool_results:
                run.last_event_seq += 1
                marker = AgentRunEvent(
                    run_id=run.id,
                    conversation_id=run.conversation_id,
                    workspace_id=run.workspace_id,
                    project_id=run.project_id,
                    type=RuntimeEventType.run_state_changed,
                    event_seq=run.last_event_seq,
                    client_event_id=f"{request.idempotency_key}:auto:tool_result:{tr_item.tool_call_id}",
                    ordering_hint=0,
                )
                marker.set_payload({"_idempotency_marker": True, "tool_call_id": tr_item.tool_call_id})
                marker.set_trace({})
                self.session.add(marker)

        # Update state version: every durable control-plane mutation
        # (events, state_patch, tool_results) advances state_version exactly once.
        # Duplicate requests (detected above) return early and advance zero times.
        has_mutation = bool(request.state_patch or request.tool_results or request.events)
        if has_mutation:
            run.state_version += 1
        run.updated_at = datetime.now(timezone.utc)

        # Set completion time if run completed
        if run.status in (AgentRunStatus.completed, AgentRunStatus.cancelled, AgentRunStatus.failed):
            run.completed_at = datetime.now(timezone.utc)

        self.session.commit()

        response = AppendResponse(
            state_version=run.state_version,
            events=event_responses,
            tool_results=tool_result_responses,
        )

        return response

    def _build_idempotent_response(
        self,
        run: AgentRunV2,
        request: AppendRequest,
    ) -> AppendResponse:
        """Build a response for a duplicate request from persisted data.

        Returns the original durable result without adding new events or effects.
        """
        # Find events that match the request's client_event_ids
        event_responses = []
        for event_item in request.events:
            existing = self.session.exec(
                select(AgentRunEvent)
                .where(AgentRunEvent.run_id == run.id)
                .where(AgentRunEvent.client_event_id == event_item.client_event_id)
            ).first()
            if existing:
                event_responses.append(EventAppendResponse(
                    client_event_id=event_item.client_event_id,
                    agent_event_id=existing.id,
                    event_seq=existing.event_seq,
                ))

        return AppendResponse(
            state_version=run.state_version,
            events=event_responses,
            tool_results=[],
        )

    def _apply_state_patch(self, run: AgentRunV2, patch: dict) -> None:
        """Apply state patch to run with validation."""
        if "status" in patch:
            new_status = AgentRunStatus(patch["status"])
            if new_status == run.status:
                pass  # idempotent — same status, no transition needed
            else:
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
            val = patch["pending_tool_version"]
            run.pending_tool_version = int(val) if val is not None else None
        if "pending_idempotency_key" in patch:
            run.pending_idempotency_key = patch["pending_idempotency_key"]
        if "last_event_seq" in patch:
            run.last_event_seq = int(patch["last_event_seq"])


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

    def get_run_snapshot(
        self,
        run_id: str,
        after_event_seq: int = 0,
        post_checkpoint_limit: int = 200,
    ) -> dict[str, Any] | None:
        """Return a durable snapshot of a run for resume/rehydrate.

        Returns latest checkpoint plus its event sequence and every event after
        it, using bounded cursor-based pagination. If the post-checkpoint range
        exceeds the safety bound, the caller must paginate using next_cursor;
        never silently resume from incomplete evidence.

        Bounded/redacted — no raw workspace_state, secrets, or chain-of-thought.
        """
        run = self.session.get(AgentRunV2, run_id)
        if not run:
            return None

        # Step 1: Find the latest checkpoint event
        checkpoint_event = self.session.exec(
            select(AgentRunEvent)
            .where(AgentRunEvent.run_id == run_id)
            .where(AgentRunEvent.type == RuntimeEventType.checkpoint_saved)
            .order_by(desc(AgentRunEvent.event_seq))
            .limit(1)
        ).first()

        latest_checkpoint = None
        checkpoint_seq = 0
        if checkpoint_event:
            latest_checkpoint = checkpoint_event.get_payload().get("checkpoint")
            checkpoint_seq = checkpoint_event.event_seq

        # Step 2: Determine the start sequence for this page.
        # First page starts at checkpoint_seq (or 0 if no checkpoint).
        # Subsequent pages start at after_event_seq + 1.
        if after_event_seq > 0:
            start_seq = after_event_seq + 1
        elif checkpoint_seq > 0:
            start_seq = checkpoint_seq
        else:
            start_seq = 0

        # Step 3: Get events from start_seq onward (bounded page).
        # +1 to detect overflow for has_more.
        if start_seq > 0:
            events = self.session.exec(
                select(AgentRunEvent)
                .where(AgentRunEvent.run_id == run_id)
                .where(AgentRunEvent.event_seq >= start_seq)
                .order_by(AgentRunEvent.event_seq)
                .limit(post_checkpoint_limit + 1)
            ).all()
        else:
            events = self.session.exec(
                select(AgentRunEvent)
                .where(AgentRunEvent.run_id == run_id)
                .order_by(AgentRunEvent.event_seq)
                .limit(post_checkpoint_limit + 1)
            ).all()

        has_more = len(events) > post_checkpoint_limit
        events = events[:post_checkpoint_limit]

        # Compute next_cursor: the last event_seq in this page (or None)
        next_cursor = events[-1].event_seq if events and has_more else None

        recent_events = [
            {
                "id": e.id,
                "type": e.type.value if hasattr(e.type, "value") else str(e.type),
                "event_seq": e.event_seq,
                "payload": e.get_payload(),
                "created_at": e.created_at.isoformat(),
            }
            for e in events
        ]

        # Step 4: Extract unconsumed steering events from the event stream
        unconsumed_steering = []
        for e in events:
            event_type = e.type.value if hasattr(e.type, "value") else str(e.type)
            if event_type == "steering.queued":
                payload = e.get_payload()
                unconsumed_steering.append({
                    "steering_seq": e.event_seq,
                    "steering_type": payload.get("steering_type", ""),
                    "content": payload.get("content", ""),
                    "client_message_id": payload.get("client_message_id", ""),
                    "metadata": payload.get("metadata", {}),
                })
            elif event_type == "steering.consumed":
                # Remove consumed steering from the unconsumed list
                consumed_seq = e.get_payload().get("steering_seq")
                unconsumed_steering = [
                    s for s in unconsumed_steering if s["steering_seq"] != consumed_seq
                ]

        # Build side effects (bounded)
        side_effects = run.get_side_effects()

        return {
            "run_id": run.id,
            "conversation_id": run.conversation_id,
            "workspace_id": run.workspace_id,
            "project_id": run.project_id,
            "viewer_user_id": run.viewer_user_id,
            "status": run.status.value if hasattr(run.status, "value") else str(run.status),
            "current_turn": run.current_turn,
            "current_step": run.current_step,
            "last_event_seq": run.last_event_seq,
            "state_version": run.state_version,
            "model_provider": run.model_provider,
            "model_name": run.model_name,
            "created_at": run.created_at.isoformat(),
            "updated_at": run.updated_at.isoformat(),
            "completed_at": run.completed_at.isoformat() if run.completed_at else None,
            "side_effects": side_effects,
            "latest_checkpoint": latest_checkpoint,
            "recent_events": recent_events,
            "has_more": has_more,
            "next_cursor": next_cursor,
            "unconsumed_steering": unconsumed_steering,
        }

    def append_steering(
        self,
        run_id: str,
        steering_type: str,
        content: str,
        client_message_id: str,
        metadata: dict[str, Any] | None = None,
        expected_state_version: int | None = None,
    ) -> dict[str, Any]:
        """Append a steering event to a run.

        Uses client_message_id for durable idempotency.
        Persists as steering.queued event (not run_state_changed).
        The steering event is queued and consumed at the next loop boundary.
        """
        run = self.session.get(AgentRunV2, run_id)
        if not run:
            raise ValueError(f"Run {run_id} not found")

        # Check durable idempotency FIRST (P0-3), before optimistic concurrency.
        # An exact retry with the original expected version after success must
        # return its durable idempotent response, not 409.
        steering_client_event_id = f"steering:{client_message_id}"
        existing = self.session.exec(
            select(AgentRunEvent)
            .where(AgentRunEvent.run_id == run_id)
            .where(AgentRunEvent.client_event_id == steering_client_event_id)
        ).first()
        if existing:
            return {
                "run_id": run_id,
                "steering_seq": existing.event_seq,
                "state_version": run.state_version,
                "accepted": True,
                "message": "已接收（幂等）",
            }

        # Check optimistic concurrency (P0-4) — AFTER idempotency check.
        # A different request with a stale version must return 409.
        if expected_state_version is not None:
            if run.state_version != expected_state_version:
                raise StaleStateVersionError(
                    run_id=run_id,
                    expected=expected_state_version,
                    actual=run.state_version,
                )

        # Check run is not terminal
        terminal_statuses = {AgentRunStatus.completed, AgentRunStatus.cancelled, AgentRunStatus.failed}
        if run.status in terminal_statuses:
            raise ValueError(f"Run {run_id} is already {run.status.value}")

        # Create steering.queued event (P0-5)
        run.last_event_seq += 1
        steering_seq = run.last_event_seq

        event = AgentRunEvent(
            run_id=run.id,
            conversation_id=run.conversation_id,
            workspace_id=run.workspace_id,
            project_id=run.project_id,
            type=RuntimeEventType.steering_queued,
            event_seq=steering_seq,
            client_event_id=steering_client_event_id,
            ordering_hint=0,
        )
        event.set_payload({
            "steering_type": steering_type,
            "content": content,
            "metadata": metadata or {},
            "client_message_id": client_message_id,
        })
        event.set_trace({})
        self.session.add(event)

        run.state_version += 1
        run.updated_at = datetime.now(timezone.utc)
        self.session.commit()

        return {
            "run_id": run_id,
            "steering_seq": steering_seq,
            "state_version": run.state_version,
            "accepted": True,
            "message": "已接收",
        }


# ─── Singleton accessor ─────────────────────────────────────────────────────

def get_agent_runtime_service(session: Session) -> AgentRuntimeService:
    """Get AgentRuntimeService instance."""
    return AgentRuntimeService(session)
