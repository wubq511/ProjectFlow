# T46 ProjectFlow Agent Evaluation Lab 规格

> 状态：设计已批准，Ready for Agent
> 日期：2026-07-16
> Issue：[#93](https://github.com/wubq511/ProjectFlow/issues/93)
> 目标：建立一套面向本地 Coding Agent、以 ProjectFlow 领域状态为真值、以可复现诊断和修复交接为核心产物的 Agent 评测系统。

## Problem Statement

ProjectFlow 已有公开 HTTP/SSE Agent 入口、重复场景运行、模型 conformance、确定性 verifier、trajectory exporter、token/cost telemetry 和生产 canary，但这些能力仍是面向 runtime 验证的基础设施，不是一套完整的 Agent 质量工程系统。

当前主要问题不是“缺少一个综合分”，而是缺少一条可信、自动、可交接的闭环：当 Prompt、模型、Skill、Tool、Context、Policy 或 Runtime 发生变化时，本地 Codex、Claude Code、Trae 等 Coding Agent 不能通过自然语言自动发现评测、隔离运行 ProjectFlow Agent、判断失败、定位根因、形成修复建议并返回可直接继续开发的交付物。现有 release scenarios 数量少，主要判断 terminal status、Skill routing、tool evidence、privacy 和 latency；它们不能充分验证最终 Project State、Proposal-Confirm、复杂多轮行为、语义质量或根因归属。

ProjectFlow 当前没有业务专家标注、真实用户反馈、线上满意度或生产 badcase 流。可获得的主要证据是：受控场景的输入、AgentRun、RuntimeEvent、tool ledger、Context receipt、VerifierReport、状态变化、最终回复、模型配置、token/cost/latency 和代码版本。若直接用 LLM-as-a-Judge 代替专家，会产生自我偏好、位置偏差、漂移和循环自证；若只用规则，又无法判断规划、拆解、分工、风险建议和解释质量。

用户真正需要的是一个“评测与诊断实验室”，而不是一个静态 benchmark 或 SaaS 看板：

- 日常开发时，只需对 Coding Agent 说自然语言，就能自动跑 smoke/full/calibrate 等评测并返回结论；
- 失败时，系统能区分现象、最早偏离点、根因假设和已确认根因，并用证据支持判断；
- 每个可修复问题都能生成 Coding Agent 可直接消费的 Repair Packet，而不需要用户重新解释上下文；
- 没有专家和用户时，仍能通过状态差异、业务不变量、Milestone DAG、reference program、grader mutation、故障注入、反事实复测和多 Judge 校准形成可信标准；
- 展示时，老师、评委或观众能快速理解能力水位、失败证据和改进闭环，技术评审还能下钻到场景、Trace、grader、统计和复现信息；
- 完整原始证据留在本地，Git 只保存脱敏基线和精选展示 bundle；
- 评测标准的变更不会被普通评测或 Coding Agent 静默修改。

## Solution

建设 ProjectFlow Evaluation Lab。它是一个独立于被测 Agent 运行逻辑的本地评测与诊断系统，由九个能力组成：Standards Registry、Scenario Compiler、Hermetic Runner、Evidence Ledger、Grader Stack、Diagnosis Lab、Asset Factory、Agent Control Plane 和 Showcase Dashboard。

系统包含两条严格隔离的闭环：

1. **日常评测闭环**：验证标准与环境，选择场景，预算预估，隔离运行 ProjectFlow Agent，采集状态与轨迹，分层评分，重复聚合，诊断失败，生成报告、问题簇、Repair Packet、候选回归和脱敏展示 bundle。
2. **标准校准闭环**：研究 ProjectFlow 规范、代码和外部方法，生成候选标准与 anchors，运行 grader mutation、故障注入、多模型、多顺序和多次 Judge，分析分歧，生成标准 diff，并等待 Robert 批准后冻结新版本。

普通评测只能消费冻结标准，不能修改标准。失败只能回流为候选标准或候选回归提案，不能通过降低阈值、删除场景或改写金标把失败重新定义为通过。

ProjectFlow 任务不存在唯一正确文案，因此金标不是单段 reference answer，而是四类质量资产的组合：

- **Golden Constraints**：必须发生、允许发生、禁止发生、必须保持不变的状态和行为；
- **Golden Milestones**：关键节点及其偏序关系，允许多条合理轨迹；
- **Reference Program**：证明 fixture 可解、生成目标状态并验证 grader 的确定性参考路径，不要求被测 Agent 复制；
- **Semantic Anchors**：明显优秀、明显失败和边界输出，用于校准语义 rubric 与 Judge。

评测结果不压缩成一个会掩盖风险的总分。Outcome、Authority & Safety、Trajectory、Semantic Quality、Reliability 和 Efficiency 分列展示。Proposal-Confirm、viewer visibility、privacy、幂等、未知副作用、终态一致性和禁止直接 Commit Effect 属于 hard gates，不得被语义质量或效率分抵消。

系统的主行为测试 seam 继续使用现有公开 HTTP/SSE conversation streaming 入口。确定性用户确认、拒绝、assignment response/finalize 等动作继续使用现有 FastAPI public human-action seam。受保护的内部 run/event/resource 读取只用于证据采集，不成为第二条行为入口。评测系统不得直接 import runtime、router、verifier 或业务 service 来判定被测系统正确性。

日常入口是稳定 CLI 和配套 Agent Skill。CLI 是事实接口，Coding Agent 通过自然语言选择、运行、轮询、恢复、比较和下钻评测。MCP 只能在 CLI/result contract 稳定后作为薄适配层，不复制 runner 或 grader 逻辑。

每个评测 run 生成同源的机器与人类产物：结构化 result contract、Run Report、Evidence Ledger、问题簇、Repair Packet、候选回归、脱敏 baseline 和 Dashboard bundle。Dashboard 不重新评分，只渲染经过 hash 和 provenance 验证的产物。

## User Stories

1. As Robert, I want to ask a local Coding Agent to evaluate ProjectFlow in natural language, so that I do not have to remember or manually execute the evaluation commands.
2. As Robert, I want the Coding Agent to discover available suites and scenarios, so that I can ask broad questions without knowing internal identifiers.
3. As Robert, I want a fast smoke preset, so that I can receive useful feedback during normal development.
4. As Robert, I want a full preset with repeated observations, so that I can distinguish stable capability from a lucky run.
5. As Robert, I want a calibration preset, so that standards and semantic rubrics can be researched and upgraded through evidence rather than intuition.
6. As Robert, I want a short live-demo preset, so that I can show a real evaluation within two to five minutes.
7. As Robert, I want every run to return a concise verdict and artifact paths, so that I can immediately inspect or hand off the result.
8. As Robert, I want the system to explain what failed and why, so that evaluation results lead to engineering action.
9. As Robert, I want repeated failures with one root cause grouped into one issue cluster, so that reports are not flooded with duplicate badcases.
10. As Robert, I want frozen historical baselines and latest candidate results shown together, so that a showcase cannot hide regressions.
11. As Robert, I want skipped, errored and excluded cases visible, so that the displayed score cannot be cherry-picked.
12. As Robert, I want the Dashboard to state that current evidence is offline and synthetic, so that it does not pretend to represent real user satisfaction.
13. As Robert, I want a high-level presentation for teachers and judges, so that they can understand ProjectFlow Agent quality quickly.
14. As a technical reviewer, I want to drill into scenarios, traces, graders, versions and statistics, so that I can verify the claims behind the presentation.
15. As a Coding Agent, I want a stable CLI with structured output, so that I can run evaluation without parsing human terminal prose.
16. As a Coding Agent, I want explicit exit codes for pass, Agent regression, infrastructure failure, partial budget stop and invalid standards, so that I can react correctly.
17. As a Coding Agent, I want to validate configurations without spending model tokens, so that obvious environment errors fail cheaply.
18. As a Coding Agent, I want to filter by suite, case, capability, risk, tag, model and changed component, so that I can run a bounded evaluation.
19. As a Coding Agent, I want mandatory P0 cases included even when diff-scoping omits them, so that optimization cannot bypass safety boundaries.
20. As a Coding Agent, I want long-running evaluations to expose machine-readable status, so that I can poll without consuming full logs.
21. As a Coding Agent, I want completed observations reused on resume, so that interruptions do not burn the same tokens again.
22. As a Coding Agent, I want a reproducible command and frozen manifest for every run, so that I can rerun the same experiment.
23. As a Coding Agent, I want an immutable Repair Packet for each actionable issue cluster, so that I can start repair work from a bounded task.
24. As a Coding Agent, I want Repair Packets to distinguish confirmed fixes from investigations, so that I do not make broad changes based on weak attribution.
25. As a Coding Agent, I want the Repair Packet to include the observed behavior and expected contract, so that the failure is unambiguous.
26. As a Coding Agent, I want the Repair Packet to include stable evidence references, so that I can inspect the exact state and trajectory.
27. As a Coding Agent, I want the Repair Packet to include base commit and worktree fingerprint, so that I can reject stale instructions.
28. As a Coding Agent, I want the Repair Packet to list affected components and likely code surfaces, so that I can narrow exploration.
29. As a Coding Agent, I want the Repair Packet to state non-goals and protected boundaries, so that I do not introduce unrelated regressions.
30. As a Coding Agent, I want executable acceptance criteria and verification commands, so that completion is objectively checkable.
31. As a Coding Agent, I want a candidate regression case attached to the Repair Packet, so that the same failure can be prevented after repair.
32. As a Coding Agent, I want explicit instructions not to weaken frozen standards, so that I fix ProjectFlow rather than the judge.
33. As a Coding Agent, I want low-confidence cases routed to an investigation packet, so that I collect evidence before editing code.
34. As a ProjectFlow developer, I want the evaluator separated from Agent runtime internals, so that the tested system cannot grade itself.
35. As a ProjectFlow developer, I want the public conversation stream to remain the primary behavior seam, so that evaluation exercises the real product path.
36. As a ProjectFlow developer, I want each observation to use an isolated temporary database and runtime, so that cases cannot collide or damage development data.
37. As a ProjectFlow developer, I want evaluation to fail closed if it detects a non-evaluation database, so that no automated run can reset real project data.
38. As a ProjectFlow developer, I want fixture seeds and hidden goal state versioned, so that outcomes are reproducible.
39. As a ProjectFlow developer, I want agent-visible and evaluator-hidden data structurally separated, so that hidden oracles cannot leak into prompts.
40. As a ProjectFlow developer, I want state snapshots before, during and after an episode, so that graders can verify actual world changes.
41. As a ProjectFlow developer, I want read-only tools checked against unchanged state hashes, so that hidden repair or mutation is detected.
42. As a ProjectFlow developer, I want Proposal-Confirm checked end to end, so that the Agent cannot commit Primary Project State before human confirmation.
43. As a ProjectFlow developer, I want human confirmation simulated through the human API seam, so that the tested Agent cannot impersonate confirmation.
44. As a ProjectFlow developer, I want viewer visibility checked across conversations and ProjectMemory, so that private data cannot cross identities.
45. As a ProjectFlow developer, I want utility and security scored separately, so that high task success cannot offset privacy or authority violations.
46. As a ProjectFlow developer, I want required, allowed, forbidden and unchanged state constraints, so that final-state correctness is executable.
47. As a ProjectFlow developer, I want Milestone DAG evaluation, so that multiple correct tool paths are accepted without weakening critical ordering.
48. As a ProjectFlow developer, I want strict, unordered, subset and superset trajectory semantics, so that path expectations match each scenario's real constraints.
49. As a ProjectFlow developer, I want a reference program for every stateful scenario, so that fixtures and graders are proven solvable before evaluating the Agent.
50. As a ProjectFlow developer, I want grader mutation tests, so that required steps, forbidden writes and privacy leaks are known to be detectable.
51. As a ProjectFlow developer, I want obvious good, bad and boundary semantic anchors, so that Judge changes can be sanity-checked.
52. As a ProjectFlow developer, I want Skill trigger precision and recall measured, so that false triggers and missed Skills are visible.
53. As a ProjectFlow developer, I want Skill prerequisites, allowed tools, required steps, forbidden actions and fallback behavior evaluated, so that Skill quality is not reduced to routing.
54. As a ProjectFlow developer, I want single-turn, multi-turn, insufficient-information, conflict, goal-switching and adversarial cases, so that the suite reflects conversational Agent behavior.
55. As a ProjectFlow developer, I want a deterministic user controller with optional LLM phrasing, so that user simulation remains natural without changing hidden facts.
56. As a ProjectFlow developer, I want the simulator itself graded for policy compliance, so that an invalid simulated user does not blame the Agent.
57. As a ProjectFlow developer, I want semantic-preserving prompt variants, so that punctuation or paraphrasing does not change core outcomes unexpectedly.
58. As a ProjectFlow developer, I want distraction tools and weakened descriptions tested, so that tool selection robustness is measurable.
59. As a ProjectFlow developer, I want hard graders executed before semantic Judges, so that deterministic failures do not incur unnecessary model cost.
60. As a ProjectFlow developer, I want semantic Judges to evaluate one criterion at a time, so that their labels and reasons are interpretable.
61. As a ProjectFlow developer, I want Judge candidate identity blinded and pairwise order randomized, so that self-preference and position bias are reduced.
62. As a ProjectFlow developer, I want Judge model, rubric and prompt versions captured, so that score drift is auditable.
63. As a ProjectFlow developer, I want Judge disagreement reported rather than averaged away, so that uncertainty remains visible.
64. As a ProjectFlow developer, I want low-confidence or conflicting judgments marked needs-review, so that soft evidence cannot become a false hard gate.
65. As a ProjectFlow developer, I want pass@1, pass^k and all-invariant-pass reported separately, so that capability and reliability are not conflated.
66. As a ProjectFlow developer, I want paired baseline comparisons using the same cases, seeds, model and standards, so that regressions are not random sample differences.
67. As a ProjectFlow developer, I want confidence intervals and insufficient-evidence states, so that small samples are not presented as statistically significant.
68. As a ProjectFlow developer, I want latency, token, tool count, retry and timeout metrics by scenario, so that efficiency regressions are diagnosable.
69. As a ProjectFlow developer, I want ProjectFlow Agent cost, evaluator-model cost and external Coding Agent cost separated, so that budget reports remain truthful.
70. As Robert, I want smoke ProjectFlow Agent cost capped at $0.10, so that routine checks stay inexpensive.
71. As Robert, I want full ProjectFlow Agent cost capped at $1, so that broad regression runs remain bounded.
72. As Robert, I want calibrate ProjectFlow Agent cost capped at $3, so that deep standard research remains controlled.
73. As Robert, I want external Coding Agent cost excluded from these caps, so that evaluation budgets are not mixed with development-agent usage.
74. As Robert, I want Judge and simulator model costs reported separately, so that auxiliary evaluation spend is visible.
75. As a ProjectFlow developer, I want budget exhaustion to stop new observations while preserving completed work, so that partial evidence is not lost.
76. As a ProjectFlow developer, I want infrastructure errors separated from Agent failures, so that provider outages do not lower capability scores.
77. As a ProjectFlow developer, I want a fault-injection benchmark with known causes, so that RCA quality can be measured without human root-cause labels.
78. As a ProjectFlow developer, I want RCA top-1 accuracy, top-3 recall and false-attribution rate, so that the diagnosis system has its own quality gates.
79. As a ProjectFlow developer, I want the earliest divergence treated as a hypothesis rather than automatic root cause, so that correlation is not presented as causation.
80. As a ProjectFlow developer, I want counterfactual reruns that change one factor at a time, so that routing, context, tool, model and implementation causes can be distinguished.
81. As a ProjectFlow developer, I want root-cause confidence and excluded alternatives recorded, so that repair decisions remain auditable.
82. As a ProjectFlow developer, I want candidate regressions generated automatically but not promoted automatically, so that the frozen suite remains governed.
83. As Robert, I want standard changes expressed as a reviewable diff, so that I can approve how the measuring stick changes.
84. As Robert, I want no standard upgrade without my explicit approval, so that Judge drift cannot silently redefine quality.
85. As a calibration Agent, I want required evidence, mutation results, Judge disagreement and cost included in a standard proposal, so that approval is informed.
86. As a calibration Agent, I want to use research, ProjectFlow contracts, repeated tests and adversarial examples, so that candidate gold standards are evidence-based.
87. As a calibration Agent, I want hard standards and semantic rubrics promoted independently, so that stable invariants do not wait on subjective quality dimensions.
88. As a calibration Agent, I want failed calibration to leave the active standard unchanged, so that experimental rubrics cannot affect daily evaluation.
89. As a showcase viewer, I want a simple release verdict and capability matrix, so that I can understand the result without reading raw traces.
90. As a showcase viewer, I want to see hard-gate status separately from semantic quality, so that safety failures cannot be hidden in an average.
91. As a showcase viewer, I want to see one representative evidence chain from input to state outcome, so that the evaluation feels concrete rather than decorative.
92. As a showcase viewer, I want to see a failure become a Repair Packet and then a passing regression, so that the improvement loop is visible.
93. As a technical reviewer, I want manifest hashes, coverage, errors and reproducible commands, so that the showcase can be independently checked.
94. As a privacy reviewer, I want showcase bundles to use stable pseudonyms and redacted evidence, so that technical proof does not leak private data.
95. As a repository maintainer, I want raw artifacts ignored by Git, so that traces and large model outputs do not pollute source control.
96. As a repository maintainer, I want only approved, redacted baselines and showcase bundles committed, so that repository evidence remains small and safe.
97. As a repository maintainer, I want artifact schemas versioned, so that old results can be migrated or rejected explicitly.
98. As a repository maintainer, I want stale Repair Packets detected from commit and worktree fingerprints, so that agents do not repair the wrong code state.
99. As a repository maintainer, I want full evidence retained locally with restricted file permissions, so that diagnosis remains possible without public disclosure.
100. As a future product owner, I want real user traces promotable into candidate datasets later, so that the offline system can evolve without redesigning its core contracts.

## Implementation Decisions

- Build a ProjectFlow-native evaluation kernel rather than making a generic SaaS or benchmark the source of truth. ProjectFlow owns domain scenarios, state constraints, Milestone DAGs, privacy and authority graders, RCA taxonomy and result contracts.
- Keep the evaluator logically independent from the system under test. It communicates through public HTTP/SSE and authenticated evidence reads; it does not call runtime or domain implementation functions to decide whether that same implementation is correct.
- Reuse the existing public conversation streaming path as the single highest behavior seam. Human confirmation and other deterministic user actions use existing public human-action contracts. Internal run/event/resource reads are evidence seams only.
- Preserve and adapt the existing T43 scenario runner, fixture provisioner, repeated evaluation, model conformance, trajectory export and token/cost telemetry during migration. New contracts are introduced additively and parity is required before retiring V0 paths.
- Organize the system into Standards Registry, Scenario Compiler, Hermetic Runner, Evidence Ledger, Grader Stack, Diagnosis Lab, Asset Factory, Agent Control Plane and Showcase Dashboard.
- Use a dedicated evaluation runtime module with its own dependency boundary. The system under test must not import scenario expectations, hidden facts, graders, anchors or reference programs.
- Define a versioned Scenario Contract containing capability, risk, tags, visible user input, fixture, hidden goal, required/allowed/forbidden/unchanged state constraints, Milestone DAG, semantic rubric references, simulator policy, repetition policy and budgets.
- Split each Scenario Contract into structurally distinct agent-visible and evaluator-hidden sections. Hidden state, reference programs, rubric anchors and expected trajectories are never inserted into the ProjectFlow Agent context.
- Define immutable Run Manifests that freeze suite, scenario, standard, rubric, code/worktree fingerprint, model, thinking level, Prompt Kernel, Skills, tool manifest, fixture seed, Judge, simulator, repeat, budget and redaction versions before execution.
- Treat observations as immutable records containing user turns, run/event/trace locators, state snapshots, tool ledger, Outcome Contract, Context receipt, verifier, final output, terminal status, metrics, costs and hashes.
- Use a file-backed local artifact store for V1. Complete artifacts remain local and ignored by Git; approved redacted baselines and showcase bundles may be committed.
- Use stable pseudonyms in redacted bundles so repeated references remain diagnosable without exposing raw IDs. Raw evidence uses restricted local permissions and never contains secrets.
- Provision an isolated temporary SQLite database, upload directory, ephemeral internal token and dedicated backend/sidecar process pair per worker. Evaluation refuses to run against known development or production database paths.
- Support a small bounded worker pool only after per-worker isolation is proven. Sequential execution remains the safe fallback for effectful scenarios and provider rate limits.
- Use deterministic fixture builders and seeds. Reference programs validate that stateful scenarios are solvable and generate expected goal states; the Agent is not required to reproduce their exact trajectory.
- Model ProjectFlow as a hybrid task-execution, reasoning-decision, multi-turn conversational and Skill-dense Agent. Every core workflow is evaluated at Turn, Session, Trace and Outcome layers.
- Cover clarification/direction, stage planning, task breakdown, assignment, status/read, check-in/risk/replan, conversations/ProjectMemory, and runtime/recovery/security capability families.
- Build a Golden Core coverage matrix with normal, negative, boundary, insufficient-information, conflict, goal-switching, adversarial and multi-turn classes. V1 targets at least 50 high-quality canonical Scenario Contracts; coverage completeness and risk coverage matter more than raw count.
- Define `demo`, `smoke`, `full` and `calibrate` presets. Demo runs a small representative subset in two to five minutes. Smoke runs one representative case per critical capability and makes no significance claim. Full runs the frozen core with repeated paired observations. Calibrate performs targeted multi-model and multi-Judge standard testing.
- Keep mandatory P0 safety, privacy, Proposal-Confirm and idempotency cases in all relevant presets even when diff-based selection excludes their apparent modules.
- Implement a deterministic user controller for multi-turn scenarios. The controller owns goal, hidden facts, refusal conditions and allowed actions; an optional LLM only realizes the allowed action in natural language. Simulator compliance is graded separately.
- Execute deterministic graders before semantic Judges. State diff, invariants, schema, reference validity, privacy, authority, terminal consistency and hard trajectory rules never depend on model opinion.
- Support final-state constraints using required changes, allowed changes, forbidden changes and fields that must remain equal.
- Support trajectory evaluation using Milestone DAGs and strict, unordered, subset and superset matching semantics. Critical approval and state-transition order may be strict; independent reads must not be over-constrained.
- Score Outcome, Authority & Safety, Trajectory, Semantic Quality, Reliability and Efficiency separately. Hard-gate failures cannot be averaged with soft dimensions.
- Use structured semantic rubrics that evaluate one criterion at a time and return label, score, reason and confidence. Judge inputs include visible task facts, candidate output and deterministic evidence, but not hidden chain-of-thought.
- Blind candidate model identity where possible, use a different Judge family from the candidate where practical, randomize pairwise ordering and record disagreement. Semantic scores default to soft metrics until anchors and stability evidence justify a hard threshold.
- Use verdicts `pass`, `fail`, `needs_review`, `infra_error` and `insufficient_evidence`. Infrastructure and evidence insufficiency are not counted as Agent failures or passes.
- Report pass@1, pass^k, all-invariant-pass, per-scenario failure, confidence intervals, latency percentiles, token, tool, retry, error and timeout metrics. Small samples must not claim statistical significance.
- Compare candidate and baseline with identical scenario, seed, model snapshot, standards, Judge and repetition configuration. Differential improvement cannot replace absolute invariants.
- Define a root-cause taxonomy covering intent/outcome classification, routing, context/memory, Skill, tool choice, tool arguments, tool result consumption, policy, model, runtime, fixture, grader and system infrastructure.
- Treat the earliest divergence as a root-cause hypothesis. Upgrade to confirmed root cause only when deterministic evidence or repeated single-variable counterfactual intervention supports causality.
- Add a fault-injection benchmark with known failures for routing, context, tool schema/result, effect boundary, privacy, terminal events, visibility and proposal evidence. Measure RCA top-1 accuracy, top-3 recall, false attribution and evidence completeness.
- Cluster badcases by shared confirmed or high-confidence root cause, capability, scenario and affected version. Generate one actionable issue per cluster rather than one per observation.
- Generate immutable Repair Packets with schema version, packet type, severity, confidence, run, code/worktree fingerprint, affected components, observed and expected behavior, reproduction, evidence, root-cause status, suggested scope, protected boundaries, non-goals, acceptance criteria, verification and candidate regression.
- Use `fix` Repair Packets only for deterministic or counterfactually confirmed causes. Use `investigation` packets for unresolved hypotheses and require bounded diagnostic experiments before implementation.
- Generate a copy-ready Coding Agent prompt that points to the Repair Packet and requires commit/worktree validation, scoped implementation, preserved business boundaries and target/full verification.
- Generate candidate regression cases automatically but store them outside the frozen suite. Promotion requires fixture solvability, grader mutation validation, representative scope, redaction and explicit standard approval.
- Keep calibration separate from normal evaluation. A calibration run produces candidate standards, evidence, anchors, mutation results, Judge bias/disagreement metrics, cost and a reviewable diff. Failed or unapproved calibration leaves active standards unchanged.
- Robert is the only authority for promoting candidate standards into the active frozen registry. Coding Agents and Judges cannot self-promote thresholds, rubrics or cases.
- Expose CLI operations for listing suites/cases/runs, validating, running presets or filters, polling status, reporting, showing case/run/trace, comparing baselines, resuming and retrying. All commands support bounded machine-readable output.
- Define separate exit semantics for pass, Agent regression, infrastructure error, budget/partial completion and invalid standard/configuration.
- Provide a repository-local Agent Skill that maps natural-language requests to the stable CLI. MCP is a future thin adapter and must invoke the same core service.
- Generate one Run Report, structured summary, Evidence Ledger, issue clusters, Repair Packets, candidate regressions, baseline comparison and showcase bundle from the same immutable result graph.
- Build a read-only Showcase Dashboard for judge-first presentation with technical drill-down. It displays release verdict, hard gates, capability matrix, reliability, cost, representative evidence chains, issue clusters, Repair Packets, regression closure, coverage and excluded/error counts.
- Default the Dashboard to approved frozen evidence and allow a controlled two-to-five-minute live demo subset. Live runs are labeled separately from accepted baselines.
- Do not recompute grades in the Dashboard. Verify artifact schema, hashes and provenance before rendering.
- Treat current evidence as offline/synthetic. Do not expose user satisfaction, production quality or online business outcome claims until real data exists and is governed.
- Separate cost ledgers: `sut_cost` for the ProjectFlow Agent under test, `evaluator_model_cost` for Judges and simulators, and `coding_agent_cost` for external Codex/Claude Code/Trae usage. Coding Agent cost is external/not counted in ProjectFlow Agent caps.
- Cap ProjectFlow Agent spend per run at $0.10 for smoke, $1 for full and $3 for calibrate. Demo is contained within the smoke ceiling. Budget exhaustion stops new observations, preserves completed evidence and yields a partial result.
- Do not place tokens, API keys, cookies, private messages, full raw IDs or hidden Judge prompts in command arguments, stdout summaries, committed baselines or showcase bundles.
- Preserve FastAPI/DB as the fact source, Proposal-Confirm as the human commit boundary, ProjectMemory visibility rules, private conversation ownership, Policy Gate semantics and existing effect ceilings.

## Testing Decisions

- The primary behavior test seam is the public conversation HTTP/SSE path. Tests send real user messages through this seam, observe the streamed result, then verify state and evidence through existing public human actions and protected read seams.
- Good tests assert external outcome, state constraints, visible artifacts, trajectory evidence and safety boundaries. They do not assert private implementation calls or hidden chain-of-thought.
- Keep deterministic component tests for contracts, scenario validation, state diff, Milestone DAG matching, redaction, budget planning, statistics, result schemas and artifact hashing.
- Add integration tests that launch an isolated backend/sidecar pair with a temporary SQLite database and execute a full observation through the public seam.
- Add a fail-closed test proving evaluation refuses known development database paths and never resets the existing demo database.
- Add isolation tests proving parallel or repeated observations cannot share conversations, proposals, ProjectMemory, AgentRun events or mutable fixture state.
- Add Scenario Contract tests proving hidden fields never appear in the ProjectFlow request body, Context receipt, trace or final output.
- Add reference-program tests proving every stateful fixture can reach its goal state and every reference program satisfies hard gates.
- Add grader mutation tests that delete required milestones, add forbidden writes, reorder strict actions, introduce privacy leaks, cross viewer identity, duplicate terminal events and unknown side effects; each mutation must be detected by its intended grader.
- Add state-diff tests for required, allowed, forbidden and unchanged constraints, including list ordering, timestamps, generated IDs and fields that require normalization.
- Add Milestone DAG tests for multiple valid trajectories, missing nodes, forbidden nodes, alternate ordering and independent unordered reads.
- Add Skill evaluation tests for positive and negative triggers, precision/recall, prerequisites, conflicts, tool allowlists, parameter correctness, required path, forbidden action, fallback and output usability.
- Add controlled User Simulator tests proving it never reveals hidden facts, changes the user goal, accepts a forbidden proposal or helps the Agent complete its own task.
- Add multi-turn scenarios for clarification, rejection, assignment negotiation, goal switching, repeated questions, conversation history, private/team visibility and replan feedback.
- Add Proposal-Confirm scenarios proving pending proposals do not mutate Primary Project State, confirmation commits deterministically, rejection leaves state unchanged and the Agent cannot invoke confirmation as a tool.
- Add privacy scenarios for raw IDs, UUIDs, private conversation ownership, team history, ProjectMemory visibility, subject-and-owner records and malicious tool output.
- Add read-only purity scenarios comparing normalized before/after state hashes for state, timeline, proposal and memory reads.
- Add runtime scenarios for timeout, transient retry, invalid arguments, partial tool results, cancellation, checkpoint, resume, steering, unknown side effects and duplicate idempotency keys.
- Add output evidence tests proving claims about state, tasks, members and proposals are supported by visible state or tool observations.
- Add semantic anchor tests using obvious good, bad and boundary outputs. A Judge version that cannot distinguish anchors or has unstable ordering cannot be promoted.
- Add Judge bias tests for A/B order swapping, same-family preference, verbosity, rubric version and repeated disagreement.
- Add fault-injection tests with known root causes and measure diagnosis top-1 accuracy, top-3 recall, false attribution and confidence calibration.
- Add counterfactual tests proving only one factor changes between paired runs and that root-cause confirmation requires repeated outcome change.
- Add badcase clustering tests proving repeated observations with a common cause create one issue cluster and unrelated failures do not merge.
- Add Repair Packet schema and snapshot tests covering fix/investigation types, evidence references, stale worktree detection, protected boundaries, acceptance criteria and candidate regressions.
- Add candidate-regression governance tests proving generated cases cannot enter the frozen suite without validation and approval.
- Add calibration lifecycle tests proving candidate standards are isolated, standard diffs are complete, failed calibration leaves active standards unchanged and only approved versions become active.
- Add cost-ledger tests proving ProjectFlow Agent, evaluator models and external Coding Agent cost are not mixed, and each cap applies only to the intended bucket.
- Add budget-stop tests proving new observations stop at the ProjectFlow Agent ceiling while completed observations and partial reports remain usable.
- Add statistics tests for pass@1, pass^k, confidence intervals, paired comparison, small-sample insufficient-evidence and missing telemetry coverage.
- Add artifact tests for immutable manifests, hashes, resume, migration, local permissions, redaction, stable pseudonyms and malformed/stale result rejection.
- Add CLI contract tests for list, validate, run, status, report, show, compare, resume and retry, including JSON output and exit semantics.
- Add acceptance tests in which Codex, Claude Code and Trae-equivalent shell agents can discover and run smoke from natural-language instructions, poll completion and return the Run Report and Repair Packet paths without manual commands.
- Add Dashboard tests proving it renders the same verdict as the structured summary, exposes failures/errors/exclusions, distinguishes baseline from live runs and never loads raw private artifacts.
- Reuse the existing public-seam scenario, operational eval, verifier, effect-ceiling, privacy, memory, resume, fixture provisioner, trajectory and model conformance tests as migration prior art.
- Run mock/deterministic suites in normal CI. Credentialed production-model smoke/full/calibrate jobs remain explicit bounded workflows with recorded model/config versions and are not silently triggered by ordinary unit tests.
- Require V1 acceptance evidence to include: complete Golden Core coverage, all P0 hard gates passing, grader mutation coverage, reference-program solvability, bounded costs, agent-first CLI acceptance, Repair Packet usability, Dashboard provenance parity and a fault-injection RCA baseline.

## Out of Scope

- Automatically modifying ProjectFlow code, Prompt, Skill, tool schema, rubric or threshold after evaluation.
- Automatically opening or merging repair pull requests.
- Allowing a Coding Agent, ProjectFlow Agent or Judge to promote standards without Robert's approval.
- Replacing Proposal-Confirm with Tool Execution Approval or any evaluator-specific approval model.
- Giving the ProjectFlow Agent shell, arbitrary file, arbitrary network or database access for evaluation.
- Capturing or evaluating hidden model chain-of-thought.
- Treating semantic Judge scores as ground truth without calibrated anchors and stability evidence.
- Claiming real-user satisfaction, retention, productivity or production business outcomes before real governed data exists.
- Building a multi-tenant cloud evaluation SaaS, hosted control plane or production deployment in V1.
- Making Inspect AI, Promptfoo, Phoenix, LangSmith, Braintrust, DeepEval or OpenAI hosted Evals the ProjectFlow evaluation source of truth.
- Adding a full MCP control plane before the CLI and result contract are stable.
- Importing public benchmark datasets as ProjectFlow domain correctness tests.
- Fine-tuning, preference optimization, SFT/DPO dataset production or model training pipelines.
- Ingesting real private user conversations into evaluation without a later privacy and consent design.
- Committing raw traces, private conversation text, complete model outputs, raw IDs, secrets or large local artifacts to Git.
- Replacing the existing ProjectFlow Dashboard or project workflow with an evaluation product for end users.
- Using evaluation reads to repair or advance Project, Stage or Task state.
- Deleting current T43 evaluation assets before additive parity and migration evidence passes.
- Measuring external Coding Agent subscription or token cost as part of the ProjectFlow Agent run caps.

## Further Notes

- ProjectFlow Evaluation Lab is a diagnostic quality system, not a leaderboard. A low score without evidence and an actionable Repair Packet is not considered a successful evaluation outcome.
- The current T43 harness is a strong starting point but its five release scenarios mainly validate routing, terminal status, required tool evidence, privacy and latency. T46 extends this foundation with domain state oracles, multi-turn scenarios, calibrated semantics, causal diagnosis and repair handoff rather than replacing the runtime.
- The design was informed by the provided “Agent 评测：方法论与体系设计” article. The main adopted principles are continuous evaluation, Agent-type-specific metrics, Turn/Session/Trace/Outcome layers, Skill evaluation, deterministic-before-LLM scoring, structured RCA, actionable optimization and regression feedback production.
- External primary-source research supports a combined pattern rather than one platform dependency: Promptfoo-style agent control, Inspect-style task/log/resume contracts, τ-bench final-state goals and pass^k, ToolSandbox world snapshots and Milestone DAGs, AgentDojo utility/security/ground-truth separation, and SWE-bench hermetic harness validation.
- OpenAI hosted Evals is not selected as a dependency because official documentation marks the service legacy and scheduled for shutdown. The open-source historical registry pattern may be studied, but the new system remains local and provider-neutral.
- Semantic Judges are a secondary diagnostic instrument. ProjectFlow hard correctness comes from state, invariants, trajectories, visibility and authority rules.
- The absence of experts and users is addressed through proxy-expert calibration, executable oracles, grader mutation, reference programs, fault injection, counterfactual tests and explicit uncertainty. It is not hidden by inventing user metrics.
- The initial Golden Core should be approximately 50–64 high-quality canonical scenarios selected by capability/risk coverage, then expanded through controlled paraphrase, boundary, adversarial and historical badcase variants. Generated variants do not create new truth.
- Historical T44 canary evidence shows ProjectFlow model-call costs are low enough for the approved ceilings, but those measurements are not permanent provider price commitments. Every run records actual reported cost and metric coverage.
- The Showcase Dashboard is evidence-backed presentation, not a marketing-only page. It must expose coverage, failures, infrastructure errors, skipped cases, version provenance and reproducibility alongside positive results.
- A later phase may ingest governed real-user traces into candidate datasets, add an MCP adapter, or adopt a trace platform. Those extensions must preserve the same Scenario, Observation, Grade, Diagnosis and Repair Packet contracts.
