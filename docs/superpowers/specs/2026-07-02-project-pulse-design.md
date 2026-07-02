# T42 Project Pulse 周期巡检与今日待确认设计方案

## 背景

ProjectFlow 的核心不是记录任务，而是让学生项目小队持续知道：现在谁该做什么、谁需要同步、哪些协作链路正在断开。当前 Agent 已经能生成方向卡、阶段计划、任务拆解、分工建议、行动卡、风险和重排提案，但这些能力主要依赖用户触发。用户不点按钮时，Agent 不会主动维护项目状态感知。

这会带来一个直接问题：成员登录网站的主要动机是确认自己的任务、分工和推进状态。如果 Agent 只在被触发时分析，成员之间的对接会变慢，负责人也无法及时发现谁需要更新状态。

T42 的目标是补强 Agent 的主动推进底座，让它通过周期性巡检生成可处理的“今日待确认”，而不是只在聊天里输出建议。

## 设计目标

1. Agent 每天主动检查项目状态，发现任务、分工、check-in、风险和对接链路中的异常。
2. 巡检产物以行动卡和主动追问为主，短摘要为辅。
3. 成员打开项目后，第一眼看到今天自己需要确认、回复或处理的事项。
4. 负责人能看到项目脉搏摘要和需要介入的协作断点。
5. PulseItem 有状态闭环，Agent 能记住“问过什么、谁回了、是否升级、是否过期”。
6. LLM 不可用时仍有规则 fallback，保证基础推进能力不断。

## 非目标

V1 不做范围裁决模块。Agent 不判断一个新想法是否纳入 MVP、延后、驳回或需要澄清。

V1 不让 Agent 自动改 owner、取消任务、改截止时间、改阶段目标、改方向卡或改 MVP 边界。这些仍走现有人工确认流程。

V1 不用 PulseItem 替代 ActionCard。ActionCard 保持现状，PulseItem 作为独立的巡检结果对象。

V1 不做复杂通知中心、历史归档页、负责人审批流、批量处理、巡检频率配置或完整后台管理。

## 核心产品机制

T42 引入 Project Pulse，中文可称为“项目脉搏巡检”。它不是长报告，也不是聊天总结，而是一套周期性检查项目协作状态并生成处理项的机制。

巡检结果分三类：

1. 行动项：明确让某个人做一件事。
2. 追问题：信息不足，需要成员补充状态。
3. 摘要项：给负责人或团队看的短状态判断。

巡检产物主入口是“今日待确认”。它放在项目总览和我的任务页顶部，并作为打开项目后的首屏焦点。它不强制跳转、不弹全屏、不锁页面；有 P0 必答追问时，只限制本轮 check-in 完成，不阻止用户浏览项目或更新任务。

Agent 面板不承载主要处理动作。它负责解释为什么出现这些待确认项，展示最近一次项目脉搏摘要和触发信号。

## 巡检节奏

V1 使用“每日轻巡检 + check-in 深巡检”。

每日轻巡检默认每天 09:00 运行。它关注协作链路是否断开，不做完整项目评审。如果当天 09:00 没跑成功，用户第一次打开项目时异步补跑。

check-in 深巡检跟随 active check-in cycle 的 next_due_date。到期后后台尝试运行；如果到期后未运行，项目打开时异步补跑。它优先生成 check-in 相关追问和草稿。

页面加载不等待巡检。打开项目时先展示已有项目状态、最近一次 PulseRun 和 active PulseItems；随后后台判断是否需要补跑。补跑完成后刷新“今日待确认”和 Agent 面板摘要。

所有巡检日期按项目时区计算。当前项目沿用 Asia/Shanghai。

## 数据对象

### PulseRun

PulseRun 表示一次巡检执行。它用于防重复、记录巡检结果、支撑 Agent 面板显示“上次巡检时间”和短摘要。

字段：

- id
- project_id
- workspace_id
- patrol_type：daily_light / checkin_deep
- status：success / fallback / failed
- summary_status：on_track / watch / needs_action / blocked
- summary_text
- today_focus
- attention_items：string[]
- started_at
- finished_at

### PulseItem

PulseItem 表示巡检生成的一条需要处理、回复、解释或升级的项目脉搏项。它是用户可见、可追踪、可闭环的正式对象。

字段：

