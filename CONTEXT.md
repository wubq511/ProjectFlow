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

**Memory Source Event**:
A formal business decision point that may derive a Governed Context Record, identified by a source type and source ID; it does not require a corresponding AgentEvent row.
_Avoid_: Formal Project Event, AgentEvent, timeline event

**Source-Level ProjectMemory Idempotency**:
A V1 write contract where a Memory Source Event may derive multiple memory types, but at most one ProjectMemory per memory type; multiple same-type subitems are canonicalized into one record or skipped rather than split with item keys.
_Avoid_: Candidate-level idempotency, V1 source item key, duplicate same-type memories

**Viewer Identity Context**:
A request-scoped ProjectFlow member identity used to evaluate project visibility in the MVP before real authentication exists; it is not proof of identity.
_Avoid_: Auth user, login session, security credential

**Governed Context Record**:
A persisted context record derived from a Memory Source Event, governed by source, status, visibility, and lifecycle rules, and used to inform future Agent judgment without becoming current project truth.
_Avoid_: Long-term state, Agent memory log, source of truth

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
An explicit, unauthenticated viewer_user_id passed on memory read/export and Agent run requests. Missing or invalid → 400; viewer outside workspace → 404. No fallback to owner view.
_Avoid_: Auth session, JWT, implicit viewer

**MemoryRetriever**:
The local-first retrieval runtime for ProjectMemory. Tries SQLite FTS5 with jieba tokenization, falls back to structured field filtering, and returns candidate memory IDs (not prompt text). Fail-closed on errors: memory_backend becomes `none` and the Agent run continues.
_Avoid_: Vector database, embedding search, prompt builder

**MemoryContext**:
The viewer-visible, budget-truncated ProjectMemory text injected into Agent prompts. Built by FastAPI from candidate IDs; capped by token budget and hard memory count. Carries metadata: memory_backend, used_memory_ids, retrieval/injected counts, latency.
_Avoid_: Raw memory list, unlimited context, sidecar-built context

**memory_backend**:
Observable metadata recording which retrieval path served a run: `fts5`, `sqlite_field`, or `none`. Stored in AgentEvent output_snapshot, never in AgentRunState.side_effects.
_Avoid_: AgentRunState side effect, business state
