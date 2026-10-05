# ProjectFlow 阶段 0 数据契约基线

版本：2026-10-02  
适用分支：`codex/data-contract-regression-baseline-20261001`  
事实源：FastAPI + SQLite；Next.js 与 Agent Bridge 均为消费者，不自行定义第二套业务状态。

## 1. 契约原则

1. 数据库模型负责持久化，Pydantic Schema 负责 API 边界校验与返回形状，服务层负责 JSON 转换及业务引用校验。
2. Agent Bridge 仅转发 FastAPI 契约；跨进程字段统一使用 `snake_case`。
3. 前端可用 `camelCase` 命名局部视图状态，但 API 类型及请求体必须与 FastAPI 保持 `snake_case`。
4. Agent 建议写操作继续遵循 Proposal → Confirm。`EvidenceRef` 只解释建议依据，不绕过确认机制。
5. 旧库升级由 `create_db_and_tables()` 内的幂等迁移完成，禁止要求用户删除 SQLite 文件重建。
6. 缺少新增字段的旧行必须获得安全默认值；无法解析的旧 JSON 在读取时回退为空列表、空对象或 `null`，不令接口崩溃。

## 2. 核心对象契约矩阵

下表中的“数据库字段”为当前持久化事实；枚举值由 `backend/app/models/enums.py` 与相应 Pydantic Schema 约束。

| 对象 | 数据库事实 | 写入 Schema | 读取 Schema / API | Agent / 前端消费 |
| --- | --- | --- | --- | --- |
| Project | `id, workspace_id, name, idea, deadline, deliverables, project_template, status, current_stage_id, direction_card, created_by, created_at, updated_at` | `ProjectCreate`；`ProjectUpdate` | `ProjectRead`；`POST /api/projects`、`GET/PATCH /api/projects/{id}`、`GET /api/projects/{id}/state` | workspace state 与 project state 均返回项目模板和归一化后的方向卡；前端项目表单、总览及 Agent 上下文消费 |
| Workspace | `id, name, owner_user_id, description, team_size, project_template, created_at, updated_at` | `WorkspaceCreate`，owner 由 query 参数提供 | `WorkspaceRead`；`POST/GET /api/workspaces`、`GET /api/workspaces/{id}` | `team_size` 与 `project_template` 均返回前端；旧 `use_case` 只作为迁移输入，不是公开契约 |
| DirectionCard | 不设独立表，保存在 `Project.direction_card` TEXT JSON | `ProjectUpdate.direction_card: dict`；Agent clarify 确认后写入 | 所有 Project、ProjectState、WorkspaceState 读取路径均调用 `normalize_direction_card()` | 当前键：`problem, users, value, deliverables, boundaries, risks, suggested_questions`；扩展键按存在性返回 |
| Task | `id, project_id, stage_id, title, description, priority, status, owner_user_id, backup_owner_user_id, due_date, estimated_hours, dependency_ids, acceptance_criteria, can_cut, assignment_reason, order_index, created_by_agent, updated_at` | `TaskCreate`、`TaskUpdate`、`TaskStatusUpdateCreate` | `TaskRead`；`POST /api/tasks`、`GET/PATCH /api/tasks/{id}`、项目/阶段任务列表 | 验证活动继续建模为 Task；后续只在 Task 契约上增加验证语义，不建立 Experiment Runtime |
| AssignmentProposal | 原有字段 + `evidence_refs` JSON；状态仍为 `proposed → ... → finalized` | `AssignmentProposalCreate` | `AssignmentProposalRead`；创建、单条读取、项目列表及 project/workspace state | Agent 分工建议可附结构化依据；确认/拒绝/协商/最终分配流程不变 |
| Risk | 原有字段；`evidence` 为 TEXT JSON；`evidence_refs` 为 JSON | `RiskCreate`、`RiskUpdate` | `RiskRead`；`POST /api/risks`、项目列表与状态更新 | `evidence` 保留可读说明，`evidence_refs` 提供可追溯字段依据；风险卡仅显示可读字段和值，不暴露实体 ID |
| ActionCard | 原有字段 + `evidence_refs` JSON | `ActionCardCreate`、`ActionCardUpdate` | `ActionCardRead`；`POST /api/action-cards`、项目列表与状态更新 | Agent 下一步建议可展示结构化依据；原卡片类型、状态和十个页面均保留 |
| TimelineEvent | 实际模型名为 `AgentEvent`，表名 `agent_events`；快照存为 TEXT JSON | 由服务内部创建，无通用公开 Create Schema | `AgentEventRead`；`GET /api/projects/{id}/timeline` | 记录 Agent 事件、确认状态及导出事件；用户界面使用可读摘要而非原始 ID |
| Export | 无独立数据库表；是由数据库当前状态派生的 Markdown | 无请求体 | `{ markdown: string }`；唯一公开入口 `POST /api/projects/{id}/export/review-summary` | 前端 `exportReviewSummary()` 调用该入口；成功后写一条 `event_type=export` 的 AgentEvent |

