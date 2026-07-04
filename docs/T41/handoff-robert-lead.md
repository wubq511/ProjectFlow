# T41 Agent Runtime Implementation — Lead Handoff (Robert)

## 角色

你是 T41 Agent Runtime 重构的 Lead，负责核心基础设施、跨切面关注点、全量测试和最终收尾。

## 总体背景

ProjectFlow 要从固定 CoordinatorAgent 升级为工具化 Agent Runtime。架构已确定：TypeScript Agent Bridge Sidecar + Pi 组件级 Runtime + ProjectFlow Tool Contract + Durable AgentRunState + Proposal-Confirm Commit。架构选型不再讨论，以已提交文档为准。

## 关键文档

先读这些，按顺序：

1. `docs/PRD-Agent-Runtime.md` — 完整 PRD
2. `docs/T41/ProjectFlow_Agent_Runtime_Team_TDD.md` — 总方案
3. `docs/T41/ProjectFlow_Agent_Runtime_Foundation_Design.md` — 底座设计
4. `docs/T41/ProjectFlow_Agent_Tools_Skills_Design.md` — Tools & Skills 设计
5. `CONTEXT.md` — 领域词汇表
6. `docs/adr/0001-agent-runtime-confirmation-boundary.md`
7. `docs/adr/0002-tiered-agent-write-boundary.md`
8. `docs/adr/0003-use-replan-proposals-for-agent-inferred-task-state-changes.md`
9. `docs/adr/0004-keep-project-state-read-paths-pure.md`
10. `docs/T41/research/agent-write-boundary-research.md`
11. `docs/T41/research/read-path-state-mutation-research.md`

## Issue Tracker

- PRD: https://github.com/wubq511/ProjectFlow/issues/45
- 你的 slices: #46 (S1), #47 (S2), #54 (S9), #55 (S10), #60 (S15)
- Member A 的 slices: #48 (S3), #50 (S5), #53 (S8), #56 (S11), #59 (S14), #61 (S16)
- Member B 的 slices: #49 (S4), #51 (S6), #52 (S7), #57 (S12), #58 (S13)

## 同步点与依赖关系

### 同步点 1：S5 (Read-only tools) — 你的 S1+S2 必须先完成

```
你: S1 → S2 ──────┐
Member A: S3 ──────┼→ S5 (Member A 实现) → S6/S7/S8/S9/S13/S14 三线并行
Member B: S4 ──────┘
```

- **你负责**：先完成 S1 再做 S2。S1 的 schemas 是其他所有人的类型基础。
- **触发条件**：S1+S2 merge 后，通知 Member A 开始 S3。Member B 的 S4 无依赖可同步开始。
- **合流信号**：S1+S2+S3+S4 全部 merge 后，Member A 开始 S5。

### 同步点 2：S10 (Event bridge) — 你的 S9 必须先完成

```
S5 ──→ S6 (B) ──┐
     ──→ S7 (B) ──┤
     ──→ S8 (A) ──┼→ S9 (你) → S10 (你) → S11 (A)
     ──→ S13 (B) ─┤               └→ S12 (你) → S15 (你)
     ──→ S14 (A) ─┘
```

- **你负责**：S9 (replan migration)。S9 完成后开始 S10。
- **触发条件**：S5 merge 后，三人各自开始 S6/S7/S8/S9/S13/S14 并行。你的 S9 不依赖其他工具 slices。
- **合流信号**：S9+S6+S7+S8 全部 merge 后，你开始 S10。

### 你的 slices 执行顺序

```
S1 → S2 ──────────→ S9 ──→ S10 ──→ S15
```

- **S1**：无 blocker，立即开始
- **S2**：等 S1 完成
- **S9**：等 S5 完成（不需要等 S6/S7/S8/S13/S14）
- **S10**：等 S9+S6+S7+S8 完成
- **S15**：等 S10+S12+S13+S14 完成

## 你的 Slices（7 条）

### S1: Foundation schemas, manifest, tool result, event, trace → #46

**无 blocker，立即开始。**

- AgentRunState、Tool Manifest、ProjectFlowToolResult、RuntimeEvent、TraceEnvelope、Error Model
- **HumanActionManifest** — model_callable=false，描述 confirm/reject/commit 等人类动作
- Python SQLModel + TypeScript interface + snake_case/camelCase adapter 测试
- 写入 Boundary 层级：Runtime Metadata / Reviewable Draft Record / Advisory Project Record / Primary Project State

### S2: FastAPI append/persistence API with idempotency → #47

**Blocked by S1。完成后通知 Member A 开始 S3。**

- AgentRun/AgentRunState SQLModel
- `POST /internal/agent-runs/{run_id}/events:append` — 原子提交
- Idempotency key 幂等、event_seq 按 run_id 单调分配
- Internal tool endpoint 框架

### S9: Check-in/replan migration → #54

**S5 merge 后直接开始。**

- `generate_replan_proposal` tool endpoint
- `analyze_checkins_and_risks` 不再直接调用 `create_status_update()`
- Agent 推断的 task status changes 走 replan proposal

### S10: Event bridge + trace envelope → #55

**同步点 2。等 S6+S7+S8+S9 完成后开始。**

- 完整 Pi → ProjectFlow event 映射
- Trace envelope 串起 run/tool/proposal 关联
- Proposal confirmation events

### S15: Unit tests + evaluation tests + privacy/resume tests → #60

**Blocked by S10+S12+S13+S14。最后执行。**

- **Foundation unit tests**（8 个）：manifest parser, policy engine, event mapper, trace envelope builder, result normalizer, budget checker, run state transition validator, side effect status classifier
- **Evaluation tests**（21 个 Test Matrix 场景）：侧重 skill selection 和 tool evaluation
- **Privacy/resume tests**：trace 默认不含 sensitive data、manifest version mismatch、debug raw payload 模式

## 与其他成员的接口

**你产出、Member A 消费：**
- S1 schemas → A 的 S3 sidecar 需要类型定义
- S2 append API → A 的 S3 sidecar 需要调用此 API
- S10 event bridge → A 的 S11 前端需要消费 event stream

**你产出、Member B 消费：**
- S1 schemas → B 的 S6/S7/S13 tool endpoints 需要类型定义
- S2 append API → B 的 S6/S7/S13 需要通过此 API 持久化

**Member A 产出、你消费：**
- S3 sidecar → S10 event bridge 需要 sidecar event stream
- S14 skills → S15 需要测试 skill selection

**Member B 产出、你消费：**
- S6/S7/S13 tool endpoints → S10 需要这些 flows 的 event
- S12 parity tests → S15 补充 evaluation tests

## 安全约束

- 不发布 npm 包或部署生产
- 不删除旧 Coordinator 直到 parity tests 通过
- 不提交 vendor imports 到 Git
- 密钥不进代码/commit/日志/traces
- `unknown` side effect status 禁止自动 fallback
