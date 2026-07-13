# Changelog

All notable changes to ProjectFlow are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- T45 private multi-conversation history: creator-owned private conversations, migrated team history, viewer-scoped list/create/read APIs, stable message cursor pagination, deterministic titles, URL-deep-linked selection, and streaming-safe Agent sidebar switching.
- T44 normalized usage evidence now records input/output/reasoning/cache-read/cache-write tokens, uncached input, detailed cost, requested model, resolved model and fallback reason without converting unavailable provider fields to zero.
- Prompt Kernel 2.0 and Context Ledger receipts separate stable rules from dynamic facts, gate time injection, preserve block versions/hashes, and keep the current request as the final dynamic block.
- T43 Agent Harness V2 P0: Outcome Contract, RunPlan/WorkState, token-aware context compaction, composable Skills V2, deterministic verifier, manifest-enforced Tool Executor V2, durable checkpoint/resume/steering, frontend run controls, run-scoped large-result pagination, trajectory export, public HTTP/SSE scenario evaluation and cross-model conformance canary.
- Identity boundaries for project creation and proposal confirmation now require a real member of the target workspace; the frontend fails closed when no active member identity is available.
- High-frequency model token and tool-progress deltas now remain live SSE events while final outputs and state boundaries stay durable, preventing per-token event/state double writes.
- DeepSeek V4 Flash/Pro production canary with frozen per-scenario latency gates, real token/cost telemetry, tool-evidence outcomes and actual workspace-ID/UUID privacy checks.

### Fixed

- Current user input is sent to Pi exactly once and excluded from recent history; ordinary conversation now honors the selected model and supported thinking level.
- Model configuration enforces exactly one valid default and rejects invalid explicit selections instead of silently attributing execution to a fallback.
- Skill V2 effect ceilings now use one strictest-ceiling policy across routing, Outcome Contract, prompt/trace metadata, manifest exposure and runtime invocation. Human-only, destructive and open-world tools remain unavailable.
- Assignment proposals now require explicit constraint-check evidence before persistence when either recommended member has stored free-text constraints. This is an evidence-completeness gate, not semantic validation.
- SQLite conversation migration preserves messages/run foreign keys while removing the former one-conversation-per-project uniqueness constraint.
- Skills V2 prerequisites now gate eligibility without adding intent score; Chinese release prompts route deterministically instead of selecting the first prerequisite-satisfied skills.
- Pi `message_end` usage and cost are extracted from the assistant message, so production canary telemetry no longer reports zero tokens or cost.
- Operational evaluation accepts one-of read evidence where state is already injected and checks real workspace IDs instead of treating normal `project_*` terms as raw-ID leaks.

- T42 ProjectMemory V1 remediation Batches A–D (R1–R6, R8): sidecar memory context injection, FTS5 project-scoped top-k, two-phase natural language retrieval (strict AND → relaxed OR), query normalization, 50-query stratified eval, memory observability via `agent.started` `_memory` payload, history memory display (active+superseded+archived), ProjectMemorySync status closure, streaming raw-ID sanitization, partial aggregate support, and a 5-scenario A/B eval harness with independent blind review.
- R8 release evidence: the initial 150-pair/300-call sidecar Pilot and selective S1/S2 remediation runs completed without model-call errors; combined evidence passes 7/7 gates. A narrow member-constraint assignment output guard (review, one repair, re-review, deterministic check, conservative fallback) raises the final selective S1 B-group evidence from 80% to 10/10 and reports guard status/calls in SSE evidence.

## [0.3.0] - 2026-07-08

### Multi-Model Multi-Provider Config & Switching

- ModelConfigStore: JSON file registry with validation, enrichment, CRUD, atomic persist
- DotEnvWriter: serial write queue for .env with key/value validation and atomic write
- FileWatcher: fs.watch with debounce, handles change and rename events, async onChange
- ModelRouter: registry-based resolution with provider:name fallback lookup
- Pi-runtime: dynamic provider imports, custom model support for openai-compatible
- Sidecar config API: GET/POST/PUT/DELETE /config/models, PUT .../api-key, POST /config/reload, GET /config/providers/:provider/models
- Frontend settings dialog with model config tab (add/edit/delete models, set API keys)
- Frontend agent sidebar model selector with localStorage persistence
- onRunAgent signature extended with model param through full prop chain
- Shared loadDotEnv function, reloadDotEnv callback for consistent .env reload
- API key safety: 512-char limit, protected env var guard, newline rejection, suffix masking
- Settings accessible from all views including project dashboard
- Default model configs: DeepSeek V4 Flash/Pro, MiMo V2.5, MiMo V2.5 CN

### Backend Cleanup

- Removed legacy `routes_agent.py` and `test_agent_endpoints.py`
- Refactored `agent_tools_service.py`
- Updated related tests

## [0.2.0] - 2026-07-07

### T42 ProjectMemory V1

- Implemented governed ProjectMemory backend/runtime slices for issues #71-#77: deterministic extraction, source hooks, visibility, retrieval, Agent context injection, evaluation harness, and optional vector guardrails.
- Stabilized ProjectMemory acceptance path in commit `03e7bda`; backend ruff passes and backend test baseline is 514 passed / 4 skipped.
- Added T42 closure review documenting the remaining V1 frontend memory list/export UI gap.

### T41 Agent Runtime Sidecar

- S3: Sidecar 骨架（HTTP server、config、health endpoint）
- S5: Read-only tools（get_project_state、get_workspace_state、timeline slice）路由至统一 internal contract
- S6: Stage Plan Proposal Tool
- S7: Advisory Risk/ActionCard Tool + advisory write tools（create_risk、create_checkin）
- S8: AssignmentProposalTool
- S9: Check-in/replan migration（checkin task updates 走 replan proposals）
- S10: Event bridge + trace envelope + debug payload store
- S11: Frontend integration（advisory write tools + frontend test fixes）
- S12: Legacy Coordinator parity + cutover safety net
- S13: Direction Card + Task Breakdown Proposal Tools
- S14: Skills 系统（6 SKILL.md 文件）
- S15: Unit/Eval/Privacy 测试（559 agent-bridge tests）
- S16: Debug 模式

### Fixed

- Agent 失败事件与完成事件不再共存于同一 run（event-mapper 修正 stopReason 映射）
- Tool result metadata 在 runtime 循环中正确保留
- Advisory write tools 安全加固（harden after review）
- 阻止重复 pending replan proposals
- 移除 unsafe as-any casts，添加 typed WorkspaceState
- S5 read-only tools 路由至统一 internal contract
- S10 audit patch：agent.failed event、run.state_changed auto-gen、state transition validation、ToolManifest alignment

### Docs

- 同步 S5/S9/S10/S12/S13/S15 完成状态至 CLAUDE.md、handoff、code-wiki
- T41 文档对齐 + 参考表

## [0.1.0] - 2026-06-08

### Added

- MVP 闭环跑通（Phase 0-41）
- Next.js 前端 + FastAPI 后端 + SQLite 数据库
- 状态机驱动 Agent 工作流
- 项目仪表盘三栏布局
- Agent sidebar UI
- 安全加固 + 性能优化 + 前端体验打磨
