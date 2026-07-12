# ProjectFlow Agent 能力成熟化规格

> 状态：P0 control plane implemented; production-model canary pending credentials
> 日期：2026-07-12
> 目标：在不突破 ProjectFlow 业务安全边界的前提下，把现有领域 Agent 从“能调用工具的业务自动化”升级为“可规划、可恢复、可验证、可扩展、可持续评测的成熟 Agent Harness”。

## Executive Conclusion

ProjectFlow 当前并不是缺少 Agent 底座。它已经具备多轮模型循环、13 个 typed tools、工具 manifest、policy gate、预算与取消、流式事件、trace、Proposal-Confirm、ProjectMemory、6+1 个 Skills 和较强的隐私约束。这些能力使它明显高于普通的单轮聊天机器人。

但它尚未达到 Claude Code、Codex 这类成熟 Agent 的基本水平。核心差距不在模型，也不在工具数量，而在“自主任务控制层”缺失：没有持久化目标与计划、没有统一的 plan-act-observe-verify 循环、没有上下文压缩与可靠恢复、Skills 没有贯穿主流式路径、工具 manifest 中的 timeout/retry 等声明没有完全转化为执行语义、系统提示词强制所有请求调用工具、没有行为级 end-to-end Agent 评测门禁，也缺少运行中 steering 与等待用户输入的状态。

因此本规格选择 **Harness-first 纵向升级**：保留现有 Pi runtime、FastAPI 事实源、typed tool contract、Proposal-Confirm 和 ProjectMemory，在其上补齐 Goal/Plan/Verifier/Context/Steering，在其下补齐 tool executor、checkpoint/recovery 和 evaluation harness。不会复制 coding agent 的 shell、文件编辑和任意网络访问能力；对标的是成熟 Agent 的控制能力与可靠性，而不是 Claude Code/Codex 的代码操作范围。

## Final Working-Tree Audit (2026-07-12)

本节是当前实现状态的权威结论，优先级高于下文按开发轮次保留的“Phase 完成状态”和历史测试计数。下文的完成标签只表示对应组件切片曾通过测试，不表示发布门禁完成，也不表示 ProjectFlow 已被证明达到 Claude Code/Codex 的整体成熟度。

### 已接通

- Phase 0-4 的核心控制面：统一请求准备、Outcome Contract、分层 Prompt Kernel、Context Engine、Skills V2、WorkState、RunPlan、确定性 Verifier、Tool Executor V2、ToolLedger。
- Phase 5 的恢复核心：durable checkpoint、分页读取完整事件轨迹、rehydrate、同 run resume、恢复工具证据合并、steering API/队列、未知副作用 fail closed。
- Phase 6 的基础设施切片：semver compatibility、Skill fixture runner、受控 capability adapter。
- Proposal-Confirm、FastAPI 事实源、隐私过滤和 LLM-callable tool 禁止直接 commit 主事实的既有边界保持不变。

### 独立验证结果

| 验证面 | 当前结果 |
|---|---|
| Agent Bridge tests | 990/990 passed（55 files） |
| Agent Bridge typecheck/build | passed / passed |
| Backend tests | 760 passed / 4 skipped |
| Backend ruff | passed |
| Frontend tests | 125/125 passed（16 files） |
| Frontend lint/build | passed / passed |
| Patch hygiene | `git diff --check` passed |

### 发布证明状态

- 统一公开 HTTP/SSE 场景 runner、trajectory exporter、routing/outcome/P95 latency/token/cost 指标和跨模型 conformance job 已实现，并由确定性 public-seam 测试覆盖。
- effect approval 的状态机、steering contract 和前端批准/拒绝 UX 已接通；当前工具集中没有需要执行前审批的合格 capability，因此该状态保持可用但不强行套到 Proposal-Confirm 或 advisory write 上。
- 前端已接通运行快照轮询、断线恢复、追加约束、修改计划、澄清回答、批准/拒绝和取消控制。
- 大型工具结果已持久化到 run-scoped resource，并通过 Bearer 保护的分页读取契约和 `read_tool_resource` 工具续读。
- 真实 production-model canary runner 已实现，但本机未配置 DeepSeek/Xiaomi provider key，尚未获得真实模型 routing/outcome/latency/token/cost 基线；这仍是唯一明确的环境性发布证据缺口。
- semantic LLM judge 仍按设计延后；必须先用真实场景证明确定性 verifier 存在不可接受的语义缺口，再引入额外成本和非确定性。

因此，当前结论是：**Agent Harness V2 的 P0 控制面和运维评测面已形成并通过仓库级回归，结构能力达到本规格定义的主流 Agent 基本线；在配置真实 provider 凭据并跑出 production canary 基线前，不能宣称真实模型质量与成本门禁已经通过。**

## Current State Audit

### 已具备的强项

1. FastAPI/DB 是唯一业务事实源，sidecar 不直接读写数据库。
2. 高影响主事实变更必须进入 Proposal-Confirm，人类确认边界清晰。
3. 工具有显式 input/output schema、风险类别、effect、隐私、resume 和 trace metadata。
4. Agent run、事件序列和工具结果已具备 durable persistence 基础。
5. 工具结果具备幂等键、结构化 observation、side-effect status 和 bounded payload。
6. runtime 已支持多模型路由、多轮工具调用、并行只读工具、预算、timeout 上限、取消和 SSE。
7. ProjectMemory 已实现确定性抽取、可见性过滤、检索、上下文注入、证据记录和输出守卫。
8. 用户可见文本已具备中文、原始 ID 隐藏、XML 隔离和 output sanitization 约束。
9. 单元、契约、隐私和 memory evaluation 覆盖较强，适合作为继续演进的回归基础。

### 关键缺口

| 能力面 | 当前状态 | 主要问题 | 目标状态 |
|---|---|---|---|
| 目标理解 | 弱 | 用户请求直接进入模型，没有 durable goal、成功标准或“回答/行动/澄清”分类 | 每个 run 先形成可审计的 Outcome Contract |
| 计划与进度 | 弱 | runtime 只有技术状态，没有工作计划、步骤依赖、进度或重规划语义 | 非简单任务有持久化 RunPlan，可动态修订 |
| Agent loop | 中 | 能多轮调用工具，但缺少显式 verify/refine 阶段 | Observe → Plan → Act → Verify → Refine/Finish |
| 工具设计 | 强 | 13 个领域工具具备注册硬门禁、版本兼容、受控 capability adapter 和大型结果续读 | 继续按真实产品需求扩展 capability packs |
| 工具执行 | 中 | manifest 声明的 per-tool timeout/retry/concurrency group 未完全成为真实 executor 行为 | 统一 executor 严格执行 manifest，并分类恢复 |
| 系统提示词 | 弱 | “每个请求至少调用一次工具”会迫使问答类请求产生无意义副作用；规则、流程和上下文混在一起 | 分层、版本化、按任务装配的 prompt kernel |
| Skills | 弱到中 | 关键词式单 Skill 选择；主流式对话路径没有加载 Skill；部分 references 实际一次性加载 | hybrid router、可组合 Skills、渐进加载、lint/eval/version |
| 上下文管理 | 弱 | 固定最近 8 条消息，没有 token ledger、摘要、compaction 或 context provenance | 分层 context packet、自动压缩、关键约束保留证明 |
| 会话恢复 | 弱到中 | FastAPI 有 durable state，但 sidecar session 在内存；重启后不能从 checkpoint 继续 | 工具边界 checkpoint、无重复副作用 resume/reconcile |
| 用户协作 | 弱 | 只能取消，缺少运行中 steer、queue、awaiting_user、修改计划 | 可中断、追加约束、回答澄清、继续同一 run |
| 权限治理 | 中强 | proposal boundary 强，但没有通用 tool-call approval；open-world 全禁 | 基于 effect 的 policy，必要时进入 awaiting_approval |
| 自我验证 | 弱 | 主要依赖 schema、业务 validator 和专用 memory guard | deterministic verifier + bounded semantic judge |
| 可观测性 | 中强 | 事件和 trace 基础好，但缺少 outcome、plan、prompt/skill version 和 verifier 证据 | 可重放完整决策轨迹与质量指标 |
| Agent 评测 | 弱到中 | 多为单元/契约矩阵，缺少真实入口、多模型、行为结果与恢复场景 | 统一公开入口的 scenario eval + release gates |
| 扩展性 | 弱 | 工具和 Skills 主要静态内置，没有 connector/MCP-compatible discovery 或 hooks | 受控 capability adapter 与 lifecycle hooks |

### 审计中发现的具体设计风险

1. 主对话流式入口与按钮式 `/runs` 路径能力不一致；前者没有装载指定 Skill，后者装载 Skill 但不包含 references。
2. Skill selector 依赖少量中文关键词并只返回一个 Skill，无法处理“先分析风险再生成调整提案”这类组合目标。
3. Skill loader 宣称按需加载 references，但组合函数会遍历并加载所声明的全部 references。
4. Tool registry 使用 map set 注册，重复名称存在静默覆盖风险；schema safety 检查没有成为注册硬门禁。
5. 工具 manifest 中的 retry 和 per-tool timeout 主要是描述性配置，runtime 实际调用未形成统一重试/退避/超时执行器。
6. BudgetManager 定义了 step/output token/result byte 预算，但主 loop 对部分计数与执行约束的接线不完整。
7. 近期对话按固定条数截断，长任务会丢失早期目标、验收标准和用户修正。
8. sidecar 运行态保存在进程内 session store，FastAPI 虽保存事件与状态，但未提供真正的 checkpoint rehydrate。
9. 系统 prompt 把“必须调用工具”当作全局规则，无法正确处理解释、澄清、拒绝、无操作建议和“当前无需变更”等请求。
10. 现有 S15 evaluation 主要证明组件和 contract 存在，不足以证明 Agent 能在模糊、长链、失败和对抗输入下完成用户目标。

## First-Principles Capability Model

