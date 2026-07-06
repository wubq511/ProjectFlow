---
name: project-memory-v1
description: Governed project memory for ProjectFlow decisions, retrieval, visibility, and Agent context injection
status: acceptance
created: 2026-07-06T09:29:56Z
updated: 2026-07-07
---

# PRD: project-memory-v1

## Implementation Status

Issues #71-#77 are closed and merged to `main` as of 2026-07-07, with latest stabilization commit `03e7bda`. This completes the backend/runtime/evaluation/vector-guardrail implementation slices:

- Data model, deterministic extractor, source hooks, idempotent writes, supersede behavior, and visibility governance.
- Direction-card, proposal rejection, assignment, and replan memory source events.
- JSON memory list, Markdown export API, default FTS5+jieba retrieval, Agent context injection, and observability metadata.
- Retrieval evaluation harness and optional `memory-vector` dependency guardrails.

The PRD is still in acceptance, not complete. The remaining V1 closure gap is the project-page read-only ProjectMemory list/export UI, now tracked as GitHub issue #80: backend JSON and Markdown endpoints exist, but the frontend has no memory list/export entry point yet. The known replan path (b) gap through `/api/replans/confirm` remains an accepted V1 limitation documented in the design.

## Problem Statement

ProjectFlow already helps users make project decisions through direction cards, proposal confirmations, assignments, replans, and Agent runs. The problem is that those decisions do not yet become durable, governed context. After a project moves forward, the Agent can forget why a direction was chosen, why a proposal was rejected, what constraints shaped a team assignment, or what tradeoff caused a replan.

From the user's perspective, this creates repeat work and unstable Agent judgment. The user has to restate prior decisions, inspect old project history manually, and worry that the Agent may make recommendations that ignore settled context. The system also lacks a white-box way to inspect which past decisions are being used as memory.

The product needs a ProjectMemory capability that preserves important project decisions without turning ordinary chat into long-term memory, without making the sidecar read the database, without leaking private member constraints, and without adding heavy default dependencies.

## Solution

Build ProjectMemory V1 as a governed context layer owned by ProjectFlow. ProjectMemory records are derived only from approved Memory Source Events, stored in ProjectFlow's own SQLite-backed data model, indexed for local retrieval, filtered by lifecycle and visibility, and injected into Agent context only when visible to the current viewer.

V1 will be deterministic and local-first:

- Memory extraction is deterministic and does not call an LLM.
- Default retrieval uses SQLite FTS5, jieba tokenization, and structured field filtering.
- Optional vector retrieval is available only through an explicit memory-vector extra.
- Markdown export and a read-only memory list make the memory layer inspectable.
- Agent context injection reuses the same visibility rules as the memory UI and Markdown export.

ProjectMemory is not Primary Project State. It is a governed context record derived from business decision points and used to inform future Agent judgment.

## User Stories

