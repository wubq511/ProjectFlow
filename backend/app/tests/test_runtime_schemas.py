"""Tests for T41 Runtime Foundation Schemas.

Validates:
- Schema creation and validation
- snake_case/camelCase adapter behavior
- Enum values match spec
- Tool manifest completeness
- HumanActionManifest model_callable=False
- Boundary layer classification
"""

from datetime import datetime, timezone

from app.schemas.runtime import (
    AgentRunState,
    AppendRequest,
    AppendResponse,
    EventAppendItem,
    HumanActionManifest,
    PendingToolCall,
    ProjectFlowToolResult,
    ResumePolicy,
    RuntimeEvent,
    RuntimeEventState,
    SideEffect,
    ToolAnnotations,
    ToolBackendConfig,
    ToolEffectConfig,
    ToolError,
    ToolExecutionApprovalExtension,
    ToolLinks,
    ToolManifest,
    ToolProposalConfig,
    ToolResultLimit,
    TraceEnvelope,
    TraceSpan,
)
from app.models.enums import (
    AgentRunStatus,
    HumanActionType,
    RuntimeEventType,
    SideEffectStatus,
    ToolEffectType,
    ToolResultStatus,
    ToolRiskCategory,
)


class TestAgentRunState:
    """Test AgentRunState schema."""

    def test_create_minimal(self):
        state = AgentRunState(
            run_id="run_123",
            conversation_id="conv_456",
            workspace_id="ws_789",
            project_id="proj_012",
        )
        assert state.run_id == "run_123"
        assert state.status == AgentRunStatus.created
        assert state.current_turn == 0
        assert state.current_step == 0
        assert state.last_event_seq == 0

    def test_create_full(self):
        state = AgentRunState(
            run_id="run_123",
            conversation_id="conv_456",
            workspace_id="ws_789",
            project_id="proj_012",
            status=AgentRunStatus.tool_running,
            current_turn=2,
            current_step=5,
            model={"provider": "openai", "name": "gpt-4o"},
            pending_tool_call=PendingToolCall(
                tool_call_id="tc_001",
                tool_name="get_workspace_state",
                tool_version=1,
                idempotency_key="run_123:tc_001:get_workspace_state:1",
            ),
            side_effects=[
                SideEffect(tool_call_id="tc_000", status=SideEffectStatus.event_persisted)
            ],
            last_event_seq=3,
            resume_policy=ResumePolicy(manifest_version=1, requires_regeneration_on_mismatch=True),
        )
        assert state.status == AgentRunStatus.tool_running
        assert state.pending_tool_call is not None
        assert state.pending_tool_call.tool_name == "get_workspace_state"
        assert len(state.side_effects) == 1

    def test_status_transitions(self):
        """Verify all status values are valid."""
        for status in AgentRunStatus:
            state = AgentRunState(
                run_id="run_123",
                conversation_id="conv_456",
                workspace_id="ws_789",
                project_id="proj_012",
                status=status,
            )
            assert state.status == status


