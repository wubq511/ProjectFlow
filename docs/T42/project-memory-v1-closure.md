# T42 ProjectMemory V1 Closure Review

Status: R8 selective remediation Pilot passed 7/7 gates as of 2026-07-11.

## Summary

GitHub issues #71-#80 established the merged V1 base. This remediation branch completes R1-R6 and R8, including the final selective Pilot evidence and output sanitization.

The completed implementation covers the ProjectMemory V1 backend/runtime and frontend path:

- Governed `ProjectMemory` and `ProjectMemorySync` persistence.
- Deterministic extractor with no LLM calls.
- Source hooks for direction-card confirmation, proposal rejection with reason, assignment finalization, replan confirmation, and replan rejection with reason.
- Source-level idempotency, supersede behavior, lifecycle/status filtering, explicit viewer identity, and `subject_and_owner` privacy.
- JSON memory list and Markdown export API with `Cache-Control: no-store`.
- Default FTS5+jieba retrieval with SQLite field fallback and `none` fallback.
- FTS5 retrieval uses project-scoped JOIN to prevent cross-project contamination in top-k results.
- Two-phase FTS5 retrieval (strict AND → relaxed OR → merge with token coverage) for natural language query robustness (R4).
- Query normalization with Chinese/ASCII stop words, auditable domain aliases, and token coverage scoring.
- 50-query stratified evaluation harness covering 8 query slices (exact keyword, paraphrase, short/elliptical, typo/noisy, mixed Chinese/English, conflict/lifecycle, project distractor, privacy negative).
- Agent context injection through FastAPI-built context; sidecar receives `memory_context` via `WireRunStartResponse` and injects into model prompt via `<project_memory_context>` XML tag. Real route tests cover both `/runs` and `/runs/stream` through the `executeRun` boundary.
- Sidecar `agent.started` event payload includes `_memory` metadata (backend, used_memory_ids, retrieval_count, injected_count, latency_ms) for runtime observability (R2).
- Debug payload store records memory text (redacted by default; full text only with `includeSensitiveData`).
- Retrieval evaluation harness and optional `memory-vector` extra with default-install guardrails.
- Frontend `ProjectMemoryPanel` with topic-grouped read-only list, loading/error/empty states, and Markdown export/copy/download using the current viewer identity.

## Verification Evidence

Latest local verification (formal Pilot remediation, 2026-07-11):

- Backend tests: 641 passed, 4 skipped.
- Agent bridge tests: 558 passed across 20 files.
- Frontend tests: 57 passed across 10 files.
- Agent bridge typecheck/build: passed.
- Backend Ruff: passed.
- Frontend lint/build: passed.
- 50-query FTS5 eval: Recall@10 100%, Recall@3 100%, MRR@10 0.97, bad-first rate 2%, fixture max latency 10.60 ms.
- R8 A/B eval harness: 103 targeted tests passed, including runtime evidence validation, aggregate → blind review → reviewed release workflow, terminal-decision checks, raw-ID gate, and report regressions.
- R8 formal Pilot: initial 300-call / 150-pair sidecar run completed with 0 errors and 300/300 runtime evidence records. The selective remediation Pilot then reran S1/S2 plus a reduced S1 hard-constraint slice: S2 rejection reduction reached 100%, S1 compliance lift remained +80pp, and raw-ID leakage was 0/140 post-fix calls. Combined per-Gate evidence now passes 7/7. See `project-memory-v1-ab-pilot-report.md` and `project-memory-v1-ab-selective-rerun-report.md`.

## GitHub Issue Status

| Issue | Status | Scope |
|---|---|---|
| #71 | Closed | Direction card first tracer bullet |
| #72 | Closed | Proposal rejection memory and reason capture |
| #73 | Closed | Assignment memory with subject-and-owner privacy |
| #74 | Closed | Replan memory tracer |
| #75 | Closed | Default retrieval and Agent context injection |
| #76 | Closed | Retrieval evaluation harness |
| #77 | Closed | Optional vector extra and dependency guardrails |
| #80 | Closed | Frontend read-only memory list and Markdown export UI |

## PRD Coverage

Implemented:

