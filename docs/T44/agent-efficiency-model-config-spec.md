# T44 Agent 效率与模型配置完整性 Spec

## Problem Statement

ProjectFlow 的 Agent Harness 已具备持久化运行、工具策略、恢复、验证和生产模型 canary，但当前仍存在会直接影响成本、延迟、可观测性和配置可信度的问题：同一轮用户输入可能被重复送入模型；当前消息又可能重复进入最近历史；运行轨迹没有保留缓存读写和推理 token；多个模型可以同时被标记为默认；用户选择的模型可能没有进入普通对话路径；请求模型无效时可能静默回退而造成审计归因错误；部分 Skill 组合的 effect ceiling 和成员约束在工具执行后才被发现。

用户真正需要的不是一个表面上“缓存率更高”的 Agent，而是一个能够在保持 Proposal-Confirm、ProjectMemory 可见性和业务事实边界不变的前提下，以更少的未缓存输入、更低的成本和更稳定的延迟完成相同结果的 Agent。缓存率只是一项解释指标，不能替代任务成功率、未缓存 token、总成本和隐私正确性。

## Solution

建立从请求准备、Pi runtime、模型解析、Prompt/Context、Skill/Tool policy 到 trajectory/canary 的单一可验证链路：每个当前用户输入只进入模型一次；每次调用都记录真实解析模型、输入/输出/推理/缓存读写 token 和成本；模型配置始终有且只有一个有效默认项；显式模型选择要么被准确执行，要么返回可解释错误；稳定 Prompt 前缀与动态事实后缀分离；紧凑 Outcome Contract 仅在 action mode 注入；Skill effect ceiling、成员约束和业务不变量在工具暴露或持久化前确定性执行。

优化按“先纠正与测量，再改变 Prompt，最后优化工具结构”的顺序交付。任何改动都必须通过固定场景的基线对比，不能以单次 cache hit rate 提升作为验收结论。

## Implementation Status (2026-07-13)

Deterministic implementation is complete:

- `e8bd6e0`: current input is represented exactly once, excluded from recent history, and normalized usage/trajectory evidence distinguishes unavailable cache fields from explicit zero.
- `22b7977`: model configuration enforces one valid default; explicit invalid selections fail; requested and resolved model attribution, fallback reason and supported thinking levels propagate through normal conversation.
- `70bcb99`: Prompt Kernel 2.0 separates stable and dynamic blocks, injects time only when required, emits versioned Context receipts and hashes the assembled system/user/tool payload.
- `6ae1831`: one strictest Skill V2 ceiling now drives Outcome Contract, prompt/trace metadata, manifest exposure, runtime policy and verification. Assignment persistence requires constraint-check evidence for members with stored constraints before adding the proposal row.
- `299c6b9`, `38ffba0` and `bbb4359`: repeated canary observations now provision isolated fixtures and the demo reset clears all runtime/memory tables in foreign-key order.
- `bf5ebab`: usage normalization follows Pi semantics: `input` is already non-cached input, while cache rate uses `cacheRead / (input + cacheRead + cacheWrite)`.
- `1d12236` and `e47d6b4`: risk analysis stops echoing persisted content into the tool loop, and the canonical runner supports bounded scenario reruns.

Validation baseline: backend `825 passed / 4 skipped` plus Ruff; agent bridge `1142 passed` across 58 files plus typecheck/build; frontend `147 passed` across 17 files plus lint/build.

The repeated post-T44 production canary is complete: 15 isolated observations per model passed routing, outcome, privacy and frozen per-scenario latency gates. Flash/Pro cache hit was 93.01%/93.51%; normalized non-cached input per observation fell 85.2%/77.2% and measured cost per observation fell 68.5%/58.8% relative to the accepted pre-T44 baseline. Flash remains the default; Pro remains explicit quality escalation. See `post-t44-production-canary-2026-07-13.md`. Natural-language member constraints remain semantically unverifiable; the shipped gate proves evidence completeness only.

## User Stories