成熟 Agent 的本质不是“模型能思考”或“工具很多”，而是一个受控闭环：

```text
Goal
  → Build trustworthy context
  → Choose an execution strategy
  → Act through bounded capabilities
  → Observe real outcomes
  → Verify against success criteria
  → Re-plan, ask, recover, or finish
  → Preserve evidence and useful memory
```

由此得到八条不可妥协的设计原则：

1. **结果优先**：run 的完成条件是用户目标被验证，而不是模型停止生成。
2. **事实优先**：最终结论必须能追溯到 workspace state、tool observations、用户输入或受治理 memory。
3. **行动最小化**：不需要工具时不调用；需要副作用时选择影响最小的 capability。
4. **控制面与业务面分离**：Goal、Plan、Verifier、Checkpoint 属于 Agent 控制面；Project/Stage/Task 仍属于业务事实面。
5. **声明必须可执行**：manifest 中的 timeout、retry、parallel、privacy、effect 和 resume 不是文档，必须由 executor 强制执行。
6. **失败是正常路径**：timeout、validation error、partial result、disconnect、restart 和用户 steering 都必须有明确状态与恢复策略。
7. **高风险确定性治理**：权限、隐私、状态变更和引用合法性由代码验证；LLM judge 只评估难以确定性判断的语义质量。
8. **质量必须可测**：所有“更智能”“更成熟”都必须映射为 scenario、metric 和 release gate。

## Considered Approaches

### A. Prompt 与工具数量驱动

继续扩写系统 prompt、增加更多业务工具、增加更强模型。成本低，但会放大当前上下文噪音、工具误调用和路径漂移，无法解决恢复、验证、steering 与行为评测问题。不采用。

### B. Harness-first 纵向升级（采用）

保留现有 sidecar 与 FastAPI 边界，围绕一个真实用户入口补齐 Outcome Contract、RunPlan、Context Engine、Verifier、Executor、Checkpoint 和 Eval Harness。每个阶段都形成可用的 tracer bullet，能持续对比质量、成本和可靠性。

### C. 全量替换为新的 Agent framework

可以快速获得部分通用能力，但会重做已经正确的 ProjectFlow tool contract、业务事务、Proposal-Confirm、memory 可见性和 event persistence，并引入新的框架耦合。除非现有 Pi runtime 阻塞必需能力且无法适配，否则不采用。

## Adversarial Review Amendments

本规格在进入编码前经过第一性原理对抗性审查。以下修正属于实施约束，不是可选建议：

1. **统一行为内核，不立即强制统一传输协议**：`/runs` 与 `/runs/stream` 可以在迁移期共存，但必须复用相同的 request preparation、Skill resolution、prompt kernel、tool filtering 和 policy。只有 parity scenario 通过后，dashboard actions 才迁移到公开 conversation stream。测试主 seam 保持公开流式入口，但不能为了“一个 seam”一次性重写所有调用方。
2. **WorkState 不是第二事实源**：FastAPI 是 WorkState 的 durable authority；sidecar 只能提交带 expected state version 的 transition request。用户可见 work status 必须从已持久化状态/事件派生，不能由前端或 sidecar 独立推断。
3. **先 tracer，再稳定 schema**：Phase 0 只定义 additive draft contracts 和 compatibility rules。Outcome Contract、RunPlan、VerifierReport、ToolLedger 必须各经过至少一个 end-to-end tracer 后才能标记 stable v1。
4. **质量阈值先基线后定标**：安全、权限、幂等和隐私仍是 100% 硬门禁；Skill routing、outcome rate、latency 和 cost 的数值在 Phase 0 先作为 provisional targets，基线完成后再冻结 release thresholds。
5. **确定性 verifier 先于 LLM judge**：P0 不引入 LLM-as-judge。只有确定性 outcome/evidence gates 已稳定、且存在无法编码的语义质量缺口时，才在后续阶段加入独立 judge 和 bounded refine。
6. **T43 不是单次编码任务**：每个切片必须能独立合并、回滚和通过主 seam 验收。禁止一次 delegation 同时实现 Outcome Contract、Planner、Context Engine、Executor、Resume 和 Evaluator。
7. **Skill composition 后置**：先让单 Skill 在流式/非流式路径行为一致，再设计 top-k composition；组合前必须有冲突、effect ceiling 和 tool allowlist 的确定性合并规则。
8. **控制面数据最小化**：新增持久化模型必须证明不能由既有 AgentRunV2、AgentRunEvent 或 tool result ledger 的 versioned payload 表达，避免为每个概念创建新的表和迁移负担。

### First implementation tracer

首个编码切片只解决已被代码证据确认的行为漂移：

- 抽取一个共享的 Skill context resolver，供 `/runs` 与 `/runs/stream` 使用；
- 显式 `runtime_config.skill` 在两条路径行为一致；
- conversation stream 仅在确定性 intent 明确匹配时传递 Skill，不做模糊 LLM routing；
- 没有 Skill 的普通问答不再受“每个请求必须调用工具”约束；
- 有显式 action Skill 的按钮式流程继续由 Skill 规定必须调用相应落库工具；
- 不迁移 dashboard transport，不新增数据库模型，不引入 LLM judge，不改变 Proposal-Confirm；
- 用共享 resolver 单元测试、两条 route contract 测试和 answer-only prompt test 证明行为。

这个 tracer 的目的不是宣称 Phase 1 完成，而是验证统一行为内核可以在不破坏现有产品路径的情况下落地。

### First tracer implementation evidence (2026-07-12)

首个 tracer 已实现并通过独立对抗性复查；本节保留当时的切片证据，完整 T43 状态以顶部 Final Working-Tree Audit 为准：

- `/runs` 与 `/runs/stream` 在任何 run/HTTP 副作用前复用同一 Skill preparation；未知 Skill fail-closed，Skill 正文加载失败不会创建 FastAPI run；
- 无 Skill 的 answer mode 不暴露 model-callable tools，也不包含全局强制工具调用指令；
- 显式或确定性匹配的 action Skill 只暴露 allowlist tools，并保留原 Skill 的落库要求；
- 对话 intent matcher 使用 action/request 优先级与 question/bare-label guard；现有“分析当前风险”进入 `risk-analysis`，“根据签到调整计划”进入 `risk-replan`；
- agent-bridge `636/636` tests、typecheck、build 通过；backend targeted `66/66`、full `717 passed / 4 skipped`、changed-file ruff 通过；`git diff --check` clean；
- 当前 matcher 仍是有意保守的确定性正则：未识别的自由表达安全降级到 answer mode，model-based routing 与 Skill composition 仍属于后续切片。

### Second slice: Shared request preparation + Outcome Contract + Prompt kernel (2026-07-12)

在首个 Skill tracer 基础上，本切片实现了 Phase 0/1 的剩余核心，但仍不能视为整个 T43 或 Phase 1 已完成：

**共享请求准备 (`request-preparation.ts`)**：
- `prepareRunRequest()` 是 `/runs` 与 `/runs/stream` 共享的单一入口，在任何 run/HTTP 副作用前完成验证、Skill 解析和 Intent 分类；
- 返回 discriminated union: `invalid | unknown-skill | skill-load-error | ready`；
- `ready` 状态包含已验证的 wire request、解析后的 SkillContext 和 Outcome Contract；
- 两条 route 的行为内核完全相同，transport 仍然独立（不强制迁移）。

**Additive draft Outcome Contract (`outcome-contract.ts`)**：
- `classifyRequest()` 使用确定性规则（无 LLM judge）将请求分类为 answer/clarify/analyze/act/review；
- 完整 contract 包含 normalizedGoal、constraints、successCriteria、requiredEvidence、effectCeiling、clarificationPolicy、verificationLevel、completionMode；
- effectCeiling 根据 Skill 的 allowedTools 自动推断：proposal tools → `proposal_only`，advisory tools → `advisory_only`，read-only → `none`；
- **事件持久化子集**：`agent.started` 事件的 `_outcome_contract` 只记录 request_type、effect_ceiling、completion_mode、verification_level、clarification_policy；normalizedGoal/constraints/successCriteria/requiredEvidence 不持久化到事件 payload（避免膨胀），仅在 runtime 内存中使用；
- 不新增数据库表，复用现有 event payload 结构。

**Prompt kernel 版本化**：
- `PROMPT_KERNEL_VERSION` 常量（当前 `1.0.0`）标识提示词模板版本；
- `hashPromptKernel()` 返回稳定 hash（基于版本号+模板结构，不包含动态内容），跨不同 workspace/skill/memory 上下文一致；
- `hashAssembledPrompt()` 返回完整组装提示词的 hash（包含动态内容），仅用于 debug，不记录到事件；
- 系统提示词首行注入 `[prompt_kernel: 1.0.0]`；
- `agent.started` 事件记录 `_prompt_kernel.version` 和 `_prompt_kernel.hash`（稳定 hash）；
- 使用 node:crypto SHA-256，截断到 16 hex 字符；提示词结构变更时递增版本号。

**测试覆盖**：
- `outcome-contract.test.ts`: 11 tests — answer/act/analyze/review 分类、constraints、success criteria；
- `request-preparation.test.ts`: 16 tests — validation（含畸形字段）、skill resolution、Outcome Contract classification、prompt kernel stable/assembled hash；
- `handler-contract.test.ts`: 6 tests — 两条 route 的 unknown skill、load failure、valid skill 行为；
- `public-stream-scenario.test.ts`: 8 tests — 最小 public-seam scenario harness，覆盖 answer-only（无工具）、explicit action（只暴露 allowlist）、unknown skill/load failure（无 startRun）、无 orphan run、confirm_proposal 工具不暴露；
- agent-bridge `675/675` tests、typecheck、build 通过；backend `717 passed / 4 skipped`、ruff 通过；`git diff --check` clean。
- **注意**：handler-contract 和 public-stream-scenario 测试调用真实 handler 函数（非 HTTP server），使用 mock model/FastAPI；它们验证核心逻辑路径但不是完整的 HTTP-level 端到端测试。

