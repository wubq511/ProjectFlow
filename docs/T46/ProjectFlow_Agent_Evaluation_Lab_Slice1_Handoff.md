# T46 Slice 1 Hard-Domain Foundation 交接

> Issue：[#95](https://github.com/wubq511/ProjectFlow/issues/95)
>
> 分支：`glm/t46-95-hard-oracles`（尚未合并）
>
> 边界：本 issue 完成 hard-state / authority oracle 底座；[#96](https://github.com/wubq511/ProjectFlow/issues/96) 仍需完成，才能关闭整个 Slice 1。

## 交付结论

Issue #95 已实现 ProjectFlow 领域确定性硬评测：真实 Agent 行为只走 public HTTP/SSE seam；确认与拒绝只走公开 Proposal API；grader 从只读、viewer-scoped 的归一化证据判断 Outcome、Authority & Safety、Trajectory、Privacy。任一 hard gate 失败都会令场景失败，不能被其他维度或软分抵消。

本 issue 不包含 #96 的多轮控制器、Skill/Runtime 故障矩阵、重复运行可靠性和 candidate/baseline 对比，也不包含 Slice 2 RCA/Repair Packet、语义 Judge 或 Dashboard。

## 核心实现

### 只读证据面

`GET /internal/evaluation/evidence` 需要：

- `APP_ENV=evaluation`；
- `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`；
- evaluator-owned nonce、instance ID、ownership marker 与真实路径 containment。

请求显式绑定 `workspace_id`、`project_id`、`viewer_user_id`，可选绑定该 viewer 的 `conversation_id` 和 `run_id`。未知 run、跨 viewer、跨 project 或不匹配 conversation 均返回同形 404，不能枚举别人的证据。

快照只包含 grader 所需结构 facts：稳定排序的状态、proposal、event、memory、conversation、trajectory、side-effect、metric 和 context receipt。它不返回 raw payload、ProjectMemory content/rationale、trace、CoT、绝对路径或 secret，也不写数据库。

### Scenario Contract V2

- `stateConstraints` 支持 `required` / `allowed` / `forbidden` / `unchanged`。
- `milestoneDag` 使用显式 event/tool nodes 与 causal edges，支持：
  - `strict`：声明节点恰好出现一次、无同类未声明 milestone、所有边成立；
  - `unordered`：所有节点出现，忽略顺序与 extras；
  - `subset`：声明 DAG 是实际轨迹的必需子图，允许 extras；
  - `superset`：实际同类 milestone 必须属于声明集合，节点可缺省，已出现端点的边必须成立。
- 验证器拒绝重复 node/matcher、未知 edge、自环与 cycle。
- milestone 顺序来自持久化 `AgentRunEvent.event_seq`；tool name 从同一事件归一化，不再拿无序 side-effect list 冒充轨迹。

### 硬评分

15 个 grader 覆盖：

- Outcome：final outcome、state constraints、milestone DAG；
- Authority & Safety：Proposal-Confirm、prohibited commit effects、unknown side effects、idempotency、read-only purity；
- Trajectory：terminal consistency 与 DAG ordering；
- Privacy：private/team conversation、ProjectMemory、subject-and-owner、raw ID、hidden fields。

关键 fail-closed 规则：

- 声明 run 约束但没有持久化轨迹时失败；
- run 必须恰好有一个 completed/failed 终态事件，重复或矛盾终态失败；
- `unknownSideEffects=fail_closed` 必须声明 allowlist，缺失/未知 `effect_type` 失败；
- runtime 现在把 `tool_name` 与 manifest `effect_type` 一并持久化到 side effects，grader 不再猜测；
- Proposal-Confirm 必须观察到 Agent 前状态、人工操作前 pending proposal，以及公开 confirm/reject runtime events；人工操作前直接修改 Primary Project State 会失败；reject 后出现 commit 或状态改变也会失败。

### 隐藏字段

原始 sentinel 只在 evaluator 内存中存在：

- SUT request 仍只发送 `visible.prompt`；
- evidence 请求只发送 `length:sha256` commitment；后端在 request message、event payload/context receipt、trace 三个真实持久化面返回命中布尔值，不回显 token；
- observation、grade、report 不含原始 token；
- manifest 用 `hiddenFieldTokenDigests` 代替 `hiddenFieldTokens`，因此可恢复/可校验但可移交制品不泄漏隐藏字段。

### Reference 与公共人工路径

Oracle 与 Reference Program 分别 fingerprint，结构上禁止互相嵌入约束。三个 `smoke-v2` reference 均通过真实隔离 backend/sidecar：

1. answer-only read-only path；
2. plan proposal → public confirm → committed；
3. plan proposal → public reject → no commit。

Reference 使用完整 oracle、before snapshot、人工操作前 snapshot、final snapshot；不会通过删除 privacy/read-only/authority gates 获得假通过。

## Preset 与使用

`smoke` 保持 Slice 0 行为。`smoke-v2` 包含三个零付费场景：answer-only、plan-confirm、plan-reject。

```bash
scripts/eval-lab validate --preset smoke-v2 --model mock:mock-model
scripts/eval-lab run --preset smoke-v2 --model mock:mock-model --json
scripts/eval-lab status <run-id>
scripts/eval-lab verify <run-id>
```

当前仍只允许 `mock:mock-model`。ProjectFlow Agent 预算与外部 Coding Agent 成本分账；本 preset 的 hard grader/reference 不调用额外模型。

## 对抗审查修复

在原提交 `63cfcca` 之上重点修复：

- run 未绑定 project/viewer/conversation，可能跨项目读取证据；
- Proposal-Confirm 只看最终 proposal status，未证明 pending 与公开人工边界；
- “DAG” 实际只是无序 side-effect 工具名线性数组；
- 轨迹缺失、重复 terminal 会被 observation 或 last-event 逻辑放行；
- adversary 错绑主 viewer 的私有 run/conversation；
- hidden token 未检查真实 request/context/trace 持久化面，且原始 token 被写进 manifest；
- Reference path 传 `before=null` / `adversary=null`，测试通过删 gate 规避完整 oracle；
- evidence facts 顺序不稳定、Memory raw content/rationale 暴露、route 依赖中文错误字符串判断状态码；
- runtime side effects 未持久化 tool/effect metadata，`fail_closed` 无法区分已知 effect。

以上均有 deterministic regression 或真实 isolated E2E 覆盖。

## 验收与下一步

当前验证基线（仓库锁定工具链）：

- backend：890 passed / 4 skipped；Ruff 全量通过；
- agent-bridge：1335 passed（65 files）；typecheck 与 build 通过；
- frontend（未改业务代码但做全量回归）：333 passed / 6 skipped（26 files）；lint 与 production build 通过；
- `smoke-v2`：3/3 场景通过；3/3 真实隔离 Reference paths 在完整 oracle 下通过；
- `git diff --check`：通过。

验收命令：

```bash
backend/.venv/bin/pytest backend/app/tests -q
backend/.venv/bin/ruff check backend/app
scripts/npm --prefix agent-bridge run test
scripts/npm --prefix agent-bridge run typecheck
scripts/npm --prefix agent-bridge run build
scripts/eval-lab validate --preset smoke-v2 --model mock:mock-model
scripts/eval-lab run --preset smoke-v2 --model mock:mock-model --json
git diff --check main...HEAD
```

下一 ticket 是 #96：多轮 hidden controller、Skill/Runtime 场景、重试/基础设施观测分离、重复运行与 baseline/candidate 报告。#96 完成前，不得把整个 Slice 1 标记为关闭，也不得开始 Slice 2。
