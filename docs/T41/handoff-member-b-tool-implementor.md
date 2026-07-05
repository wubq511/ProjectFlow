# T41 Agent Runtime Implementation — Member B Handoff (Tool Implementor)

## 角色

你是 T41 Agent Runtime 重构的 Tool Implementor，负责 read path purity、proposal/advisory tool endpoints 和 legacy parity/cutover。

## 总体背景

ProjectFlow 要从固定 CoordinatorAgent 升级为工具化 Agent Runtime。架构：TypeScript Agent Bridge Sidecar + Pi 组件级 Runtime + ProjectFlow Tool Contract + Durable AgentRunState + Proposal-Confirm Commit。

**核心原则：**
- FastAPI/DB 是唯一事实源
- LLM-callable tools 不能 commit Primary Project State
- Tiered Write Boundary：Runtime Metadata / Reviewable Draft Record / Advisory Project Record / Primary Project State
- Read-only paths 不能修复或推进 Stage/Project
- Proposal Confirmation 是当前唯一的人类确认边界
- Agent-inferred task status changes 必须走 replan proposal
- Risk（任意 severity）可直接创建为 Advisory Project Record
- Risk mitigation 改主事实时必须走 proposal confirmation

## 关键文档

先读这些：

### 核心设计文档

| # | 文档 | 重点章节 | 参考时机 |
|---|------|----------|----------|
| 1 | `docs/PRD-Agent-Runtime.md` | 完整 PRD | 了解需求全貌 |
| 2 | `docs/T41/ProjectFlow_Agent_Runtime_Team_TDD.md` | §4 架构原则、§7 事务边界、§8 Tool Contract | 架构决策、边界确认 |
| 3 | `docs/T41/ProjectFlow_Agent_Runtime_Foundation_Design.md` | §4 Runtime Loop、§7 Tool Hooks、§8 Policy Engine、§11 State Ownership | S6/S7/S13 实现参考 |
| 4 | `docs/T41/ProjectFlow_Agent_Tools_Skills_Design.md` | §2 Write Effect Boundary、§4.5-4.10 tool specs、§7 Internal Endpoints、§8 旧 Coordinator 迁移 | S6/S7/S13 工具定义 |

### 领域知识

| # | 文档 | 说明 | 参考时机 |
|---|------|------|----------|
| 5 | `CONTEXT.md` | 领域词汇表 | 遇到领域术语时查阅 |

### 架构决策记录 (ADR)

| # | 文档 | 决策 | 参考时机 |
|---|------|------|----------|
| 6 | `docs/adr/0002-tiered-agent-write-boundary.md` | 四层写入边界：runtime_metadata/reviewable_draft/advisory_write/primary_commit | S6/S7/S13 工具分类 |
| 7 | `docs/adr/0003-use-replan-proposals-for-agent-inferred-task-state-changes.md` | Agent 推断的任务状态变化走 replan proposal | S13 replan 相关工具 |
| 8 | `docs/adr/0004-keep-project-state-read-paths-pure.md` | Read path 无副作用，不隐式推进状态 | S4 read purity 实现 |

### 研究文档

| # | 文档 | 说明 | 参考时机 |
|---|------|------|----------|
| 9 | `docs/T41/research/agent-write-boundary-research.md` | 写入边界研究：LangGraph、OpenAI Agents SDK 对比 | 深入理解边界设计 |
| 10 | `docs/T41/research/read-path-state-mutation-research.md` | Read path 状态变更研究 | S4 read purity 深入参考 |

### 现有代码参考

| 文件 | 重点 | 参考时机 |
|------|------|----------|
| `backend/app/services/project_state_service.py` | `_catch_up_stage_progress()` | S4 移除隐式状态推进 |
| `backend/app/services/agent_flow_service.py` | `_persist_agent_output()` 和 `_create_agent_proposal()` | S6/S7/S13 迁移参考 |
| `backend/app/services/task_service.py` | `create_status_update()` | S4/S13 task status 处理 |
| `backend/app/services/risk_service.py` | Risk 创建逻辑 | S7 advisory write 参考 |

**额外需要读的现有代码：**
- `backend/app/services/project_state_service.py` — 特别是 `_catch_up_stage_progress()`
- `backend/app/services/agent_flow_service.py` — 特别是 `_persist_agent_output()` 和 `_create_agent_proposal()`
- `backend/app/services/task_service.py` — 特别是 `create_status_update()`
- `backend/app/services/risk_service.py`
- `backend/app/services/agent_proposal_service.py`
- `backend/app/agent/output_schemas.py` — 特别是 `RiskAnalysisOutput.requires_confirmation`

