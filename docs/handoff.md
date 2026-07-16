# ProjectFlow Handoff

Status: current as of 2026-07-16.

## Latest Architecture Handoff

### 2026-07-16 — Demo Seed Data V2 Overhaul, Conversation Folding, Chat Message Collapsing

Implemented on `feature/handoff-member-a-ts-runtime` branch. Full seed rewrite in `backend/app/seed/demo_projectflow.py` (1456 lines) and frontend UX for conversation/message folding in `agent-sidebar.tsx` and `ChatMessage.tsx`.

**Seed data V2 changes:**

- **Expanded entities**: 11 tasks (was 10, added agent_architecture), 8 AgentEvents (was 5, added negotiate + scope_rejected + replan), 7 ProjectMemories (was 3, covering all 7 V1 memory_type values including subject_and_owner privacy boundary), 5 AgentProposals (was 0, 4 confirmed + 1 rejected), 3 AgentConversations with 18 messages (was 0), 1 AssignmentNegotiation (was 0), 12 TaskStatusUpdates (was 0), 3 AssignmentResponses (was 0), 6 check-ins spread across 3 dates (was 6 all same date).
- **Timeline aligned to real development**: 4 stages (05-28→06-07 research, 06-08→07-04 design with T41 ADR, 07-05→07-14 implementation with T41-T45 slices, 07-15→07-17 testing). 16 timeline anchors with distinct UTC datetimes, no `created_at=now()` for historical entities.
- **De-paneling**: direction_card suggestions/questions/decision_points/unknowns no longer reference defense/presentation context. Risk evidence updated to match due dates (backend_api overdue 4→6 days consistently). memory rationale rewritten from "评审关注/答辩前" to development-focused language.
- **Memory indexing**: 7 seeds get FTS5-indexed with ProjectMemorySync records (best-effort, same semantics as memory_service._persist_candidates).
- **Frontend conversation UX**: Conversation history Sheet now groups by month with collapsible sections (`ConversationGroupList` with `ChevronDown` toggle). Chat messages default-collapse older history (last 2 messages visible, "展开历史消息 · N 条" toggle bar). `displayContent` threshold raised from 50→2000 chars so seed conversation messages display in full.

**Key files:**

- `backend/app/seed/demo_projectflow.py` — complete rewrite (1456 lines)
- `backend/app/seed/reset.py` — no changes (already covered all SQLModel tables)
- `backend/app/seed/demo_blocker_scenario.py` — narrative sync
- `backend/app/tests/test_seed_reset_export.py` — assertion counts updated
- `backend/app/tests/test_replan_proposal_flow.py` — fixed 1 pre-existing test (Chinese status label)
- `frontend/src/components/project/agent-sidebar.tsx` — `ConversationGroupList` component + collapsible older messages
- `frontend/src/components/project/agent/ChatMessage.tsx` — `displayContent` threshold 50→2000
- `docs/demo-script.md` — 11-step flow with conversation/memory privacy steps

**Verification:** backend seed tests 31/31 pass; backend ruff pass; frontend 191 passed (18 files), lint pass, build pass.

### 2026-07-15 — Debounced View Navigation to Eliminate RSC Flight Cancellation Noise

Implemented debounce fix for rapid sidebar view switching.

**Problem:**

- Rapidly clicking different views in the project sidebar triggered multiple consecutive `router.replace(...)` calls.
- Next.js App Router cancels in-flight RSC flight requests when a newer navigation starts, producing `net::ERR_ABORTED` console errors.
- These errors are browser-normal cancellation noise, not application bugs, but they clutter the console and degrade perceived quality.

**Fix:**

- Added a generic typed `useDebouncedCallback` hook in `frontend/src/lib/useDebouncedCallback.ts` (with `frontend/src/lib/useDebouncedCallback.test.ts` unit tests).
- Applied a 60ms debounce to `handleNavigateView` in `frontend/src/app/workspaces/[workspaceId]/page.tsx`.
- Consecutive rapid clicks are coalesced into a single `router.replace` call with the latest selected view.

**Key files:**

- `frontend/src/lib/useDebouncedCallback.ts`
- `frontend/src/lib/useDebouncedCallback.test.ts`
- `frontend/src/app/workspaces/[workspaceId]/page.tsx`

**Verification:** Rapid view switching no longer produces `net::ERR_ABORTED`; frontend tests pass (196).

### 2026-07-15 — Workspace UI/UX Polish, Accessibility Contrast, Nested Cards Removal and Framer Motion Transitions

Implemented in commit `768ae89` (with visual upgrades in follow-up).

**Frontend UX & Accessibility Polish:**

- **Contrast enhancement**: Darkened the `--color-text-tertiary-token` / `text-tertiary` from `#8896a6` to `#5f7188` to meet the 4.5:1 WCAG 2.1 AA contrast ratio standard on light backgrounds.
- **Speech bubbles upgrade**: Re-styled chat message bubbles inside `ChatMessage` to use asymmetric rounded corners (`rounded-2xl rounded-tr-none border-neutral-200/80 bg-white` for user, `rounded-tl-none border-neutral-100 bg-neutral-50/60` for agent) with an ambient drop shadow, elevating the AI chat feel.
- **Sliding navigation active background**: Enabled spring-loaded sliding background pills for sidebar menu items inside `ProjectSidebar` via Framer Motion's `layoutId="activeNavBackground"`, providing smooth physical feedback when changing views.
- **Hover elevation transitions**: Added border color and drop-shadow hover transition effects to metric stat panels (`CompactStat`), Next Action banner, and primary card blocks, providing immediate responsiveness to cursor hover events.
- **Typography cleanup**: Removed the vestigial AI-generated `uppercase` class from Chinese section headers and subheaders inside `direction-decision-view.tsx`, `replan-diff.tsx`, `agent-proposal-panel.tsx`, `action-card.tsx`, and `export-panel.tsx` to align letter casing with standard Chinese typography conventions.
- **Nested cards elimination**: Cleared nested card container anti-patterns by refactoring projects lists (`workspace-content.tsx`), resource items (`project-resources-panel.tsx`), project memories list (`project-memory-panel.tsx`), and timeline events (`timeline.tsx`) into clean flat list rows separated by subtle dividers, complying with `DESIGN.md` guidelines.

**Key files:**

- `frontend/src/styles/globals.css`
- `frontend/tailwind.config.ts`
- `frontend/src/components/ui/compact-stat.tsx`
- `frontend/src/components/project/project-content.tsx`
- `frontend/src/components/project/project-sidebar.tsx`
- `frontend/src/components/project/workspace-content.tsx`
- `frontend/src/components/project/project-resources-panel.tsx`
- `frontend/src/components/project/project-memory-panel.tsx`
- `frontend/src/components/agent/timeline.tsx`
- `frontend/src/components/project/agent/ChatMessage.tsx`
- `frontend/src/components/risk/replan-diff.tsx`
- `frontend/src/components/agent/agent-proposal-panel.tsx`
- `frontend/src/components/agent/action-card.tsx`
- `frontend/src/components/agent/export-panel.tsx`
- `frontend/src/components/agent/direction-decision-view.tsx`
- `frontend/src/components/task/task-breakdown-board.tsx`

**Verification:** Frontend Vitest unit tests (191 passed) and production compiler build (`npm run build`) completed successfully.

### 2026-07-14 — Settings Relocation, AgentSidebar Cleanup, Settings UI Polish, Slash Command Chips, and Composer Steering

Implemented in commit `20e4ea2`.

**Frontend UX:**

- **Settings entry moved to left sidebar footer**: The settings gear icon was removed from the top-right of the project dashboard and added to the bottom of `ProjectSidebar`. It dispatches a `projectflow:open-settings` custom event, which `app-shell.tsx` listens for to open `SettingsDialog`.
- **SettingsDialog tabbed navigation**: The settings dialog now has two tabs — “模型配置” (model config) and “系统” (system). The “系统” tab hosts the relocated “重置演示数据” action.
- **Model config UI polish**: `ModelConfigTab` now shows status tags (默认 / 无效), an API key setting area per model, and an actions dropdown menu (MoreHorizontal) for edit/delete. Layout is responsive across screen sizes.
- **Recent Activity panel removed**: The bottom-right “最近活动” section was removed from `AgentSidebar`, decluttering the right panel.
- **Reset demo moved to Settings > 系统**: The reset flow now uses a cross-component `projectflow:reset-demo` custom event. The workspace page listens for it and calls `resetDemo()`, then reloads or navigates to the seeded project.

**Agent Composer / Runtime:**

- **Slash command selected-state highlight chip**: `SlashCommandChip` renders the selected slash command as a compact chip inside `ChatComposer`. The chip is one-click removable, and the message bubble mirrors the composer appearance when no extra text is present.
- **Composer / steering merge**: The separate constraint input box was merged into the main chat composer. `ChatComposer` handles slash-command hinting, chip rendering, and loop-boundary steering consumption. `project-actions.ts` centralizes `getLeadingSlashCommand` and slash-command metadata, eliminating duplication with `ALL_AGENT_ACTIONS`.
- **Steering poller and mid-stream abort scaffolding**: `agent-bridge/src/runtime/steering-poller.ts` was added to poll for steering inputs at loop boundaries. Mid-stream abort wiring was added to `pi-runtime.ts`, `cancel-run.ts`, and related routes/schemas. The frontend exposes steering history via `SteeringHistory`.

**Key files:**

- `frontend/src/components/settings/settings-dialog.tsx`
- `frontend/src/components/settings/model-config-tab.tsx`
- `frontend/src/components/project/project-sidebar.tsx`
- `frontend/src/components/app-shell.tsx`
- `frontend/src/components/project/agent-sidebar.tsx`
- `frontend/src/app/workspaces/[workspaceId]/page.tsx`
- `frontend/src/components/project/agent/ChatComposer.tsx`
- `frontend/src/components/project/agent/ChatMessage.tsx`
- `frontend/src/components/project/agent/SlashCommandChip.tsx`
- `frontend/src/components/project/agent/SlashCommandMenu.tsx`
- `frontend/src/components/project/agent/SteeringHistory.tsx`
- `frontend/src/components/project/project-actions.ts`
- `agent-bridge/src/runtime/steering-poller.ts`
- `agent-bridge/src/runtime/pi-runtime.ts`
- `agent-bridge/src/server/routes/cancel-run.ts`
- `backend/app/schemas/agent_conversation.py`
- `backend/app/services/agent_conversation_service.py`
- `backend/app/services/agent_runtime_service.py`

**Verification:** frontend lint/build/test pass; agent-bridge typecheck/build/test pass; backend ruff/pytest pass. See runbook for latest baseline.

### T44/T45 — Agent Efficiency, Model Integrity and Private Conversation History (2026-07-13)

T44 and T45 are implemented in bounded commits `e8bd6e0`, `22b7977`, `6027885`, `435f489`, `70bcb99` and `6ae1831`. Post-implementation canary hardening and evidence are in `38ffba0`, `299c6b9`, `bbb4359`, `bf5ebab`, `1d12236` and `e47d6b4`.

- Current user input enters Pi exactly once and is excluded from recent history. Usage evidence distinguishes input/output/reasoning/cache-read/cache-write tokens, uncached input and detailed cost; unavailable provider fields remain unknown rather than zero.
- Model configuration has exactly one valid default. Normal conversation propagates explicit model/thinking selection, invalid explicit models fail, and requested/resolved attribution plus fallback reason remain separate.
- Prompt Kernel 2.0 keeps stable rules before dynamic facts, gates time injection, records versioned Context receipts and hashes the assembled system/user/tool payload.
- Skill V2 metadata is the single ceiling authority. The strictest ceiling is preserved through routing, Outcome Contract, prompt/trace evidence, manifest exposure, runtime policy and verification. Read-only concurrency remains; all writes remain sequential.
- Assignment persistence now requires non-empty constraint-check evidence when the recommended or backup member has stored free-text constraints. This is an evidence-completeness gate only; semantic compliance requires a future structured constraint model.
- Projects support multiple Agent conversations. New conversations are creator-owned/private; legacy rows migrate to team history without breaking message/run foreign keys. All routes validate viewer access, GET is non-mutating, summaries are lightweight, and messages use stable cursor pagination.
- The Agent sidebar provides local draft/new conversation, history Sheet, private/team labels, URL selection and older-message loading. Conversation changes are locked while streaming. Team conversations receive team-visible ProjectMemory only.

Verification: backend 825 passed / 4 skipped plus Ruff; agent bridge 1142 passed across 58 files plus typecheck/build; frontend 147 passed across 17 files plus lint/build.

Repeated post-T44 production evidence is complete: 15 isolated observations per model passed routing, outcome, privacy and frozen per-scenario latency gates. Flash/Pro cache hit was 93.01%/93.51%; mean non-cached input per observation fell 85.2%/77.2%, and measured cost per observation fell 68.5%/58.8% relative to the accepted pre-T44 baseline. Flash remains the default and Pro remains explicit escalation. The canonical measurement spend was $0.1242190356; an excluded delegated partial run has unrecoverable additional provider cost. See `docs/T44/post-t44-production-canary-2026-07-13.md`.

### T43 — Agent Harness V2 P0 (2026-07-12)

T43 closes the control-plane gaps identified in `docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md` without broadening the Agent into a coding or open-world agent.

- Shared request preparation and a versioned Prompt Kernel classify answer/clarify/analyze/act/review requests before creating a run.
- Outcome Contract, durable RunPlan/WorkState and deterministic verifier make completion depend on evidence and success criteria rather than model stop alone.
- Token-aware context blocks, compaction receipts, Skills V2 composition and compatibility gates preserve constraints across long runs.
- Tool Executor V2 enforces manifest timeout/retry/concurrency/effect declarations; large results become run-scoped durable resources readable through bounded pagination.
- Durable checkpoint, rehydrate, same-run resume and steering support constraints, plan changes, clarification answers and approval responses without replaying known side effects.
- The frontend polls a browser-safe snapshot and exposes resume, steer, approval and cancel controls. Full checkpoint content, viewer identity and raw event history are not forwarded to the browser.
- Trajectory export, public HTTP/SSE scenario evaluation and primary/fallback conformance canary report routing, outcome, P95 latency, token use and cost.
- Proposal-Confirm and FastAPI fact ownership remain unchanged. No current tool requires execution approval, so approval state is available but intentionally inactive rather than forced onto proposal/advisory operations.

High-frequency model token and tool-progress deltas are live SSE transport only; final output, tool results, checkpoints and state boundaries remain durable. This reduced the real browser risk-analysis run from 3,532 persisted events before the fix to 123 after the fix, with the run still completing after six bounded tool calls.

Verification: backend 760 passed / 4 skipped + ruff; agent bridge 994 passed across 55 files + typecheck/build; frontend 125 passed across 16 files + lint/build.

Production canary (2026-07-13): DeepSeek V4 Flash and DeepSeek V4 Pro both reached 100% routing and outcome pass rates across answer, status, risk-replan, planning and assignment/privacy scenarios. Flash P95 was 32.655s with 93,972 input / 10,360 output tokens and $0.0170647008 measured cost. Pro P95 was 92.711s; after replacing the privacy evaluator's false-positive `project_*` regex with actual workspace-ID + UUID checks, the combined Pro evidence was 97,566 input / 14,886 output tokens and $0.058729118 measured cost. Frozen latency gates are 30s for answer, 90s for status/planning/privacy and 120s for risk-replan.

### Agent Thinking Process Folding (2026-07-10)

Implemented thinking/reasoning process folding in the Agent sidebar, using Pi runtime turn boundaries to separate thinking tokens from answer tokens.

**What was built:**