- id
- pulse_run_id
- project_id
- workspace_id
- type：action / question / summary / escalation
- priority：P0 / P1 / P2
- status：pending / answered / resolved / deferred / escalated / expired
- audience_type：member / owner / team
- audience_user_id
- source_signal
- delivery_policy：auto_send / needs_owner_approval / proposal_required
- title
- content
- evidence
- expected_response
- response_payload
- linked_task_id
- linked_stage_id
- linked_risk_id
- linked_action_card_id
- cooldown_key
- last_seen_at
- expires_at
- created_at
- updated_at

PulseItem 不支持 dismiss。它不能无语义消失，只能回答、稍后处理、标记解决或系统自动过期。

### PulseSignal

PulseSignal 是巡检内部使用的候选信号，不持久化。规则和专业模块先产出 PulseSignal，再经过合并、分级、分发策略和去重，最终写入 PulseItem。

流程：

```text
collect_signals()
→ merge_signals()
→ classify_priority()
→ apply_delivery_policy()
→ dedupe_by_cooldown_key()
→ persist_pulse_items()
```

合并规则：

```text
同一 project + same audience_user_id + same linked_task_id + same intent
→ 合并为一个 PulseItem
```

intent 可包括 ask_status、ask_blocker、confirm_assignment、remind_action、escalate_to_owner、suggest_handoff_adjustment。

## PulseItem 与 ActionCard 的边界

ActionCard 用于主动推进流程里的可执行行动建议，回答“现在做什么、怎么开始、完成标准是什么”。它的生命周期保持 active → done / dismissed。

PulseItem 用于周期性巡检流程里的协作状态处理，回答“为什么 Agent 现在要打扰这个人、这件事有没有闭环、是否需要升级”。它的生命周期更复杂。

关系：

```text
PulseItem 可以关联 ActionCard
ActionCard 不依赖 PulseItem
```

例如：巡检发现“小林的 P0 后端任务状态不明，影响小陈联调”，可以生成给小林的追问 PulseItem、给负责人的升级 PulseItem，以及给小陈的替代行动 ActionCard。

## 信号库

信号全部保留，但不是每个信号都直接打扰用户。先检测候选信号，再决定生成行动卡、追问、风险、摘要或提案。

每日轻巡检信号：

1. P0/P1 任务临近截止但状态未更新。
2. 任务状态超过 24 小时无变化。
3. check-in 逾期。
4. blocker 持续存在。
5. 分工提案未确认。
6. 行动卡过期或长期未完成。
7. 依赖任务未完成，后续任务受到影响。
8. 成员本周期可用时间明显下降。
9. 当前阶段完成率长期不动。
10. 高风险未处理或被忽略后状态未改善。

check-in 深巡检信号：

1. 成员回复中出现 blocker。
2. 成员可用时间下降。
3. 成员信心低。
4. 成员没有提交 check-in。
5. 任务状态和 check-in 内容冲突。
6. 多人提到同一个阻塞点。
7. P0 任务未按预期推进。
8. 现有行动卡没有被执行。
9. 风险已经持续多轮。
10. 当前阶段目标与已完成任务不匹配。

确定性信号由规则直接判断，例如 check-in 逾期、分工未确认、行动卡长期未完成、P0/P1 临近截止、任务 24 小时无更新、成员可用时间下降。

解释性信号交给专业模块分析，例如多人是否提到同一个 blocker、任务状态与 check-in 内容是否冲突、阶段目标与已完成任务是否不匹配、风险是否多轮未改善。

## 专业模块边界

V1 专业模块少而稳，其他信号先用规则 fallback 覆盖。

1. Check-in Readiness：在 check-in 前生成每个成员应该回答的具体问题。
2. Task Progress Patrol：判断任务是否状态不明、临近截止、长期未更新。
3. Handoff Patrol：判断任务依赖和成员对接是否断开。
4. Risk Pulse：判断信号是否需要升级为风险或负责人介入。

V1 不做深的模块：

- 成员负载深分析
- 评审准备深分析
- 阶段目标匹配分析
- 范围裁决

这些方向的信号保留，但先用基础规则或摘要覆盖。

## 分级与分发策略

巡检敏感度采用平衡型：

```text
P0 快速追问
P1 合并提醒
P2 进入摘要
```

P0 表示如果不立刻补信息，协作链路会断。它自动发给相关成员；到期未回复时，默认升级给负责人。如果存在明确依赖关系，且被影响成员能做出替代行动，再少量提醒被影响成员。