## Issue Tracker

- PRD: https://github.com/wubq511/ProjectFlow/issues/45
- 你的 slices: #49 (S4), #51 (S6), #52 (S7), #57 (S12), #58 (S13)
- Lead (Robert) 的 slices: #46 (S1), #47 (S2), #54 (S9), #55 (S10), #60 (S15)
- Member A 的 slices: #48 (S3), #50 (S5), #53 (S8), #56 (S11), #59 (S14), #61 (S16)

## 同步点与依赖关系

整个 T41 有两个硬同步点，其余时间三人可以完全独立并行。

### 同步点 1：S5 (Read-only tools) — 你的 S4 必须先完成

```
Robert: S1 → S2 ──────┐
Member A: S3 ──────────┼→ S5 (Member A 实现) → S6+S7 (你) / S8 (A) / S9 (Robert) 三线并行
你: S4 ────────────────┘
```

- **S4 无 blocker**：你可以立即开始，不需要等任何人。
- **S5 阻塞**：S5 需要 S1+S2+S3+S4 全部完成。你的 S4 是其中一环。
- **你的动作**：立即开始 S4，完成后 merge。S5 由 Member A 实现，你不需要等 S5 完成才能做其他事。
- **S5 完成后**：你可以开始 S6 和 S7（两者都依赖 S5）。

### 同步点 2：S12 (Legacy cutover) — 等 S10 完成

```
S6+S7 (你) → S12 (你，等 S10)
```

- S12 需要 S5+S6+S7+S8+S9+S10 全部完成。
- **你的动作**：S6+S7 完成后，如果 S10 还没完成，可以先写 S12 的 parity test 框架和 test fixtures，但完整验证要等 S10。

### 无同步点：可直接推进的 slices

- **S4**：无 blocker，立即开始
- **S6**：等 S5 完成后直接开始
- **S7**：等 S5 完成后直接开始（S6 完成后接着做）
- **S12**：等 S10 完成后直接开始
- **S13**：等 S5 完成后直接开始（与 S6/S7 并行）

## 你的 Slices（5 条）

### S4: Read-only purity + State Repair Command → #49

**状态：已完成（2026-07-04，本地分支 `member-b/s4-read-purity`）。**

这是最重要的基础工作之一。当前 `GET /api/projects/{project_id}/state` 会隐式推进 Stage/Project，违反 read purity。

1. **移除 `_catch_up_stage_progress()`** — 从 `get_project_state()` 中移除 `_catch_up_stage_progress()` 调用。`GET /api/projects/{project_id}/state` 只返回当前持久化状态视图。

2. **保留 `try_advance_stage()` 在 command path** — `POST /tasks/{task_id}/status-updates` 中的 `try_advance_stage()` 保持不变。这是正确的 command path（人类明确操作）。

3. **新增 State Repair Command** — 新增显式 repair 路径，用于修复 seed/import/direct DB edit 造成的 stale Stage/Project 状态。候选方案：admin CLI、内部 API endpoint、maintenance job。Repair 调用 `_catch_up_stage_progress()` 的逻辑，但只在被显式调用时执行。

4. **Read purity 测试** — 新增回归测试：GET 不改变 persisted 或 in-session 的 Project.status、Project.current_stage_id、Stage.status。

5. **更新现有测试** — `test_project_state_endpoint.py` 移除对隐式 catch-up 的依赖。

**关键约束：**
- human-origin `TaskStatusUpdate` 可在同一 command transaction 内触发 `try_advance_stage()`
- seed/import/direct DB edit 造成的 stale 由 State Repair Command 修复
- `get_workspace_state()` 当前已满足 read-only，加回归测试锁住

**验收标准：**
- [x] `get_project_state()` 不再调用 `_catch_up_stage_progress()`
- [x] State Repair Command 实现完成
- [x] Read purity 回归测试通过
- [x] Repair command 测试通过
- [x] 现有测试更新，不依赖隐式 catch-up

**本轮落地内容：**
- `backend/app/services/project_state_service.py`
  - 移除 `get_project_state()` 中的隐式 `_catch_up_stage_progress()` 调用，确保 `GET /api/projects/{project_id}/state` 保持纯读。
  - 将修复逻辑提炼为显式 `repair_project_state()` / `_repair_stage_progress()`，只在 repair command 调用时执行。