1. As a project owner, I want confirmed direction-card decisions to become durable project memory, so that future Agent suggestions respect the chosen project direction.
2. As a project owner, I want MVP and scope boundaries from a direction card to be remembered, so that the Agent does not repeatedly suggest work outside the agreed scope.
3. As a project owner, I want rejected proposals with explicit reasons to be remembered, so that future suggestions do not repeat rejected ideas without acknowledging the reason.
4. As a project owner, I want proposal rejection to require a reason before it becomes memory, so that accidental or unexplained rejection clicks do not pollute long-term context.
5. As a project owner, I want finalized assignment decisions to be remembered, so that the Agent understands the team's agreed resource allocation.
6. As a team member, I want my reusable availability or preference constraints from assignments to be remembered only when explicitly captured, so that the Agent can plan around them without inventing constraints.
7. As a team member, I want private member constraints to be visible only to me and the responsible owner, so that project memory does not leak sensitive working constraints to the full team.
8. As a project owner, I want replan confirmations to become memory, so that the Agent understands current plan changes and their rationale.
9. As a project owner, I want replan rejections with clear reasons to become memory, so that future replans avoid known dead ends.
10. As a user, I want ordinary chat and one-off questions to never become long-term project memory, so that casual conversation does not distort future Agent judgment.
11. As a user, I want Agent intermediate reasoning to never become project memory, so that only formal project decisions influence future context.
12. As a user, I want every memory to have a source type and source id, so that I can trace where the memory came from.
13. As a user, I want every memory to have a rationale, so that I can understand why the system considers the memory relevant.
14. As a user, I want old memories to be superseded rather than deleted, so that project history remains auditable.
15. As a user, I want expired or superseded memories to stop influencing Agent output, so that stale context does not steer new work.
16. As a user, I want ProjectMemory to avoid raw internal IDs in visible text, so that memory output remains readable and safe.
17. As a user, I want memory list, Markdown export, and Agent context to show the same visible memory set, so that there is no hidden memory path.
18. As a user, I want to export visible project memory as Markdown, so that I can audit and share the project's decision context.
19. As a user, I want the memory page to be read-only in V1, so that governed memory is changed only by formal project decisions.
20. As a local demo user, I want to pass an explicit viewer identity when viewing or using memory, so that ProjectFlow can evaluate visibility consistently before real authentication exists.
21. As a local demo user, I want missing or invalid viewer identity to fail clearly, so that the system never silently falls back to the owner view.
22. As a workspace member, I want project memory to be unavailable outside my workspace/project scope, so that cross-project leakage is blocked.
23. As an Agent user, I want the Agent to receive only relevant active memories within a token budget, so that output improves without flooding the prompt.
24. As an Agent user, I want Agent runs to record whether memory was used and which backend served retrieval, so that memory behavior is observable.
25. As an Agent user, I want retrieval failure to degrade gracefully, so that formal project workflows are not blocked by indexing or search problems.
26. As a developer, I want MemoryExtractor to be deterministic, so that the same source event produces stable content and rationale.
27. As a developer, I want MemoryExtractor to work the same with mock, missing, or real LLM providers, so that memory writing is independent of provider setup.
28. As a developer, I want source hashes to depend only on stable source event fields, so that template changes do not corrupt idempotency.
29. As a developer, I want source-level idempotency in V1, so that each source event and memory type has at most one memory record.
30. As a developer, I want multiple same-type subitems to be aggregated or skipped, so that V1 does not need premature item-key complexity.
31. As a developer, I want idempotent writes to skip unchanged events, so that repeated hooks do not duplicate memory.
32. As a developer, I want changed source content to supersede prior memory, so that corrected project decisions are reflected without deleting history.
33. As a developer, I want ProjectMemory indexing to be best effort, so that memory extraction failure does not roll back the business decision.
34. As a developer, I want default setup to avoid torch, sentence-transformers, model downloads, and external services, so that ProjectFlow remains easy to run locally.
35. As a developer, I want optional vector retrieval isolated behind an explicit extra, so that semantic retrieval can improve quality without becoming a default dependency.
36. As a developer, I want a warmup command that is safe without vector dependencies, so that default installs do not fail on missing optional retrieval.
37. As a developer, I want the sidecar to never read the database for memory, so that T41 runtime boundaries remain intact.
38. As a developer, I want Agent context assembly to happen through the FastAPI context builder, so that memory visibility and filtering stay in the source-of-truth service.
39. As a reviewer, I want a minimum retrieval evaluation harness, so that recall and latency regressions are measurable.
40. As a reviewer, I want acceptance tests for visibility, idempotency, deterministic extraction, and no raw IDs, so that the system's safety boundaries are protected.
41. As a product maintainer, I want V1.1 extensions clearly separated from V1, so that ProjectMemory ships with a stable small surface before adding graph, item keys, or LLM extraction.

## Implementation Decisions

- Introduce ProjectMemory as a Governed Context Record derived from Memory Source Events, not as Primary Project State.
- Add a ProjectMemory governance model and a ProjectMemorySync model. The governance model owns lifecycle, source, visibility, scope, rationale, and source hash. The sync model tracks indexing status per backend.
- V1 Memory Source Events are limited to direction-card confirmation, proposal rejection with non-empty rejection reason, assignment finalization, replan confirmation, and replan rejection with clear reason.
- The source id always points to the proposal object that produced the formal decision. Assignment finalization uses the assignment proposal object. Proposal rejection does not require or create an AgentEvent row.
- V1 hooks extraction after the business decision commits. Extraction runs synchronously inside the FastAPI service boundary, uses a fresh session, catches exceptions, and never rolls back the business decision.
- MemoryExtractor V1 is deterministic. It reads schema-validated event payloads plus display fields, generates Chinese user-visible text through fixed templates, and never calls an LLM.
- Deterministic extraction writes conclusion in content and explicit source fields in rationale. It does not infer hidden causality or fill missing facts.
- All user-visible memory text must use display names, titles, Chinese enum labels, or safe placeholders. Raw user, task, stage, project, or internal IDs are allowed only in structural fields.
- V1 uses source-level idempotency. The unique write identity is project, source type, source id, memory type, and source hash. A single source event may create multiple memory types but at most one record per memory type.
- Multiple same-type subitems in one source event must be canonically sorted and aggregated into one memory when safe. If aggregation would break visibility, scope, subject, or related entity semantics, that memory type is skipped.
- V1 does not introduce source_item_key or memory_key. If future events require multiple same-type memories from one source, V1.1 will add source_item_key through an expand-contract migration.
- Idempotent replay with the same source hash skips writing. Changed content for the same source and memory type creates a new memory and marks the old active memory superseded.
- ProjectMemory has active, superseded, and archived states. V1 writes active and superseded only. Archived is reserved for a later lifecycle flow.
- V1 visibility has two modes: team and subject_and_owner. owner_only is deferred.
- subject_and_owner memories must have both subject user and owner snapshot. Missing subject or owner information fails closed and must not downgrade to team.
- Owner snapshot is resolved at write time so future project, stage, or task owner changes do not silently change historical memory visibility.
- Viewer Identity Context is explicit in V1. Memory list, Markdown export, and Agent run creation require viewer_user_id. Missing or malformed viewer_user_id returns a bad request response. Viewer outside the project workspace returns not found.
- Memory list, Markdown export, and Agent context injection reuse the same can-view-memory logic and must produce consistent visible memory sets.
- Memory list and Markdown export responses are no-store to avoid local viewer switching cache leaks.
- Default retrieval uses SQLite FTS5 with jieba pre-tokenization and structured field filtering. It must work in the normal development install.
- Optional vector retrieval uses sqlite-vec and local embeddings only when the memory-vector extra is installed and ready. Missing vector dependencies, failed sqlite-vec load, or missing model must fall back to default FTS5 behavior.
- The warmup command skips successfully when vector retrieval is not installed. It pre-downloads and warms models only when the optional vector extra is installed.
- Retrieval returns candidate memory ids only. Candidates are always reloaded from ProjectMemory and filtered by project, status, visibility, expiration, and score before Agent injection.
- Agent context injection is capped by token budget and hard item count. V1 target is 1500 tokens and at most 8 memories.
- Agent observability records memory usage, backend, used memory ids, retrieval count, injected count, and latency in AgentEvent output metadata. Memory usage does not enter AgentRunState side effects.
- The T41 sidecar remains database-free. It receives memory only through context built by FastAPI.
- Frontend proposal rejection must collect and submit a non-empty reason when the rejection should become durable memory.
- The project UI provides a read-only ProjectMemory list and Markdown export for the current viewer.
- V1 keeps known replan path coverage limited to the AgentProposal confirm path. The alternate replan confirm API path remains a known T41/V1.1 alignment item.