P1 表示今天值得处理，但不应该打断所有人。它合并成每日提醒，每个成员最多一条 P1 汇总。

P2 表示需要被 Agent 记住，但不应该打扰人。它只进入项目脉搏摘要，后续巡检继续观察。

delivery_policy 决定是否自动分发：

- auto_send：追问、状态更新提醒、check-in 提醒、分工确认提醒、依赖对接轻建议。
- needs_owner_approval：临时协助、放下原任务处理风险、backup owner 接手沟通、多个成员的新协作安排。
- proposal_required：换 owner、改截止时间、取消或延后任务、改阶段计划、改方向卡、改 MVP 边界。

V1 可以生成 proposal_required 的 PulseItem 作为入口提示，但不直接执行结构性变更。

## 冷却与去重

为避免重复打扰，V1 使用 cooldown。

规则：

- P0：同一成员 + 同一任务 + 同一问题，12 小时内不重复追问。
- P1：同一成员每天最多合并提醒 1 次。
- P2：只进摘要，不推送。
- 负责人升级：同一问题 24 小时内最多 1 次。
- 依赖成员提醒：同一依赖链 24 小时内最多 1 次。

如果已有 pending 的 PulseItem 没处理，不生成同类新项，只更新 evidence 和 last_seen_at。

## 今日待确认

“今日待确认”是 Project Pulse 的主要用户入口。

位置：

1. 项目总览顶部：展示项目级和当前用户相关的 P0/P1。
2. 我的任务页顶部：只展示当前用户相关 PulseItem。
3. Agent 面板：展示项目脉搏摘要和解释，不作为主要处理入口。

打开项目后，如果存在 P0/P1 PulseItem，“今日待确认”作为首屏焦点突出显示，但不强制跳转。

排序：

```text
P0 必须处理
→ P1 今日建议处理
→ 分工确认
→ check-in 草稿
→ 普通行动卡
```

数量限制：

- P0 永远显示。
- 最多显示 5 条。
- P1 超过 3 条时合并。
- P2 不进 inbox，只进摘要。

卡片交互保持极简。每张卡只有一个主操作，最多一个次操作。

- 追问卡：回答 / 稍后处理。
- 行动卡：标记已处理 / 稍后处理。
- 分工确认卡：去确认 / 稍后处理。
- 升级卡：查看影响 / 稍后处理。
- check-in 草稿卡：确认提交 / 继续编辑。

卡片正文固定三层：

```text
标题：请确认后端 API 的当前进度
原因：这个 P0 任务 24 小时未更新，且会影响前端联调。
需要你做：回答当前是否卡住，或选择稍后处理。
```

卡片元信息用标签展示，例如 P0、需回复、今天到期、影响 1 人。

## PulseItem 状态闭环

支持状态流转：

```text
pending → answered → resolved
pending → deferred → pending / escalated / expired
pending / deferred → escalated
pending / deferred / answered → expired
pending / answered / deferred / escalated → resolved
```

回答用于追问类 PulseItem。稍后处理需要给原因或预计时间。标记已解决用于用户确认问题已经不存在。系统自动过期用于任务完成、阶段结束、分工确认、风险解决或新一轮 check-in 已提交等场景。

如果用户标记 blocker 已解决，但关联任务仍是 blocked，系统应提示用户同步更新任务状态，或生成轻量追问：“是否把任务状态从 blocked 更新为 in_progress？”

## Check-in 汇入机制

Pulse 回复可以汇入 check-in，但只限 check-in 相关追问。

可汇入的 PulseItem：

- 任务状态追问
- blocker 是否解除
- 今天或本周期可投入时间
- 任务是否已经开始
- 当前任务进度说明
- 信心或风险反馈

不汇入 check-in 的 PulseItem：

- 给负责人的升级提醒
- 给下游成员的替代行动建议
- 分工确认提醒
- 负责人确认项
- 风险摘要
- 非个人任务相关建议

汇入方式不是静默写入，而是生成 check-in 草稿：

```text
PulseItem.response_payload
→ CheckInResponse draft
→ 用户确认
→ 写入 check-in
```

用户回答若干 check-in 相关追问后，系统整理成本轮 check-in：

- 做了什么
- 卡点
- 下周期可用时间
- 信心

用户确认后再提交。

## 项目脉搏摘要

摘要不做长报告，不做评分。它是一张短状态提示卡。