- `backend/app/api/routes_projects.py`
  - 新增 `POST /api/projects/{project_id}/state-repair`，作为显式 State Repair Command。
- `backend/app/schemas/project_state.py`
  - 新增 `ProjectStateRepairRead` 响应结构，返回 `changed`、`repaired_stage_ids`、`current_stage_id`、`project_status`。
- `backend/app/tests/test_project_state_endpoint.py`
  - 新增 project/workspace 读路径纯读回归测试。
  - 新增 repair service 和 repair API 测试，覆盖单阶段修复与级联修复到项目完成。

**验证：**
- 运行：`python -m pytest app/tests/test_project_state_endpoint.py app/tests/test_nplus1_workspace_state.py -v`
- 结果：`8 passed`

**交接影响：**
- S4 已完成，Member A 的 S5（read-only tools）不再被本 slice 阻塞。
- 2026-07-05：S5（Member A）与 S9（Robert）已落地到 `main`，S6 已可开始。

### S6: First proposal tool: stage plan proposal → #51

**状态：已完成（2026-07-05，本地分支 `member-b/s6-stage-plan-proposal`）。**

实现第一个 proposal tool，验证 proposal creation → confirmation 的完整路径。

1. **Internal endpoint** — `POST /internal/agent-tools/stage-plan-proposal`
   - 复用旧 `CoordinatorAgent.generate_stage_plan` 的 LLM 调用、schema validation、fallback、reference validation
   - 复用 `agent_flow_service._create_agent_proposal()` 创建 pending AgentProposal
   - 不 commit Stage/Project

2. **Manifest** — risk_category=draft_only, effects.effect_type=proposal_create, idempotency_key_required=true, execution.mode=sequential

3. **Idempotency** — 同一 (run_id, tool_call_id, tool_name, tool_version) 重试返回已有 proposal_id

4. **Side effect status** — tool 成功时 side_effect_status=proposal_persisted, 返回 proposal_id + links.agent_event_id

5. **Tests** — draft_only 不 commit 的 contract test、idempotency 测试、proposal confirmation 边界测试

**关键约束：**
- tool success observation 只在 FastAPI 持久化成功后返回
- 现有 `test_agent_proposal_confirm.py` 的 plan 确认测试应该继续通过

**验收标准：**
- [x] endpoint 实现完成
- [x] 创建 pending AgentProposal，不 commit
- [x] idempotency 测试通过
- [x] side_effect_status=proposal_persisted
- [x] 现有 proposal confirm 测试继续通过

**本轮落地内容：**
- `backend/app/api/routes_agent_tools.py`
  - 在 unified internal tool dispatcher 中新增 `stage-plan-proposal` 路由分发。
- `backend/app/services/agent_tools_service.py`
  - 新增 `stage-plan-proposal` handler，复用 `CoordinatorAgent.generate_stage_plan` 和既有 `run_agent_flow(...)` / pending `AgentProposal` 持久化链路。
  - 同一 `idempotency_key` 重试时复用既有 `plan` proposal，不重复创建草案。
  - tool success 返回 `side_effect_status=proposal_persisted`，并带回 `links.proposal_id` 与 `links.agent_event_id`。
- `agent-bridge/src/tools/projectflow-tools.ts`
  - 新增 `generate_stage_plan_proposal` manifest，配置为 `draft_only`、`proposal_create`、`sequential`、`project_proposal_write`。
  - 默认注册到 sidecar tool registry，映射到 `POST /internal/agent-tools/stage-plan-proposal`。
- `backend/app/tests/test_agent_tools_api.py`
  - 新增 S6 回归测试，覆盖 pending proposal 创建、不直接创建 Stage、idempotency 复用，以及 confirm 后落库 Stage。
- `agent-bridge/tests/unit/projectflow-tools.test.ts`
  - 新增 stage plan proposal manifest / executor / registry 测试。

**验证：**
- `python -m pytest backend/app/tests/test_agent_tools_api.py backend/app/tests/test_agent_proposal_confirm.py -v`
- `npm test -- --run tests/unit/projectflow-tools.test.ts`
- `npm run typecheck`
- 结果：backend `35 passed`，sidecar unit `123 passed`，typecheck 通过

**交接影响：**
- S6 已完成，Member B 的 S7（advisory write tool）已解除阻塞，可直接开始。
- S13 仍按原计划在 S6 / S7 完成后继续。

### S7: Advisory write tool: Risk/ActionCard → #52