- V1 Memory Source Events listed in the PRD are covered on the intended paths.
- Deterministic extraction, source-level idempotency, visibility, read/export consistency, retrieval, Agent injection, evaluation harness, and optional vector guardrails are implemented.
- Proposal rejection requires a non-empty reason to become memory.
- Ordinary chat and Agent intermediate reasoning do not become ProjectMemory.
- Frontend read-only memory list and Markdown export UI (issue #80) is implemented using the existing backend endpoints and current viewer identity.

Remaining V1 closure gaps (remediation plan `project-memory-v1-remediation-plan.md`):

1. ~~**R1 — sidecar memory context 断链**~~：**已修复（Batch A）**。`WireRunStartResponse.memory_context` → start-run route → `RunInput.memoryContext` → `ContextBuildInput.memoryContext` → `<project_memory_context>` XML 注入。
2. ~~**R3 — FTS 跨项目挤占**~~：**已修复（Batch A）**。FTS5 SQL JOIN `project_memories` + `project_id`/`status` 前置过滤。
3. ~~**R4 — 自然语言检索鲁棒性**~~：**已修复（Batch B）**。两阶段检索（strict AND → relaxed OR → merge + token coverage）+ 查询规范化 + 中文停用词 + 可审计领域同义归一 + 50 条分层评测（8 slice）；primary gold labels 保持独立，没有通过扩大答案集合规避 bad-first gate。
4. ~~**R2 — T41 memory observability**~~：**已修复（Batch B）**。`agent.started` 事件 payload 含 `_memory` metadata；debug payload store 可存全文（默认 redacted）；`side_effects` 不含 memory 字段。
5. ~~**R5 — 历史记忆展示**~~：**已修复（Batch C）**。JSON/Markdown 展示允许 active + superseded + archived（AD-3 展示语义）；Agent 注入仅 active + 未过期；两者复用同一 `can_view_memory` 授权谓词；私有历史记忆仍只对 subject/owner 可见。
6. ~~**R6 — ProjectMemorySync 状态闭环**~~：**已修复（Batch C）**。FTS 索引成功 → `synced` + `backend_memory_id` + `last_synced_at`；FTS 不可用、真实 INSERT 失败或 supersede DELETE 失败 → `failed` + 仅含错误类型的安全文本；日志不记录异常正文；业务提交不因索引失败回滚。
7. **R7 — optional vector 完整化**：只有依赖护栏和底层组件，没有生产索引与 Agent 使用闭环。vector scaffold/guardrails 已实现，end-to-end 未完成。
8. ~~**R8 — Agent 效果评估**~~：**已完成**。初始 150 paired / 300-call 正式 Pilot 后，按失败项选择性复验 S1/S2。S2 重复拒绝率由 A 80% 降至 B 0%；S1 维持 +80pp lift；修复后 140/140 正式调用无 raw-ID 泄露。结合未受影响的旧 S3-S5 证据，7/7 Gate 通过。S1 B 组绝对服从率稳定为 80%，记录为模型残余风险。

Accepted V1 limitation:

- The alternate replan path through `/api/replans/confirm` does not produce ProjectMemory. As of 2026-07-11, the frontend does not use that endpoint. This remains documented as a T41/V1.1 alignment item.

## Recommended Next Issue

R8 无需继续重复调用。后续若更换模型或调整 memory prompt，应把 S1 B 组 80% 绝对服从率作为回归基线。R7（optional vector V1.1）仍是需要数据库 schema 变更审批的独立项目。

## Product Smoke Checklist

Before closing T42 V1:

- Confirming a direction card creates direction/boundary memories.
- Rejecting an Agent proposal requires a reason and creates a rejection memory.
- Finalizing assignment creates assignment memory and only exposes `subject_and_owner` constraints to the subject and owner snapshot.
- Confirming/rejecting replan through the AgentProposal path creates plan/tradeoff/boundary/rejection memory as applicable.
- Ordinary chat does not create ProjectMemory.
- JSON memory list, Markdown export, and Agent context must reuse the same authorization predicate; JSON/Markdown return active + superseded + archived (AD-3 display); Agent context additionally filters by active status, expiry, and retrieval eligibility.
- Missing `viewer_user_id` returns 400; non-member viewer returns 404.
- AgentEvent output metadata records memory usage/backend/IDs/latency; AgentRunState side effects do not record memory usage.
- Sidecar model prompt contains `<project_memory_context>` with FastAPI-built memory text.
- FTS5 retrieval does not return memories from other projects in top-k results.
- `agent.started` event payload contains `_memory` metadata with backend, used_memory_ids, and latency.
- Two-phase FTS5 retrieval (strict AND → relaxed OR) handles natural language queries.
- 50-query stratified eval covers 8 slices; paraphrase Recall@10 ≥ 80%; overall Recall@3 ≥ 80%; MRR ≥ 0.75; bad-first rate ≤ 2%.
- Superseded/archived memories are visible in JSON list and Markdown export; Agent retrieval only returns active memories.
- FTS5 sync status is `synced` after successful indexing; unavailable/write/delete failures become `failed` with content-free error text; business commits are not blocked by index failures.
- R8 harness covers 5 scenarios and 7 gates；Mock/Direct 不具备隐私 release 资格；最终 sidecar Pilot 使用专用项目、FastAPI viewer 裁决和独立盲化人工复核。

## Worktree Cleanup Candidates

All historical T42 worktrees have been cleaned up (2026-07-07). No registered worktrees remain.