## Testing Decisions

- The primary test seam is the backend service/API integration layer. Tests should exercise observable behavior from Memory Source Event through ProjectMemory persistence, retrieval, visibility filtering, Markdown export, and Agent context injection.
- Tests should avoid asserting private implementation details such as internal helper call order or exact tokenizer internals. They should assert externally meaningful outcomes: written records, skipped records, superseded status, visible memory sets, API responses, and Agent context shape.
- Existing proposal confirmation, assignment flow, replan proposal, Agent runtime API, endpoint, and request validation tests are the closest prior art. New tests should follow those patterns.
- Deterministic extractor tests should assert stable content and rationale for the same source event and extractor version, no LLM dependency, no raw IDs in user-visible fields, and validation skipped for incomplete required fields.
- Idempotency tests should assert unchanged replay skips writing, changed source event supersedes prior active memory, and same source event plus same memory type never writes multiple active memories.
- Source-level aggregation tests should cover direction-card multiple boundaries, replan multiple adjustments, and assignment multi-member constraints. Safe public aggregation should produce one memory; unsafe private/member aggregation should skip the member constraint memory.
- Visibility tests should cover team visibility, subject_and_owner visibility, missing subject or owner fail-closed behavior, explicit viewer_user_id requirements, and consistency across JSON list, Markdown export, and Agent context.
- Retrieval tests should cover default FTS5 search, field-filter fallback, candidate SQLite recheck, inactive and expired filtering, project mismatch filtering, and no direct injection from the index backend.
- Optional vector tests should run only in an explicit vector-enabled environment. Default CI must not require torch, sentence-transformers, sqlite-vec, or downloaded embedding models.
- Frontend tests should cover rejection reason collection and the memory list/export flow from the current viewer's perspective.
- The minimum retrieval evaluation harness should use fixed Chinese project-memory fixtures and queries, targeting default FTS5 recall@10 of at least 90%, latency under 500ms, and low irrelevant-memory inclusion.

## Out of Scope

- LLM-based memory extraction and any optional LLM extractor write switch.
- Automatic capture of ordinary chat, one-off Q&A, button feedback, or Agent intermediate reasoning.
- Manual creation, editing, deletion, or archiving of ProjectMemory by users.
- LongTermMemoryNode, LongTermMemoryEdge, graph editing, Graphiti, Zep, or other graph memory systems.
- Independent ShortTermMemory tables.
- source_item_key or memory_key in V1.
- Real authentication, sessions, or security credentials. V1 uses explicit Viewer Identity Context only.
- owner_only visibility.
- Cross-project UserMemory.
- Reranker, cross-encoder ranking, LLM reranking, and agentic retrieval tools.
- Time decay scoring beyond valid_until and superseded filtering.
- ProjectMemory rebuild jobs.
- Full coverage of the alternate replan confirm path.
- Mem0, Qdrant, external vector databases, or external memory services in V1.
- Database deletion or cleanup flows for old memory.

## Further Notes

The canonical design direction has already been settled through the T42 project-memory design review. The most important implementation risk is scope creep: V1 should remain a deterministic, governed, local-first memory layer rather than a general memory framework.

The recommended delivery order is:

1. Data model and deterministic extractor contract.
2. Source event hooks and idempotent write path.
3. Visibility and Viewer Identity Context.
4. Default FTS5 retrieval and Agent context injection.
5. Memory list and Markdown export.
6. Evaluation harness and frontend rejection reason flow.
7. Optional vector extra only after default retrieval is stable.

The PRD should be converted into a technical epic before implementation so the work can be split across backend model/write path, retrieval/context, API/frontend, and evaluation tasks without violating the shared boundaries.