**该切片当时未实现（已由后续切片完成）**：
- RunPlan、WorkState 持久化；
- Tool Executor V2（timeout/retry enforcement）；
- Verifier-Optimizer；
- Checkpoint/Resume/Steering；
- 语义 judge；
- 公开 conversation stream scenario harness（当前只有 unit/contract tests）。

### Phase 2: Context Engine + Skills V2 (2026-07-12)

**A. Context Engine (`context-blocks.ts`)**：
- `ContextBlock` 接口：id、source (BlockSource)、priority (0-100)、retention (pinned/required/compressible/droppable)、content、estimatedTokens、visibility、version；
- `ContextLedger` 类：token budget 追踪、priority-based assembly、分层 compaction（先丢 droppable，再丢 compressible）；
- `estimateTokens()` 保守估算混合 CJK/ASCII 文本（~3 chars/token）；
- `createBlock()` 工厂函数自动计算 token 估算；
- **Compaction 保证**：pinned blocks 永不丢弃（goal、constraints、safety rules）；required blocks 只在最后手段丢弃；droppable blocks 优先丢弃；
- 当前 Context Engine 已实现但未集成到 context-builder.ts（集成属于后续切片，需要修改 buildContext 调用链）。

**B. Skills V2 metadata (`skill-v2-metadata.ts`)**：
- `SkillV2Metadata` 接口：version、triggerExamples、negativeTriggers、prerequisites、outcomeType、allowedEffects、requiredVerification、compatibilityRange、evalFixtures；
- `SkillPrerequisite` 支持 6 种类型：has_direction_card、has_stages、has_tasks、has_members、has_pending_proposals、no_pending_proposals；
- `SkillEffectCeiling`：none、advisory_only、proposal_only、full；
- 所有 7 个 SKILL.md 已添加 v2 frontmatter（additive，不改变业务边界）；
- `skill-index.ts` 已更新解析 v2 metadata。

**C. Two-stage deterministic skill router (`skill-router.ts`)**：
- Stage 1：narrow candidates — negative triggers 优先拒绝、prerequisite 检查、trigger example 匹配、description keyword 匹配；
- Stage 2：select and combine — top score > 0 才选择、冲突检测（incompatible effects、overlapping proposal tools）、tool allowlist union + forbidden tool filtering；
- 组合限制：最多 2 个 skill、combined effect ceiling 取最严格、confirm/reject/commit tools 始终过滤；
- **不调用 LLM 分类器**：所有选择都是确定性的。

**D. Skill lint (`skill-lint.ts`)**：
- 检查项：missing tools、duplicate name/version、escaping reference paths、incompatible manifest/tool versions、invalid effects、forbidden tools、effect ceiling mismatch；
- `lintSkills()` 函数可在 CI/test 中运行，无需启动 server；
- 已通过真实 skills 目录 lint 验证。

**E. Lazy reference loading**：
- `prepareSkillContext()` 只加载 SKILL.md body，不加载 references；
- `loadSkillReferences()` 新函数按需加载特定 reference；
- 现有 `SkillLoader.loadReference()` 已支持单个 reference 按需加载。

**F. ContextLedger 集成到 buildContext (`context-builder.ts`)**：
- `buildContext()` 现在支持 `maxContextTokens` 参数，启用 budget-aware assembly；
- 创建真实 context blocks：identity、domain_rules、id_mapping、memory_rules、current_time、skill_body、project_memory、user_message、workspace_state、pending_proposals、recent_messages；
- 优先级排序：identity(100) > domain_rules(95) > id_mapping(90) > memory_rules(88) > current_time(85) > skill_body(80) > project_memory(75) > user_message(70) > workspace_state(65) > pending_proposals(60) > recent_messages(40)；
- Retention 策略：identity/domain_rules/id_mapping/memory_rules/current_time = pinned；skill_body/project_memory/user_message/workspace_state/pending_proposals = required；recent_messages = compressible；
- Compaction 先丢 droppable，再丢 compressible，pinned 永不丢弃；
- `pi-runtime.ts` 从 model config 获取 `contextTokens`（additive 可配置字段，`ModelCapabilities.contextTokens`），未配置时使用 `DEFAULT_CONTEXT_TOKENS = 32_000`（保守默认，非模型真实能力）；
- 预算 < pinned/required 内容时：ContextLedger 仍添加所有 pinned/required blocks（安全优先），记录 `budgetExceededByPinned` 警告，compaction 元数据包含该标志；
- Compaction 元数据记录到 `agent.started` 事件的 `_context_compaction`（block types、token estimates、pinned preserved、budget exceeded flag，不含敏感正文）。

**G. Skill Router 集成到 prepareRunRequest (`request-preparation.ts`)**：
- `prepareRunRequest()` 现在在无显式 skill 时使用确定性 router；
- Router 从 SkillIndex 获取所有 skills，使用 `routeSkills()` 选择 1-2 个兼容 skills；
- 显式 `runtime_config.skill` 仍最高优先且兼容；
- 不确定/negative/conflict/prerequisite failure 时 answer mode；
- 多 Skill context 有明确可测试结构：`allSkillContexts` 数组、`routingReason` 字段；
- Outcome Contract 使用组合后的 effect ceiling（通过 `computeCombinedEffectCeiling`）；
- 两条 route 都传递 `workspaceState` 和 `hasPendingProposals` 给 router。

**H. 多 Skill 组合 (`pi-runtime.ts`)**：
- `mergeSkillContexts()` 合并多个 skill 的 body 和 allowedTools（union）；
- 合并后的 `mergedSkillContext` 用于 buildContext 和 tool filtering；
- 组合 metadata 记录到 `_context_compaction.retained_types`。

**I. evalFixtures**：
- `skill-lint.ts` 解析 evalFixtures 字段但**不运行** fixtures（无 runner 实现）；
- 仅作为 metadata 存储，不声称"已使用"。

**测试覆盖**：
- `context-blocks.test.ts`: 15 tests — budget 追踪、priority ordering、pinned/required 保证、compaction 行为；
- `context-budget.test.ts`: 10 tests — buildContext 集成、compaction metadata、pinned blocks、memory rules、answer/action mode；
- `skill-router.test.ts`: 10 tests — explicit skill、negative triggers、prerequisites、trigger examples、effect ceiling、forbidden tools、answer mode fallback；
- `skill-composition.test.ts`: 9 tests — 冲突检测、negative triggers、prerequisite failures、forbidden tools、stable ordering、answer mode fallback；
- `skill-lint.test.ts`: 7 tests — valid skills、missing tools、duplicate names、path escaping、forbidden tools、effect mismatch、real skills lint；
- `skill-resolver.test.ts`: 18 tests — prepareSkillContext、validateSkillName、parity；
- `outcome-contract.test.ts`: 11 tests — answer/act/analyze/review 分类；
- `request-preparation.test.ts`: 16 tests — validation、skill resolution、prompt kernel；
- `handler-contract.test.ts`: 6 tests — 两条 route 的 unknown skill、load failure、valid skill 行为；
- `public-stream-scenario.test.ts`: 8 tests — answer-only、action、unknown skill、load failure；
- `phase2-scenarios.test.ts`: 8 tests — **真实生产 seam**：compaction + goal/constraints retention、memory provenance、single skill tool exposure、dual skill composition、negative trigger degradation、conflict fail-closed、lazy references、forbidden tools；
- agent-bridge `734/734` tests、typecheck、build 通过；backend `717 passed / 4 skipped`、ruff 通过；`git diff --check` clean。

**Phase 2 完成状态**：
- Context Engine 已集成到 buildContext/executeRun 生产调用链；
- Skill Router V2 已集成到 prepareRunRequest；
- 多 Skill 组合已实现并影响 prompt body、tool union、effect ceiling；
- Compaction 元数据已记录到 agent.started 事件；
- 模型 context budget 从 model config 获取（additive 可配置，保守默认）；
- Lazy reference loading 保持（不自动全载）；
- evalFixtures 仅解析不运行（无 runner）；
- **真实 public stream handler scenario harness 已通过**（phase2-scenarios.test.ts）。

### Phase 3: RunPlan + WorkState + Deterministic Verifier (2026-07-12)

**A. WorkState (`work-state.ts`)**：
- `WorkStateStatus` 类型：understanding/planning/executing/verifying/awaiting_user/awaiting_approval/recovering/completed/partial/blocked/failed/cancelled；
- 合法转换表：understanding→planning/executing/awaiting_user/completed/failed/cancelled，planning→executing/awaiting_user/failed/cancelled，executing→verifying/planning/recovering/awaiting_user/awaiting_approval/completed/partial/blocked/failed/cancelled 等；
- `transitionWorkState()` 检查版本匹配（乐观并发）和转换合法性；非法或 stale transition 抛异常（fail closed）；
- `isTerminalWorkState()` 识别终态；`workStateToUserMessage()` 返回用户安全中文消息；
- WorkState 与 transport AgentRunState 分离，通过 event payload 持久化（不新增 DB 表）。

**B. RunPlan (`run-plan.ts`)**：
- `shouldCreatePlan()` 决策逻辑：answer/clarify/review 不建 plan；act with side effects、analyze with verification、显式计划关键词 → 创建 plan；
- `PlanStep` 结构：id、goal、dependencies、allowedTools、completionCriteria、status、attemptCount、maxAttempts、failurePolicy；
- `createSimplePlan()` 单步 plan；`createMultiStepPlan()` 多步 plan 带依赖；
- `advancePlanStep()` 推进步骤；`failPlanStep()` 应用 failure policy（retry/skip/abort/ask_user）；
- `getPlanProgress()` 返回用户安全进度（current/total/goal/status，不含 chain-of-thought）；
- 简单 answer-only 不建仪式化 plan。

