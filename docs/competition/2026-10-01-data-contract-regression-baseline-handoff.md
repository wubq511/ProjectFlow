# ProjectFlow 阶段 0：数据契约与回归基线交接

状态：已完成，待合并（2026-10-02）

分支：`codex/data-contract-regression-baseline-20261001`

依赖基线：`codex/unify-project-types-demo-seed-20261001` @ `b69ce4f48606792254bd2b861eec869bec414958`

## 1. 范围与边界

- 仅实施阶段 0：固定数据/API/Bridge 契约、补齐关键断裂链路及失败测试。
- 保留 Next.js、FastAPI、SQLite、Agent Bridge；FastAPI 仍是业务事实源。
- 保留 Proposal → Confirm；未新增多 Agent Runtime 或独立 Experiment 系统。
- 未删除项目页面、Mock 模型或演示种子。
- 未引入无法由数据库计算的宣传指标。
- 本分支从上一阶段功能分支创建，未修改 `main`。

## 2. 审计结论与决策

1. `EvidenceRef` 已存在于 Agent 结构化输出和前端类型，但 AssignmentProposal、Risk、ActionCard 原先没有数据库字段，服务层也没有持久化，刷新后依据会永久丢失。本分支将其作为阶段 0 的实际断裂链路修复。
2. DirectionCard 虽有新旧键归一化函数，但 Agent 使用的 WorkspaceState 曾绕过它，造成普通 API 与 Agent 上下文看见不同字段。本分支统一所有读取路径。
3. 评审摘要的公开入口为 `POST /api/projects/{id}/export/review-summary`。阶段 0 用后端与前端特征测试固定该入口，不重构现有导出组装逻辑。
4. Workspace `team_size`、统一后的 `project_template` 已有创建/读取/迁移测试；旧 `use_case` 只保留为迁移输入，不再属于公开 API。
5. 验证活动后续继续建模为 Task；阶段 0 只预留测试结构，不提前创造 Experiment 实体。

完整契约见：`docs/competition/ProjectFlow_阶段0数据契约基线.md`。

## 3. 逐文件修改台账

### 3.1 数据模型、Schema 与迁移

| 文件 | 修改内容 |
| --- | --- |
| `backend/app/schemas/evidence.py` | 新增唯一的 `EvidenceRef` Pydantic 契约，必填 `entity_type/field/value`，`entity_id` 可选。 |
| `backend/app/agent/output_schemas.py` | 删除重复定义，复用公共 `EvidenceRef`，防止 Agent 输出与 API 漂移。 |
| `backend/app/models/assignment.py` | AssignmentProposal 新增非空 JSON `evidence_refs`，默认 `[]`。 |
| `backend/app/models/risk.py` | Risk 新增同构 `evidence_refs`。 |
| `backend/app/models/action_card.py` | ActionCard 新增同构 `evidence_refs`。 |
| `backend/app/schemas/assignment.py` | Create/Read Schema 增加 `evidence_refs`。 |
| `backend/app/schemas/risk.py` | Create/Read Schema 增加 `evidence_refs`。 |
| `backend/app/schemas/action_card.py` | Create/Read Schema 增加 `evidence_refs`。 |
| `backend/app/schemas/workspace_state.py` | Agent workspace state 的分工建议增加 `evidence_refs`。 |
| `backend/app/core/database.py` | 新增幂等 `_migrate_evidence_refs()`；旧表补列并令既有行默认 `[]`，无需删除 SQLite。 |

### 3.2 服务与聚合读取

| 文件 | 修改内容 |
| --- | --- |
| `backend/app/services/assignment_service.py` | 创建分工建议时序列化并持久化 EvidenceRef。 |
| `backend/app/services/risk_service.py` | 创建风险时持久化 EvidenceRef。 |
| `backend/app/services/action_card_service.py` | 创建行动卡时持久化 EvidenceRef。 |
| `backend/app/services/agent_flow_service.py` | Agent flow 的分工、风险、行动卡输出均传递 EvidenceRef。 |
| `backend/app/services/agent_tools_service.py` | 直接/建议工具的分工、风险、行动卡写入均传递 EvidenceRef。 |
| `backend/app/services/agent_proposal_service.py` | 确认重排建议后创建行动卡时保留 EvidenceRef。 |
| `backend/app/services/replan_service.py` | 重排链路的行动卡保留 EvidenceRef。 |
| `backend/app/services/project_state_service.py` | ProjectState 风险转换返回 EvidenceRef。 |
| `backend/app/services/workspace_state_service.py` | WorkspaceState 分工建议返回 EvidenceRef；DirectionCard 改为统一归一化读取。 |
| `backend/app/api/routes_risks.py` | Risk API 转换返回 EvidenceRef。 |