固定结构：

```text
状态
一句话判断
今日重点
需要关注
```

状态四档：

- on_track：正常推进
- watch：需要关注
- needs_action：需要处理
- blocked：已阻塞

中文显示：

- 正常推进
- 需要关注
- 需要处理
- 已阻塞

示例：

```text
状态：需要介入
一句话判断：当前阶段的关键链路卡在后端任务状态不明。
今日重点：先确认小林能否完成接口字段。
需要关注：
- 小林有 1 个 P0 追问待回复
- 小陈可以先做接口 mock
- 分工提案还有 1 个未确认
```

摘要来源是 PulseRun.summary_*。LLM 不可用时，规则 fallback 生成基础摘要。

## 失败处理与 fallback

周期性巡检不能完全依赖 LLM。执行链路：

```text
读取项目状态
→ 确定性规则检测基础信号
→ 生成基础 PulseSignal
→ 必要时调用专业模块解释、归并和生成自然追问
→ Agent 成功：用 Agent 优化后的 PulseItem
→ Agent 失败：用规则 fallback 生成基础 PulseItem
→ 写入 PulseRun + PulseItem
→ 前端显示今日待确认
```

fallback 至少生成：

- check-in 逾期提醒
- P0/P1 任务临近截止提醒
- 任务长时间未更新追问
- 分工提案未确认提醒
- blocker 持续存在提醒
- 行动卡未完成提醒

fallback 只能生成 auto_send 的低风险内容，不能生成临时协作安排、换 owner、砍任务、改计划等高影响建议。

## API 边界

V1 只做五个核心接口：

```text
POST /projects/{project_id}/pulse-runs/run
GET /projects/{project_id}/pulse
POST /pulse-items/{id}/answer
POST /pulse-items/{id}/defer
POST /pulse-items/{id}/resolve
```

`GET /projects/{project_id}/pulse` 支持 `current_user_id` 参数，用于后端整理 my_items 和 checkin_draft。

返回结构建议：

```text
latest_run
active_items
my_items
owner_items
team_items
checkin_draft
```

V1 不做：

- PulseItem 删除
- dismiss
- 完整历史列表
- 批量处理
- 复杂负责人审批流
- PulseItem 转正式 replan 的专门接口
- 巡检频率配置

## 运行策略

后台定时为主，打开项目补跑兜底。

Daily light patrol：

- 默认每天 09:00 运行。
- 如果当天没有 success 或 fallback 的 daily_light PulseRun，用户打开项目时异步补跑。
- 手动刷新不重复生成同类 PulseItem。

Check-in deep patrol：

- 跟随 active check-in cycle 的 next_due_date。
- 到期后后台尝试运行。
- 如果到期后还没运行，项目打开时异步补跑。

异步补跑期间：

- 页面先显示旧状态。
- “今日待确认”先显示已有 active PulseItem。
- 可显示轻提示“正在更新项目脉搏...”。
- 补跑完成后刷新数据。
- 不弹 modal。

## V1 范围

V1 交付的核心体验：

1. 项目有每日轻巡检和 check-in 深巡检。
2. 巡检会生成 PulseRun 和 PulseItem。
3. “今日待确认”成为项目打开后的首屏焦点。
4. 我的任务页展示当前用户相关 PulseItem。
5. Agent 面板展示短项目脉搏摘要和解释。
6. P0/P1/P2 分级生效。
7. P0 未回复默认升级给负责人；有明确依赖且下游能调整时，少量提醒被影响成员。
8. PulseItem 不支持忽略，必须回答、稍后处理、解决或自动过期。
9. check-in 相关 Pulse 回复可整理成 check-in 草稿。
10. LLM 失败时使用规则 fallback。

## 后续扩展

后续可以考虑：

- 范围裁决模块。
- 成员负载深分析。
- 评审准备深分析。
- 阶段目标匹配分析。
- PulseItem 历史页。
- 负责人确认队列。
- 巡检频率配置。
- 更完整的通知渠道。
- PulseItem 与 ActionCard 的长期模型统一。

## 自检

本方案没有把 Agent 升级为自动决策者。高影响变更仍需人工确认。

本方案没有让 PulseItem 替代 ActionCard。两者边界独立。

本方案没有把摘要做成长报告。摘要保持短状态提示卡。

本方案保留完整信号库，但 V1 专业模块少而稳，避免一口气扩成通用项目管理系统。