## 3. DirectionCard 新旧 JSON 兼容

当前标准键与旧键映射如下：

| 当前键 | 可接受旧键 | 规则 |
| --- | --- | --- |
| `users` | `target_users` | 优先读取当前键，空值时读取旧键 |
| `value` | `core_value` | 同上 |
| `boundaries` | `constraints` + `out_of_scope` | 当前键为空时合并旧列表并去重 |
| `risks` | `initial_risks` | 当前键为空时读取旧列表 |

`source_summary`、`assumptions`、`unknowns`、`mvp_boundary`、`decision_points`、`reason` 属于兼容扩展字段：只有数据中存在时才返回。非法 JSON、非对象 JSON 或空字符串返回 `null`。Project API、聚合 ProjectState 和供 Agent 使用的 WorkspaceState 必须得到同一归一化结果。

## 4. JSON 字段序列化规则

| 字段 | SQLite 表示 | 写入规则 | API 读取规则 | 旧值/坏值回退 |
| --- | --- | --- | --- | --- |
| `Project.direction_card` | TEXT JSON object | `json.dumps(..., ensure_ascii=False)` | `normalize_direction_card()` | `null` |
| `Stage.done_criteria` | TEXT JSON array | 服务层 JSON 编码 | `list[str]` | `[]` |
| `Task.dependency_ids` | TEXT JSON array | 服务层 JSON 编码 | `list[str]` | `[]` |
| `Task.acceptance_criteria` | TEXT JSON array | 服务层 JSON 编码 | `list[str]` | `[]` |
| `Risk.evidence` | TEXT JSON array | `json.dumps(..., ensure_ascii=False)` | `list[str \| dict]` | `[]` |
| `AssignmentProposal/Risk/ActionCard.evidence_refs` | SQLite JSON column | SQLAlchemy JSON serializer；服务层将 Pydantic 对象 `model_dump()` | `list[EvidenceRef]` | 迁移默认 `[]` |
| `AgentEvent.input_snapshot/output_snapshot` | TEXT JSON object/array | `set_*_snapshot()` | `get_*_snapshot()`，API 返回已解码值 | 事件创建者必须写合法 JSON；当前不静默吞掉损坏事件 |

`EvidenceRef` 的稳定结构为：

```json
{
  "entity_type": "task",
  "entity_id": "optional-internal-id",
  "field": "priority",
  "value": "P0"
}
```

`entity_type`、`field`、`value` 必填且非空；`entity_id` 可选。前端只显示字段标签和值，不显示内部实体 ID。

## 5. SQLite 迁移保证

应用启动调用 `SQLModel.metadata.create_all(engine)` 后运行幂等迁移：

