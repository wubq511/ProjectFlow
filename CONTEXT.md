# ProjectFlow

ProjectFlow is a student-team project management product with an Agent runtime that proposes, explains, and coordinates project work while FastAPI and the database remain the source of truth.

## Language

**Agent Proposal**:
A pending Agent-generated business change that must be confirmed by a human before it changes project state.
_Avoid_: Tool approval, draft, suggestion when the change can later be committed

**Replan Proposal**:
An Agent Proposal for changing existing Primary Project State during execution, including task status, task dates, ownership-sensitive changes, stage adjustments, and related mitigation action cards.
_Avoid_: TaskStatusChangeProposal, direct task status write

**Proposal Confirmation**:
The human confirm or reject decision for an Agent Proposal; confirmation triggers deterministic backend commit and rejection leaves project state unchanged.
_Avoid_: Tool approval, execution approval, model approval

**Primary Project State**:
The current project truth that drives planning and execution: Project direction/status/current stage, Stage plan/status, Task scope/status/owner/dates/dependencies, and finalized assignment ownership.
_Avoid_: Project aggregate, workspace state, every persisted project-related row

**Reviewable Draft Record**:
A persisted Agent-created draft or typed proposal that can become Primary Project State only through a human confirmation flow.
_Avoid_: Advisory record, runtime metadata

**Advisory Project Record**:
A persisted Agent-created record that guides work without directly rewriting Primary Project State, such as a Risk of any severity or an ActionCard.
_Avoid_: Primary project state, proposal, commit

**Runtime Metadata**:
Conversation, run, event, trace, state, and tool-result records that make Agent execution observable and replayable without being project commitments.
_Avoid_: Primary project state, proposal

**Commit Effect**:
Any write that changes Primary Project State.
_Avoid_: Advisory write, event write, proposal creation

**Advisory Write Effect**:
A FastAPI-owned, idempotent write of an Advisory Project Record, returning created IDs and user-visible controls for dismissal, resolution, or completion.
_Avoid_: Commit effect, proposal confirmation

**Read-Only State View**:
A ProjectFlow state view that reports current facts without creating, repairing, or committing project state.
_Avoid_: Repair read, catch-up read

**State Repair Command**:
An explicit human-triggered, maintenance, migration, or scheduled command that reconciles stale Primary Project State outside read paths.
_Avoid_: Read-time repair, hidden catch-up

**Tool Execution Approval**:
A future human approval before running a tool whose execution has immediate external, destructive, or otherwise irreversible impact.
_Avoid_: Proposal confirmation, tool approval

**Policy Gate**:
The runtime decision that allows, denies, or blocks a tool call before execution according to ProjectFlow's manifest and safety rules.
_Avoid_: Human approval, proposal confirmation

**ProjectFlow Tool**:
A narrow, typed Agent-callable capability that reads, analyzes, or creates pending ProjectFlow artifacts through FastAPI-owned contracts.
_Avoid_: Generic API caller, shell tool, direct database tool

**ProjectMemory**:
A governed context record derived from a Memory Source Event, storing a project decision's conclusion (content) and rationale. Not Primary Project State; used to inform future Agent judgment.
_Avoid_: Chat history, long-term memory node, user memory

**Memory Source Event**:
A formal project decision point that triggers ProjectMemory extraction. V1 events: direction_card_confirmed, proposal_rejected, assignment_confirmed, replan_confirmed, replan_rejected.
_Avoid_: Any user action, chat message, Agent intermediate reasoning

**MemoryExtractor**:
A deterministic function that reads a Memory Source Event payload and produces ProjectMemory candidates through fixed Chinese templates, without calling an LLM.
_Avoid_: LLM-based extraction, embedding pipeline

**Viewer Identity Context**:
An explicit, unauthenticated viewer_user_id passed on memory read/export requests. Missing or invalid → 400; viewer outside workspace → 404. No fallback to owner view.
_Avoid_: Auth session, JWT, implicit viewer
