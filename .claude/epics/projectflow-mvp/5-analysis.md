---
issue: 5
title: Agent Infrastructure and Structured Outputs
analyzed: 2026-05-29T00:09:57Z
estimated_hours: 10
parallelization_factor: 2.0
---

# Parallel Work Analysis: Issue #5

## Overview

Build the single Coordinator Agent foundation for ProjectFlow. The work creates structured Pydantic outputs, provider-aware LLM calls, prompt boundaries, validation and fallback behavior, timeline event logging, module entrypoints, and tests that do not require a real API key.

## Parallel Streams

### Stream A: Output Schemas
**Scope**: Define Pydantic schemas for every agent output and fail-closed validation helpers.
**Files**:
- `backend/app/agent/output_schemas.py`
- `backend/app/agent/__init__.py`
- `backend/app/tests/test_agent_output_schemas.py`
**Can Start**: immediately
**Estimated Hours**: 3
**Dependencies**: none

### Stream B: LLM Client, Prompts, and Fallback Pipeline
**Scope**: Add mock and OpenAI-compatible provider configuration, prompt boundaries, JSON extraction/repair, retry, template fallback, and timeline logging support.
**Files**:
- `backend/app/core/config.py`
- `backend/app/agent/llm_client.py`
- `backend/app/agent/prompts.py`
- `backend/app/agent/workflow.py`
- `backend/app/agent/coordinator.py`
- `backend/app/tests/test_agent_workflow.py`
**Can Start**: after Stream A schema interfaces are fixed
**Estimated Hours**: 5
**Dependencies**: Stream A

### Stream C: Agent Module Entry Points
**Scope**: Create module functions for clarification, planning, breakdown, assignment recommendation, assignment negotiation, active push, check-in analysis, risk analysis, and replanning.
**Files**:
- `backend/app/agent/modules/__init__.py`
- `backend/app/agent/modules/clarification.py`
- `backend/app/agent/modules/planning.py`
- `backend/app/agent/modules/breakdown.py`
- `backend/app/agent/modules/assignment_recommendation.py`
- `backend/app/agent/modules/assignment_negotiation.py`
- `backend/app/agent/modules/active_push.py`
- `backend/app/agent/modules/checkin_analysis.py`
- `backend/app/agent/modules/risk_analysis.py`
- `backend/app/agent/modules/replanning.py`
- `backend/app/tests/test_agent_modules.py`
**Can Start**: after Stream A and Stream B provide shared generation primitives
**Estimated Hours**: 2
**Dependencies**: Stream A, Stream B

## Coordination Points

### Shared Files
- `backend/app/core/config.py` - provider settings must remain backward-compatible with existing settings.
- `backend/app/models/agent_event.py` - issue acceptance requires event status; this is a database model change and needs explicit approval before editing.
- `backend/app/agent/output_schemas.py` - Stream B and C should import schemas but not redefine them.

### Sequential Requirements
- Stream A should lock schema names and validation shape before Stream B or C.
- Stream B should expose one generation function that Stream C modules call.
- Any `AgentEvent` model change must happen only after approval for the database schema change.

## Conflict Risk Assessment

Low to medium. Most files are new under `backend/app/agent`, but `config.py` and `agent_event.py` are shared infrastructure. The main risk is accidentally letting the agent write database state directly; keep module outputs as proposals and let services finalize changes later.

## Parallelization Strategy

Use a mostly sequential implementation despite logical streams because Stream B and C depend on the Stream A API. If explicit parallel-agent execution is requested, Stream A can be implemented first, then Stream B and C can run with disjoint write scopes.

## Expected Timeline
- With parallel execution: 7h wall time
- Without: 10h
- Efficiency gain: 30%