- `_migrate_workspaces()`：补 `team_size`、`project_template`，并将旧 `use_case` 映射到统一枚举。
- `_migrate_projects()`：补 `project_template`，旧项目默认 `general`。
- `_migrate_evidence_refs()`：为 `assignment_proposals`、`risks`、`action_cards` 补 `JSON NOT NULL DEFAULT '[]'`。
- 现有 proposals、tasks、agent runs、conversation 迁移继续按原顺序执行。

每个迁移先检查表与列，允许重复启动。阶段 0 回归测试使用真实旧式 SQLite 表验证：迁移可重复执行，既有行读取到 `[]`，无需人工 SQL 或删除数据库。

## 6. Agent Bridge ↔ FastAPI 契约

| Bridge 工具 | FastAPI 入口 | 新增/固定字段 | 可选性 |
| --- | --- | --- | --- |
| `recommend_assignment` | `POST /internal/agent-tools/assignment-recommendation` | `evidence_refs[]`，item 使用 `entity_type/entity_id/field/value` | 整体可选，默认空；item 的 `entity_id` 可选 |
| `create_risk` | `POST /internal/agent-tools/create-risk` | 同上 | 同上 |
| Agent flow 结构化输出 | FastAPI agent flow service | Assignment、Risk、ActionCard 输出中的 `evidence_refs` | 缺失时为空列表 |

Bridge manifest 的字段名、必填性和 FastAPI Schema 由单元测试共同固定。Bridge 不缓存或二次持久化这些字段。

## 7. 前端消费约定

- `EvidenceRef`、AssignmentProposal、Risk、ActionCard 的 API 类型包含 `evidence_refs`。
- 分工建议、风险卡、行动卡共用 `EvidenceRefList`，避免三套展示逻辑漂移。
- 展示将常见字段翻译为中文，并复用状态翻译；未知字段以去下划线文本兜底。
- 该展示是解释层，不提供直接写操作，也不改变 Proposal → Confirm。
- DirectionCard 前端类型允许标准字段及已存在的扩展字段，避免 Agent 返回扩展信息时被本地类型截断。

## 8. 阶段 0 回归覆盖

已建立或固定以下行为：

1. Project/Workspace `project_template` 创建、种子、读取及旧库迁移。
2. Workspace `team_size` 创建与读取。
3. DirectionCard 旧键经 Project、ProjectState、WorkspaceState 三条路径读取一致。
4. EvidenceRef 经 API 创建、SQLite 落库、列表、ProjectState、WorkspaceState 完整往返。
5. 旧数据库新增 EvidenceRef 列后既有行默认 `[]`，迁移可重复运行。
6. 统一导出入口的 method/path、返回 `{markdown}`、核心章节和 export 时间线事件。
7. Bridge manifest 的 EvidenceRef 字段命名与可选性。
8. 前端空依据不渲染、非空依据可读且不泄露内部实体 ID。

## 9. 后续测试结构预留

本阶段不提前引入未实现实体，也不加入永久跳过的伪测试。后续阶段按依赖链增加：

- `test_validation_task_contracts.py`：验证任务仍是 Task；覆盖验证目标、验收标准、状态转换及项目聚合读取。
- `test_validation_result_contracts.py`：结果关联 Task 与证据；覆盖写入、回读、缺失证据和旧任务兼容。
- `test_permissions_api.py`：覆盖 owner/member/非成员对读取、建议确认、状态修改及导出的权限矩阵。

这些测试必须先写失败用例，再实现字段与接口；若新增数据库字段，继续遵循模型 → Schema → 迁移 → 服务 → Agent 状态 → 前端类型 → 前端展示 → 测试的完整清单。

## 10. 已知边界

- 当前导出组装逻辑仍位于公开路由中，旧 `export_service` 未接线。阶段 0 仅冻结唯一公开行为，重构不得在数据契约前改变输出。
- TimelineEvent 在产品语言中称“时间线事件”，代码模型名为 `AgentEvent`；本阶段不做无收益改名迁移。
- EvidenceRef 的 `value` 是生成时证据快照，不代表关联实体的实时值；后续可信状态应明确“快照时间/来源”，而非悄然覆盖历史依据。