**C. Deterministic Verifier (`verifier.ts`)**：
- 6 个验证维度：schema_validity、effect_boundary、tool_evidence、success_criteria、localization_privacy、terminal_consistency；
- `VerificationDimension`：name、passed、description、evidence、fixable；
- `VerifierReport`：schemaVersion、id、runId、timestamp、dimensions、passed、completion、hasFixableFailures、summary；
- `CompletionClassification`：complete/partial/blocked/failed/answer_only；
- effect boundary 检查 effect ceiling rank 对齐（proposal_persisted ≤ proposal_only，commit_persisted > full）；
- **tool_evidence 使用 durable ledger 成功条目**：优先使用 `ToolLedgerEntry[]` 而非仅 `toolName` 匹配 `runState.toolResults`；
- **unknown side effect → blocked/manual_review**：ledger 中 `sideEffectStatus=unknown` 的条目使 completion 为 blocked，不自动恢复；
- localization/privacy 检查：raw UUID、raw ID pattern、non-YYYY-MM-DD date format；
- 确定性检查，无 LLM judge。

**D. Runtime Loop 集成 (`pi-runtime.ts`)**：
- 创建 WorkState（run start 时 understanding）；
- 非 trivial 请求创建 RunPlan，WorkState transition 到 planning；
- agent loop 前 transition 到 executing；
- **Pi agent_end 不再设置 terminal status**：`applyPiEventToRunState` 捕获 stop reason/final content 到 `pendingTerminal`，设置非终态 `persisting_tool_result`；`mapPiEvent` 返回 `agent.output_captured`（非 terminal event type）；
- **Post-loop 终态确定**：runAgentLoop 结束后，依次执行：(1) RunPlan step reconciliation（工具成功→step completed）；(2) WorkState→verifying + 持久化 `work_state.changed` 事件；(3) 运行 deterministic verifier + 持久化 `verifier.completed` 事件；(4) 基于 cancellation + model error + verifier completion 生成且只生成一个 terminal event（agent.completed OR agent.failed OR run.cancelled）；
- **Durable control-plane events**：`work_state.changed`、`run_plan.created`、`verifier.completed` 通过 `persistControlPlaneEvent` 经 FastAPI appendEvents 持久化，每个事件有独立 payload/version，可重放完整 WorkState/RunPlan/VerifierReport；
- RunPlan step reconciliation：工具成功后更新对应 step status/attempt/evidence；
- 同 run 永远不能同时 persisted completed 和 failed；
- Progress events 不含 chain-of-thought。

**测试覆盖**：
- `work-state.test.ts`: 13 tests — 创建、转换、非法拒绝、stale 拒绝、终态、用户消息；
- `run-plan.test.ts`: 13 tests — shouldCreatePlan、plan 创建、步骤推进、failure policy、进度；
- `verifier.test.ts`: 15 tests — schema/effect/tool/success/privacy/terminal 维度、completion classification；
- `phase3-scenarios.test.ts`: 18 tests — answer-only 无 plan、action 建 plan、非法转换拒绝、verifier pass→complete、missing evidence→partial、privacy fail、无冲突 terminal、progress 安全；
- agent-bridge `793/793` tests、typecheck、build 通过；backend `717 passed / 4 skipped`、ruff 通过；`git diff --check` clean。

**Phase 3 完成状态**：
- WorkState 定义、合法转换、版本追踪已实现；
- RunPlan 创建、步骤推进、failure policy 已实现；
- 确定性 verifier 6 维度检查已实现；
- Runtime loop 已集成 WorkState/RunPlan/Verifier；
- 所有 Phase 3 核心功能已实现并测试通过。

### Phase 4: Tool Executor V2 (2026-07-12)

**A. ToolExecutor (`tool-executor.ts`)**：
- 所有 model-callable tools 必须经过 ToolExecutor，不允许 toPiTool 或其他路径绕过；
- 统一 error taxonomy：validation、policy、auth、not_found、conflict、rate_limit、timeout、transient、permanent、unknown_side_effect、budget_exceeded、cancelled；
- **错误分类映射**：HTTP errors（401→auth、404→not_found、409→conflict、429→rate_limit、ECONNREFUSED→transient）正确分类，不把除 timeout/validation 外全部变 permanent；
- 错误 observation 使用安全中文，保留 machine code，不泄漏 secrets/raw payload；
- Input schema validation（required fields + type/enum checks）；
- Policy decision（evaluatePolicy）；
- Per-tool timeout（Promise.race + AbortSignal，timer 在 finally 中清理）；
- **Timeout side-effect 分类**：read-only/effect=none + replay-safe/idempotent → `no_side_effect`（可安全重试）；advisory/proposal/write timeout → `unknown_side_effect`（manual review，不重试）；
- Retry with bounded exponential backoff + jitter（可注入以 deterministic test）；
- 只对 replay-safe/idempotent 且 side effect 尚未发生的 timeout/transient/rate_limit 做自动重试；
- validation/policy/auth/not_found/conflict/permanent/unknown_side_effect 不重试；
- **Durable ledger**：`onLedgerEntry` callback，每次 attempt 完成（validation/policy/cancel/timeout）立即持久化，不只存 latest；
- Per-attempt idempotency key：`${logicalCallId}:attempt:${attempt}`，logical ID 稳定，attempt 唯一；
- **Concurrency groups**：`ConcurrencySemaphore` 按 manifest concurrencyGroup 排队，read-only parallel 尊重 maxConcurrency，write sequential（maxConcurrency=1），取消等待锁可中断；
- **Large results**：`ToolResourceRef`（resource_id/type/summary/bytes/has_more）在超 4KB 结果中生成，模型只收 summary+ref，raw payload 不进普通 trace/context；
- Constructor 清理：移除未使用的 fastapiClient 参数。
- Result byte bound/normalization（通过 normalizeResult）。

**B. Registry Hard Gates (`registry.ts`)**：
- Duplicate name/version 拒绝（不能 map.set 静默覆盖）；
- JSON Schema 基本合法性；
- Risk/effect/policy 一致性（draft_only→proposal_create、advisory_write→advisory_record_create、read_only→none）；
- Forbidden tools 阻止（confirm/reject_proposal、execute_shell、edit_file 等）；
- LLM-callable 不能有 commit effect；
- humanTriggeredOnly + modelCallable 互斥；
- timeoutMs 范围校验（1000-300000ms）；
- destructive/openWorld + modelCallable 互斥；
- Backend contract 校验（owner=fastapi、method=POST）。

**C. ToolLedger (`tool-ledger.ts`)**：
- 每次 tool call attempt 通过 `onLedgerEntry` callback 立即持久化（包括 validation/policy/cancel/timeout failures）；
- `tool.ledger_entry` 事件类型，包含 logical call id、attempt、policy、input hash、per-attempt idempotency key、result、side effect status、reconciliation status、timestamps、resource_ref；
- `replayLedgerFromEvents` 从事件重放 ledger；
- `getToolEvidence` 获取工具成功证据（用于 RunPlan step verification 和 verifier）；
- `hasUnknownSideEffects` 检测未知副作用（verifier 使用）；
- `hasUnknownSideEffects` 检测未知副作用；
- 不新增表，复用现有 event envelope。

**D. Runtime 集成 (`pi-runtime.ts`)**：
- `toPiTool` 使用 ToolExecutor.execute() 而非直接执行；
- ToolExecutor 创建在 executeRun 中，传入 registry、fastapiClient、options；
- Ledger entry 在每次工具执行后持久化为事件；
- RunPlan step reconciliation 使用 ToolLedger 成功证据而非仅凭 toolName 匹配。

**测试覆盖**：
- `tool-registry-gates.test.ts`: 11 tests — duplicate rejection、forbidden tools、risk/effect consistency、timeout validation、destructive/openWorld blocking；
- `tool-executor.test.ts`: 11 tests — input validation、policy enforcement、timeout、retry、error taxonomy、ledger；
- `phase4-scenarios.test.ts`: 17 tests — timeout、transient retry、write timeout no retry、validation no retry、stable idempotency、duplicate rejection、large result bounded、ledger replay、no proposal-confirm exposure；
- agent-bridge `832/832` tests、typecheck、build 通过；backend `717 passed / 4 skipped`、ruff 通过；`git diff --check` clean。

**Phase 4 完成状态**：
- ToolExecutor 已实现并集成到 runtime loop；
- Registry hard gates 已实现；
- ToolLedger 已实现并通过 FastAPI events 持久化；
- 所有 enforcement（validation、policy、timeout、retry、concurrency、idempotency）已实现；
- 统一 error taxonomy 已实现；
- 所有 Phase 4 核心功能已实现并测试通过。

### Phase 5: Checkpoint + Resume + Steering (2026-07-12)

**A. Durable Checkpoint (`checkpoint.ts`)**：
- `RunCheckpoint` 接口：schemaVersion、id、runId、conversationId、workspaceId、projectId、transportStatus、workState、workStateVersion、outcomeContractSummary、runPlanSnapshot、manifestVersions、toolLedgerRefs、pendingToolCall、latestSteeringSeq、contextSummary、recoveryDecisions、timestamp、version；
- `createCheckpoint()` 从当前 run state 创建 bounded/redacted 快照（不存 raw workspace_state、secret、chain-of-thought）；
- Checkpoint 边界：post-loop（所有 tool observations 收集后）、pre-terminal（终态前）；
- 通过现有 FastAPI appendEvents API 持久化（`checkpoint.saved` 事件类型），不新增表；
- `canResumeCheckpoint()` 检查恢复资格。

**B. Recovery Policy (`checkpoint.ts`)**：
- `ToolRecoveryAction`：completed、safe_to_retry、blocked_unknown、blocked_incompatible、pending；
- `computeRecoveryDecisions()` 从 ledger 计算每个 tool call 的恢复策略：
  - success/proposal_persisted/advisory_record_persisted → completed（不重放）
  - timeout/transient + no_side_effect → safe_to_retry
  - unknown side effect → blocked_unknown（manual review）
  - policy/validation/auth/permanent → blocked_incompatible