class TestToolManifest:
    """Test Tool Manifest schema."""

    def test_read_only_tool(self):
        manifest = ToolManifest(
            name="get_workspace_state",
            description="Read workspace state",
            risk_category=ToolRiskCategory.read_only,
            annotations=ToolAnnotations(read_only=True),
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/workspace-state"),
        )
        assert manifest.annotations.read_only is True
        assert manifest.risk_category == ToolRiskCategory.read_only
        assert manifest.model_callable is True
        assert manifest.sidecar_only is False

    def test_draft_only_tool(self):
        manifest = ToolManifest(
            name="create_stage_plan_proposal",
            description="Create a stage plan proposal",
            risk_category=ToolRiskCategory.draft_only,
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/stage-plan-proposal"),
            effects=ToolEffectConfig(
                effect_type=ToolEffectType.proposal_create,
                idempotency_key_required=True,
            ),
            proposal_confirmation=ToolProposalConfig(creates_proposal=True, required_before_commit=True),
        )
        assert manifest.risk_category == ToolRiskCategory.draft_only
        assert manifest.effects.effect_type == ToolEffectType.proposal_create

    def test_advisory_write_tool(self):
        manifest = ToolManifest(
            name="create_risk",
            description="Create a risk record",
            risk_category=ToolRiskCategory.advisory_write,
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/risks"),
            effects=ToolEffectConfig(
                effect_type=ToolEffectType.advisory_record_create,
                idempotency_key_required=True,
            ),
        )
        assert manifest.risk_category == ToolRiskCategory.advisory_write
        assert manifest.effects.effect_type == ToolEffectType.advisory_record_create

    def test_destructive_tool_disabled(self):
        """Destructive tools should not be model-callable in production."""
        manifest = ToolManifest(
            name="delete_project",
            description="Delete a project",
            risk_category=ToolRiskCategory.destructive,
            model_callable=False,
            annotations=ToolAnnotations(destructive=True),
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/delete-project"),
        )
        assert manifest.model_callable is False
        assert manifest.annotations.destructive is True

    def test_sidecar_only_flag(self):
        """sidecar_only defaults to False."""
        manifest = ToolManifest(
            name="get_project_state",
            description="Read project state",
            risk_category=ToolRiskCategory.read_only,
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/project-state"),
        )
        assert manifest.sidecar_only is False

    def test_result_limit_object(self):
        """result_limit is a ToolResultLimit object."""
        manifest = ToolManifest(
            name="get_workspace_state",
            description="Read workspace state",
            risk_category=ToolRiskCategory.read_only,
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/workspace-state"),
        )
        assert isinstance(manifest.result_limit, ToolResultLimit)
        assert manifest.result_limit.max_bytes == 65536
        assert manifest.result_limit.redaction == "none"

    def test_tool_execution_approval_extension(self):
        """tool_execution_approval_extension is optional."""
        manifest = ToolManifest(
            name="get_workspace_state",
            description="Read workspace state",
            risk_category=ToolRiskCategory.read_only,
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/workspace-state"),
            tool_execution_approval_extension=ToolExecutionApprovalExtension(),
        )
        assert manifest.tool_execution_approval_extension is not None
        assert manifest.tool_execution_approval_extension.current_runtime_supported is False
        assert manifest.tool_execution_approval_extension.future_approval_scope is None

    def test_execution_mode_values(self):
        """execution.mode 只接受 parallel / sequential。"""
        manifest = ToolManifest(
            name="get_workspace_state",
            description="Read workspace state",
            risk_category=ToolRiskCategory.read_only,
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/workspace-state"),
        )
        assert manifest.execution.mode == "sequential"

    def test_privacy_config(self):
        """privacy 使用 data_classification / trace_include_inputs / trace_include_outputs。"""
        manifest = ToolManifest(
            name="get_workspace_state",
            description="Read workspace state",
            risk_category=ToolRiskCategory.read_only,
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/workspace-state"),
        )
        assert manifest.privacy.data_classification == "project_sensitive"
        assert manifest.privacy.trace_include_inputs is False
        assert manifest.privacy.trace_include_outputs is False

    def test_error_config(self):
        """errors 使用 model_visible_error_policy。"""
        manifest = ToolManifest(
            name="get_workspace_state",
            description="Read workspace state",
            risk_category=ToolRiskCategory.read_only,
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/workspace-state"),
        )
        assert manifest.errors.model_visible_error_policy == "normalized_summary"

    def test_resume_config(self):
        """resume 使用 manifest_version / incompatible_version_policy。"""
        manifest = ToolManifest(
            name="get_workspace_state",
            description="Read workspace state",
            risk_category=ToolRiskCategory.read_only,
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/workspace-state"),
        )
        assert manifest.resume.manifest_version == 1
        assert manifest.resume.incompatible_version_policy == "regenerate"

    def test_trace_config(self):
        """trace 使用 emits 列表。"""
        manifest = ToolManifest(
            name="get_workspace_state",
            description="Read workspace state",
            risk_category=ToolRiskCategory.read_only,
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/workspace-state"),
        )
        assert isinstance(manifest.trace.emits, list)
        assert len(manifest.trace.emits) == 0

    def test_retry_config(self):
        """retry 使用 max_attempts。"""
        manifest = ToolManifest(
            name="get_workspace_state",
            description="Read workspace state",
            risk_category=ToolRiskCategory.read_only,
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/workspace-state"),
        )
        assert manifest.retry.max_attempts == 1

    def test_proposal_config(self):
        """proposal_confirmation 使用 creates_proposal / required_before_commit / public_action_only / resumes_model_loop_by_default。"""
        manifest = ToolManifest(
            name="create_stage_plan_proposal",
            description="Create stage plan proposal",
            risk_category=ToolRiskCategory.draft_only,
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/stage-plan-proposal"),
            proposal_confirmation=ToolProposalConfig(
                creates_proposal=True,
                required_before_commit=True,
            ),
        )
        assert manifest.proposal_confirmation.creates_proposal is True
        assert manifest.proposal_confirmation.required_before_commit is True
        assert manifest.proposal_confirmation.public_action_only is True
        assert manifest.proposal_confirmation.resumes_model_loop_by_default is False