### 3.3 Agent Bridge

| 文件 | 修改内容 |
| --- | --- |
| `agent-bridge/src/tools/projectflow-tools.ts` | `recommend_assignment` 与 `create_risk` manifest 增加可选 `evidence_refs`，字段使用 FastAPI 的 snake_case。 |
| `agent-bridge/tests/unit/projectflow-tools.test.ts` | 固定数组结构、必填键及可选 `entity_id`，防止 Bridge/FastAPI 契约漂移。 |

### 3.4 前端类型与展示

| 文件 | 修改内容 |
| --- | --- |
| `frontend/src/lib/types.ts` | DirectionCard 补齐已有扩展字段，避免 Agent 扩展信息被前端类型截断。 |
| `frontend/src/components/ui/evidence-ref-list.tsx` | 新增共用“结构化依据”展示；翻译常见字段，只显示字段和值，不显示内部实体 ID。 |
| `frontend/src/components/ui/evidence-ref-list.test.tsx` | 验证非空渲染、空值不渲染及不泄露 entity ID。 |
| `frontend/src/components/assignment/assignment-flow-panel.tsx` | 分工建议展示结构化依据。 |
| `frontend/src/components/risk/risk-card.tsx` | 风险卡展示结构化依据。 |
| `frontend/src/components/agent/action-card.tsx` | 行动卡展示结构化依据。 |
| `frontend/src/lib/api.test.ts` | 固定唯一公开评审摘要导出 method/path 和返回结构。 |

前端部分遵循现有卡片视觉语言，采用紧凑、只读的共享组件，没有重排页面或新增交互入口。

### 3.5 测试与文档

| 文件 | 修改内容 |
| --- | --- |
| `backend/app/tests/test_phase0_data_contracts.py` | 新增 EvidenceRef 全链路往返、DirectionCard 新旧 JSON 三路径一致、导出结构与时间线事件特征测试。 |
| `backend/app/tests/test_database_migrations.py` | 新增三张旧表补 EvidenceRef 列、既有行默认值及迁移幂等测试。 |
| `docs/competition/ProjectFlow_阶段0数据契约基线.md` | 固定九类对象、JSON 序列化、旧库迁移、Bridge、前端消费与后续测试结构。 |
| 本文件 | 记录分支基线、审计决策、逐文件修改、实际验证和已知基线债务。 |

## 4. 验证记录

### 4.1 通过项

| 命令/范围 | 结果 |
| --- | --- |
| 后端阶段 0 + 迁移定向测试 | `7 passed` |
| 后端受影响链路测试：phase0、migration、project template、seed/export、agent tools、project state | `122 passed` |
| Agent Bridge manifest 定向测试 | `253 passed` |
| 前端 EvidenceRef + API 导出定向测试 | `24 passed` |
| Agent Bridge `npm run typecheck` | 通过 |
| Agent Bridge `npm run build` | 通过 |
| 前端 `npm run lint` | 通过 |
| 前端 `npm run build` | 通过，Next.js 生产构建及 TypeScript 校验成功 |
| 后端 `python -m compileall -q app` | 通过 |
| `git diff --check` | 通过；仅 Git 提示现有 Windows CRLF 转换策略 |

### 4.2 全量后端基线

`pytest -q` 实际结果：`855 passed, 4 skipped, 67 failed, 2 errors`。

失败归因：

- 绝大多数失败用例把 Project deadline 硬编码为 `2026-07-01`、`2026-08-01` 或 `2026-08-15`。执行日为 2026-10-02，生产 Schema 正确拒绝过去日期，测试随后读取错误响应中的 `id` 而连锁失败。
- 两个资源安全用例依赖 Windows 创建符号链接的权限，当前环境无法满足。
- 新增及本次受影响的定向测试全部通过，未发现 EvidenceRef、DirectionCard、导出或 Bridge 改动造成的回归。

处理决定：本分支不放宽“截止日不能早于当前日期”的生产校验，也不把大范围旧测试日期重写混入数据契约变更。应在独立测试维护分支中将固定日期改为相对日期，并为 Windows symlink 用例增加能力检测/条件跳过。

## 5. 推送记录

- 功能提交：`58899ca`（`feat(contract): establish phase 0 regression baseline`）。
- 目标远端：`origin` = `https://github.com/scy404/ProjectFlow.git`。
- 目标分支：`codex/data-contract-regression-baseline-20261001`。
- 2026-10-02 首次推送失败：`Recv failure: Connection was reset`。
- 第二次网络重试未获执行授权，当前提交仅保存在本地新分支；未修改或推送 `main`。