- unknown side effect 永不自动重放（100% 硬门禁）

**C. Rehydrate (`rehydrate.ts`)**：
- `rehydrateFromEvents()` 从 FastAPI 持久化事件重建 run state：
  - 查找最新 `checkpoint.saved` 事件获取 checkpoint
  - 从 `work_state.changed` 事件重建 WorkState
  - 从 `run.state_changed` 事件重建 transport status
  - 从 `run_plan.created/step_updated` 事件重建 RunPlan
  - 从 `tool.ledger_entry` 事件重放 tool ledger
- `RehydrateResult`：success、runState、workState、runPlan、toolLedger、checkpoint、canResume、resumeReason
- Terminal states（completed/cancelled/failed）不可 resume
- unknown side effect → 不可 resume

**D. ToolLedger 增强 (`tool-ledger.ts`)**：
- `persistCheckpoint()` 持久化 checkpoint 事件
- `persistSteeringEvent()` 持久化 steering 事件
- `hasUnknownSideEffects()` 检测未知副作用

**E. Runtime 集成 (`pi-runtime.ts`)**：
- Post-loop checkpoint：agent loop 结束后、verifier 之前持久化 checkpoint
- Pre-terminal checkpoint：终态事件之前持久化 checkpoint
- Checkpoint 版本号递增记录

**测试覆盖**：
- `checkpoint.test.ts`: 7 tests — 创建、field 验证、run plan snapshot、recovery decisions、resume 资格；
- `rehydrate.test.ts`: 9 tests — 空事件、work state 重建、transport status 重建、tool ledger 重放、run plan 重建、terminal 不可 resume、unknown side effect 不可 resume、checkpoint 使用；
- `phase5-scenarios.test.ts`: 14 tests — checkpoint 边界、rehydrate、no-duplicate side effect、terminal 不可 resume、recovery policy、hasUnknownSideEffects；
- agent-bridge `862/862` tests、typecheck、build 通过；backend `717 passed / 4 skipped`、ruff 通过；`git diff --check` clean。

**Phase 5 完成状态**：
- Durable checkpoint 已实现并通过 FastAPI events 持久化；
- Rehydrate 从事件重建 run state 已实现；
- Recovery policy 已实现（no-duplicate side effect、unknown → blocked）；
- Post-loop 和 pre-terminal checkpoint 已集成到 runtime loop。

**F. FastAPI Durable API (`routes_agent_runtime.py`, `agent_runtime_service.py`)**：
- `GET /internal/agent-runs/{run_id}/snapshot`：返回 durable snapshot（run state + latest checkpoint + recent events），bounded/redacted；
- `POST /internal/agent-runs/{run_id}/steering`：追加 steering event（constraint/correction/plan_change/clarification_answer/approval_response/cancel），使用 client_message_id 幂等；
- Steering 使用 `run_state_changed` 事件类型，payload 包含 `event_category: "steering"` + `steering_type` + `content`；
- Terminal run 拒绝新 steering（409）；
- 通过 service-to-service auth 校验。

**G. Sidecar Resume + Steering (`resume-run.ts`, `steering.ts`, `fastapi-client.ts`)**：
- `POST /runs/:runId/resume`：从 FastAPI snapshot → rehydrate → 恢复同一 run（不创建新 run）；
- `POST /runs/:runId/steering`：转发到 FastAPI steering endpoint；
- cancel 类型直接转发到 cancel endpoint；
- `FastapiClient` 新增 `getRunSnapshot()` 和 `appendSteering()` 方法；
- Terminal/unknown_side_effect/incompatible 时 fail closed。

**H. Frontend Integration (`api.ts`, `types.ts`)**：
- `getRunSnapshot()`、`resumeRun()`、`sendSteering()` API 函数；
- `WorkStateStatus` 类型和 `WORK_STATE_LABELS` 中文映射；
- `SteeringType` 类型定义；
- 最小 Agent sidebar 接线（显示 work status/step、awaiting question/approval）。

**测试覆盖**：
- `checkpoint.test.ts`: 7 tests
- `rehydrate.test.ts`: 9 tests
- `phase5-scenarios.test.ts`: 14 tests
- agent-bridge `862/862` tests、typecheck、build 通过
- backend `717 passed / 4 skipped`、ruff 通过
- `git diff --check` clean

**Phase 5 完成状态**：
- Durable checkpoint + recovery policy 已实现；
- Rehydrate 从事件重建 run state 已实现；
- FastAPI snapshot/steering endpoints 已实现；
- Sidecar resume/steering routes 已实现；
- Frontend API/types 已实现；
- No-duplicate side effect enforcement 已实现。

**I. Resume Handler (`resume-run.ts`)**：
- 从 FastAPI snapshot 重建 run state，调用 `executeRun` 继续**同一 run**（不创建新 run）；
- 通过 internal workspace-state tool 获取当前 workspace state（不使用 snapshot 中的 bounded data）；
- 保持 run_id、plan/work versions、ledger/idempotency；
- Recovery decisions：completed tools 跳过、safe_to_retry 重试、unknown/incompatible blocked；
- Skill context 从 checkpoint 恢复（如有）。

**J. Steering Queue (`pi-runtime.ts`)**：
- `PendingSteeringEvent` 类型：constraint/correction/plan_change/clarification_answer/approval_response/cancel；
- `consumeSteering()` 在 agent loop 后（post-loop boundary）消费；
- constraint/correction → 持久化 `steering.consumed` 事件；
- clarification_answer + awaiting_user → transition 到 understanding；
- cancel → abort + cancelled terminal event；
- 消费事件通过 `persistControlPlaneEvent` 持久化，可重放。

**K. Awaiting Flows**：
- awaiting_user：WorkState 可从 executing/planning 转入；收到 clarification_answer 后回到 understanding/planning；
- awaiting_approval：WorkState 可从 executing 转入（effect policy request）；
- 两种状态都持久化 `work_state.changed` 事件。

**L. Compatibility Checking**：
- Checkpoint recovery decisions 基于 ledger entry 的 side effect status 和 error code；
- proposal_persisted/advisory_record_persisted → completed（不重放）；
- timeout/transient + no_side_effect → safe_to_retry；
- unknown side effect → blocked（100% 硬门禁）。

**测试覆盖**：
- `checkpoint.test.ts`: 7 tests
- `rehydrate.test.ts`: 9 tests
- `phase5-scenarios.test.ts`: 14 tests
- `phase5-complete.test.ts`: 10 tests — resume same run、steering consumed、clarification same run、cancel terminal、unknown blocked、recovery decisions、single terminal
- agent-bridge `872/872` tests、typecheck、build 通过
- backend `717 passed / 4 skipped`、ruff 通过
- `git diff --check` clean

**Phase 5 完成状态**：
- Durable checkpoint + recovery policy 已实现；
- Rehydrate 从事件重建 run state 已实现；
- FastAPI snapshot/steering endpoints 已实现；
- Sidecar resume/steering routes 已实现；
- Resume 执行同一 run（不创建新 run）；
- Steering queue 在 loop boundary 消费；
- awaiting_user/awaiting_approval 状态转换已实现；
- Frontend API/types 已实现；
- No-duplicate side effect enforcement 已实现。

### Phase 6: Operational Hardening (2026-07-12)

**A. Semver Compatibility (`semver.ts`)**：
- `parseSemVer()`、`compareVersions()`、`satisfiesRange()`、`satisfiesCompatibility()`；
- 支持 >=、<=、>、<、~（tilde）、^（caret）、exact 版本匹配；
- `checkManifestCompatibility()`：相同→compatible、同 major→regenerable、不同 major→incompatible；
- `checkPromptCompatibility()`：相同 hash→compatible、不同→regenerable；
- Checkpoint resume 使用 compatibility check 决定 continue/regenerate/blocked。

**B. evalFixtures Runner (`eval-runner.ts`)**：
- `loadFixtures()` 从 SKILL.md evalFixtures 路径加载 YAML fixtures；
- `runFixture()` 执行单个 fixture（positive/negative/prerequisite/conflict/tool_allowlist）；
- `runSkillFixtures()` 运行一个 skill 的所有 fixtures；
- Fixture schema：name、type、input、expectedSkill、expectedTools、expectedEffectCeiling、prerequisites、description；
- 真正读取并运行 fixtures，不只解析。

**C. Capability Adapter (`capability-adapter.ts`)**：
- `CapabilityAdapter` 类：controlled MCP-style capability discovery 和 registration；
- `allowedCapabilities` 白名单，不在白名单中的 capability 被拒绝；
- `discoverCapabilities()` 返回 bounded metadata，完整 schema 按需；
- `registerCapability()` 经过 ToolRegistry hard gates；
- destructive/openWorld capabilities 被拒绝；
- Lifecycle hooks：before_register、after_register、before_execute、after_execute、on_error；
- Hooks 是 deterministic，不能 mutate primary state；
- Hook failures 被记录但不阻塞执行。

**D. Compatibility Check in Resume (`checkpoint.ts`)**：
- `checkCompatibility()` 检查 manifest/skill/prompt compatibility；
- 返回 compatible/regenerate/blocked decision；
- 每个 component 记录 checkpoint version vs current version；
- Incompatible → blocked，compatible → continue，regenerable → regenerate。

**测试覆盖**：
- `semver.test.ts`: 14 tests — parsing、comparison、range checking、compatibility、manifest check；
- `eval-runner.test.ts`: 8 tests — positive/negative/prerequisite/conflict/tool_allowlist fixtures；
- `capability-adapter.test.ts`: 11 tests — discovery、registration、hooks、forbidden tools；
- agent-bridge `912/912` tests、typecheck、build 通过
- backend `717 passed / 4 skipped`、ruff 通过
- `git diff --check` clean

---

## Phase 0-6 Exit Gates Report (superseded by Final Working-Tree Audit)