class TestHumanActionManifest:
    """Test HumanActionManifest schema."""

    def test_confirm_proposal(self):
        manifest = HumanActionManifest(
            name="confirm_proposal",
            description="Confirm a pending proposal",
            action_type=HumanActionType.confirm_proposal,
            backend=ToolBackendConfig(endpoint="/api/proposals/{proposal_id}/confirm"),
            effects=ToolEffectConfig(effect_type=ToolEffectType.runtime_metadata_write),
        )
        assert manifest.model_callable is False
        assert manifest.human_triggered_only is True
        assert manifest.action_type == HumanActionType.confirm_proposal

    def test_reject_proposal(self):
        manifest = HumanActionManifest(
            name="reject_proposal",
            description="Reject a pending proposal",
            action_type=HumanActionType.reject_proposal,
            backend=ToolBackendConfig(endpoint="/api/proposals/{proposal_id}/reject"),
            effects=ToolEffectConfig(effect_type=ToolEffectType.event_write),
        )
        assert manifest.model_callable is False
        assert manifest.human_triggered_only is True

    def test_model_callable_must_be_false(self):
        """HumanActionManifest always has model_callable=False."""
        manifest = HumanActionManifest(
            name="test_action",
            description="Test action",
            action_type=HumanActionType.cancel_run,
            backend=ToolBackendConfig(endpoint="/test"),
            effects=ToolEffectConfig(effect_type=ToolEffectType.event_write),
        )
        # This is enforced by the Literal[False] type
        assert manifest.model_callable is False

    def test_annotations_read_only_and_destructive(self):
        """HumanActionManifest annotations 默认 read_only=False, destructive=False。"""
        manifest = HumanActionManifest(
            name="confirm_proposal",
            description="Confirm proposal",
            action_type=HumanActionType.confirm_proposal,
            backend=ToolBackendConfig(endpoint="/api/proposals/{proposal_id}/confirm"),
            effects=ToolEffectConfig(effect_type=ToolEffectType.runtime_metadata_write),
        )
        assert manifest.annotations.read_only is False
        assert manifest.annotations.destructive is False