1. As a project member, I want my current message to be sent to the model exactly once, so that I do not pay for duplicated context.
2. As a project member, I want the current message excluded from prior-message history, so that the Agent does not treat one instruction as two turns.
3. As a project member, I want Agent answers to preserve their current quality after context deduplication, so that efficiency does not reduce usefulness.
4. As a project member, I want answer-only requests to avoid unnecessary planning context, so that simple questions remain fast.
5. As a project member, I want action requests to include a concise goal and success criteria, so that multi-step work remains aligned.
6. As a project owner, I want every model call to report input, output, reasoning, cache-read and cache-write tokens, so that cost can be explained.
7. As a project owner, I want uncached input tokens reported directly, so that a high cache percentage cannot hide a bloated prompt.
8. As a project owner, I want cost and latency reported per scenario and model, so that model choices are evidence-based.
9. As a project owner, I want every run to record the actual resolved model, so that telemetry reflects what really executed.
10. As a project owner, I want an explicit fallback reason whenever a requested model cannot be used, so that silent substitution cannot occur.
11. As a project owner, I want exactly one valid default model configuration, so that runtime selection is deterministic.
12. As a project owner, I want invalid or conflicting model configurations rejected before serving traffic, so that configuration errors fail early.
13. As a project member, I want the model selected in the Agent UI to affect normal conversation as well as advanced actions, so that the control is truthful.
14. As a project member, I want unsupported thinking levels clamped or hidden per model, so that selecting a level has predictable behavior.
15. As a project member, I want an automatic model option, so that I am not forced to understand provider details for ordinary use.
16. As a project owner, I want Flash and Pro compared across repeated fixed scenarios, so that one lucky run cannot define routing policy.
17. As a project owner, I want Pro treated as a measured quality escalation rather than same-provider outage recovery, so that fallback semantics stay honest.
18. As a project owner, I want cross-provider models canaried in read-only scenarios before automatic failover, so that side effects are never replayed blindly.
19. As a developer, I want stable Prompt Kernel content ordered before dynamic time, ID mapping and workspace facts, so that provider prefix caching can work.
20. As a developer, I want prompt, context-block, Skill, tool-manifest and model versions recorded in trajectory evidence, so that regressions can be reproduced.
21. As a developer, I want Context Ledger receipts to report rejected and dropped blocks accurately, so that silent context loss is visible.
22. As a project member, I want required constraints preserved when history is compacted, so that long conversations do not drift.
23. As a project owner, I want the strictest composed Skill effect ceiling applied before tools are exposed, so that a less restrictive Skill cannot widen authority.
24. As a project owner, I want member constraints checked before an assignment proposal is persisted, so that invalid drafts never enter review state.
25. As a project owner, I want write tools to remain sequential while safe read-only calls may run concurrently, so that latency improves without weakening invariants.
26. As a developer, I want natural-language Skill routing to have one production authority, so that Python and TypeScript keyword rules cannot drift.
27. As a Skill author, I want reference documents loaded only for the plan step that needs them, so that unused playbooks do not consume context.
28. As a project owner, I want batching introduced only when trajectories prove tool-call count is a bottleneck, so that write semantics are not complicated speculatively.
29. As a project owner, I want every optimization compared against privacy, outcome and verifier gates, so that cost reduction cannot ship a weaker Agent.
30. As a developer, I want provider-specific cache semantics isolated behind usage normalization, so that telemetry remains comparable across providers.

## Implementation Decisions