- **Turn boundary tracking**: SSE `status` events with `phase: "turn_start"` are used to count Pi runtime turns. `turnCountRef` starts at -1, increments on each `turn_start`. `turnTokensRef` records tokens per turn index.
- **Thinking/answer separation**: On `onDone`, if `turnCount >= 1` (multiple turns), turn 0 tokens become `thinkingContent` (shown in collapsible section); turn 1+ tokens are the final answer. Single-turn responses have no thinking section.
- **Streaming UX**: All tokens display in `streamingBuffer` during streaming (preserves typing effect). After completion, the message re-renders with a collapsible thinking section + final answer.
- **Collapsible component**: `@base-ui/react/collapsible` with `grid-template-rows` CSS transition for smooth expand/collapse animation. Shows "思考过程 · N 步" with ChevronRight toggle.
- **Tool observation noise filter**: `cleanThinkingContent()` replaces short standalone JSON (`{}`, `{"limit": 10}`) with `> 🔧 **工具调用**` blockquote format. Tracks markdown code block boundaries to avoid false positives.
- **Step counter**: `countThinkingSteps()` counts tool call markers + reasoning paragraphs for the "N 步" display.
- **Ref cleanup**: All streaming refs (`turnTokensRef`, `turnCountRef`, `streamingBufferRef`) are reset in `onDone`, `onError`, `handleStopStreaming`, and at the start of `handleSendAgentMessage` (prevents stale data on rapid re-sends).
- **Project switch safety**: `lastThinkingContent` cleared in `handleSelectProject` and `handleShowWorkspace`.
- **Dead code removed**: `project-layout.tsx` deleted (was never imported).

**Key files:** `frontend/src/app/workspaces/[workspaceId]/page.tsx`, `frontend/src/components/project/agent/ChatMessage.tsx`, `frontend/src/components/project/agent-sidebar.tsx`, `frontend/src/components/project/workspace-layout.tsx`, `frontend/src/components/ui/collapsible.tsx`

**Verification (2026-07-10):** `next build` pass

### Multi-Model Multi-Provider Config & Switching (2026-07-08)

Implemented multi-model, multi-provider configuration and runtime switching for the Agent Bridge Sidecar.

**What was built:**

- **ModelConfigStore**: JSON file registry (`model-configs.json`) with validation, enrichment (apiKeySet/apiKeySuffix/valid/invalidReason), CRUD operations, and atomic persist (write temp → rename).
- **DotEnvWriter**: Serial Promise queue for `.env` writes. Validates key names (rejects protected system vars), rejects newlines in values, enforces 512-char max on API keys. Atomic write (same-directory temp + rename to avoid EXDEV).
- **FileWatcher**: `fs.watch` with 500ms debounce. Handles both `'change'` and `'rename'` events (atomic-save editors). Async onChange with proper await and error handling.
- **ModelRouter**: Refactored from `{defaultProvider, defaultModel}` to registry-based `ModelConfigStore` lookup. `resolve(id?)` tries exact id match, then `provider:name` composite key, then default.
- **Pi-runtime changes**: Dynamic `import()` for Pi SDK providers (deepseek, openai, anthropic, xiaomi, xiaomi-token-plan-cn, openrouter). `resolveRealModel()` now async, supports custom models not in catalog via `createCustomOpenAICompatibleModel()`. `apiKeyOverride` on ResolvedModel is reserved for future per-request key injection (Pi SDK does not yet support this channel).
- **Sidecar config API routes**: `GET/POST /config/models`, `PUT/DELETE /config/models/:id`, `PUT /config/models/:id/api-key`, `POST /config/reload`, `GET /config/providers/:provider/models`. All with input validation, field whitelisting on update, and proper error codes.
- **Frontend settings dialog**: `SettingsDialog` with "模型配置" tab — list/add/edit/delete model configs, set API keys, reload. Accessible from all views (navbar gear on non-dashboard, floating gear on project dashboard).
- **Frontend model selector**: In Agent sidebar, a `Select` dropdown above the thinking level selector. Selection persists in localStorage (`pf:selected-model-id`). Selected model's `{provider, name}` passed through `onRunAgent` → `runAgentFlow` → sidecar `runtime_config.model`.
- **Shared `loadDotEnv()`**: Extracted from `index.ts` to eliminate code duplication between startup and FileWatcher onChange. `reloadDotEnv` callback passed through ServerContext → RunContext for `POST /config/reload`.
- **Default model configs**: 4 presets in `model-configs.json` — DeepSeek V4 Flash (default), DeepSeek V4 Pro, MiMo V2.5, MiMo V2.5 CN (国内 Token 计费).

**Verification (2026-07-08):**
- agent-bridge: `tsc --noEmit` pass, 540 vitest tests pass (18 files)
- frontend: `npm run build` pass, `api.test.ts` 15 tests pass
- backend: 519 pytest tests pass, 4 skipped

**Design doc:** `docs/T41/multi-model-config-design.md`

**Key files:** `agent-bridge/model-configs.json`, `agent-bridge/src/types/model-config.ts`, `agent-bridge/src/config/model-config-store.ts`, `agent-bridge/src/config/dotenv-writer.ts`, `agent-bridge/src/config/file-watcher.ts`, `agent-bridge/src/runtime/model-router.ts`, `agent-bridge/src/runtime/pi-runtime.ts`, `agent-bridge/src/server/routes/config-models.ts`, `agent-bridge/src/server/routes/config-api-key.ts`, `agent-bridge/src/server/routes/config-reload.ts`, `agent-bridge/src/server/routes/config-providers.ts`, `agent-bridge/src/server/app.ts`, `agent-bridge/src/index.ts`, `frontend/src/components/settings/settings-dialog.tsx`, `frontend/src/components/settings/model-config-tab.tsx`, `frontend/src/components/project/agent-sidebar.tsx`, `frontend/src/lib/api.ts`, `frontend/src/lib/types.ts`

### T42 — ProjectMemory V1 Remediation Closure (2026-07-11)

The merged #71-#80 implementation is now followed by completed remediation slices R1-R6 and R8. The selective R8 Pilot passes 7/7 release gates; R7 remains a separately approved V1.1 vector project.

**Closure result:**

- FastAPI-built memory context reaches the sidecar model prompt on both run routes; runtime evidence is emitted in `agent.started`.
- Retrieval is project-scoped and uses two-phase natural-language matching; the 50-query eval reaches Recall@10/Recall@3 100%, MRR@10 0.97, and 2% bad-first rate.
- Viewer authorization is shared by list/export/injection, history display is lifecycle-aware, and FTS synchronization reaches terminal `synced` or `failed` states.
- The initial 150-pair/300-call sidecar Pilot plus selective S1/S2 remediation evidence passes 7/7 gates. Post-fix raw-ID leakage is 0/140 calls; S2 rejection reduction is 100%. A narrow member-constraint assignment output guard raised the selectively composed S1 B-group evidence to 10/10 and exposes guard status/call count in final SSE evidence.
- Verification: backend `702 passed, 4 skipped` and Ruff pass; agent bridge `607 passed` across 26 files plus typecheck/build pass; frontend `117 passed` across 14 files plus lint/build pass.
- Accepted V1 limitation: alternate `/api/replans/confirm` path still does not produce ProjectMemory; current frontend does not use this endpoint.

**Canonical closure record:** `docs/T42/project-memory-v1-closure.md`. Final Pilot evidence: `docs/T42/project-memory-v1-ab-selective-rerun-report.md`.

### T42 — ProjectMemory V1 Optional Vector Extra & Dependency Guardrails (2026-07-07, issue #77)

Add the optional `memory-vector` dependency path and guardrails for vector retrieval without changing ProjectMemory V1's default local-first behavior.

**What was built:**

- **`memory-vector` extra**: `pyproject.toml` adds `[project.optional-dependencies] memory-vector` with `sentence-transformers>=2.2.0` and `sqlite-vec>=0.2.0`. Default `pip install -e ".[dev]"` does not install torch, sentence-transformers, sqlite-vec, or embedding model files.
- **`vector_retriever.py`**: All vector-only imports (sentence_transformers, sqlite_vec) are inside functions, never at module top level. `is_vector_available()` checks importability without triggering downloads. `VectorRetriever` class with lazy model/extension initialization, `embed()`, `index_memory()`, `search()`. `VectorBackendError` on init failure for caller-side fallback.
- **`MemoryBackend.vector`**: Enum extended with `vector` value. `MemoryRetriever.search()` gains `prefer_vector: bool = False` parameter. When True, tries vector first then falls back to FTS5 → sqlite_field → none. When False (default), unchanged FTS5 → sqlite_field → none chain.
- **`prefer_vector` propagation**: `retrieve_memory_ids()`, `build_memory_context()`, `retrieve_visible_memory_ids()` all accept `prefer_vector` kwarg.
- **Warmup module**: `python -m app.memory.warmup` — without extra prints skip message and exits 0; with extra initializes embedding model; on failure exits 1. FTS5 retrieval always functional regardless.
- **Config**: `MEMORY_VECTOR_ENABLED`, `MEMORY_VECTOR_MODEL`, `MEMORY_VECTOR_MODEL_DIR` in `Settings`. Model directory `backend/data/memory-models/` added to `.gitignore`.
- **Guardrail tests**: `test_memory_vector_guardrails.py` (13 tests) — default install no vector deps, retriever no vector imports at module level, warmup skip, fallback to FTS5, memory_backend reflects actual backend, prefer_vector signature compatibility.
- **Vector-only tests**: `test_memory_vector.py` — auto-skipped without extra, runs only with `pip install -e ".[memory-vector]"`.
- **Documentation**: `docs/T42/memory-vector-optional.md` — default vs extra path, warmup behavior, model storage, fallback semantics, environment variables.

**Acceptance criteria verified (10/10):**
1. Default install does not install vector deps ✓
2. Vector deps only through `memory-vector` extra ✓
3. Default path does not import vector deps at module import time ✓
4. `python -m app.memory.warmup` prints skip message and exits 0 without extra ✓
5. With extra, warmup can initialize/download embedding model ✓
6. sqlite-vec/embedding init failure reports clear error, FTS5 stays functional ✓
7. Vector unavailable falls back to fts5 → sqlite_field → none ✓
8. `memory_backend` reflects actual backend used ✓
9. Optional vector tests only run in vector-enabled env ✓
10. Documentation states default path, extra path, warmup, model storage, fallback ✓

**Key files:** `backend/pyproject.toml`, `backend/app/agent/memory/vector_retriever.py`, `backend/app/agent/memory/retriever.py`, `backend/app/agent/memory/context_builder.py`, `backend/app/services/memory_service.py`, `backend/app/core/config.py`, `backend/app/memory/__init__.py`, `backend/app/memory/__main__.py`, `backend/app/memory/warmup.py`, `backend/app/tests/test_memory_vector_guardrails.py`, `backend/app/tests/test_memory_vector.py`, `docs/T42/memory-vector-optional.md`