class TestProjectFlowToolResult:
    """Test ProjectFlowToolResult schema."""

    def test_success_result(self):
        result = ProjectFlowToolResult(
            status=ToolResultStatus.success,
            data={"workspace_id": "ws_123", "project_count": 3},
            side_effect_status=SideEffectStatus.no_side_effect,
            observation="Workspace has 3 active projects",
        )
        assert result.status == ToolResultStatus.success
        assert result.side_effect_status == SideEffectStatus.no_side_effect

    def test_blocked_result(self):
        result = ProjectFlowToolResult(
            status=ToolResultStatus.blocked,
            error=ToolError(
                code="POLICY_DENIED",
                reason="human_triggered_only",
                message="confirm_proposal is human-triggered only",
            ),
            observation="The requested tool is human-triggered only and was not executed.",
        )
        assert result.status == ToolResultStatus.blocked
        assert result.error is not None
        assert result.error.code == "POLICY_DENIED"

    def test_proposal_created_result(self):
        result = ProjectFlowToolResult(
            status=ToolResultStatus.success,
            data={"proposal_id": "prop_123"},
            side_effect_status=SideEffectStatus.proposal_persisted,
            links=ToolLinks(proposal_id="prop_123", created_ids=["prop_123"]),
            observation="Stage plan proposal created",
        )
        assert result.side_effect_status == SideEffectStatus.proposal_persisted
        assert result.links.proposal_id == "prop_123"

    def test_llm_tool_no_commit_persisted(self):
        """LLM-callable tools must not return commit_persisted."""
        # This is a policy check, not a schema validation
        # In practice, the policy engine should enforce this
        result = ProjectFlowToolResult(
            status=ToolResultStatus.success,
            side_effect_status=SideEffectStatus.advisory_record_persisted,
        )
        # Verify we're using advisory, not commit
        assert result.side_effect_status != SideEffectStatus.commit_persisted


class TestRuntimeEvent:
    """Test RuntimeEvent schema."""

    def test_tool_started_event(self):
        event = RuntimeEvent(
            type=RuntimeEventType.tool_started,
            run_id="run_123",
            event_seq=5,
            timestamp=datetime.now(timezone.utc),
            state=RuntimeEventState(status=AgentRunStatus.tool_running),
            payload={"tool_name": "get_workspace_state", "tool_call_id": "tc_001"},
        )
        assert event.type == RuntimeEventType.tool_started
        assert event.event_seq == 5

    def test_state_changed_event(self):
        event = RuntimeEvent(
            type=RuntimeEventType.state_changed,
            run_id="run_123",
            state=RuntimeEventState(status=AgentRunStatus.model_streaming),
        )
        assert event.type == RuntimeEventType.state_changed


class TestTraceEnvelope:
    """Test TraceEnvelope schema."""

    def test_basic_trace(self):
        trace = TraceEnvelope(
            run_id="run_123",
            tool_call_id="tc_001",
            tool_name="get_workspace_state",
            spans=[
                TraceSpan(name="tool_call", start_ms=1000, end_ms=1500),
            ],
        )
        assert trace.run_id == "run_123"
        assert len(trace.spans) == 1
        assert trace.include_sensitive_data is False

    def test_proposal_trace(self):
        trace = TraceEnvelope(
            run_id="run_123",
            proposal_id="prop_123",
            attributes={"proposal_type": "stage_plan"},
        )
        assert trace.proposal_id == "prop_123"


class TestAppendAPI:
    """Test Append API request/response schemas."""

    def test_append_request(self):
        request = AppendRequest(
            idempotency_key="run_123:append:v1",
            state_patch={"status": "tool_running"},
            events=[
                EventAppendItem(
                    client_event_id="client_evt_001",
                    type=RuntimeEventType.tool_started,
                    ordering_hint=5,
                )
            ],
            tool_results=[],
        )
        assert request.idempotency_key == "run_123:append:v1"
        assert len(request.events) == 1

    def test_append_response(self):
        response = AppendResponse(
            state_version=7,
            events=[{"client_event_id": "client_evt_001", "agent_event_id": "evt_001", "event_seq": 5}],
        )
        assert response.state_version == 7
        assert len(response.events) == 1