### Deterministic Safety Invariants (component-level evidence)
| Gate | Status | Evidence |
|------|--------|----------|
| Proposal-Confirm boundary | ✅ COMPONENT PASS | LLM-callable tools cannot commit; confirm/reject/commit blocked at registry |
| Privacy fixtures | ✅ COMPONENT PASS | Memory visibility filtering, raw ID detection in verifier, XML escaping |
| Terminal uniqueness | ✅ COMPONENT PASS | Single terminal event enforced in post-loop; WorkState transitions validated |
| Resume no duplicate side effects | ✅ COMPONENT PASS | Recovery decisions: proposal_persisted→completed, unknown→blocked |
| Primary-state write behind confirmation | ✅ COMPONENT PASS | Tool risk categories enforced; draft_only/advisory_write boundaries |

### Routing & Outcome (Provisional Baseline)
| Gate | Status | Evidence |
|------|--------|----------|
| Skill routing accuracy | ❌ NOT MEASURED | 组件测试通过，但没有统一公开场景集上的准确率 |
| Outcome pass rate | ❌ NOT MEASURED | Verifier 已接线，但没有真实任务结果基线 |
| Latency/token/cost | ❌ NOT MEASURED | 尚未形成发布门禁指标 |

### Infrastructure Completeness
| Component | Phase | Status |
|-----------|-------|--------|
| Shared Skill resolver | 0-1 | ✅ |
| Outcome Contract | 1 | ✅ |
| Context Engine (blocks/compaction) | 2 | ✅ |
| Skills V2 metadata/router | 2 | ✅ |
| WorkState + RunPlan | 3 | ✅ |
| Deterministic Verifier | 3 | ✅ |
| Durable terminal ordering | 3 | ✅ |
| Tool Executor V2 | 4 | ✅ |
| Durable ToolLedger | 4 | ✅ |
| Durable Checkpoint | 5 | ✅ |
| Rehydrate/Resume | 5 | ✅ CORE / ⚠️ NO LIVE RESTART CANARY |
| Steering queue | 5 | ✅ CORE / ⚠️ NO COMPLETE UI |
| Semver compatibility | 6 | ✅ |
| evalFixtures runner | 6 | ✅ |
| Capability adapter | 6 | ✅ COMPONENT / ⚠️ NO EXTERNAL CONFORMANCE JOB |

### Deferred (Evidence-Based)
| Item | Reason |
|------|--------|
| Semantic LLM judge | No evidence of deterministic verifier gaps; deferred with evidence |
| Effect approval gate + UX | Control-plane state exists; end-to-end approval flow deferred |
| Frontend Agent controls | API/types implemented; complete resume/steering/approval UI deferred |
| Large result pagination | ToolResourceRef implemented; full pagination deferred |
| Trajectory/model conformance | Exporter, multi-model jobs and live canary deferred |
| Multi-agent orchestration | Out of scope per spec |
| Open-world connectors | Out of scope per spec |

## Problem Statement

ProjectFlow 用户希望 Agent 像成熟的 Claude Code/Codex 一样，能够理解目标、主动探索、制定计划、调用合适工具、根据结果调整、验证输出、处理中断并在长对话中保持一致，而不是只能按按钮触发固定业务模块。

当前 Agent 已能调用领域工具并创建 proposal/advisory records，但不同入口能力不一致，决策过程缺少持久化计划与完成判定，长任务上下文会退化，失败恢复有限，Skills 不能可靠地按需组合，系统 prompt 会强迫无意义工具调用，测试也主要证明组件存在而非用户目标达成。因此用户无法稳定预测 Agent 在复杂任务、失败场景和长会话中的表现。

## Solution

建设 **ProjectFlow Agent Harness V2**，以统一公开对话流式入口为主 seam，并由以下十个组件协作：

1. **Intent & Outcome Contract**：把请求分类为 answer、clarify、analyze、act、review；记录目标、约束、成功标准和允许的 effect ceiling。
2. **Run Planner**：为非简单任务生成结构化步骤、依赖、验证条件和进度；工具结果或用户 steering 可以触发重规划。
3. **Context Engine**：用 token ledger 装配稳定规则、目标、计划、workspace facts、近期对话、memory、skill 和 observations；支持 compaction 与 provenance。
4. **Prompt Kernel**：将不可变安全规则、运行模式、领域规则、Skill instructions 和动态上下文分层、版本化；移除全局强制工具调用。
5. **Capability Router**：根据 goal、plan step、workspace state 和 effect ceiling 动态选择最小工具集与一个或多个 Skills。
6. **Tool Executor**：统一强制 schema、policy、timeout、retry、backoff、concurrency、idempotency、result bound 和 error taxonomy。
7. **Checkpoint & Recovery**：每次可靠 observation 后持久化 checkpoint；sidecar 重启、断流或超时后从事件和 tool ledger 恢复，禁止重复副作用。
8. **Verifier-Optimizer**：先执行确定性 validator，再对少量语义质量维度使用结构化 judge；最多两次 refine，并检测不收敛。
9. **Steering & Approval**：支持 cancel、追加约束、修改计划、回答澄清和 effect-based approval；主事实提交仍走既有 proposal confirmation。
10. **Evaluation & Observability**：用统一入口运行 scenario suites，记录 outcome、plan、tools、versions、cost、latency、recovery 和 verifier evidence，形成发布门禁。

### 统一状态模型

技术传输状态与认知工作状态必须分离：

```text
TransportState:
created → context_building → model_streaming ↔ tool_running → completed/failed/cancelled

WorkState:
understanding → planning → executing → verifying
    ↘ awaiting_user
    ↘ awaiting_approval
    ↘ recovering
    → completed | partial | blocked | failed
```

TransportState 回答“进程正在做什么”，WorkState 回答“任务为什么尚未完成”。前端、trace 和 eval 都以 WorkState 为主要用户语义。

### Outcome Contract

每个 run 必须产生一个结构化 contract：

- request type；
- normalized goal；
- constraints；
- success criteria；
- required evidence；
- effect ceiling；
- clarification policy；
- verification level；
- completion mode：complete、partial、blocked 或 answer-only。

简单问答允许直接 answer-only，不得为了满足 prompt 而调用写工具。信息不足且缺口会改变结果时进入 awaiting_user。可以安全推断时记录 assumption 并继续。

### RunPlan

只有满足任一条件时才显式建 plan：需要两个以上有依赖的动作、存在副作用、需要多个工具、需要验证、预计跨越一次上下文压缩、或用户明确要求计划。简单查询不生成仪式化计划。

每个 step 包含目标、依赖、允许能力、期望 observation、完成条件、状态、attempt count 和失败策略。计划更新必须形成事件，不覆盖历史。

### Context Engine

上下文按优先级装配：

1. 安全与业务 invariant；
2. Outcome Contract 与当前 RunPlan；
3. 最新用户 steering；
4. 当前 step 必需的 workspace facts；
5. 有效 ProjectMemory；
6. 当前 Skills 与按需 references；
7. 近期关键 observations；
8. 对话摘要与必要原文。

系统维护 token ledger，并为每个 context block 记录来源、版本、可见性和保留优先级。接近预算时先丢弃过期 tool payload，再压缩历史 observations，最后生成结构化 conversation summary。Goal、未完成 steps、用户硬约束、approval 状态和未确认 side effects 永不被摘要丢失。

### Prompt Kernel

Prompt 由可测试模板分层生成：

- Kernel：身份、事实纪律、effect boundary、隐私和完成原则；
- Mode：answer/clarify/plan/act/verify/recover；
- Domain：ProjectFlow 术语与状态机；
- Skill：当前任务的工作流知识；
- Context：结构化事实与 memory；
- Tool contract：仅暴露当前 step 所需能力；
- User message：严格隔离的原始请求。

Prompt 必须带版本号和 hash。行为规则不得重复散落在 system prompt、Skill 和工具 description 中：必须执行的限制放 policy/validator；跨任务恒定原则放 Kernel；任务流程放 Skill；工具使用条件放 manifest。

### Skills V2

Skill metadata 扩展为：version、trigger examples、negative triggers、prerequisites、outcome type、allowed effects、allowed tools、required verification、references、eval fixtures 和 compatibility range。

Router 使用两阶段选择：先用确定性状态/显式 action key 缩小候选，再用小型结构化分类器或主模型选择 top-k。Skill 可以组合，但必须合并 capability allowlist 并取更严格的 effect ceiling。主流式对话和按钮式动作必须调用同一 router。

Skill 正文与 reference 分离：启动时只加载 metadata；选中后加载正文；只有某个 plan step 需要时才加载对应 reference。提供 lint、冲突检测、工具存在性检查、fixture tests 和版本兼容检查。

### Tool Platform V2

1. 注册时拒绝重复 name/version，验证 JSON Schema、risk/effect 一致性和 backend contract。
2. Tool Router 每个 step 只暴露最小集合；工具很多时先使用 capability search，再延迟加载完整 schema。
3. Tool Executor 按 manifest 执行 per-tool timeout、retry、指数退避、并发组和 provider parallel policy。
4. 错误统一分为 validation、policy、auth、not_found、conflict、rate_limit、timeout、transient、permanent、unknown_side_effect。
5. 只对明确 replay-safe 且没有 unknown side effect 的 transient error 自动重试。
6. 工具结果支持摘要、typed data、resource reference、pagination/cursor 和 provenance，避免把大 payload 直接塞回上下文。
7. 每个 call 进入 durable tool ledger，记录 intent、manifest version、attempt、policy decision、result、side effect 和 reconciliation status。
8. 新增少量控制面能力：更新 run plan、请求澄清、报告 progress、提交 verifier report；这些能力不得修改业务事实。
9. 保留禁止 arbitrary shell、file edit、SQL、URL call 和 proposal confirmation 的边界。

### Verification & Refinement

验证顺序固定为：