**What remains (T42 V1 closure gap):**
- None (issue #80 frontend UI is merged)

### T42 — ProjectMemory V1 Replan Memory Tracer (2026-07-06, issue #74)

Fourth vertical slice of ProjectMemory V1. When a replan proposal is confirmed or rejected, ProjectFlow creates governed project memory for the decision.

**What was built:**

- **`extract_replan_confirmed`**: Creates exactly 1 `plan` memory (team-visible, scope=project) + optional 1 `tradeoff` memory (when stage_adjustments or task_changes have non-empty reason, aggregated in stable sorted order) + optional 1 `boundary` memory (when task_changes have can_cut or status in cancelled/blocked). All visibility=team, scope=project. Cross-stage/task replans use project-level scope, no invented related IDs.
- **`extract_replan_rejected`**: Creates exactly 1 `rejection` memory only when `rejection_reason` is non-empty. Empty reason → skip. source_type=`replan_rejected`, visibility=team, scope=project.
- **Dispatch refactor**: `confirm_proposal()` now uses a `_source_type_map` dispatch (`clarify→direction_card_confirmed`, `replan→replan_confirmed`) instead of hardcoded `if clarify`. `reject_proposal()` now dispatches `replan→replan_rejected` vs default `proposal_rejected`.
- **Known V1 gap**: The alternate `/api/replans/confirm` path does NOT trigger memory extraction (documented, not silently changed).

**Acceptance criteria verified (10/10):**
1. Confirming replan triggers extraction after business commit ✓
2. Exactly one plan memory ✓
3. Explicit rationale may create tradeoff/boundary ✓
4. Multiple same-type adjustments canonicalized and aggregated ✓
5. Cross-stage/task replans use project-level scope, no invented IDs ✓
6. Replan rejection creates rejection only when reason exists ✓
7. Alternate /replans/confirm path is known V1 gap ✓
8. Idempotent replay with unchanged source data ✓
9. User-visible fields contain no raw internal IDs ✓
10. Tests cover all paths ✓

**Test results:** 20 new tests in `test_replan_memory.py`, 486 backend tests total pass, 559 agent-bridge tests pass, 46 frontend tests pass.

**Key files:** `backend/app/agent/memory/extractor.py`, `backend/app/services/agent_proposal_service.py`, `backend/app/services/memory_service.py`, `backend/app/tests/test_replan_memory.py`

**What remains (T42 V1 next tracer bullets):**
- None (issue #80 frontend UI is merged)

### T42 — ProjectMemory V1 Default Retrieval & Agent Context Injection (2026-07-06, issue #75)

FTS5 + jieba Chinese tokenization retrieval, structured field fallback, memory_backend=none兜底, and Agent prompt context injection.

**What was built:**

- **`MemoryRetriever`**: FTS5 virtual table with jieba tokenization, `_safe_fts_query` wrapping tokens in double-quotes to prevent FTS5 operator injection, structured field filtering as fallback, memory_backend=none as final fallback.
- **`build_memory_context`**: Loads candidate memory IDs from retrieval, reloads authoritative ProjectMemory rows, filters by project/workspace/active/valid_until/visibility, formats as numbered Chinese text, truncates by token budget (character heuristic) and hard count limit. Header/footer wrapping text counted against budget.
- **Agent context injection**: `generate_structured_output` and `start_run` build memory context and inject into prompts via `<project_memory_context>` XML tags with `html.escape()`. Memory metadata nested under `_memory` key in AgentEvent output_snapshot to avoid overwriting agent output keys.
- **viewer_user_id enforcement**: Legacy conversation non-stream path now passes viewer_user_id. T41 `start_run` validates workspace_id/project_id consistency.
- **Superseded memory cleanup**: `_supersede_memory` removes old FTS5 index rows on supersede.
- **Broad exception handling**: `_build_memory_context` and `_build_memory_context_for_run` re-raise KeyboardInterrupt/SystemExit.

**Test results:** 466 backend tests pass (before replan tracer), 559 agent-bridge tests pass, 46 frontend tests pass.

**Key files:** `backend/app/agent/memory/retriever.py`, `backend/app/agent/memory/context_builder.py`, `backend/app/agent/workflow.py`, `backend/app/agent/prompts.py`, `backend/app/services/agent_conversation_service.py`, `backend/app/services/agent_runtime_service.py`, `backend/app/services/memory_service.py`, `backend/app/api/routes_agent_runtime.py`, `backend/app/schemas/runtime.py`, `backend/app/tests/test_memory_retrieval.py`

### T42 — ProjectMemory V1 Assignment Memory with Subject-and-Owner Privacy (2026-07-06)

Third vertical slice of ProjectMemory V1 (issue #73). When an assignment proposal is finalized, ProjectFlow creates a team-visible assignment memory and optionally a subject-and-owner member_constraint memory. Missing subject or owner fails closed (never downgraded to team). Multi-member private constraints are skipped.

**What was built:**

- **Deterministic extractor**: `extract_assignment_confirmed` creates exactly 1 `assignment` memory (team-visible, scope=task) + optional 1 `member_constraint` memory (subject_and_owner visibility, scope=member) when `constraint_respected` is non-empty and both `subject_user_id` (recommended_owner) and `owner_user_id_snapshot` (project.created_by) are present.
- **Fail-closed behavior**: Missing subject or owner → no member_constraint written, never downgraded to team. Multi-member constraints → at most 1 member_constraint per source event (skip rather than merge/split).
- **Owner snapshot**: `owner_user_id_snapshot` resolved at write time from `project.created_by`, does not drift if later project ownership changes.
- **Hook**: `finalize_assignment_proposal()` and `finalize_assignment_proposals_by_stage()` in `assignment_service.py` call `extract_from_event(source_type="assignment_confirmed", source_id=proposal.id)` after commit. Failures absorbed, never roll back business decision.
- **Dispatch refactor**: `extract_from_event()` now supports both AgentProposal-based and AssignmentProposal-based source types via separate `_AGENT_PROPOSAL_EXTRACTORS` and `_ASSIGNMENT_PROPOSAL_EXTRACTORS` dispatch tables.
- **Content/rationale semantics**: `content` uses display names (member name, project name, task title), includes backup owner if present. `rationale` cites source. No raw IDs.
- **Visibility**: `assignment` is team-visible; `member_constraint` is subject_and_owner (only subject and owner snapshot can see). JSON list, Markdown export, and visibility logic consistent.

**Acceptance criteria verified (10/10):**
1. Finalizing triggers extraction after business commit ✓
2. Exactly one team-visible assignment memory ✓
3. member_constraint only for single subject with explicit constraint ✓
4. subject_and_owner with subject_user_id and owner_user_id_snapshot ✓
5. Missing subject/owner fails closed ✓
6. Multi-member constraints skipped ✓
7. Owner snapshot resolved at write time, does not drift ✓
8. JSON/Markdown/context visibility consistent ✓
9. No raw IDs in user-visible fields ✓
10. Tests cover all paths ✓

**Test results:** 25 new tests in `test_assignment_memory.py`, 450 backend tests total pass, 46 frontend tests pass.

**Key files:** `backend/app/agent/memory/extractor.py`, `backend/app/services/assignment_service.py`, `backend/app/services/memory_service.py`, `backend/app/tests/test_assignment_memory.py`

**What remains (T42 V1 next tracer bullets):**
- None (issue #80 frontend UI is merged)

### T42 — ProjectMemory V1 Proposal Rejection Memory (2026-07-06)

Second vertical slice of ProjectMemory V1 (issue #72). When a proposal is rejected with a non-empty reason, ProjectFlow creates a governed rejection memory. Empty/blank reasons are tolerated for legacy compatibility but do not produce memory.

**What was built:**

- **Deterministic extractor**: `extract_proposal_rejected` creates exactly 1 `rejection` memory when `rejection_reason` is non-empty and non-blank. Empty/blank → skip (no memory). No LLM calls.
- **Hook**: `reject_proposal()` in `agent_proposal_service.py` calls `extract_from_event(source_type="proposal_rejected", source_id=proposal.id)` after commit when reason is non-empty. Does NOT create an AgentEvent or expand AgentEvent enums.
- **Content/rationale semantics**: `content` states what proposal was not adopted (uses Chinese proposal type label + project name). `rationale` cites only the explicit rejection reason, does not infer hidden causality.
- **Visibility**: `team` (all workspace members can see rejection memory). Participates in same JSON/Markdown visibility as direction card memory.
- **Idempotency**: Same source_hash → skip; different hash → supersede old active rejection memory.
- **No raw IDs**: All user-visible text uses display names and Chinese labels.
- **Frontend**: Rejection flow now requires non-empty reason via textarea input before confirming reject. `onRejectProposal` callback signature changed from `(id: string) => void` to `(id: string, reason: string) => void`. Replan rejection also requires reason input.

**Acceptance criteria verified (9/9):**
1. Frontend rejection requires non-empty reason ✓
2. Legacy/empty reason calls compatible, no memory write ✓
3. Non-empty reason creates exactly one rejection memory with correct source_type/source_id ✓
4. proposal_rejected does not create AgentEvent ✓
5. content/rationale semantics correct ✓
6. Team-visible, participates in JSON/Markdown visibility ✓
7. Idempotent replay; changed reason supersedes ✓
8. No raw internal IDs ✓
9. Tests cover all paths ✓

**Test results:** 18 new tests in `test_proposal_rejection_memory.py`, 425 backend tests total pass, 46 frontend tests pass.

**Key files:** `backend/app/agent/memory/extractor.py`, `backend/app/services/agent_proposal_service.py`, `backend/app/services/memory_service.py`, `backend/app/tests/test_proposal_rejection_memory.py`, `frontend/src/components/agent/agent-proposal-panel.tsx`, `frontend/src/components/risk/replan-diff.tsx`, `frontend/src/lib/api.ts`

**What remains (T42 V1 next tracer bullets):**
- None (issue #80 frontend UI is merged)

### T42 — ProjectMemory V1 Direction Card Tracer Bullet (2026-07-06)

First vertical slice of ProjectMemory V1 (issue #71). When a direction card is confirmed through the clarify proposal flow, ProjectFlow creates governed project memory and exposes it through read surfaces.

**What was built:**

- **Data model**: `ProjectMemory` + `ProjectMemorySync` tables with idempotent unique index on `(project_id, source_type, source_id, memory_type, source_hash)`. Memory lifecycle: active → superseded (archived reserved for V1.1).
- **Deterministic extractor**: `MemoryExtractor` for `direction_card_confirmed` creates exactly 1 `direction` memory + optional 1 `boundary` memory (boundaries canonicalized in stable sorted order). No LLM calls.
- **Display resolver**: `display_resolver.py` resolves structural IDs to display names/titles with safe Chinese placeholders. No raw IDs in user-visible text.
- **Memory service**: `extract_from_event()` runs synchronously after business commit, opens new session, swallows exceptions (never rolls back business decision). Idempotent write: same source_hash → skip; different hash → supersede old.
- **Hook**: `confirm_proposal()` in `agent_proposal_service.py` calls `extract_from_event(source_type="direction_card_confirmed", source_id=proposal.id)` after commit for clarify proposals.
- **Viewer validation**: Explicit `viewer_user_id` required on memory read/export. Missing → 400; non-member → 404. No fallback to owner view.
- **Visibility**: `team` (all workspace members) and `subject_and_owner` (subject + owner snapshot only). Fail-closed on missing subject/owner.
- **API**: `GET /projects/{project_id}/memories?viewer_user_id=...` (JSON) and `GET /projects/{project_id}/memories.md?viewer_user_id=...` (Markdown export). Both return `Cache-Control: no-store`.
- **Markdown export**: 5 topic groups (方向与边界 / 被拒绝方案 / 分工与资源 / 重排取舍 / 被替代或归档的历史判断).

**Acceptance criteria verified (13/13):**
1. Extraction triggers only after business commit ✓
2. Exactly one direction memory ✓
3. Boundaries canonicalized, at most one boundary ✓
4. Idempotent replay (same hash → skip) ✓
5. Changed source → supersede old ✓
6. No raw IDs in content/rationale/Markdown ✓
7. Missing/malformed viewer_user_id → 400 ✓
8. Non-member viewer → 404 ✓
9. JSON and Markdown same visible set ✓
10. Cache-Control: no-store ✓
11. Extractor deterministic, no LLM ✓
12. T41 sidecar database-free (architectural) ✓
13. Tests cover end-to-end path ✓

**Test results:** 22 new tests in `test_project_memory.py`, 407 backend tests total pass.

**Key files:** `backend/app/models/project_memory.py`, `backend/app/agent/memory/extractor.py`, `backend/app/agent/memory/display_resolver.py`, `backend/app/services/memory_service.py`, `backend/app/api/routes_memories.py`, `backend/app/schemas/project_memory.py`, `backend/app/tests/test_project_memory.py`

**What remains (T42 V1 next tracer bullets):**
- None (issue #80 frontend UI is merged)

### T42 — ProjectMemory V1 Retrieval Evaluation Harness (2026-07-07, issue #76)

Quality guardrail for the default FTS5 retrieval path. Fixed Chinese fixtures and queries make retrieval quality regressions measurable without requiring optional vector dependencies.

**What was built:**

- **`retrieval_eval.py`**: Fixed fixture set (13 entries covering direction, boundary, rejection, assignment, member_constraint, plan, tradeoff, plus expired + subject_and_owner), annotated query set (10 realistic Chinese queries with expected memory IDs), `write_eval_fixtures()` / `run_retrieval_eval()` / `check_visibility_enforcement()` entry points. Harness exercises the `retrieve_memory_ids` service seam, not private tokenizer details.
- **`test_retrieval_eval.py`**: 11 tests covering recall@10 threshold (100% vs 90% target), FTS5 backend usage, latency assertion (< 500ms per query, actual < 7ms), expired fixture filtering, irrelevant-memory flagging, outsider visibility bypass prevention, owner/subject `subject_and_owner` access, result structure completeness, memory_type coverage, and no-external-dep enforcement.
- **No external dependencies**: Runs without torch, sentence-transformers, sqlite-vec, embedding model files, or network downloads.

**Acceptance criteria verified (9/9):**
1. Fixed fixture set covering all V1 memory_type values ✓
2. Default query set with realistic Chinese queries and expected IDs ✓
3. Harness exercises service/API retrieval seam ✓
4. FTS5 recall@10 ≥ 90% (measured: 100%) ✓
5. Latency recorded under V1 target; irrelevant-memory inclusion flagged ✓
6. Runs in default dev/test install without optional deps ✓
7. CI/document verification path runs default evaluation ✓
8. Visibility-sensitive fixtures prevent can_view_memory bypass ✓
9. Documentation explains how to extend query set without weakening baseline ✓

**Test results:** 11 new tests in `test_retrieval_eval.py`, 497 backend tests total pass.

**Key files:** `backend/app/agent/memory/retrieval_eval.py`, `backend/app/tests/test_retrieval_eval.py`

### T41 — Agent Runtime Sidecar Implementation (2026-07-04~06)

T41 Agent Runtime work now has S3, S5, S6, S7, S8, S9, S10, S11, S12, S13, S14, and S16 on the integrated mainline. The sidecar owns runtime/tool registration and event bridging, while FastAPI owns service-token-protected persistence through `/internal/agent-tools/*` and `/internal/agent-runs/*`.

**What was built:**

- **S3 (Sidecar Skeleton + Pi Runtime Adapter)**: HTTP server on port 4000, `executeRun()` wrapping Pi's `runAgentLoop`, `toPiTool()` conversion, `handlePiEvent()` mapping, FastAPI service-to-service client, model router (openai/openrouter/deepseek/anthropic/mock), context builder with stable prefix + dynamic suffix + escaped XML data, mock provider/tool loop, cancel signal handling, wire format adapter (snake_case ↔ camelCase). 10/10 acceptance criteria pass.
- **S5 (Read-only Tool Registration)**: 4 read-only tools (`get_workspace_state`, `get_agent_conversation`, `list_pending_proposals`, `get_timeline_slice`) with full `ProjectFlowToolManifest` (read_only, parallel, effectType=none). `registerDefaultTools()` at server startup. `GET /tools/list` endpoint. `FastapiClient.getPublic()` with shared `fetchJson`. Backend timeline `since`/`event_types`/`limit` filters. 3/3 acceptance criteria pass.
- **S6 (Stage Plan Proposal Tool)**: `generate_stage_plan_proposal` is a draft-only, sequential proposal tool backed by `POST /internal/agent-tools/stage-plan-proposal`. It creates pending `AgentProposal` rows, returns `proposal_persisted`, links the proposal/event IDs, and does not commit Stage/Project state.
- **S7 (Advisory Risk/ActionCard Tool)**: `analyze_checkins_and_risks` is an advisory-write tool backed by `POST /internal/agent-tools/checkins-and-risks-analysis`. It creates Risk and optional ActionCard advisory records with `created_ids`, keeps Task/Stage/Project unchanged, returns replan signals for primary-state changes, and treats Risk severity itself as advisory.
- **S8 (AssignmentProposalTool)**: `recommend_assignment` is a draft-only proposal tool backed by `POST /internal/agent-tools/assignment-recommendation`. It creates `AssignmentProposal` without writing `Task.owner_user_id`, reuses the same proposal for repeated idempotency keys, and keeps final ownership on the existing human confirmation/finalize path.
- **S9 (Check-in/replan Migration)**: default tool registry now includes `generate_replan_proposal` as a draft-only sequential proposal tool backed by `POST /internal/agent-tools/replan-proposal`. Legacy check-in analysis no longer persists `CheckInAnalysisOutput.task_updates` through `create_status_update()`; inferred task status changes become pending `replan` `AgentProposal` payloads and are applied only after proposal confirmation. The tool reuses the same proposal for repeated idempotency keys and returns `blocked + no_side_effect` when another pending replan already exists, linking the existing `proposal_id`. Commits: `7e49836`, `800f578`.
- **S10 (Event Bridge + Trace Envelope)**: Pi lifecycle events now map through a single ProjectFlow runtime event bridge with run/workspace/project/tool/proposal context and redacted trace summaries. Sidecar persists lifecycle events through `POST /internal/agent-runs/{run_id}/events:append`, streams only after FastAPI assigns `event_seq`, and emits product events for proposal/advisory side effects. FastAPI persists runtime events in `agent_run_events`, exposes `GET /internal/agent-runs/{run_id}/events`, and records proposal confirmation/rejection/commit runtime events for T41 tool-created proposals.
- **S12 (Legacy Coordinator Parity + Cutover Safety Net)**: per-flow/tool feature flags, contract parity tests, idempotency/reconciliation/safety tests, service-token auth for internal agent endpoints, and structured terminal results for not-found/disabled/crash paths.
- **S13 (Direction Card + Task Breakdown Proposal Tools)**: `generate_direction_card_proposal` and `generate_task_breakdown_proposal` are draft-only sequential proposal tools that create pending `clarify` / `breakdown` `AgentProposal` rows without mutating `Project` or creating `Task` records before confirmation.
- **S14 (Skills System)**: `SkillIndex` (directory scan + YAML frontmatter), `SkillLoader` (lazy SKILL.md + bounded on-demand references), `selectSkill()` (keyword confidence scoring), 6 SKILL.md files with `allowed-tools` constraints and reference files. 7/7 acceptance criteria pass.
- **S16 (Debug Raw Payload Mode)**: `traceIncludeSensitiveData` config (default false), `DebugPayloadStore` separate raw payload storage with retention, `hashValue()` SHA-256 utility, trace envelope with redacted/default-hash behavior, result normalizer with truncation + hash. 5/5 acceptance criteria pass.
- **S15 (Unit/Eval/Privacy Tests)**: 168 new tests across 3 files. Foundation unit tests (66): manifest parser, policy engine, event mapper, trace envelope, result normalizer, budget checker, run state transition validator, side effect status classifier, advisory/proposal boundary. Evaluation tests (65): skill selection matrix (18 user message patterns × 6 skills), tool evaluation matrix (12 tools × risk category + effect type), skill→tool mapping, proposal/advisory boundary, execution mode, manifest safety. Privacy/resume tests (37): trace defaults, debug raw payload, secret exclusion, redaction behavior, resume policy, data classification.
- **S11 (Frontend Integration)**: `useAgentStream` SSE streaming, `ChatComposer` with stop/cancel, `AgentProposalPanel` confirm/reject, `AssignmentFlowPanel` response/finalize, `AgentArtifactCard` with dismiss/resolve. 46 frontend tests pass (9 files).
- **Advisory Write Tools**: `create_risk` (advisory_write, creates Risk record directly) and `create_checkin` (advisory_write, creates CheckInCycle + CheckInResponse) are active internal agent tools. Both validate project/workspace relationships and reuse the same result for repeated idempotency keys. Proposal confirmation/rejection remains on the public proposal API and is not exposed as an internal agent tool.

**Code review:** Two-axis review (Standards + Spec) completed. Hard violations fixed around XML escaping, skill tool filtering, provider parallel gating, manifest input schema forwarding, FastAPI tool envelope, cancel terminal state, references, S16 debug storage, S12 disabled/not-found terminal result handling, S13 proposal idempotency transaction boundaries, internal endpoint service-token auth, and S11 advisory write boundaries. `update_stage_progress` and `submit_tool_result` were removed from the active internal agent tool surface because stage progress has no valid current commit model and proposal confirmation must remain a user/public API boundary. Judgement calls remain for future refactors around `skill-selector.ts` matching strategy, `pi-runtime.ts` module size, and repeated proposal-tool handler shape.

**Test results:** 385 backend tests pass, 559 sidecar unit tests pass (18 files), 46 frontend tests pass (9 files), sidecar typecheck/build pass.

**What remains (deferred):**
- None (all slices completed)

**Key files:** `agent-bridge/src/runtime/pi-runtime.ts`, `agent-bridge/src/events/event-mapper.ts`, `agent-bridge/src/events/trace-envelope.ts`, `agent-bridge/src/runtime/context-builder.ts`, `agent-bridge/src/events/debug-payload-store.ts`, `agent-bridge/src/server/app.ts`, `agent-bridge/src/policy/policy-engine.ts`, `agent-bridge/src/skills/skill-selector.ts`, `agent-bridge/src/tools/projectflow-tools.ts`, `backend/app/services/agent_tools_service.py`, `backend/app/services/agent_runtime_service.py`, `backend/app/models/agent_run_state.py`

### T41 — Agent Runtime Architecture Docs (2026-07-04)

T41 Agent Runtime architecture has been researched, reviewed, committed, and pushed in commit `aecbb6c`.

Source documents:

- `docs/T41/ProjectFlow_Agent_Runtime_Team_TDD.md`
- `docs/T41/ProjectFlow_Agent_Runtime_Foundation_Design.md`
- `docs/T41/ProjectFlow_Agent_Tools_Skills_Design.md`
- `CONTEXT.md`
- `docs/adr/`
- `docs/T41/research/`

Key decisions:

- Target architecture is TypeScript Agent Bridge Sidecar + Pi component runtime + ProjectFlow Tool Contract + durable AgentRunState + Proposal-Confirm Commit.
- Current `CoordinatorAgent` remains legacy implementation and migration asset, not the final runtime.
- FastAPI/DB remain the source of truth; sidecar must not own DB credentials or bypass FastAPI.
- LLM-callable tools cannot commit Primary Project State.
- Risk of any severity is advisory; mitigation that changes task/stage/project/owner/date state requires replan proposal confirmation.
- Read-only ProjectState/WorkspaceState/timeline paths must stay pure; stale state repair belongs in explicit State Repair Command / maintenance job.
- The architecture has already been turned into `docs/PRD-Agent-Runtime.md` and split into vertical slices/issues.

### T41 — S4 Read Purity + State Repair Command (2026-07-04)

S4 for Member B is implemented on branch `member-b/s4-read-purity` and verified locally.

Files changed:

- `backend/app/api/routes_projects.py`
- `backend/app/schemas/project_state.py`
- `backend/app/services/project_state_service.py`
- `backend/app/tests/test_project_state_endpoint.py`
- `docs/T41/handoff-member-b-tool-implementor.md`

Key results:

- `GET /api/projects/{project_id}/state` no longer advances or repairs Stage/Project state as a side effect.
- Explicit repair path added: `POST /api/projects/{project_id}/state-repair`.
- Repair returns structured result fields: `changed`, `repaired_stage_ids`, `current_stage_id`, `project_status`, `message`.
- Regression tests now lock both `get_project_state()` and `get_workspace_state()` as pure read paths.
- Repair tests cover both single-stage repair and cascaded repair that completes the whole project.

Verification:

- `cd backend`
- `python -m pytest app/tests/test_project_state_endpoint.py app/tests/test_nplus1_workspace_state.py -v`
- Result: `8 passed`

Coordination status:

- S4 is no longer a blocker for Member A's S5 read-only tools work.
- S5 has since landed on `main`; the latest follow-up status is tracked in the S6 handoff section below.

### T41 — S6 Stage Plan Proposal Tool (2026-07-05)

S6 for Member B is implemented on branch `member-b/s6-stage-plan-proposal` and verified locally.

Files changed:

- `backend/app/api/routes_agent_tools.py`
- `backend/app/services/agent_tools_service.py`
- `backend/app/tests/test_agent_tools_api.py`
- `agent-bridge/src/tools/projectflow-tools.ts`
- `agent-bridge/tests/unit/projectflow-tools.test.ts`
- `docs/T41/handoff-member-b-tool-implementor.md`

Key results:

- Explicit proposal tool path added: `POST /internal/agent-tools/stage-plan-proposal`.
- Tool reuses the legacy `CoordinatorAgent.generate_stage_plan` path but only creates a pending `plan` `AgentProposal`; it does not directly create `Stage` or mutate `Project`.
- Successful tool calls return `side_effect_status=proposal_persisted` with both `links.proposal_id` and `links.agent_event_id`.
- Repeated calls with the same idempotency key reuse the existing `plan` proposal instead of duplicating draft records.
- Existing proposal confirm flow for `plan` still persists stages only after human confirmation.

Verification:

- `cd backend`
- `python -m pytest app/tests/test_agent_tools_api.py app/tests/test_agent_proposal_confirm.py -v`
- `cd ../agent-bridge`
- `npm test -- --run tests/unit/projectflow-tools.test.ts`
- `npm run typecheck`

Results:

- backend: `35 passed`
- sidecar unit: `123 passed`
- typecheck: passed

Coordination status:

- S6 and S7 are complete on Member B branch.
- S10 event bridge is complete; S11 can consume runtime stream/query events.
- S13 is complete on Member B branch.

### T41 — S13 Direction Card + Task Breakdown Proposal Tools (2026-07-05)

S13 for Member B is implemented on branch `member-b/s13-direction-card-task-breakdown` and verified locally.

Files changed:

- `backend/app/api/routes_agent_tools.py`
- `backend/app/services/agent_tools_service.py`
- `backend/app/tests/test_agent_tools_api.py`
- `agent-bridge/src/tools/projectflow-tools.ts`
- `agent-bridge/tests/unit/projectflow-tools.test.ts`
- `docs/T41/handoff-member-b-tool-implementor.md`

Key results:

- Two new proposal tools added, fully reusing the S6 proposal creation pattern.
- `POST /internal/agent-tools/direction-card-proposal` reuses `CoordinatorAgent.generate_direction_card`, creates pending `clarify` `AgentProposal` without mutating `Project`.
- `POST /internal/agent-tools/task-breakdown-proposal` reuses `CoordinatorAgent.generate_task_breakdown`, creates pending `breakdown` `AgentProposal` without creating `Task` records.
- Both tools return `side_effect_status=proposal_persisted` with `links.proposal_id` and `links.agent_event_id`.
- Idempotency: repeated calls with the same key reuse the existing proposal.
- Sidecar manifests registered as `generate_direction_card_proposal` and `generate_task_breakdown_proposal`, both `draft_only` / `proposal_create` / `sequential`.

Verification:

- `cd backend`
- `python -m pytest app/tests/test_agent_tools_api.py -q`
- `cd ../agent-bridge`
- `npm test -- --run tests/unit/projectflow-tools.test.ts`
- `npm run typecheck`

Results:

- backend: `36 passed`
- sidecar unit: `162 passed`
- typecheck: passed

Coordination status:

- All Member B proposal tools (S6, S7, S13) are complete.
- S12 (Legacy Coordinator parity + cutover) is complete on Member B branch.
- Remaining Member B work: none — all assigned T41 slices complete.

### T41 — S12 Legacy Coordinator Parity + Cutover (2026-07-05)

S12 for Member B is implemented on branch `member-b/s12-legacy-coordinator-parity` and verified locally.

Files changed:

- `backend/app/core/config.py`
- `backend/app/core/security.py`
- `backend/app/api/routes_agent_tools.py`
- `backend/app/api/routes_agent_runtime.py`
- `backend/app/services/agent_flow_service.py`
- `backend/app/services/agent_tools_service.py`
- `backend/app/tests/conftest.py`
- `backend/app/tests/test_agent_runtime_api.py`
- `backend/app/tests/test_agent_tools_api.py`
- `agent-bridge/src/server/config.ts`
- `docs/T41/handoff-member-b-tool-implementor.md`

Key results:

- Per-flow/tool feature flags added in `Settings`: read tools, stage plan proposal, check-in/risk analysis, replan proposal, assignment recommendation, direction card proposal, and task breakdown proposal.
- `/internal/agent-tools/{tool_name}` now checks the static known-tool set and then the active feature-flag set; unknown tools return `blocked/TOOL_NOT_FOUND`, disabled tools return `blocked/POLICY_DENIED`, and unexpected crashes return `failed` with `side_effect_status=unknown`.
- `/internal/agent-tools/*` and `/internal/agent-runs/*` require `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.
- Proposal tools commit proposal creation and idempotency metadata in the same transaction, avoiding duplicate draft creation after crash/retry.
- Parity coverage now exercises read-only tools, proposal tools, advisory write, assignment recommendation, failed result shape, idempotency, pending-replan reconciliation, disabled/enabled flag transitions, tool crash reconciliation, internal service-token auth, and shell/file tool rejection.
- `CoordinatorAgent` remains as the legacy adapter behind the tool handlers; it has not been removed or shrunk.

Verification:

- `cd backend`
- `python -m pytest app/tests/test_agent_tools_api.py -q`
- `cd ../agent-bridge`
- `npm test -- --run tests/unit/projectflow-tools.test.ts`
- `npm run typecheck`

Results:

- backend: `58 passed`
- sidecar unit: `162 passed`
- typecheck: passed

Coordination status:

- All Member B proposal tools (S6, S7, S13) are complete.
- S12 (Legacy Coordinator parity + cutover) is complete on Member B branch.
- Remaining Member B work: none — all assigned T41 slices complete.

## Completed

### Phase 41 — Security Review & Performance Optimization (2026-06-08)

Comprehensive security audit and performance optimization across backend and frontend.

**Security Fixes (S2/S3/S5/S7/S8):**
- **S2+S5 File upload hardening**: `routes_uploads.py` — added `ALLOWED_EXTENSIONS` whitelist (pdf/doc/docx/ppt/pptx/csv/txt/md/png/jpg/jpeg/gif/svg/zip), `MAX_UPLOAD_BYTES=10MB` limit, chunked read/write via `shutil.copyfileobj`, removed `saved_path` from response, generalized error messages.
- **S3 XML injection prevention**: `prompts.py` — `workspace_state` JSON now escaped with `html.escape()` before injection into XML tags; removed absolute-path file reading logic and hardcoded `D:\ProjectFlow_Agent` fallback path.
- **S3 Path traversal prevention**: `schemas/resource.py` — `file_name` field validator rejects path separators (`/`, `\`, `..`).
- **S7 Prompt injection hardening**: `prompts.py` — removed `_read_resource_file()` absolute-path search and hardcoded directory fallbacks.
- **S8 User existence validation**: `core/db_utils.py` — new `require_user()` function; applied in `routes_agent_proposals.py`, `routes_assignments.py`, `routes_checkins.py`.

**Backend Performance (P1-P16):**
- **P1 Database indexes**: All 16 model files — added `index=True` to all foreign key fields; 3 composite indexes on AgentEvent, AgentProposal, AgentMessage.
- **P3+P8 HTTP client**: `llm_client.py` — replaced `urllib` with `httpx` (module-level connection pool reuse); `pyproject.toml` added `httpx>=0.27.0`.
- **P4 AgentEvent slimming**: `workflow.py` — `_log_agent_event`/`_log_failed_agent_event` now store lightweight `workspace_summary` instead of full `workspace_state` in `input_snapshot`.
- **P5+P9 Batch queries**: `agent_flow_service.py` — batch `stage_id` lookup replaces per-task `_stage_id_for_task` loop; `run_agent_flow` accepts optional `workspace_state` to avoid redundant rebuilds.
- **P6+P16 Batch task queries**: `project_state_service.py` — `_catch_up_stage_progress` uses batch task query; `assignment_responses` uses ID-list query.
- **P9+P12+P14 Conversation optimization**: `agent_conversation_service.py` — passes `workspace_state` through module chain; `_conversation_to_read` adds `limit(200)`; planner uses compact serialization.
- **P13 Export scoping**: `export_service.py` — user query filtered by workspace.
- **P15 Connection pooling**: `core/database.py` — non-SQLite databases get connection pool configuration.

**Frontend Performance (F1-F18):**
- **F1+F11 SSE reliability**: `page.tsx` — `reloadInProgressRef` debounce; `useEffect` cleanup aborts SSE.
- **F2 React.memo**: `ChatMessage`, `StreamingText`, `ModuleRunCard`, `AgentStepIndicator` wrapped in `React.memo`.
- **F3 Streaming throttle**: `StreamingText` — 100ms throttle via `displayBuffer` ref.
- **F4+F14 maxHeight animation**: 9 locations — replaced `height:auto` with `maxHeight` for GPU-accelerated animations.
- **F6+F9 useMemo**: `agent-sidebar.tsx` — computed values memoized; expand/collapse preserves content instead of unmounting.
- **F7 Lazy markdown**: `MarkdownContent.tsx` — `react-markdown` loaded via `next/dynamic`.
- **F8 App shell**: `app-shell.tsx` — removed `framer-motion`, replaced with CSS animations.
- **F10 Closure fix**: `useAgentStream.ts` — `onDone`/`onError` stored in refs, `sendMessage` dependency array cleaned.
- **F12 Agent chat hook**: New `use-agent-chat.ts` — extracted agent conversation state management.
- **F13+F17 API timeout**: `api.ts` — `request()` supports configurable `timeout` option.
- **F16 Workspace content**: `workspace-content.tsx` — `onMembersChanged` fix.
- **F18 SearchParams removal**: `project-content.tsx` — removed `useSearchParams`, uses `currentView` prop.

**Test fixes:** 6 test files updated deadline from "2026-06-07" to "2026-07-15" (expired date causing 422).

**Verification:** backend 244 tests pass; frontend lint 0 error; frontend build success.

---

### PRD 对照修复 & UI 打磨 (2026-06-07)

基于 PRD / TECH-DESIGN / MVP-Usable-Ready 三份文档对四个板块（项目总览、方向卡、阶段任务、项目复盘）的审查，完成以下修复：

**文本可读性：**
- `direction-decision-view.tsx` — 7 处 `break-all` → `break-words`（中文断行修复）
- `direction-card-panel.tsx` — 移除 `uppercase tracking-[0.14em]`（AI 痕迹）；步骤 3 描述改为"在项目总览中确认方向卡"
- `risk-card.tsx` — "证据"标签移除 `uppercase tracking-[0.14em]`
- `timeline.tsx` — 3 处 `uppercase tracking-[0.14em]` 移除

**交互安全 — Inline 二次确认：**
- 新增 `use-inline-confirm.ts` hook（3 秒超时自动恢复）
- 5 个 HIGH 级别按钮加上确认：行动卡完成、提案拒绝、风险忽略、风险解决、任务卡完成
- 确认态按钮变为 coral 色，提示危险操作

**卡片样式统一：**
- 建立 Surface / Sub-card / Empty-state / Accent 四种卡片变体
- 10 个文件统一：`rounded-xl border border-neutral-200 bg-white shadow-sm`（顶层）、`rounded-lg border border-ink/10 bg-paper/60`（子卡片）

**PRD 字段补全：**
- 方向卡种子数据补充 6 个字段：source_summary、assumptions、unknowns、mvp_boundary、decision_points、reason
- `project_service.py` 的 `normalize_direction_card()` 保留新增字段
- 10 个任务全部补充 backup_owner_user_id 和 assignment_reason
- StagePlanBoard 增加 done_criteria 渲染

**导出中文：**
- `routes_export.py` 状态值翻译（active→进行中、completed→已完成 等）
- 风险严重度/类型翻译

**复盘 Agent 总结：**
- 新增 `AgentEventType.retrospective` 枚举值
- 新增 `RetrospectiveOutput` schema（project_summary、key_achievements、challenges、lessons_learned、overall_assessment）
- 新增 `modules/retrospective.py` Agent 模块
- 新增 `POST /api/agent/retrospective` API 端点
- 复盘页新增 AI 复盘总结面板（RetroSummaryPanel）

**方向卡视觉重构：**
- 5 个色块分区：核心定义（蓝）、交付与边界（灰）、风险与问题（红）、假设与缺口（黄）、MVP 边界（绿）
- 每个分区有图标标题（Target、Package、ShieldAlert、Lightbulb、Crosshair）
- 子标题对比度提升

**其他：**
- `react-markdown` + `remark-gfm` 安装（Markdown 渲染支持）
- "重新推进" → "继续推进"

## Completed

### Phase 40 — Agent Sidebar UI Polish & Planner Reliability (2026-06-07)

Agent sidebar UI comprehensively polished with Framer Motion animations, artifact dismiss/confirm interactions, and backend planner reliability improvements.

**Backend Improvements:**
- **Planner retry logic**: `_plan_turn()` now retries up to 3 times on empty/invalid responses before falling back to safe defaults.
- **Improved JSON parsing**: `_parse_turn_plan()` uses brace-matching instead of `rfind` to extract the first complete JSON object, handling nested structures correctly.
- **DeepSeek thinking tag handling**: Strips `<｜end▁of▁thinking｜>` and similar markers before JSON parsing.
- **Enhanced logging**: Debug logs for planner raw output and LLM responses to aid troubleshooting.

**Frontend Animations (Framer Motion):**
- `ChatMessage`: fade-in + slide-up animation with staggered delay based on message index.
- `StarterPrompts`: fade-in container + staggered button animations.
- `StreamingText`: fade-in container + smooth cursor pulse animation (replaces CSS `animate-pulse`).
- `AgentContextCard`, `AgentRunCard`, `AgentErrorCard`: fade-in + slide-up entrance animations.
- `AgentArtifactCard`: layout animation with exit animation via `AnimatePresence`.

**Artifact Dismiss/Confirm:**
- `agent-sidebar.tsx`: Added `dismissedIds` and `confirmedIds` state management.
- Dismissed/confirmed artifacts filtered from view with 3-second delayed removal after confirmation.
- `AnimatePresence mode="popLayout"` wraps artifact cards for smooth exit transitions.
- State resets on project switch.

**ChatComposer Micro-interactions:**
- Focus state: `focus-within:shadow-sm focus-within:shadow-moss/5` transition.
- Send button: `shadow-sm shadow-moss/20` with `active:shadow-none` press feedback.
- Character counter: `transition-colors` for smooth warning state change.

**Confirmation Feedback:**
- `workspace/page.tsx`: After artifact confirmation, sends follow-up message to Agent: `已确认「{title}」，请确认结果并告诉我下一步。`

**Files modified:** `backend/app/agent/llm_client.py`, `backend/app/services/agent_conversation_service.py`, `frontend/src/app/workspaces/[workspaceId]/page.tsx`, `frontend/src/components/project/agent-conversation-cards.tsx`, `frontend/src/components/project/agent-sidebar.tsx`, `frontend/src/components/project/agent/ChatComposer.tsx`, `frontend/src/components/project/agent/ChatMessage.tsx`, `frontend/src/components/project/agent/StarterPrompts.tsx`, `frontend/src/components/project/agent/StreamingText.tsx`.

**Verification:** backend 245 tests pass, TypeScript compiles, frontend builds successfully, browser verification passed (Agent conversation, risk analysis module, artifact dismiss all working).

---

### Phase 39 — Agent UX Integration & Stage Auto-Advance (2026-06-07)

Proposal confirmation UX unified, task ordering stabilized, stage auto-advance implemented, and Active Push feedback improved.

**Bug Fixes:**
- **Agent `project_id` routing**: `AgentFlowRequest` now accepts `project_id`; backend `get_workspace_state()` and `run_agent_flow()` accept `project_id` for precise project targeting. Frontend `runAgentFlow()` passes `project_id` in request body. Fixes the bug where Agent always targeted the most-recently-created project in multi-project workspaces.
- **`Task.order_index` migration**: Added `ALTER TABLE tasks ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0` to fix SQLite schema mismatch after model change.

**Task Ordering (`order_index`):**
- `Task` model new column `order_index: int = Field(default=0)`.
- Synced through `TaskCreate`/`TaskRead` schemas, `TaskBreakdownItem`, breakdown prompt contract, and breakdown fallback (`0/1/2`).
- `_persist_task_breakdown()` sorts by `order_index` before writing. Query layers (`project_state_service`, `task_service`) sort by `stage_id, order_index, priority, due_date`.
- Frontend `sortTasks()`: stage_id → order_index → priority → due_date.

**Stage Auto-Advance:**
- New `try_advance_stage()` in `stage_service.py`: when a task is marked done, checks if all tasks in its stage are done. If so, auto-completes the stage, activates the next pending stage (or marks project completed if no more stages).
- Hooked into `task_service.create_status_update()` for human task status updates. Since T41 S9, Agent check-in analysis no longer uses this direct status write path; inferred task changes become pending replan proposals.
- Active Push prompt updated to detect all-tasks-done stages and suggest advancing.

**UX Improvements:**
- `PendingProposalBanner` component: yellow banner in specialist views (direction/stages) with "去确认" button that navigates to overview. `onNavigateView` prop threaded from `WorkspaceLayout` → `ProjectContent` → `ViewRenderer`.
- `DirectionCardPanel`: now shows three states — confirmed, generated-but-unconfirmed ("方向卡已生成，待确认"), and empty ("尚未生成方向卡").
- `StagePlanBoard`: `pendingPlanProposal` prop for inline preview of pending stage plans.
- `TaskBreakdownBoard`: redesigned from flat list to stage-grouped sections with color-dot indicators, `done/total` progress pills, empty stage placeholders.
- Active Push success message now shows the generated card title: `已生成行动卡"启动阶段1...", 请在项目总览中查看`.
- Overview "Next Action" section handles three states: active card / all completed with re-push button / never run with initial button.
- `TeamActionsPanel`: `canOperate` prop gated on `currentUserId === project.created_by`. Non-creators see read-only banner.

**Files modified:** `backend/app/models/task.py`, `backend/app/schemas/task.py`, `backend/app/schemas/agent_flow.py`, `backend/app/agent/output_schemas.py`, `backend/app/agent/prompts.py`, `backend/app/agent/modules/breakdown.py`, `backend/app/agent/modules/active_push.py`, `backend/app/services/stage_service.py`, `backend/app/services/task_service.py`, `backend/app/services/agent_proposal_service.py`, `backend/app/services/agent_flow_service.py`, `backend/app/services/project_state_service.py`, `backend/app/services/workspace_state_service.py`, `backend/app/api/routes_agent.py`, `backend/app/api/routes_tasks.py`, `frontend/src/lib/types.ts`, `frontend/src/lib/api.ts`, `frontend/src/components/task/task-breakdown-board.tsx`, `frontend/src/components/stage/stage-plan-board.tsx`, `frontend/src/components/agent/direction-card-panel.tsx`, `frontend/src/components/agent/team-actions-panel.tsx`, `frontend/src/components/project/project-content.tsx`, `frontend/src/components/project/workspace-layout.tsx`, `frontend/src/app/workspaces/[workspaceId]/page.tsx`.

**Verification:** backend 224/225 tests pass (1 pre-existing failure unrelated), frontend build pass.

**Follow-up (2026-06-07):**
- Direction card step indicator `computeStepIndex()` now respects stage/task count (0→intake, 1→clarified, 2→confirmed, 3→stages-exist). Previously locked at step 2.
- Direction history items individually expandable (2-line clamp + "展开全文" toggle).

---

### Phase 37 — Workspace Creation UX, Landing Page Redesign & Bug Fixes (2026-06-06, PR #37)

Workspace creation flow enhanced with team context, landing page fully redesigned to dark theme, and multiple bug fixes from code review.

**Changes:**

**Workspace Creation Flow:**
- Added team size and use case collection in workspace creation form (step 2: "团队上下文").
- `team_size` and `use_case` fields added to backend `WorkspaceCreate` schema, `Workspace` model, and `workspace_service.create_workspace()`. Frontend `CreateWorkspaceRequest` type updated accordingly.
- Custom use case input appears when "其他" is selected.
- `teamSize` string values ("1-2", "3-5", "6-10", "10+") parsed to integers before sending to backend.

**Landing Page Redesign:**
- Full redesign from light theme (`#f7f7f1`) to dark theme (`#050608`).
- New cinematic hero background image with animated motion layers.
- Replaced old sections (SignalRail, ProductPreview, scene cards, feature cards) with new metrics, workflow items, comparison layout.
- Navigation bar adapted with dark tone for landing page.
- Removed `Space_Grotesk` font and all `font-grotesk` CSS references.
- All UI labels translated to Chinese (Direction→方向澄清, Assignment→分工推荐, Execution→执行追踪, Risk→风险监控, etc.).

**Member Management:**
- Edit button now visible for workspace owner (previously hidden for owner role). Delete button still restricted to non-owners.

**Bug Fixes (from code review):**
- `next-env.d.ts`: Reverted dev-only path (`.next/dev/types/routes.d.ts`) back to production path (`.next/types/routes.d.ts`) to prevent CI build failures.
- `workspace-content.tsx`: Reverted `useState+useEffect` sync back to `useMemo+deletedProjectIds` pattern to fix optimistic delete being overwritten on parent re-render.
- `workspace-create-form.tsx`: Removed debug `console.log` from `goBack` function.

**Files modified:** `frontend/src/components/projectflow-home.tsx`, `frontend/src/components/app-shell.tsx`, `frontend/src/components/workspace/workspace-create-form.tsx`, `frontend/src/components/member/member-management-dialog.tsx`, `frontend/src/components/onboarding/member-profile-wizard.tsx`, `frontend/src/components/project/workspace-content.tsx`, `frontend/src/components/projectflow-home.test.tsx`, `frontend/src/lib/api.ts`, `frontend/src/lib/types.ts`, `frontend/src/app/layout.tsx`, `frontend/tailwind.config.ts`, `frontend/next-env.d.ts`, `backend/app/models/workspace.py`, `backend/app/schemas/workspace.py`, `backend/app/services/workspace_service.py`.

---

Phase 0 / GitHub issue #2 is complete and closed.
Phase 1 (models) / GitHub issue #3 is complete and closed.
Phase 2 (core APIs) / GitHub issue #4 is complete and closed.
Phase 4 (agent infrastructure) / GitHub issue #5 is implemented.
GitHub issue #6 (Frontend Shell, Onboarding, Workspace, and Intake) is implemented.
GitHub issue #7 (Planning and Assignment Dashboard UI) is implemented.
GitHub issue #8 (Assignment, active push, check-in, risk, and replan backend flows) is implemented.
GitHub issue #9 (Action cards, check-in, risk, timeline, and export UI) is implemented.
GitHub issue #10 (Demo Seed, Reset, Runbook, and Review Export) is implemented.
GitHub issue #11 (Verification, Tests, and Demo Stability Hardening) is complete.
GitHub issue #16 (Real LLM Provider Readiness and Diagnostics) is complete.
GitHub issue #17 (Agent Output Persistence and Confirmation) is complete.
GitHub issue #21 (Real-Provider Verification and MVP Usable Runbook) is complete.

### Phase 35 — Onboarding & Member Form Improvements (2026-06-05, PR #33)

Frontend UX improvements for onboarding and member management forms.

**Changes:**
- Popular skill click now fills the input field (user chooses level before adding) instead of auto-adding at Lv.3.
- Member management dialog (`MemberManagementDialog`) added 4 new fields: 专业, 年级, 偏好工作时段 (required), 过往项目.
- `MemberProfileWizard` "偏好工作时段" required validation aligned with onboarding path.
- Available hours input changed from `type="number"` to `type="text"` + `inputMode="numeric"` + custom up/down stepper buttons, eliminating browser scientific-notation interference with `e` character.
- New frontend fields (major, grade, pastProjects) are collected but not persisted to backend (no backend schema fields yet). `preferredTime` maps to `collaboration_preference`; `pastProjects` falls back to `interests` when interests is empty.

**Files modified:** `frontend/src/components/member/member-management-dialog.tsx`, `frontend/src/components/onboarding/member-profile-wizard.tsx`.

### Phase 36 — File Upload, Resource Management & Project Deletion (2026-06-06)

Full resource lifecycle management with file upload support and project deletion.

**Changes:**

**File Upload:**
- New `POST /api/uploads` endpoint accepting `multipart/form-data`, requires `python-multipart`.
- Uploaded files stored in `backend/data/uploads/` with UUID-based filenames; server returns `file_id` and `original_name`.
- Frontend `uploadFile()` in `api.ts` sends `FormData`; file-input components in `resource-input-panel.tsx` and `project-resources-panel.tsx` auto-upload on selection and store returned `file_id`.
- Agent `_read_resource_file()` in `prompts.py` reads uploaded file content (up to 8000 bytes) by UUID filename inside `backend/data/uploads/` and includes it as resource `summary` for clarify/plan/breakdown.

**Resource Management:**
- New `DELETE /api/resources/{resource_id}` — deletes resource record and removes uploaded file from disk (only for files under `uploads/` directory, not externally-referenced paths).
- Resource `title` field auto-fallback: empty string → file name → URL → "未命名资源".
- Resource schema validator converts empty strings to `None` for optional fields (`content_text`, `file_name`, `url`), preventing 422 errors from frontend form submissions.
- Project overview resource panel now supports file upload via "选择文件" button + delete via hover-X button.
- New-project dialog resource panel (collapsible form) supports file upload, auto-fills title from original filename.
- New-project dialog width increased to full-screen (`!max-w-none w-[45vw]`).

**Project Deletion:**
- New `DELETE /api/projects/{project_id}` endpoint — cascading delete of all child data (stages, tasks, assignments, check-ins, risks, action cards, agent events, agent proposals, resources).
- Frontend project list in workspace-content shows delete button (trash icon) on hover, with AlertDialog confirmation (shadcn/ui). Delete failure shows inline error message with retry guidance.
- Deleted projects also remove associated uploaded files from disk.

**Workspace UI Fixes (PR #36 + follow-up, 2026-06-06):**
- "查看项目" StatCard action fixed: was opening new-project dialog, now navigates to first active project.
- "查看归档" StatCard action fixed: was opening new-project dialog, now navigates to first completed project.
- Direction card text overflow: added `break-all` to all list items in `DirectionDecisionView` and `DirectionCardPanel`; "边界" section changed from `Badge` to `<ul><li>` list for long text.


**Agent File Reading:**
- `_read_resource_file()` rejects path separators, then searches `backend/data/uploads/` by base filename.
- File content injected as resource `summary` (limited to 8000 bytes) when `content_text` is empty.

**Other Fixes:**
- `ProjectResourcesPanel` select dropdown now closes on page scroll to prevent floating popover in dialog.
- Resource form confirms trigger auto-title fill when title is empty.

**Files modified:** `backend/app/api/routes_resources.py`, `backend/app/api/routes_uploads.py` (new), `backend/app/api/routes_projects.py`, `backend/app/services/resource_service.py`, `backend/app/services/project_service.py`, `backend/app/schemas/resource.py`, `backend/app/agent/prompts.py`, `backend/app/main.py`, `frontend/src/lib/api.ts`, `frontend/src/components/project/resource-input-panel.tsx`, `frontend/src/components/project/project-resources-panel.tsx`, `frontend/src/components/project/new-project-dialog.tsx`, `frontend/src/components/project/workspace-content.tsx`, `frontend/src/components/project/project-intake-form.tsx`, `frontend/src/components/project/project-content.tsx`, `frontend/src/components/project/workspace-layout.tsx`, `frontend/src/app/workspaces/[workspaceId]/page.tsx`, `frontend/src/components/ui/select.tsx`, `frontend/src/components/agent/direction-card-panel.tsx`, `frontend/src/components/agent/direction-decision-view.tsx`.

### Phase 29 — Agent Output Quality & Reliability Hardening (2026-06-05)

- WorkspaceState now includes `current_date`, `current_datetime`, and `timezone`; prompts inject them inside `<time_info>` so Agent runs can reason about deadlines and cycles against the current date.
- Project resources now enter Agent workspace context for clarify/plan/breakdown through compact resource summaries.
- Direction clarification output supports richer structured fields: `source_summary`, `assumptions`, `unknowns`, `mvp_boundary`, and `decision_points`; frontend `DirectionDecisionView` renders these sections.
- `AssignmentNegotiationOutput` no longer creates a generic `AgentProposal`; negotiate output is kept in AgentEvent timeline only, while concrete assignment negotiation remains owned by the assignment flow.
- Active push and unchanged replan fallback text is Chinese and project-aware.
- Proposal and Agent sidebar UI show generation status badges: success / repaired / fallback / failed.
- Tests added for time/resource prompt context, Chinese fallback, negotiate timeline-only behavior, and proposal status badges.
- Verification baseline: 221 backend / 26 frontend; frontend lint, build, and audit pass.

### Phase 26 — T23.B Round 2 Fixes (2026-06-03, GitHub #31)

- Skill name Chinese mapping: `SKILL_NAME_CN_MAP` in common.py (12 English→Chinese), `_normalize_user_facing_text()` post-processing in output_schemas.py, assignment_recommendation prompt guidance.
- JSON strictness: temperature lowered from 0.2→0.05, explicit JSON format in system prompt.
- Negotiate Agent endpoint: `POST /api/agent/negotiate` backend + `runAgentNegotiate()` frontend.
- Stage override for assign: `AgentFlowRequest.stage_id` allows non-active stage, `assignable_tasks()` accepts stage_id override, coordinator deep-copies workspace_state with overridden current_stage_id.
- Test isolation: conftest.py forces `LLM_API_KEY=""` to prevent real .env leakage.
- Negotiation module rewrite: `build_request()` injects rejection/negotiation context, fallback uses real rejected proposal data, fixes `current_owner_user_id` fallback bug.
- Documentation aligned: T23.B.md seed counts, handoff, runbook, CLAUDE.md, AGENTS.md, README.md updated. Phase 26 recorded.
- Test baseline: 218 backend / 24 frontend.

### Phase 31 — Onboarding Flow Critique Fixes (2026-06-04)

Applied `$impeccable` critique fixes to the onboarding flow (homepage → workspace → profile → project).

**Step indicator unification:**
- Added persistent 4-step `StepIndicator` to all onboarding pages: `onboarding/page.tsx`, `workspaces/new/page.tsx`, `onboarding/profile/page.tsx`, `projects/new/page.tsx`.
- Removed duplicate inner `StepIndicator` from `AccountSetupForm`, `WorkspaceCreateForm`, `MemberProfileWizard` to avoid double-rendering.

**Visual noise reduction:**
- Replaced uppercase eyebrow `text-xs font-bold uppercase tracking-[0.18em]` with `text-sm font-medium` on all 4 onboarding page headers.

**Profile wizard UX:**
- Added "跳过，稍后完善" skip button on every step of `MemberProfileWizard`; jumps directly to workspace dashboard.
- Success state now offers both "进入工作台" and "新建项目" actions.

**Form validation hardening:**
- Standardized blur validation across `MemberProfileWizard` (name, rolePreference, preferredTime).
- Made "所有者 ID" optional in `WorkspaceCreateForm` (placeholder: "选填，默认使用当前用户"), removing raw UUID exposure.

**Date picker clarity:**
- Added `CalendarIcon` to project intake deadline field for better affordance.

### Phase 32 — Route Unification & Workspace Navigation Fixes (2026-06-05)

**Onboarding flow simplification:**
- Removed Step 4 "Create Project" from onboarding wizard (3 steps: basic info → skills & experience → availability).
- After completing member profile, user lands directly at workspace dashboard — project creation happens inside the workspace via `NewProjectDialog`.
- Success state now shows only "进入工作台" action (removed duplicate "新建项目").

**Route unification:**
- Deleted `frontend/src/app/projects/[projectId]/page.tsx` and `frontend/src/app/projects/new/page.tsx`.
- `/workspaces/[workspaceId]` is now the sole dynamic route entry — three-column layout with unified state management.
- Project switching via `?project={id}` query param (no page navigation); view switching via `?view={view}`.
- `AppShell` navigation bar simplified: removed "新建项目" button to avoid duplication with `NewProjectDialog` in workspace content.

**WorkspaceLayout as unified entry:**
- Created `workspace-layout.tsx` as the central layout component for `/workspaces/[workspaceId]`.
- Manages `showWorkspace` / `selectedProjectId` state; renders `WorkspaceContent` (no project) or `ProjectContent` (project selected).
- `onClearSelectedProject` callback added to prevent `useEffect` conflict when navigating back to workspace.

**Null-safety hardening:**
- `ProjectSidebar`: `state.tasks ?? []`, `state.risks ?? []`, `state.members ?? []`, `state.memberships ?? []`, `state.member_profiles ?? []`, `state.workspace ?? {...}` guards throughout.
- `AgentSidebar`: `(state.timeline ?? []).slice(0, 5)` guard.
- `useRouter` null guard with `window.location.href` fallback in `NewWorkspaceDialog` callback.

**Documentation aligned:** CLAUDE.md, AGENTS.md, docs/code-wiki.md, docs/handoff.md updated. Routes table, navigation conventions, and component responsibility tables updated.

**Files deleted:** `frontend/src/app/projects/[projectId]/page.tsx`, `frontend/src/app/projects/new/page.tsx`.
**Files created:** `frontend/src/components/project/workspace-layout.tsx`.

---

### Phase 28 — Frontend Redesign Migration (2026-06-04)

Migrated frontend visual and layout foundation from `ProjectFlow_Frontend_Redesign` reference repo while preserving all existing backend-backed MVP flows.

**Visual foundation:**
- Replaced warm green tokens with blue/gold/cool-canvas design tokens in `globals.css`.
- Added `Instrument_Serif` (display) + `Inter` (body) font stack via `next/font/google`.
- Updated `tailwind.config.ts` with new color tokens, font variables, and animation presets.

**Layout migration:**
- `AppShell` redesigned with full-height behavior and simplified navigation.
- `/workspaces/[workspaceId]` changed from standalone dashboard to transition route: redirects to first project or new-project page.
- Project page migrated to three-column layout: `ProjectSidebar` (workspace/project nav), `ProjectContent` (center), `AgentSidebar` (right).

**New components:**
- `project-layout.tsx`, `project-sidebar.tsx`, `project-content.tsx`, `agent-sidebar.tsx` — three-column project layout.
- `new-project-dialog.tsx`, `workspace-content.tsx`, `new-workspace-dialog.tsx` — dialog-based creation flows.
- `compact-stat.tsx` — compact stat display component.
- `direction-decision-view.tsx` — direction card decision view.

**Preserved behavior:**
- All API calls, types, and backend integration unchanged.
- Agent proposal confirm/reject, assignment flow, check-in, risk, replan, action cards, export all functional.
- `setLastWorkspaceId`, `setCurrentUserId`, `setWorkspaceMembers`, localStorage sync preserved.
- Risk evidence Chinese rendering, replan proposal support, rejection reason display retained.

**Files modified:** `globals.css`, `tailwind.config.ts`, `layout.tsx`, `app-shell.tsx`, `projectflow-home.tsx`, `project-dashboard.tsx`, `projects/[projectId]/page.tsx`, `workspaces/[workspaceId]/page.tsx`, `agent-proposal-panel.tsx`, `direction-card-panel.tsx`, `api.ts`, `types.ts`, `api.test.ts`, `app-shell.test.tsx`, `package.json`.

**Files created:** `project-layout.tsx`, `project-sidebar.tsx`, `project-content.tsx`, `agent-sidebar.tsx`, `new-project-dialog.tsx`, `workspace-content.tsx`, `new-workspace-dialog.tsx`, `compact-stat.tsx`, `direction-decision-view.tsx`.

### Phase 27 — Code Review Hardening (2026-06-03, GitHub #31 review)

- `_normalize_user_facing_text`: `str.replace()` → `re.sub()` with ASCII word-boundary regex, preventing substring corruption (e.g. "redesign" → "reUI 设计").
- `_validate_references`: replaced inline reimplementation with `common.py` helpers (`active_stage_id`, `blocked_assignment_task_ids`, `assignable_tasks`, `rejected_assignment_pairs`), eliminating two-sources-of-truth drift.
- `_validate_references`: removed rejected-pair hard error that caused 500 when all members rejected a task (fallback picked best member → validation rejected that pair → unresolvable).
- `create_assignment_negotiation_from_proposal`: added `proposal.status == owner_rejected` gate.
- `score_member_for_task`: added Chinese constraint keywords (不可用/不能/避免/不想/不愿意/没空/冲突), fixed docstring (+1/word not +2).
- Assignment recommendation reason: resolves stage name from workspace_state instead of embedding raw stage_id.
- Negotiation no-rejection fallback: `fallback_current_owner` now uses actual task owner instead of defaulting to first member.
- `prompts.py`: `AgentEventType.assign` added to stage/task filter set so assign events only send active-stage data to LLM.
- `agent_flow_service.py`: Phase 27 briefly persisted `AssignmentNegotiationOutput` as AgentProposals; Phase 29 supersedes this by keeping negotiate output timeline-only because generic proposal confirmation cannot apply negotiation payloads.
- `_build_user_facing_assignment`: merged single-member and multi-member branches into unified flow with conditional fragments.
- `create_assignment_response` / `create_assignment_negotiation_from_proposal`: error messages use safe enum display (`.value`) and Chinese text.
- Test baseline: 218 backend / 24 frontend (unchanged, all passing).

### Phase 18 — Frontend Bugfix (2026-05-30)

- Fixed DirectionCard type field names to match backend: `target_users/core_value/constraints/out_of_scope/initial_risks` → `users/value/boundaries/risks/suggested_questions`.
- Fixed "页面暂时不可用" crash after confirming Agent proposals: DirectionCardPanel was calling `.map()` on undefined fields due to field name mismatch, triggering Next.js error boundary.
- Rewrote DirectionCardPanel with `safeStringList()` defensive rendering and full field display (deliverables, boundaries, risks, suggested questions).
- Added defensive `proposals ?? []` in AgentProposalPanel to prevent undefined crashes.
- Increased frontend API timeout from 30s to 120s (matching backend LLM timeout).
- Updated test data: `project-dashboard.test.tsx` DirectionCard field names aligned + `agent_proposals: []` added; `api.test.ts` added `agent-proposals` endpoint mock.
- Frontend test baseline: 7 tests passing across 3 files (was 5).

Implemented scope:

- Repository guardrails in `AGENTS.md` and `CLAUDE.md`.
- Root `README.md` with local setup and verification commands.
- Backend FastAPI scaffold with `GET /api/health`.
- Backend config and SQLite engine skeleton.
- Backend smoke test for health API.
- Frontend Next.js scaffold with a first ProjectFlow screen.
- Frontend API helper and type placeholders.
- Frontend test, lint, and production build setup.
- Runtime ignore rules for secrets, local databases, dependency folders, and generated caches.
- All 19 persistence tables/domain models in `backend/app/models/` with full enum alignment, including `AgentProposal`.
- Database auto-creates tables on FastAPI startup via lifespan.
- 12 model smoke tests covering insert/read for every model.
- Full CRUD APIs: users, workspaces, invitations, member-profiles, projects, resources, stages, tasks.
- WorkspaceState assembly endpoint: `GET /api/workspaces/{id}/state`.
- Service layer for all CRUD domains in `backend/app/services/`.
- Pydantic schemas for all CRUD domains in `backend/app/schemas/`.
- Agent infrastructure in `backend/app/agent/`: coordinator, workflow, prompts, LLM client, structured output schemas, module request builders, JSON repair/retry/template fallback, and AgentEvent timeline logging.
- 9 API smoke tests covering full demo path and list endpoints.
- Backend execution-loop APIs for assignment proposals/responses/finalization/negotiation, action cards, check-in cycles/responses, risks, confirmed replans, and agent endpoints.
- LLM diagnostic endpoints for current settings and one-off provider checks.
- Agent proposal confirm/reject APIs for clarify, plan, and breakdown outputs.

### GitHub issue #21 (2026-05-30)

- Fixed 3 stale frontend test assertions (English labels → Chinese UI labels) in `project-dashboard.test.tsx` and `projectflow-home.test.tsx`.
- Frontend test baseline: 5 tests passing across 3 files (was 3 failures).
- Updated `docs/runbook.md` with comprehensive LLM Provider Modes section (mock mode and real-provider mode configuration, behavior, and verification).
- Added Manual Verification Checklist covering the full MVP flow: account setup, workspace, project intake, clarification, planning, breakdown, assignment, active push, check-in, risk analysis, replan, timeline, export, demo reset, and real-provider mode verification.
- Added Final Status Report to runbook: what is truly usable (18 features), what remains fallback (3 areas), and what is out of scope for MVP (11 areas).
- Updated verification baseline in handoff to reflect all tests passing.

### GitHub issue #6 (2026-05-29)

- App shell with responsive navigation (desktop links + mobile hamburger sheet).
- Onboarding flow: account setup form with real-time validation, member profile wizard (3-step: basic info / skills & experience / availability) with completion bar and popular skill suggestions.
- Workspace flow: 2-step wizard create workspace form (basic info + team context), invite member panel with copy-link feedback, workspace dashboard with EmptyState.
- Project intake: card-section layout with project type selector (coursework/competition/startup/research), deliverable tag input, real-time validation, and localStorage draft auto-save. Resource input panel with collapsible animation.
- Full domain types in `frontend/src/lib/types.ts` (User, Workspace, MemberProfile, Project, Stage, Task, Assignment, CheckIn, Risk, ActionCard, AgentEvent, etc.).
- Full API layer in `frontend/src/lib/api.ts` (users, workspaces, invitations, profiles, projects, resources, agent, assignments, checkins, tasks, export).
- shadcn/ui installed with 16 base components + 6 custom UI components (FormSection, TagInput, FormField, StepIndicator, CompletionBar, EmptyState).
- Tailwind config updated with CSS variable colors for shadcn/ui compatibility.

### GitHub issue #7 (2026-05-29)

- Project dashboard now surfaces the planning and assignment flow: current stage, next action, clarification/direction card, stage plan, task breakdown, assignment proposal, member responses, negotiation, and final confirmation sections.
- `frontend/src/app/projects/[projectId]/page.tsx` now delegates rendering to `ProjectDashboard` and keeps page logic focused on loading state and event handlers.
- `frontend/src/lib/api.ts` loads `getProjectState` from `GET /api/projects/{project_id}/state` first and uses split endpoint composition only as a 404 fallback.
- `frontend/src/lib/types.ts` now includes assignment responses and negotiations in `ProjectState`.
- Focused frontend tests cover empty, populated, and API-failure dashboard states.

### GitHub issue #8 (2026-05-29)

- Added backend routes and services for assignment proposals, member responses, finalization, and negotiation.
- Added backend routes and services for action cards, check-in cycles/responses, risks, and confirmed replans.
- Added agent HTTP endpoints for clarify, plan, breakdown, assign, active push, check-in analysis, risk analysis, and replan.
- Extended task status updates with `available_hours_change`.
- Added backend tests for assignment flow, check-in/risk/replan flow, and agent endpoints.
- Local SQLite databases created before `AgentEvent.status` may need the runbook schema drift repair before agent timeline writes.

### GitHub issues #9-#11 (2026-05-29)

- Dashboard execution tabs are wired to implemented backend endpoints for action cards, check-in submission, task status updates, risks, timeline, and review export.
- Frontend API paths now use the actual workspace-scoped agent routes and flat assignment/check-in/action/risk routes.
- Added backend review-summary export endpoint and timeline listing endpoint.
- Added `POST /api/demo/reset` compatibility endpoint for the dashboard reset button.
- Added `docs/demo-script.md` and `docs/seed-scenarios.md`.
- Added regression tests for demo reset/export and frontend API route alignment.
- Demo seed data module (`backend/app/seed/demo_projectflow.py`) creates a realistic 6-member student team with full project data: workspace, memberships, invitations, member profiles, project with direction card, resources, 4 stages, 10 tasks, 3 assignment proposals, check-in cycle with responses (including blocker), 3 risks, 5 action cards, and 5 agent timeline events.
- Demo reset module (`backend/app/seed/reset.py`) clears all tables in dependency order.
- Seed API endpoints: `POST /api/seed/demo` (reset + seed) and `POST /api/seed/reset`.
- Review summary export endpoint: `POST /api/projects/{project_id}/export/review-summary` generates Markdown with product positioning, current state, stages, tasks, team, risks, action cards, check-ins, and agent timeline.
- Frontend API functions: `loadDemoSeed()` and `resetDemoData()` added to `api.ts`.
- Documentation: `docs/demo-script.md` (5-minute demo path), `docs/seed-scenarios.md` (blocker/availability-change scenario), `docs/runbook.md` updated with seed/reset/export instructions.
- 15 new tests for seed, reset, and export endpoints.

### GitHub issue #18 (2026-05-29)

- DirectionCardOutput schema replaced `summary`/`target_outcome`/`constraints` with `problem`/`users`/`value`/`deliverables`/`boundaries`/`risks` per acceptance criteria.
- AGENT_SYSTEM_PROMPT expanded with WorkspaceState structure guidance and 5 state-grounding rules.
- All 8 module user_prompts rewritten with explicit instructions to cite specific skills, availability, blockers, task status, priorities, and deadlines.
- `_validate_references` extended with `_validate_evidence_ids` to check RiskProposal.evidence for fabricated task_id/stage_id.
- Tests: added messy project fixture (4 members, 3 stages, 6 tasks with blocked/overdue/unassigned), 7 new test cases for representative model outputs and fabrication rejection. These tests are included in the current backend baseline.

### GitHub issue #20 (2026-05-29)

- AssignmentRecommendationItem schema: added `skill_match`, `availability_match`, `preference_match`, `constraint_respected` for structured citation of why a member was recommended.
- ActionCardProposal schema: added `goal`, `start_suggestion`, `completion_standard` so push cards specify what they achieve, how to start, and how to know they're done.
- AssignmentProposal model and AssignmentProposalCreate/Read schemas updated with the 4 citation fields. ActionCard model and ActionCardCreate/Read schemas updated with the 3 new fields.
- Agent module prompts upgraded: assignment_recommendation requires filling all citation fields; active_push requires goal/start_suggestion/completion_standard; risk_analysis requires structured evidence dicts with detail field; replanning requires action cards to include goal/start_suggestion/completion_standard and forbids owner changes on finalized assignments.
- Fallback payloads now cite real member data from workspace_state instead of generic placeholders.
- Replan service guard: `confirm_replan` now rejects `owner_user_id` changes for tasks that have a finalized AssignmentProposal. Non-ownership changes (due_date, can_cut, status) are still allowed.
- Frontend: ActionCardItem displays goal, start_suggestion ("Start:"), completion_standard ("Done when:"). RiskCard renders structured evidence dicts (key:value pairs + detail). ReplanDiff shows proposal metadata section with before/after comparison, impact, reason, and "Needs confirmation" badge. AssignmentFlowPanel shows citation fields (Skill/Availability/Preference/Constraint) when present.
- Frontend types.ts: ActionCard and AssignmentProposal types updated with new optional fields.
- Tests: 11 new tests in `test_usability_pass_20.py` covering structured citations, push card fields, risk evidence, replan proposal, finalized-assignment guard, and fallback citations. These tests are included in the current backend baseline.

### GitHub issue #16 (2026-05-29)

- Added `GET /api/llm/diagnostic` for checking the configured provider without exposing secrets.
- Added `POST /api/llm/diagnostic` for one-off provider diagnostics using non-secret runtime payload overrides.
- Added `LLM_TIMEOUT_SECONDS` support in backend configuration and documentation.
- Diagnostic responses report `mock`, `ok`, or `error` status and never return the API key.
- Backend provider tests are part of the current 146-test baseline.

### GitHub issue #17 (2026-05-29)

- Added `AgentProposal` persistence for high-impact clarify, plan, and breakdown outputs.
- Clarify/plan/breakdown agent endpoints now return `proposal_id` and do not directly mutate project state.
- Added `GET /api/agent-proposals`, `GET /api/agent-proposals/{proposal_id}`, `POST /api/agent-proposals/{proposal_id}/confirm`, and `POST /api/agent-proposals/{proposal_id}/reject`.
- Confirming an agent proposal persists the payload to `Project.direction_card`, `Stage`, or `Task` records depending on proposal type.
- Confirmation updates the source `AgentEvent.user_confirmed` and creates timeline evidence.

### T42 — ProjectMemory V1 Remediation (Bat A–D, 2026-07-10)

All 6 remediation slices (R1–R6, R8) completed. R7 (optional vector) remains separate project. See `docs/T42/project-memory-v1-closure.md` and `docs/T42/project-memory-v1-remediation-plan.md`.

**Key files:** `backend/app/agent/memory/ab_eval.py`, `backend/app/agent/memory/query_normalizer.py`, `backend/app/agent/memory/retrieval_eval.py`, `backend/app/services/memory_service.py`, `backend/app/api/routes_memories.py`, `backend/app/tests/test_ab_eval.py`

## Verification Baseline

Latest deterministic verification baseline after the 2026-07-14 UX/Runtime polish (T44/T45 canary hardening plus settings, slash chips, and composer steering):

```bash
cd backend
.venv\Scripts\python -m pytest app/tests/ -v
```

```bash
cd frontend
npm run test
npm run lint
npm run build
npm audit --omit=dev
```

Results:

- Backend: 852 tests passed, 4 skipped; Ruff passed.
- Agent-bridge: 1142 tests passed across 58 files; typecheck/build passed.
- Frontend tests: 196 passed across 19 files.
- Frontend lint and production build passed.
- Frontend build passed.
- Frontend production dependency audit reported 0 vulnerabilities.

## Current Implementation Surface

Backend:

- Implemented routes: 91 business endpoint method/path pairs (80 `/api`, 11 `/internal`) covering public domains plus conversations, ProjectMemory and the sidecar runtime/tool contract.
- Domain models/persistence tables implemented (21 tables, all enums).
- AgentEvent now records `status` for success, repaired, fallback, or failed agent runs.
- AgentProposal stores pending clarify/plan/breakdown/replan outputs; confirmation persists to project state.
- Negotiate agent output is timeline-only and does not create generic AgentProposal records.
- Service layer implemented for all CRUD domains plus assignment, action-card, check-in, risk, replan, agent-flow orchestration, and agent-proposal confirm/reject.
- Pydantic schemas implemented for all CRUD and execution-loop domains.
- WorkspaceState endpoint returns members, project, stages, tasks, assignment/check-in context, project resources, and current date/time/timezone for Agent consumption.
- Agent infrastructure can run with `LLM_PROVIDER=mock` by default, or OpenAI-compatible chat-completions settings through environment variables. Agent HTTP endpoints return `proposal_id` where applicable and persist structured outputs and created entity IDs through service-layer writes.
- AgentConversation supports multiple project conversations with creator/title/visibility, safe legacy migration, viewer-scoped private/team access, summary lists and stable message pagination.

Frontend:

- Implemented routes: `/`, `/onboarding`, `/onboarding/profile`, `/workspaces/new`, `/workspaces/[workspaceId]`; project/view/conversation selection is query-driven inside the workspace route.
- Agent proposal panel and right Agent sidebar show whether each run succeeded, was repaired, used fallback, or failed.
- API base URL comes from `NEXT_PUBLIC_API_BASE_URL` or defaults to `http://localhost:8000/api`.
- All API calls go through `frontend/src/lib/api.ts`.
- All types defined in `frontend/src/lib/types.ts`.
- Navigation: 首页 / 工作台（自动检测 workspace ID）/ 新建项目。Onboarding 不再常驻导航。
- Project page uses three-column layout: `ProjectSidebar` (workspace/project nav), `ProjectContent` (center content), `AgentSidebar` (right panel).
- 首页智能重定向：有 workspace 记录则先验证该 workspace 是否仍存在于后端，存在则跳转工作台，不存在则自动清除 localStorage 记录并展示欢迎页 + "加载演示数据"按钮。
- Project dashboard composes project, workspace, resources, stages, tasks, users, profiles, action cards, check-ins, risks, replan diff, agent timeline, and export from implemented endpoints. Agent 操作按状态机 4 阶段分组（规划/分工/执行/监控），当前阶段高亮，自动推荐下一步。
- UI 语言统一中文。表单组件统一使用 shadcn/ui（Input、Select、Textarea）。
- RiskPanel 支持状态过滤（全部/待处理/已接受/已忽略/已解决）。
- localStorage 读取使用 `useSyncExternalStore` 避免 hydration mismatch。
- UI components use shadcn/ui with project color tokens. Form components unified through FormField wrapper (label + input + error + hint).
- Agent sidebar supports new/private conversations, accessible history selection, URL restoration and streaming-safe switching.

### Phase 17 — Code Review Hardening (2026-05-30)

### Phase 19 — Agent Prompt Refactor (2026-05-31)

- `prompts.py` rewritten: replaced 8 module-level `user_prompt` strings with centralized `OUTPUT_CONTRACT_BY_EVENT_TYPE` dict defining precise JSON schema requirements per event type.
- Added `_compact_member()` / `_compact_workspace_state_json()` for differential workspace state serialization (e.g., assign needs member IDs + interests, clarify doesn't; breakdown/push/checkin/risk/replan only serialize current stage tasks).
- Added `_without_none()` recursive None-value stripping to reduce token consumption.
- `build_prompt_messages()` unified: system + user message with `<output_schema>` and `<workspace_state>` XML tag isolation.
- `workflow.py`: added `_fallback_after_provider_error()` for provider timeout/connection errors; `_max_tokens_for_event_type()` per-event-type token limits (900-1600); rewritten `_repair_json_text()` with layered repair (original → code block strip → JSON extract → trailing comma → single-quote → regex key/value).
- `llm_client.py`: added 5 error subclasses (`LLMConfigurationError`, `LLMAuthError`, `LLMTimeoutError`, `LLMConnectionError`, `LLMResponseError`) with `provider` and `detail` attributes; added `build_agent_llm_client()` factory using `llm_agent_timeout_seconds` (120s) for Agent generation vs `llm_timeout_seconds` (30s) for diagnostics.
- `config.py`: added `llm_agent_timeout_seconds: PositiveFloat = 120.0`.
- `project_service.py`: added `normalize_direction_card()` for field name migration (`target_users/core_value/constraints/out_of_scope/initial_risks` → `users/value/boundaries/risks/suggested_questions`).
- `workspace_state_service.py`: complete `get_workspace_state()` implementation with JSON deserialization helpers.
- `workspace_state.py` schemas: defined `MemberState`, `StageState`, `TaskState`, `ProjectState`, `WorkspaceStateResponse`.
- Frontend: `api.ts` timeout 120s with `AbortController`, JSON parse protection; `types.ts` DirectionCard fields aligned; `constants.ts` homepage static data.
- New test files: `action-card.test.tsx`, `task-status-update.test.tsx`.
- Backend test additions: `test_agent_workflow.py`, `test_llm_provider.py`, `test_seed_reset_export.py` expanded.

### Phase 22 — T23.A Feedback Fixes (2026-06-02)

Fixes applied from the T23.A test audit (see `docs/T23/T23.A.md`):

**Blockers fixed:**
- **Agent 提案拒绝 422** (`A-17`): `POST /agent-proposals/{id}/reject` body 改为可选，`reject_proposal()` 接受 `reason | None`，前端 `rejectAgentProposal()` 发送空 body 不再报错。
- **阶段计划确认后首个阶段 inactive** (`A-13/A-14`): `_persist_stage_plan()` 确认阶段计划时自动激活第一个 stage，并更新 `project.current_stage_id` + `project.status=active`。
- **项目资源面板缺失** (`A-9`): 新增 `ProjectResourcesPanel` 组件，项目仪表盘展示已有资源 + 添加资源表单（文本/链接），API 已新增 `addResource` 支持。

**Experience fixes:**
- **创建页不暴露原始 UUID** (`A-5`, `A-8`): `AccountSetupForm` 移除原始 user UUID 显示，`WorkspaceCreateForm` / `ProjectIntakeForm` 移除所有者 UUID 显示。
- **favicon 404** (`A-1`): 添加 `public/favicon.svg` + `layout.tsx` 引用。
- **导航 workspace 同步** (`A-17`): 项目页 `setLastWorkspaceId()` 在 workspace 变更时写入，`AppShell` 增加 localStorage 事件监听同步导航链接。
- **成员管理展示技能** (`A-6/A-7`): `MemberManagementDialog` 成员列表增加技能 badge 展示。
- **Agent fallback 中文** (`A-10/A-11`): `breakdown.py` / `clarification.py` / `planning.py` fallback 模板改为中文；`common.py` 新增 `project_name_or_default()` / `project_idea_or_default()` / `first_stage_name_or_default()` / `stage_windows()` 公共函数，fallback 阶段计划现在生成 3 个中文阶段。
- **方向卡项目状态更新** (`A-8`): 确认方向卡后 project.status 从 draft → active。

**Test additions:**
- `test_agent_modules.py`: Agent 模块 fallback 中文验证
- `test_agent_proposal_confirm.py`: 提案拒绝空 body 兼容、阶段激活验证
- `conftest.py`: 新增 Agent 模块测试 fixtures

### Phase 23 — Code Review Hardening (2026-06-02)

Code review of PR #28 identified and fixed 10 issues (2 Critical, 3 High, 5 Medium/Low):

**Critical/High fixes:**
- **isValidating 死代码** (`projectflow-home.tsx`): `setIsValidating(true)` 从未调用，首页 workspace 验证 loading 状态完全无效。修复：在验证前设置 `isValidating=true`。
- **AbortController.signal 未传递** (`projectflow-home.tsx`): `fetch(url)` 未传 `{ signal }`，cleanup 的 abort 是空操作。修复：传入 signal 并处理 AbortError。
- **confirmed_by 未校验** (`agent_proposal_service.py`): 传入不存在的 user ID 触发 IntegrityError → 500。修复：添加 `require_row(session, User, confirmed_by, "User")`。
- **rejection_reason 丢弃** (`agent_proposal_service.py`): reject 接口接收 reason 但不存储。修复：AgentProposal 模型新增 `rejection_reason` 列，reject 时持久化，API 响应包含该字段。
- **next-env.d.ts dev 路径**: 还原为 `.next/types/routes.d.ts`。

**Medium/Low fixes:**
- 资源面板：添加 aria-label、local error state、catch handler
- skill badge key：`key={skill.name}` → `key={name}-{level}-{i}` 避免重复
- account-setup-form：`listUsers` effect 添加 cleanup flag
- workspace-create-form：submit 时同时验证 step 0 和 step 1
- layout.tsx：metadata description 改为中文
- planning fallback：空 deliverables 加 `or` 兜底
- breakdown fallback：空 stage_id 改为 `"unassigned"`
- test conftest：confirm 测试 fixture 补齐 JSON serializer
- 新增测试：`test_confirm_plan_does_not_duplicate_active_stage`
- README：修复 `T23.A.feedback.md` 断链

### Phase 20 — Workspace Member Management (2026-05-31)

- 工作台成员管理: 列表查看、添加、编辑、删除成员。

### Phase 21 — Test Docs + User Switcher (2026-05-31)

- Added `docs/T23/` with 4 test documents (T23.A cold-start + planning, T23.B assignment + negotiation, T23.C execution + check-in, T23.D risk + replan + export) covering the full MVP flow with step-by-step instructions, verification checklists, and horizontal evaluation criteria.
- Added user identity switcher in navigation bar: `useCurrentUserId()` / `setCurrentUserId()` / `setWorkspaceMembers()` in `app-shell.tsx` using `useSyncExternalStore` + localStorage.
- Project dashboard `currentUserId` now reads from localStorage (user switcher) with fallback to `project.created_by`.
- Project page auto-populates workspace members into localStorage on load, enabling the switcher dropdown.
- Test documents updated to reference the user switcher instead of API-based multi-member operations.

### Phase 24 — Agent Output Quality + Bug Fixes (2026-06-03)

T23.C full verification with real LLM (DeepSeek V4-pro) drove 4 blocking bugs to resolution and unified Agent output quality across all modules.

**Blocking bugs fixed (4):**

- **BUG-004 (sign-in analysis can't detect blocker)**: `_compact_workspace_state_json` now serializes `checkin_responses` for checkin events. `workflow.py:_max_tokens_for_event` increased 2-4x (checkin 900→4000, etc.) to accommodate reasoning model `reasoning_tokens` overhead. `output_schemas.py:RiskProposal.evidence` relaxed from `list[dict]` to `list[str | dict]` to match LLM output behavior. `checkin_analysis.py` fallback now dynamically detects blockers from workspace state.
- **BUG-005 (manual task status update doesn't change Task.status)**: `create_status_update` now accepts `task_id` as a positional parameter and synchronizes `Task.status` in the same transaction. `TaskStatusUpdateCreate` schema removed the `task_id` field (set by route from URL path). Call sites in `agent_flow_service.py` and `routes_tasks.py` adapted.
- **BUG-008 (Agent uses raw IDs in user-facing text)**: `AGENT_SYSTEM_PROMPT` now mandates "Never use raw IDs — use member display names and task titles". `_compact_member` gained `include_name` parameter: push/checkin/risk/replan now include `name` (display_name) in workspace state. Checkin responses serialized with `member_name` + `task_title` instead of bare `user_id`/`task_id`. All module `user_prompt`s (active_push, checkin_analysis, risk_analysis, replanning) updated to forbid internal IDs in visible text.
- **BUG-009 (Agent output mixed Chinese/English)**: `AGENT_SYSTEM_PROMPT` now requires "ALL user-facing text MUST be written in Chinese". `OUTPUT_CONTRACT` push entry and all module `user_prompt`s (active_push, risk_analysis, replanning) explicitly added this requirement.

**Frontend improvements:**

- Action card allocation simplified from type-whitelist to user_id-based: cards with no `user_id` always go to team panel; cards with `user_id` always go to personal panel. `TEAM_CARD_TYPES` whitelist removed.
- `ActionCardItem` gained `canOperate` prop (default true); team actions panel passes `canOperate={isCreator}` for permission gating.

**Documentation:**

- `T23.C.feedback.md` created in `docs/T23/` with all identified bugs (BUG-001 through BUG-009), root cause analysis, fix records, and fix status. BUG-002 and BUG-003 removed (superseded); bugs renumbered to close gaps.

Full codebase review identified 56 issues across backend and frontend. Fixed 18 issues (all P0/P1/P2 that were confirmed real), leaving 2 P0 + 9 P1 + 10 P2 for post-MVP.

Fixes applied:

- **Transaction atomicity**: `workspace_service`, `invitation_service`, `agent_flow_service`, `assignment_service` now use `flush()` + single `session.commit()` instead of multiple independent commits. Sub-service functions accept `auto_commit=False` to let callers control transaction boundaries.
- **Double JSON serialization**: Removed redundant `json.dumps()` calls in `member_profile_service` (skills), `risk_service` (evidence), and `project_service` (direction_card) that produced corrupted escaped strings like `"\"skill\""`.
- **SecretStr for config**: `llm_api_key` in `core/config.py` changed from `str | None` to `SecretStr | None`; `llm_timeout_seconds` changed to `PositiveFloat`. `llm_client.py` and `llm_service.py` updated to use `.get_secret_value()`.
- **Diagnostic request hardening**: `POST /api/llm/diagnostic` no longer accepts runtime `api_key` payloads; real-provider checks must use `LLM_API_KEY` from environment config.
- **Demo admin guard**: destructive seed/reset/demo-reset endpoints remain open in development, but require `X-ProjectFlow-Admin-Token` matching `DEMO_ADMIN_TOKEN` outside development.
- **Prompt injection protection**: `prompts.py` wraps `workspace_state` JSON in XML tags (`<workspace_state>...</workspace_state>`) to isolate user data from LLM instructions.
- **Fallback safety**: `assignment_recommendation`, `active_push`, `assignment_negotiation`, and `checkin_analysis` modules now return empty lists instead of payloads with `None` IDs when fallback data is incomplete.
- **Schema type tightening**: `skills: list | dict` → `list[str | dict]`, `evidence: list | dict` → `list[str | dict]`, `dependency_ids: dict | list` → `list[str]`, `acceptance_criteria: dict | list` → `list[str]`, `done_criteria: dict | list` → `list[str]`, `available_hours_per_week: int` → `float`.
- **Global error handler**: `main.py` adds `@app.exception_handler(Exception)` to prevent stack trace leaks, CORS middleware tightened to explicit methods/headers, lifespan error handling added.
- **Database session safety**: `get_session()` in `core/database.py` now has explicit `session.rollback()` on exception before re-raising.
- **JSON repair in workflow**: `_repair_json_text` rewritten with layered approach: try original → try brute single-quote replacement → try regex key/value replacement. Trailing comma cleanup added.
- **LLM error propagation**: `workflow.py` now catches `LLMError` separately and re-raises it to ensure network errors reach the fallback path.
- **Frontend request safety**: `api.ts` `request<T>` now uses `AbortController` with 30s timeout, JSON parse protection, and proper headers merging. `acceptInvitation` and `finalizeAssignments` now pass their actual parameters.
- **Shared utility**: `core/db_utils.py` extracted `require_row()` to replace duplicated `_require` functions across 6 service files.
- **Invitation accept**: `accept_invitation` now accepts `user_id` parameter; creates a User record when no user_id is provided instead of using a placeholder.

Verification: backend 218/218 tests pass; frontend 24/24 tests pass; frontend lint and build pass.

Unfixed issues documented in `.trae/documents/code-review-unfixed-issues.md`.

### Phase 25 — T23.D Feedback Fixes (2026-06-03)

T23.D feedback fixes closed the risk -> replan -> confirm/reject -> push/checkin/risk loop breakpoints found in `docs/T23/T23D.feedback.md`.

- Replan agent output now creates pending `AgentProposal(proposal_type="replan")` records and is confirmed/rejected through the same `/api/agent-proposals/{id}/confirm|reject` lifecycle as clarify/plan/breakdown.
- Confirming a replan proposal delegates to `confirm_replan()` in one transaction and can apply stage adjustments, task changes, and action cards; rejecting keeps project state unchanged.
- Replan fallback now derives a minimal actionable proposal from check-in blockers when evidence exists: at most one stage adjustment, one task change, and one risk-action card.
- Risk analysis prompt/contract allows up to 3 evidence-grounded risks, while empty-data fallback still returns no fabricated risks.
- Frontend risk cards show high-risk confirmation semantics, allow accepted -> resolved, and render structured evidence as readable Chinese without raw JSON/internal IDs.
- `ReplanDiff` displays the latest pending replan proposal with before/after, impact, reason, stage/task/action details, change-count badges, and confirm/reject controls.
- Agent timeline and run result UI show `success`, `repaired`, `fallback`, and `failed` distinctly.
- Review export renders enum values and structured evidence as readable Markdown without `None`/`null`/Python enum reprs.

Verification: backend 218/218 tests pass; frontend 24/24 tests pass; frontend lint and build pass.

### Phase 26 — T23.B Round 2 Feedback Fixes (2026-06-03)

T23.B second-round fixes after real LLM (GLM-5.1 via openai-compatible) re-testing. 6 IRs plus 2 follow-on items:

- **IR1 Skill name normalization**: `SKILL_NAME_CN_MAP` in `common.py` maps 12 English skill names to Chinese labels. `_normalize_user_facing_text()` in `output_schemas.py` replaces English underscores in assignment user-facing fields. Prompt updated to prefer Chinese labels.
- **IR2 JSON strictness**: `temperature` lowered from 0.2 to 0.05. System prompt strengthened with explicit JSON-only instruction.
- **IR3 Negotiate endpoint**: `POST /api/agent/negotiate` exposed in `routes_agent.py`. Frontend `runAgentNegotiate()` added to `api.ts`.
- **IR4 Stage override**: `AgentFlowRequest.stage_id` allows assignment recommendation for non-active stages. `assignable_tasks()` accepts `stage_id` override. Frontend `runAssignment()` accepts optional `stageId`.
- **IR5 Test isolation**: `conftest.py` forces `LLM_API_KEY=""` instead of popping env var, preventing real `.env` leakage into mock tests.
- **IR6 Documentation**: T23.B seed data counts aligned with actual demo seed.
- **P0 stage_id validation threading**: `coordinator.recommend_assignments()` copies workspace_state with `current_stage_id` overridden to target stage before passing to `_run()`, so `_validate_references` enforces rules against the correct stage.
- **P1 negotiation context**: `assignment_negotiation.build_request()` rewritten to include rejected proposals, reasons, preferred tasks, pending negotiations, and member summaries in the prompt. Fallback derived from actual rejected proposal data.
- **Negotiation fallback bugfix**: `current_owner_user_id` correctly set to `None` when preferred task is unassigned (was incorrectly falling back to `fallback_from_user`).

Verification: backend 218/218 tests pass; frontend 24/24 tests pass; frontend lint and build pass.

## Next Work

T41-T45 deterministic implementation and the repeated post-T44 production canary are complete. Flash remains the default; Pro is an explicit quality escalation rather than automatic same-provider fallback. A future routing change still requires its own product criteria and evidence.

The main accepted limitation is free-text member constraints: `constraint_respected` proves that the Agent supplied review evidence, not that the proposed assignment is semantically compliant. A stronger guarantee requires a structured constraint model and deterministic task/constraint matching. A second bounded optimization candidate is a compact workspace read view: one post-fix Pro risk observation still paged a large `get_workspace_state` result, although it remained within the latency gate. Post-MVP backlog also includes auth, deployment, collaboration permissions and broader UI hardening.

## Additional Completed Phases

### Phase 29 — UI Critique Fixes (2026-06-04)

Impeccable critique review of project sidebar and 8 views (overview/direction/stages/my-tasks/team-tasks/checkin/risks/retro). Score: 31/40 (Good).

**Fixes applied:**
- **Uppercase eyebrow removal (4 locations)**: `agent-sidebar.tsx` ("所有操作"/"最近活动" headers), `workspace-content.tsx` ("工作区" header), `new/page.tsx` ("ProjectFlow" brand text). Removed `uppercase tracking-wider` / `uppercase tracking-[0.18em]` per impeccable absolute ban on SaaS-template AI slop. Note: the "最近活动" section itself was later removed on 2026-07-14 as part of AgentSidebar cleanup.
- **Ghost-card removal (3 locations)**: `workspace-content.tsx` StatCard `prominent` shadow removed; two Card components (`成员`/`项目` panels) shadow-sm removed. Border-only cards per impeccable rule (no border+shadow decoration).
- **Workspace noise reduction**: Removed "暂无其他工作区" gray placeholder text from sidebar workspace dropdown.
- **Disabled state clarity**: Sidebar disabled menu items now use `opacity-60` for clear visual distinction from active items.
- **Direction card description**: Updated from "项目目标和方向澄清" to "明确项目目标、边界和关键决策" for better first-time user comprehension.

**Verification**: frontend lint pass, frontend build pass.

### Phase 30 — Workspace Page Critique Fixes (2026-06-04)

Impeccable critique review of workspace page (`workspace-content.tsx`). Initial score: 25/40 (Acceptable); post-fix score: 30/40 (Good).

**Round 1 fixes applied:**
- **P0 — Native `<select>` replacement**: `member-management-dialog.tsx` skill level selector changed from native `<select>` to shadcn `<Select>` component for form consistency and keyboard accessibility.
- **P1 — Search/filter for members and projects**: Added `Input` search boxes to both members and projects panels with real-time filtering by name/role.
- **P1 — Member list click interaction**: Member `<li>` items now have `cursor-pointer` and `onClick` opening the member management dialog.
- **P2 — Technical placeholder fixed**: `project-intake-form.tsx` `createdBy` placeholder changed from "UUID of project creator" to "选填，默认使用当前用户".
- **P2 — Delete confirmation softened**: Copy changed from "此操作不可恢复" to "该成员的分工记录将保留，但无法再访问此工作区"; cancel button relabeled from "取消" to "保留成员".
- **Minor — activeProjects filter semantics**: Filter changed from `!== "completed"` to `=== "active"` for accurate "活跃项目" count.
- **Minor — StatCard visual hierarchy**: Removed redundant `prominent` prop from "活跃项目" and "已完成" cards; only "团队成员" remains prominent.
- **Minor — Dead state cleanup**: Removed unused `refreshKey` state and its setters from `WorkspaceContent`.
- **Accessibility**: Added `aria-label={`打开项目 ${p.name}`}` to project card buttons.

**Round 2 fixes applied:**
- **P2 — Error hint visual hierarchy**: All field-level errors in `member-management-dialog.tsx` now use unified `bg-destructive/10` background + `AlertTriangle` icon + rounded container, matching the dialog-level error style.
- **P2 — StatCard action links**: Added `action` prop to `StatCard`; "活跃项目" and "已完成" cards display "查看项目"/"查看归档" links when count > 0.
- **P3 — Skill badge truncation removed**: Member list in dialog now shows all skills (removed `.slice(0, 4)`); badge key deduplicated.
- **Minor — Uppercase eyebrow removed**: Workspace header "工作区" label no longer uses `uppercase tracking-wider`.
- **Minor — Ghost-card pattern eliminated**: Removed `shadow-sm` from `StatCard` (border-only); added explicit `bg-white` to project list buttons.
- **Minor — Header density improved**: Reduced `mb-8` to `mb-6`, tightened description margin, simplified default copy by removing "Agent" jargon.

**Verification**: frontend lint pass, frontend build pass (Next.js 16.2.6 + Turbopack).

MVP Usable progress (see `.claude/epics/projectflow-mvp-usable-ready/`):
- ✅ #18 Prompt and Schema Quality Hardening (2026-05-29)
- ✅ #20 Assignment, Push, Risk, and Replan Usability Pass (2026-05-29)
- ✅ #16 Real LLM Provider Readiness and Diagnostics (2026-05-29)
- ✅ #17 Agent Output Persistence and Confirmation (2026-05-29)
- ✅ #19 Frontend Agent Status and Review UX (2026-05-30)
- ✅ #21 Real-Provider Verification and MVP Usable Runbook (2026-05-30)

All MVP Usable tasks are complete. The runbook now documents mock mode, real-provider mode, a full manual verification checklist, and a final status report.

### Phase 35 — Onboarding & Member Form Improvements (2026-06-05, PR #33)

Frontend UX improvements for onboarding and member management forms.

**Changes:**
- Popular skill click fills input field instead of auto-adding at Lv.3.
- Member management dialog added major, grade, preferredTime (required), pastProjects fields.
- Available hours input: `type="number"` replaced with `type="text"` + `inputMode="numeric"` + custom stepper buttons.
- New fields map to existing backend fields (`preferredTime` → `collaboration_preference`; `pastProjects` → `interests` fallback). `major`/`grade` not persisted (no backend fields yet).

**Files modified:** `member-management-dialog.tsx`, `member-profile-wizard.tsx`.

### Phase 33 — Stage Plan Timeline Redesign (2026-06-05)

Redesigned `StagePlanBoard` from card grid to vertical timeline layout.

**Visual changes:**
- Timeline connector line with status icons (completed/check/active/risk/pending) per stage
- Current stage highlighted with `bg-primary/5` background and "当前" badge
- Relative time labels ("还剩 N 天"/"今天截止"/"已延期 N 天") with color-coded urgency
- Inline deliverable and task count (no separate cards)
- Date range displayed with `CalendarDays` icon

**Component structure:**
- Added internal helpers: `StageIcon`, `daysUntil`, `relativeTimeLabel`, `statusClass`, `statusLabel`
- Props unchanged: `stages`, `tasks`, `currentStageId`
- No new dependencies

**Verification:** frontend lint pass, TypeScript type check pass.

T23.A test audit completed (2026-06-02) with feedback documented in `docs/T23/T23.A.md`. 4 blockers, 7 experience issues, and 1 optimization identified. All 4 blocker issues fixed in Phase 22.

T23.B testing completed (2026-06-02 mock round 1, 2026-06-03 real LLM round 2). 8 issues found (B1-B8), 11 items fixed across two rounds (Phase 26). Remaining open: A-18 (真实 LLM 超时兜底链路待补测). T23.C feedback fixes are documented in `docs/T23/T23.C.feedback.md`. T23.D feedback fixes are implemented and documented in `docs/T23/T23D.feedback.md`; a full mock + real-LLM manual rerun of D1-D17 is still pending.

Post-MVP: auth, deployment, collaboration permissions, broader UI hardening, remaining code review issues (2 P0 + 9 P1 + 10 P2 documented in `.trae/documents/code-review-unfixed-issues.md`), and outstanding bugs/feedback tracked in `docs/T23/T23.C.feedback.md` and `docs/T23/T23D.feedback.md`.

## Local Cleanup Notes

Ignored install/build artifacts may exist locally after verification:

- `backend/.venv/`
- `backend/.pytest_cache/`
- Python `__pycache__/`
- `frontend/node_modules/`
- `frontend/.next/`

They are intentionally ignored and must not be committed.

### Phase 38 — My Tasks View Enhancements (2026-06-06)

Enhanced the "我的任务" (My Tasks) view to improve usability and eliminate nested HTML button hydration errors.

**Changes:**
- Removed hover requirement for quick actions on pending tasks; quick actions (start, complete, blocked) are now always visible.
- Added a "..." (MoreHorizontal) DropdownMenu to `TaskRow` for both pending and completed tasks, triggering "签到" (Checkin) and "更新任务状态" (Update Status) actions.
- Checkin and TaskStatusUpdate components are now rendered inside `Dialog` modals triggered by the DropdownMenu instead of inline blocks at the top of the view.
- Added `key={selectedTaskForDialog.id}` to `CheckInForm` and `TaskStatusUpdateList` inside Dialogs to reset form state when switching between tasks.
- Removed duplicated `DialogHeader` from the Checkin Dialog and simplified the internal `CheckInForm` title/description text.
- Unified the "Checkin" dialog style with the "Update Task Status" dialog style by restoring `<DialogHeader>` in the view component and simplifying the form component wrapper.
- Fixed HTML button nesting hydration error caused by `DropdownMenuTrigger asChild` conflicting with the Shadcn `Button` component by applying custom styles directly to the `DropdownMenuTrigger` instead of nesting `<Button>`.

**Files modified:** `project-task-views.tsx`, `checkin-form.tsx`.