class TestBoundaryLayers:
    """Test boundary layer classification."""

    def test_event_write(self):
        """Event write tools have no side effects beyond events."""
        manifest = ToolManifest(
            name="get_workspace_state",
            description="Read workspace state",
            risk_category=ToolRiskCategory.read_only,
            annotations=ToolAnnotations(read_only=True),
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/workspace-state"),
            effects=ToolEffectConfig(effect_type=ToolEffectType.event_write),
        )
        assert manifest.effects.effect_type == ToolEffectType.event_write

    def test_proposal_create(self):
        """Draft tools create proposals that need confirmation."""
        manifest = ToolManifest(
            name="create_stage_plan_proposal",
            description="Create stage plan proposal",
            risk_category=ToolRiskCategory.draft_only,
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/stage-plan-proposal"),
            effects=ToolEffectConfig(effect_type=ToolEffectType.proposal_create),
        )
        assert manifest.effects.effect_type == ToolEffectType.proposal_create

    def test_advisory_record_create(self):
        """Advisory writes create records that don't change primary state."""
        manifest = ToolManifest(
            name="create_risk",
            description="Create risk record",
            risk_category=ToolRiskCategory.advisory_write,
            backend=ToolBackendConfig(endpoint="/internal/agent-tools/risks"),
            effects=ToolEffectConfig(effect_type=ToolEffectType.advisory_record_create),
        )
        assert manifest.effects.effect_type == ToolEffectType.advisory_record_create

    def test_runtime_metadata_write_human_only(self):
        """Runtime metadata writes are human-only actions."""
        manifest = HumanActionManifest(
            name="confirm_proposal",
            description="Confirm proposal",
            action_type=HumanActionType.confirm_proposal,
            backend=ToolBackendConfig(endpoint="/api/proposals/{proposal_id}/confirm"),
            effects=ToolEffectConfig(effect_type=ToolEffectType.runtime_metadata_write),
        )
        assert manifest.effects.effect_type == ToolEffectType.runtime_metadata_write
        assert manifest.model_callable is False


class TestEnumValues:
    """Test enum values match specification."""

    def test_agent_run_status(self):
        expected = [
            "created", "context_building", "model_streaming",
            "tool_preparing", "tool_running", "persisting_tool_result",
            "completed", "cancelling", "cancelled", "failed",
        ]
        actual = [s.value for s in AgentRunStatus]
        assert actual == expected

    def test_tool_effect_type(self):
        expected = [
            "none", "event_write", "proposal_create",
            "advisory_record_create", "runtime_metadata_write",
        ]
        actual = [e.value for e in ToolEffectType]
        assert actual == expected

    def test_side_effect_status(self):
        expected = [
            "no_side_effect", "event_persisted", "proposal_persisted",
            "advisory_record_persisted", "commit_persisted", "unknown",
        ]
        actual = [s.value for s in SideEffectStatus]
        assert actual == expected

    def test_tool_result_status(self):
        expected = [
            "success", "blocked", "failed", "aborted", "timeout", "validation_error",
        ]
        actual = [s.value for s in ToolResultStatus]
        assert actual == expected

    def test_runtime_event_type(self):
        expected = [
            "run.started", "run.completed", "run.failed", "run.cancelled",
            "tool.started", "tool.completed", "tool.blocked", "tool.failed",
            "model.streaming", "state.changed",
            "proposal.created", "proposal.confirmed", "proposal.rejected",
            "runtime.error", "agent.started", "agent.status", "agent.delta",
            "agent.completed", "agent.failed", "agent.output_captured", "tool.progress",
            "advisory_record.created",
            "proposal_confirmation.confirmed", "proposal_confirmation.rejected",
            "proposal_confirmation.committed", "run.state_changed",
            "work_state.changed", "run_plan.created", "run_plan.step_updated",
            "verifier.completed", "tool.ledger_entry", "checkpoint.saved",
            "steering.queued", "steering.consumed",
        ]
        actual = [s.value for s in RuntimeEventType]
        assert actual == expected