- Define Agent success as the joint result of outcome pass rate, verifier pass rate, privacy pass rate, uncached input tokens, total cost and latency. Cache hit rate is diagnostic only.
- Ensure request preparation has one canonical current-turn representation. A user message may appear either in the Pi prompt argument or pre-populated Agent context, never both.
- Build recent history before persisting the current user message or explicitly exclude the current message identifier from the history query.
- Extend normalized model usage with input, output, reasoning, cache-read, cache-write and detailed cost fields. Preserve missing-provider semantics as unknown rather than zero when the provider supplies no value.
- Record actual resolved provider/model separately from requested provider/model. A fallback must include a machine-readable reason.
- Require exactly one valid default model during configuration load and mutation. Setting a new default atomically clears the previous default.
- Validate configured models against the installed Pi provider catalog when the provider supports catalog discovery. Validate capabilities, context window, output limit and supported thinking levels without trusting duplicated hand-written flags.
- Propagate model and thinking selection through the public conversation stream request. Keep an automatic mode as the user-facing default and hide or clamp unsupported levels.
- Keep the current effective Flash default during measurement, but do not freeze a permanent Flash-versus-Pro policy until repeated conformance evidence exists.
- Treat Pro as a quality escalation candidate, not as provider outage isolation. Automatic cross-provider failover remains disabled for effectful runs until safe pre-effect failure classification and rehydration are proven.
- Version the Prompt Kernel and order stable identity, domain rules, selected Skill workflow and deterministic tool contracts before dynamic time, ID mapping, ProjectMemory, workspace state, history and current request.
- Do not place volatile timestamp text in the stable kernel. Provide current date/time as a dynamic fact block only where the task needs it.
- Inject a compact Outcome Contract and current plan step only for action mode. Do not copy full WorkState, verifier reports or internal reasoning into the model prompt.
- Make Context Ledger add/drop decisions explicit in receipts. Required blocks that cannot fit must produce a deterministic blocked or degraded outcome rather than disappear silently.
- Preserve the Skill router's computed strictest effect ceiling and filter model-callable tools before execution. Post-run verification is defense in depth, not the primary authorization boundary.
- Validate assignment member constraints inside the deterministic service transaction before proposal persistence. The output guard remains a narration check only.
- Allow read-only concurrency when every actual call is declared safe; keep proposal and advisory writes sequential.
- Retain deterministic quick-action identifiers as explicit product intents. Consolidate only free-form natural-language routing into one production implementation.
- Load Skill references on demand at a declared plan step. Do not inject all references at selection time.
- Do not add batch write tools until fixed trajectories demonstrate that per-item calls exceed latency or tool-call budgets. Any future batch contract must define atomicity, idempotency and per-item errors first.
- Keep Proposal-Confirm, FastAPI business authority, ProjectMemory visibility and sidecar no-direct-DB boundaries unchanged.

## Testing Decisions

- The primary test seam is the public conversation streaming endpoint. A scenario observes streamed events, persisted messages/run evidence, selected Skill/tool behavior, resolved model, usage telemetry and final outcome.
- Test external behavior rather than private helper calls whenever the public seam can expose the requirement.
- Add a deterministic payload-capture fixture that proves the current user content occurs exactly once and does not reappear in recent history.
- Add model-config contract tests for zero defaults, duplicate defaults, invalid catalog IDs, unsupported thinking levels, explicit selection, fallback reason and actual-model attribution.
- Add usage-normalization fixtures for providers with full cache data, partial data and no cache data.
- Add Prompt Kernel snapshot/hash tests for stable-prefix ordering without freezing dynamic facts.
- Add tool-policy tests proving composed effect ceilings filter manifests before invocation.
- Add service-level assignment tests proving member-constraint violations cannot persist proposals.
- Repeat each production-model conformance scenario at least three times before changing routing policy; report pass rate and variance rather than a single P95 from five one-off samples.
- Compare before and after using outcome, privacy, uncached input, total input, output, cache read/write, first-token latency, total latency and cost.
- Preserve the existing backend, agent-bridge and frontend unit/typecheck/lint/build suites as regression gates.

## Out of Scope

- Expanding the context window to the provider maximum before duplication and telemetry are fixed.
- Automatic cross-provider failover after any write or unknown side effect.
- Replacing Pi, FastAPI, ProjectMemory or Proposal-Confirm.
- Adding an LLM judge before deterministic verifier evidence shows a remaining semantic gap.
- Adding broad batch write tools without trajectory evidence.
- Exposing provider API keys or raw provider payloads to the frontend.
- Multi-agent orchestration.

## Further Notes

- Delivery is split into fresh Claude Code sessions with bounded handoffs: request/usage telemetry; model configuration; Prompt/Context; Skill/Tool safety; final scenario evaluation.
- Each follow-up or review fix starts a fresh Claude Code session. Conversation resume is reserved for an explicit continuity request and is not a token-cost strategy.
- The first measurable milestone is not a higher cache rate. It is a verified reduction in duplicated and uncached input with unchanged outcome and privacy gates.