1. schema 与引用合法性；
2. effect boundary 与状态一致性；
3. tool evidence 是否支持结论；
4. Outcome Contract 的 success criteria；
5. 中文、日期、原始 ID、隐私与用户可见性；
6. 必要时才进行语义 rubric judge。

语义 judge 与 generator 逻辑隔离，输出结构化 dimension scores、fail reasons 和可执行反馈。只有可修复失败才进入 refine；最多两次。分数没有提升、出现同类失败或预算不足时停止，并返回 partial/blocked，而不是无限循环。

### Memory Boundaries

ProjectMemory 继续只表示受治理的项目事实和决策，不承担临时思考缓存。新增 Run Working Memory 表示当前目标、计划、摘要、pending observation 和 verifier feedback；它随 run 生命周期管理，不自动变成 ProjectMemory。

只有既有确定性 Memory Source Event 可以写 ProjectMemory。context trace 必须区分 project memory、conversation summary 和 run checkpoint，避免把模型自述误当事实。

### Steering, Approval, and Recovery

- 用户可在 run 中追加约束，消息在当前工具调用结束后优先处理。
- cancel 终止当前调用并保留可恢复 checkpoint。
- clarification 进入 awaiting_user，收到回答后继续同一 run，而不是创建无关新任务。
- tool execution approval 只用于未来开放世界或高风险 advisory capability；Proposal Confirmation 继续负责主事实提交，两者不可混用。
- sidecar restart 后由 FastAPI 读取 checkpoint、plan、tool ledger 和 manifest versions，判断 regenerate、reconcile 或 manual review。
- unknown side effect 永不自动重放。

## User Stories

1. As a project member, I want the Agent to distinguish between a question and an action request, so that asking for an explanation does not create records.
2. As a project member, I want the Agent to restate the actionable goal internally, so that it works toward the outcome I actually requested.
3. As a project member, I want the Agent to ask only blocking clarification questions, so that it does not interrupt work unnecessarily.
4. As a project member, I want the Agent to record reasonable assumptions, so that I can inspect why it continued without asking me.
5. As a project owner, I want every run to have explicit success criteria, so that “completed” means the requested result was verified.
6. As a project owner, I want non-trivial work to show a concise plan, so that I can understand what will happen next.
7. As a project owner, I want the plan to update when new evidence appears, so that the Agent does not blindly follow an obsolete plan.
8. As a project member, I want to see which step is running, so that progress is meaningful rather than a generic loading indicator.
9. As a project member, I want simple questions to finish without a ceremonial plan, so that routine use remains fast.
10. As a project member, I want the Agent to select only relevant tools, so that the model is not distracted by unrelated capabilities.
11. As a project owner, I want every side effect to be linked to the step that requested it, so that changes are auditable.
12. As a project owner, I want repeated tool calls to be idempotent, so that retries never create duplicate proposals or records.
13. As a project member, I want transient tool failures to recover automatically when safe, so that temporary network issues do not ruin the task.
14. As a project owner, I want unknown side effects to stop for review, so that the Agent never guesses whether a write occurred.
15. As a project member, I want validation errors returned as actionable Chinese observations, so that the Agent can correct its arguments.
16. As a project owner, I want tool timeouts and retries to match their manifest, so that declared policy equals runtime behavior.
17. As a project owner, I want duplicate or invalid tool manifests rejected at startup, so that registry errors cannot silently change behavior.
18. As a project member, I want read-only tools to run in parallel when safe, so that analysis completes faster.
19. As a project owner, I want proposal and advisory writes to remain sequential, so that concurrent calls cannot violate business invariants.
20. As a project member, I want the Agent to use the correct Skill for free-form conversation, so that Skills work outside dashboard buttons.
21. As a project member, I want the Agent to combine compatible Skills, so that multi-part requests can be completed in one coherent run.
22. As a Skill author, I want negative triggers and prerequisites, so that Skills do not activate on superficial keyword matches.
23. As a Skill author, I want references loaded only when needed, so that detailed playbooks do not consume every run’s context.
24. As a Skill author, I want lint and fixture tests, so that broken tool names and incompatible versions fail before release.
25. As a project member, I want the Agent to remember the original goal during long conversations, so that later answers do not drift.
26. As a project member, I want old tool payloads compacted before important constraints, so that context limits preserve what matters.
27. As a project owner, I want every injected memory item to retain provenance and visibility evidence, so that private context cannot leak.
28. As a project owner, I want temporary run summaries separated from ProjectMemory, so that model-generated notes do not become project facts.
29. As a project member, I want to interrupt and correct a running Agent, so that I do not need to cancel and restart the entire task.
30. As a project member, I want to answer a clarification and continue the same run, so that the Agent retains its plan and evidence.
31. As a project member, I want to cancel a run immediately, so that unwanted work stops without corrupting durable state.
32. As a project owner, I want a cancelled run to preserve a safe checkpoint, so that valid completed work can be inspected or resumed.
33. As a project owner, I want sidecar restarts to recover from durable state, so that process failure does not erase task progress.
34. As a project owner, I want resume to verify manifest compatibility, so that changed tools are not replayed under old assumptions.
35. As a project owner, I want primary state changes to remain behind Proposal Confirmation, so that higher autonomy does not remove human control.
36. As a project member, I want the Agent to verify its final recommendation against real workspace facts, so that fluent but unsupported advice is rejected.
37. As a project owner, I want deterministic validators to run before an LLM judge, so that security and business rules do not depend on model opinion.
38. As a project member, I want the Agent to refine a fixable weak result, so that it can recover from its first imperfect draft.
39. As a project owner, I want refinement bounded by iteration and convergence limits, so that the Agent cannot loop indefinitely.
40. As a project member, I want partial completion to be labeled honestly, so that I know what remains unresolved.
41. As a project owner, I want every run trace to identify prompt, Skill, tool and model versions, so that regressions can be reproduced.
42. As a project owner, I want quality, latency, cost and recovery metrics per scenario, so that model or prompt changes are evidence-based.
43. As a developer, I want one public end-to-end test seam, so that button and conversation paths cannot drift apart.
44. As a developer, I want scenario replay with mocked and real models, so that deterministic CI and production realism are both covered.
45. As a developer, I want adversarial prompt-injection scenarios, so that XML isolation and fact boundaries are continuously verified.
46. As a developer, I want multi-model conformance tests, so that provider switching does not silently break tool use or structured outputs.
47. As a product owner, I want release gates tied to user outcomes, so that a high unit-test count alone cannot claim Agent maturity.
48. As a project member, I want progress messages to explain the current goal and step without exposing chain-of-thought, so that the UI is useful and safe.
49. As a project owner, I want sensitive raw inputs and provider payloads excluded from normal traces, so that observability does not weaken privacy.
50. As a future integrator, I want a controlled capability adapter, so that approved external services can be added without bypassing ProjectFlow policy.

## Implementation Decisions

### Architecture

- Keep the TypeScript sidecar as the model/tool orchestration process and FastAPI as the business fact, authorization, transaction and durable event authority.
- Add an Agent control plane rather than expanding the legacy Coordinator facade.
- Preserve existing typed ProjectFlow tools, Proposal-Confirm, advisory write boundary and ProjectMemory governance.
- Use the public conversation streaming API as the primary product and evaluation seam. During migration, dashboard actions may keep their current transport, but both paths must share one behavioral preparation kernel; transport convergence happens only after parity evidence passes.
- Maintain separate transport and work state machines.
- Persist Outcome Contract, RunPlan, checkpoints, tool ledger entries and verifier reports through FastAPI-owned versioned state/events and transactions; add dedicated tables only when existing durable envelopes cannot represent the required query or integrity semantics.
- Treat current runtime and tool event envelopes as migration assets; evolve them with versioned additive fields.

### Runtime and planning

- Classify requests before acting; answer-only requests may complete without tools.
- Create plans only for non-trivial or effectful work.
- Require each plan step to declare evidence and completion criteria.
- Re-plan only on new evidence, user steering, recoverable failure or verifier feedback.
- End runs with complete, partial, blocked, cancelled or failed semantics; do not collapse them into generic completed.
- Emit user-safe progress summaries, never private chain-of-thought.

### Context and prompts

- Introduce token-budget accounting for every context block.
- Implement deterministic preservation rules for goal, constraints, pending effects, plan and approvals.
- Version the prompt kernel and record its hash in run evidence.
- Remove the unconditional “every request must call a tool” instruction.
- Keep enforceable requirements in code policy/validators, not prompt prose alone.
- Use structured summaries for long histories and retain links to original events.

### Tools

- Enforce manifest validation and duplicate rejection during registration.
- Implement a shared executor that owns policy, timeout, retry, backoff, concurrency, idempotency and result normalization.
- Distinguish retryable errors from business conflicts and unknown side effects.
- Add tool result references/pagination for large data rather than returning arbitrarily large inline JSON.
- Expose only tools allowed by the current Outcome Contract, plan step and active Skills.
- Keep arbitrary shell, filesystem, SQL, open URL and confirm-proposal capabilities unavailable to the model.

### Skills

- Make the same Skill router serve conversation and dashboard actions.
- Introduce compatible top-k Skill composition only after single-Skill route parity is proven, using least-privilege tool union and the strictest effect ceiling.
- Add versioned metadata, prerequisites, negative triggers, verification requirements and eval fixtures.
- Load metadata at startup, body on selection and references at the step that needs them.
- Fail startup or CI when Skills reference missing tools, escaping paths or incompatible manifest versions.

### Verification

- Build deterministic verifiers for schema, business invariants, references, permissions, evidence, localization, date format and privacy.
- Add an LLM judge only after deterministic verification is stable and measured evidence shows a remaining semantic quality gap.
- Persist structured verifier reports.
- Limit refinement to two iterations and stop on non-improvement.
- Use explicit partial/blocked output when criteria cannot be satisfied.

### Recovery and user control

