---
issue: 8
title: Assignment, Active Push, Check-in, Risk, Replan Backend Flows
analyzed: 2026-05-29T05:30:43Z
estimated_hours: 14
parallelization_factor: 2.4
---

# Parallel Work Analysis: Issue #8

## Overview

Issue #8 completes the backend execution loop after planning: assignment proposals and confirmation, active push action cards, check-in capture, risk detection, replan proposal/confirmation, and agent endpoints. The existing code already has SQLModel persistence tables and structured agent modules, so the safest path is to add thin route layers and deterministic services over the existing models without changing the database schema.

## Parallel Streams

### Stream A: Assignment Workflow
**Scope**: Create assignment proposal, response, negotiation, and finalization services and APIs.
**Files**: `backend/app/schemas/assignment.py`, `backend/app/services/assignment_service.py`, `backend/app/api/routes_assignments.py`, `backend/app/tests/test_assignment_flow.py`
**Can Start**: immediately
**Estimated Hours**: 4
**Dependencies**: none

### Stream B: Check-in, Risk, and Action Card Workflow
**Scope**: Create check-in cycles/responses, manual task status updates with availability changes, risk persistence, and action card persistence APIs.
**Files**: `backend/app/schemas/checkin.py`, `backend/app/schemas/risk.py`, `backend/app/schemas/action_card.py`, `backend/app/services/checkin_service.py`, `backend/app/services/risk_service.py`, `backend/app/services/action_card_service.py`, `backend/app/api/routes_checkins.py`, `backend/app/api/routes_risks.py`, `backend/app/api/routes_action_cards.py`, `backend/app/tests/test_checkin_risk_replan_flow.py`
**Can Start**: immediately
**Estimated Hours**: 4
**Dependencies**: none

### Stream C: Agent Endpoint Orchestration
**Scope**: Expose coordinator endpoints for clarify, plan, breakdown, assign, active push, check-in analysis, risk analysis, and replan, then persist agent-generated proposals through services where appropriate.
**Files**: `backend/app/schemas/agent_flow.py`, `backend/app/services/agent_flow_service.py`, `backend/app/api/routes_agent.py`, `backend/app/tests/test_agent_endpoints.py`
**Can Start**: after Stream A and Stream B service contracts are stable
**Estimated Hours**: 4
**Dependencies**: Stream A, Stream B

### Stream D: API Registration and End-to-End Verification
**Scope**: Register routers, cover the assignment flow and check-in -> risk -> replan path, run the backend suite, and update CCPM/GitHub status.
**Files**: `backend/app/main.py`, `.claude/epics/projectflow-mvp/8.md`, `.claude/epics/projectflow-mvp/updates/8/*`
**Can Start**: after Streams A-C
**Estimated Hours**: 2
**Dependencies**: Stream A, Stream B, Stream C

## Coordination Points

### Shared Files
`backend/app/main.py` should be edited only after new route modules exist. `backend/app/schemas/__init__.py` and `backend/app/services/__init__.py` are currently not used as aggregation points, so streams can avoid them.

### Sequential Requirements
Agent endpoints should call deterministic services after coordinator output is validated. Assignment finalization must remain a service operation that updates task ownership only after a confirmed proposal. Replan must stay a proposal until an explicit confirmation endpoint applies the changes.

## Conflict Risk Assessment

Conflict risk is medium because Streams A-C all touch backend contracts, but write sets can stay mostly separate. The only unavoidable shared file is router registration in `main.py`, reserved for Stream D.

## Parallelization Strategy

Run Streams A and B first because they define deterministic service contracts. Stream C can then compose those services with the existing coordinator. Stream D handles final integration, route registration, and whole-suite verification.

## Expected Timeline

- With parallel execution: 6h wall time
- Without: 14h
- Efficiency gain: 57%