**已完成（2026-07-05）。**

已实现 advisory write tool 路径，并完成 AI + 人工验收。

**实现结果：**

1. **Internal endpoint** — `POST /internal/agent-tools/checkins-and-risks-analysis`
   - 复用 `CoordinatorAgent.analyze_checkin` 和 `analyze_risks`
   - 将 advisory 持久化与旧 `_persist_agent_output()` 剥离，避免沿用会触发主事实写入的旧副作用链
   - Risk（任意 severity）可直接创建为 Advisory Project Record
   - `action_cards` tool arguments 可直接创建 `ActionCard` Advisory Project Record
   - tool result 返回 `created_ids`、`related_event_ids`、`replan_signal`
   - 不改 Primary Project State

2. **Manifest / registry**
   - sidecar 新增 `analyze_checkins_and_risks`
   - `risk_category=advisory_write`
   - `effects.effect_type=advisory_record_create`
   - `idempotency_key_required=true`

3. **Mitigation 边界**
   - high-severity Risk 的 mitigation 如果涉及 Task.status / owner / due_date / Stage / Project 变更，仍需后续走 replan proposal
   - Risk row 创建本身不需要确认
   - `RiskAnalysisOutput.requires_confirmation` 已改为 mitigation confirmation 语义

4. **不直接修改 Task.status**
   - tool 不调用 `create_status_update()`
   - Agent 推断出的 task status changes 通过 `replan_signal.task_changes` 返回，交给后续 replan tool 处理

5. **Idempotency**
   - 同 key 重试复用同一次 advisory 结果，不重复创建 Risk/ActionCard
   - Risk dedup 继续沿用 open/accepted task+type 规则；ActionCard dedup 按 active project+task+type+title

6. **Tests**
   - 覆盖 advisory write 不改主事实
   - 覆盖 Risk/ActionCard `created_ids` 返回
   - 覆盖 idempotency 复用
   - 覆盖 mitigation / replan 边界

**关键改动文件：**
- `backend/app/api/routes_agent_tools.py`
- `backend/app/services/agent_tools_service.py`
- `backend/app/agent/output_schemas.py`
- `backend/app/tests/test_agent_tools_api.py`
- `agent-bridge/src/tools/projectflow-tools.ts`
- `agent-bridge/tests/unit/projectflow-tools.test.ts`

**验证：**
- `python -m pytest backend/app/tests/test_agent_tools_api.py -q`
- `python -m pytest backend/app/tests/test_checkin_replan_migration.py -q`
- `python -m pytest backend/app/tests/test_agent_output_schemas.py -q`
- `npm test -- --run tests/unit/projectflow-tools.test.ts`
- `npm run typecheck`
- 结果：backend `18 + 1 + 33 passed`，sidecar unit `125 passed`，typecheck 通过

**合并修正：**
- 补齐 ActionCard advisory 创建路径，不再只保留空入口。
- 移除 high-severity Risk 自动要求 `requires_confirmation=true` 的旧 schema 校验；该字段只表示 mitigation/replan 主事实变更需要确认。
- `replan_signal.reason` 改为中文模型可见文本。

**关键约束：**
- 任意 severity 的 Risk 都是 advisory，不需要 proposal confirmation
- 只有 mitigation 改主事实才需要 confirmation
- `requires_confirmation` 要重新解释，不阻止 advisory Risk row 创建
- tool result 必须返回 created_ids

**验收标准：**
- [x] endpoint 实现完成
- [x] Risk 任意 severity 可直接创建
- [x] mitigation 改主事实走 replan signal / 后续 replan proposal 边界
- [x] `requires_confirmation` 改为 mitigation confirmation 语义
- [x] 不直接调用 `create_status_update()`
- [x] idempotency 和 advisory boundary 测试通过

### S12: Legacy Coordinator parity + cutover → #57

**Blocked by S10 (Robert 产出)。S6+S7 完成后可先写 test 框架，完整验证等 S10。**

收尾工作。验证新 path 与旧 path 产出一致。

1. **Parity test 套件** — 每条旧 flow 都有 parity test：输出 schema、reference validation、fallback、AgentEvent、proposal payload、created IDs、frontend artifact

2. **Idempotency tests** — 每个 proposal/advisory tool 的 idempotency

3. **Side-effect reconciliation tests** — unknown side effect 禁止自动 fallback、tool crash 后 reconciliation

4. **Safety tests** — sidecar 无 DB 访问、LLM tools 无 confirm/reject/commit、shell/file 不注册、internal endpoints 有权限校验