- Checkpoint after every persisted tool result and after plan/approval state changes.
- Rehydrate from FastAPI state and events, never from sidecar memory alone.
- Resume only when manifest and schema versions are compatible; otherwise regenerate or request review.
- Add queued steering and awaiting_user/awaiting_approval semantics.
- Do not automatically replay any call with unknown side-effect status.

### Extensibility

- Define a ProjectFlow capability adapter compatible with MCP-style annotations and deferred tool discovery, without granting generic open-world access.
- Add lifecycle hooks only for deterministic enforcement or telemetry; hooks cannot bypass service authorization or mutate primary state directly.
- Defer multi-agent orchestration until the single-Agent harness passes the maturity gates. Parallel read-only analysis may later use isolated workers without sharing write authority.

## Testing Decisions

### Primary seam

The highest product seam is the public conversation streaming endpoint. A scenario sends a real user message through this endpoint and observes:

- streamed status/content/tool/done/error events;
- persisted run, work state, plan and checkpoint;
- tool ledger and events;
- proposal/advisory artifacts;
- verifier report and completion classification;
- absence of forbidden state changes or data leakage.

Dashboard Agent actions must ultimately be representable as the same typed intents and must pass parity scenarios against this seam. Their transport may remain separate during incremental migration. Lower-level runtime and tool tests remain, but release confidence comes from the public path.

### Test strategy

- Prefer external behavior over internal implementation details.
- Use deterministic mock-model scripts for CI state-machine, tool and recovery coverage.
- Run a smaller conformance suite against at least one primary and one fallback production model configuration.
- Freeze scenario inputs, expected artifacts, forbidden effects and rubric versions.
- Separate deterministic gates from stochastic quality scores.
- Repeat stochastic scenarios enough times to report pass rate and variance, not a single lucky run.
- Store redacted trajectories for failed scenarios so regressions are diagnosable.
- Compare changes against a fixed baseline before accepting prompt, Skill, model or tool updates.

### Scenario families

1. Answer-only and no-tool correctness.
2. Blocking versus non-blocking clarification.
3. Direction, planning, breakdown and assignment proposal flows.
4. Risk/check-in advisory flows and replan boundaries.
5. Multi-Skill composition.
6. Tool validation, conflict, timeout, rate limit and safe retry.
7. Cancellation, queued steering, awaiting_user and resume.
8. Sidecar restart and checkpoint rehydration.
9. Long conversation compaction and goal retention.
10. ProjectMemory visibility, rejection and member-constraint compliance.
11. Prompt injection, raw ID, secret and cross-project isolation.
12. Model/provider conformance.
13. Verifier refinement, non-convergence and partial completion.
14. Duplicate side-effect and unknown-side-effect reconciliation.

### Release gates for “mainstream Agent basic level”

- 100% of deterministic safety invariants pass.
- 100% of primary-state writes remain behind human confirmation.
- 100% of terminal runs have exactly one consistent terminal status/event.
- 100% of resume scenarios avoid duplicate side effects.
- 100% of privacy fixtures prevent unauthorized memory, raw ID and secret exposure.
- Provisional target: at least 90% safe recovery rate for injected transient tool failures; freeze the threshold after Phase 0 baseline.
- Provisional target: at least 90% Skill routing accuracy on the frozen routing set, including negative cases; freeze the threshold after Phase 0 baseline.
- Provisional target: at least 85% end-to-end outcome pass rate across the representative scenario suite for the primary model; freeze the threshold after Phase 0 baseline.
- Fallback model outcome rate may not regress more than 10 percentage points from the primary model on contract-critical scenarios.
- 100% of long-context fixtures preserve normalized goal, hard constraints, pending approvals and unfinished plan steps after compaction.
- Semantic judge disagreement and run-to-run variance are reported; semantic score alone cannot override a deterministic failure.
- Latency and token/cost budgets are recorded by scenario and compared to the pre-change baseline before rollout.

### Evaluator-optimizer policy

```text
Generate/Act
  → Deterministic Evaluate
  → Semantic Evaluate only when needed
  → PASS: finish
  → FIXABLE FAIL: refine, maximum 2
  → NON-FIXABLE / NO IMPROVEMENT: partial or blocked
```

Evaluator output is structured and versioned. The generator does not grade its own safety compliance without deterministic evidence. Full iteration history is retained in redacted trace data. The semantic-evaluator and refine branches are disabled until deterministic evaluation has stable fixtures and a measured semantic gap justifies their cost and variance.

## Delivery Roadmap

### Phase 0 — Baseline and contract freeze

- Build the unified scenario runner against the current public stream path.
- Record current outcome, routing, tool, latency, token and failure baselines.
- Draft additive Outcome Contract, WorkState, RunPlan, VerifierReport and ToolLedger contracts with explicit compatibility rules; stabilize each only after an end-to-end tracer.
- Add golden tests proving current double-path differences before convergence.

Exit: current behavior is measurable, the first Skill/prompt parity tracer passes, and draft control-plane contracts have evidence-backed open questions.

### Phase 1 — Unified ingress and prompt correction

- Make conversation and dashboard paths share one request preparation and intent envelope while allowing transport coexistence during migration.
- Add request classification and Outcome Contract.
- Remove unconditional tool-call behavior.
- Introduce prompt kernel versioning and minimal tool exposure.
- Make explicit/deterministically matched Skills work on the streaming path before introducing model-based routing or composition.

Exit: answer-only, clarify and action requests choose correct modes through one endpoint.

### Phase 2 — Context Engine and Skills V2

- Add token ledger, context blocks, provenance and compaction.
- Add Skill V2 metadata, hybrid routing, composition and lazy references.
- Add skill lint/fixtures and compatibility validation.

Exit: long-context and Skill routing gates pass without privacy regressions.

### Phase 3 — RunPlan and Verifier

- Persist WorkState, Outcome Contract and RunPlan.
- Add plan progress/replan events.
- Add deterministic verifiers; introduce bounded semantic evaluator/refinement only when measured gaps justify it.
- Expose user-safe progress UI.

Exit: non-trivial scenarios finish only after success criteria verification.

### Phase 4 — Tool Executor V2

- Enforce manifest validation, duplicate rejection and capability filtering.
- Implement real per-tool timeout, retry/backoff, concurrency groups and error taxonomy.
- Add durable tool ledger, resource references and reconciliation states.

Exit: tool failure/retry/idempotency/unknown-side-effect gates pass.

### Phase 5 — Checkpoint, resume and steering

- Persist checkpoints after reliable boundaries.
- Implement restart rehydrate, manifest compatibility and regeneration policy.
- Add queued steering, awaiting_user and awaiting_approval.
- Unify cancellation semantics across API, sidecar and frontend.

Exit: interruption and restart scenarios pass with no duplicate side effects.

### Phase 6 — Capability adapter and operational hardening

- Add deferred capability discovery and approved connector adapter.
- Add deterministic lifecycle hooks for enforcement/telemetry.
- Add quality dashboards, model conformance jobs and canary rollout.
- Remove superseded legacy routing only after parity evidence passes.

Exit: primary and fallback models pass release gates under canary traffic.

## Prioritization

P0 capabilities required for the stated target:

- unified ingress;
- Outcome Contract and answer/clarify/act distinction;
- RunPlan and WorkState;
- prompt kernel correction;
- Skills on the stream path;
- context compaction and goal retention;
- manifest-enforcing Tool Executor;
- deterministic verifier, with bounded semantic refine deferred until justified by evaluation evidence;
- checkpoint/resume without duplicate effects;
- public-seam behavior eval gates.

P1 capabilities that substantially improve maturity after P0:

- queued steering and richer awaiting_user UX;
- deferred tool search;
- semantic judge model separation;
- capability adapter and lifecycle hooks;
- quality/cost dashboard.

P2 capabilities intentionally deferred:

- multi-agent teams;
- autonomous background scheduling;
- broad external connectors;
- generalized plugin marketplace;
- arbitrary computer/browser control.

## Out of Scope

- Turning ProjectFlow into a coding agent with shell, file editing, git or arbitrary command execution.
- Giving the model direct database access or direct Primary Project State commit authority.
- Letting the Agent confirm or reject its own proposal.
- Replacing FastAPI, SQLite or the existing business domain model.
- Rebuilding ProjectMemory V1 or pulling the optional vector V1.1 project into this scope.
- Full multi-agent orchestration before the single-Agent control plane passes the release gates.
- Arbitrary URL calls, unrestricted MCP servers or open-world tools.
- Hiding raw chain-of-thought in persisted traces or showing it to users.
- Production deployment or public release as part of this specification.

## Further Notes

### Why this is the correct comparison with Claude Code and Codex

Claude Code publicly describes its harness as a repeated context-gathering, action and verification loop with interruption/steering, saved sessions, compaction, on-demand Skills, subagents, permissions and checkpoints. Codex documentation similarly emphasizes durable repository instructions, Skills, MCP/tools, sandbox/approval controls, multi-agent context isolation, verification and eval-driven workflows. ProjectFlow should adopt these control-plane properties while retaining its narrower project-management capability surface and stricter Proposal-Confirm boundary.

This means “达到基本水平” is satisfied by reliable goal completion, bounded autonomy, recovery, verification and extensibility—not by copying coding-specific tools.

### Source references

- [Claude Code: How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Claude Code: Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- [Claude Code: How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [Claude Code: Best practices](https://code.claude.com/docs/en/best-practices)
- [OpenAI Codex manual](https://developers.openai.com/codex/codex-manual.md)
- [OpenAI Codex use cases](https://developers.openai.com/codex/use-cases)

### Rollback principle

每个阶段必须以 additive schema、feature flag 和 scenario comparison 交付。新 planner、context engine、verifier 或 executor 发生回归时，可以按 workspace/run 回退到前一条 sidecar path，但不得绕过 Proposal-Confirm、viewer validation、memory visibility 或 event persistence。旧路径只有在统一 seam 的能力与安全 gates 全部通过后才允许删除。