5. **Feature flag** — 按 flow/tool 细粒度，不全局粗切

6. **Cutover 条件** — parity + idempotency + safety tests 全部通过

7. **Coordinator 缩减** — 保留为 legacy adapter 直到全部 cutover

**验收标准：**
- [ ] 每条 flow 有 parity test
- [ ] idempotency/safety/reconciliation tests 通过
- [ ] feature flag 按 flow 控制
- [ ] Coordinator 保留为 legacy adapter

### S13: Remaining proposal tools: direction card + task breakdown → #58

**已完成（2026-07-05，本地分支 `member-b/s13-direction-card-task-breakdown`）。**

已实现剩余的 proposal tools，完全复用 S6 的 proposal creation 模式。

**实现结果：**

1. **Direction card proposal** — `POST /internal/agent-tools/direction-card-proposal`
   - 复用 `CoordinatorAgent.generate_direction_card` 的 LLM 调用、schema validation、fallback
   - 复用 `agent_flow_service._create_agent_proposal()` 创建 `proposal_type=clarify` 的 pending AgentProposal
   - 不 commit Project

2. **Task breakdown proposal** — `POST /internal/agent-tools/task-breakdown-proposal`
   - 复用 `CoordinatorAgent.generate_task_breakdown` 的 LLM 调用、schema validation、fallback
   - 复用 `agent_flow_service._create_agent_proposal()` 创建 `proposal_type=breakdown` 的 pending AgentProposal
   - 不直接创建 Task

3. **Manifest / registry**
   - sidecar 新增 `generate_direction_card_proposal` 和 `generate_task_breakdown_proposal`
   - `risk_category=draft_only`、`effects.effect_type=proposal_create`
   - `idempotency_key_required=true`、`execution.mode=sequential`
   - 注册到 `createProposalTools()` 和 `createDefaultProjectFlowTools()`

4. **Idempotency** — 同一 (run_id, tool_call_id, tool_name, tool_version) 重试返回已有 proposal_id

5. **Side effect status** — tool 成功时 `side_effect_status=proposal_persisted`，返回 `proposal_id + links.agent_event_id`

**关键改动文件：**
- `backend/app/api/routes_agent_tools.py`
- `backend/app/services/agent_tools_service.py`
- `backend/app/tests/test_agent_tools_api.py`
- `agent-bridge/src/tools/projectflow-tools.ts`
- `agent-bridge/tests/unit/projectflow-tools.test.ts`

**验证：**
- `python -m pytest backend/app/tests/test_agent_tools_api.py -q`
- `npm test -- --run tests/unit/projectflow-tools.test.ts`
- `npm run typecheck`
- 结果：backend `36 passed`，sidecar unit `162 passed`，typecheck 通过

**验收标准：**
- [x] direction card proposal endpoint 实现完成
- [x] task breakdown proposal endpoint 实现完成
- [x] 创建 pending AgentProposal，不 commit
- [x] idempotency 测试通过
- [x] side_effect_status=proposal_persisted

## 与其他成员的接口

**Lead (Robert) 产出、你消费：**
- S1 schemas → 你的 S6/S7 需要 ToolResult/Manifest/ToolManifest 类型
- S2 append API → 你的 S6/S7 需要通过这个 API 持久化 event/tool result
- S9 replan migration → 你的 S12 需要验证 replan migration 正确性

**Member A 产出、你消费：**
- S5 read-only tools → 你的 S6 需要 list_pending_proposals 来避免重复 proposal

**你产出、Lead 消费：**
- S4 read purity → S5 read-only tools 依赖 read path 无副作用
- S6/S7 tool endpoints → Lead 的 S10 event bridge 需要这些 flows 的 event
- S12 parity → 确认所有迁移正确

## 开发环境

```bash
cd backend
source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000

# 测试
python -m pytest app/tests/ -v
python -m pytest app/tests/test_agent_proposal_confirm.py -v
python -m pytest app/tests/test_replan_proposal_flow.py -v
python -m pytest app/tests/test_assignment_flow.py -v
python -m pytest app/tests/test_project_state_endpoint.py -v
```

## 安全约束

- 密钥不进代码/commit/日志
- `unknown` side effect status 禁止自动 fallback
- LLM-callable tools 不包含 confirm/reject/commit
- internal endpoints 仍做 permission check

## Suggested Skills

- 无需特定 skill，专注后端 tool endpoints 和测试
