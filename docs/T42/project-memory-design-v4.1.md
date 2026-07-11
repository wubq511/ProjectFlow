# T42 Project Memory V1 设计方案（V4.1 终稿）

> 本文档是 ProjectFlow 项目记忆系统的 V1 最终设计，自包含、无待定项。吸收 4 份深度调研、ProjectFlow 源码对齐、外部记忆系统（TencentDB-Agent-Memory、echovault、recall-loom 等）方法论、以及 V4 审核（`v4-audit.md`）的全部 P0/P1/P2 决策后产出。V3、V4 已废，以本文件为准。
>
> 审核决策摘要见文末「审核决策落地」。

## 背景

ProjectFlow 的 Agent 已经能围绕方向卡、阶段计划、任务拆解、分工建议、行动卡、风险和巡检产物输出判断。但这些判断如果只依赖当前状态和最近一轮对话，就会出现一个项目管理产品里很致命的问题：Agent 不知道"当初为什么这么做"。

例如，某个任务曾经因为超出 MVP 被延后；某个成员曾经因为本周时间不足被分配轻任务；某个风险曾经被接受而不是继续升级。如果 Agent 之后忘记这些原因，它可能今天建议砍掉 A，明天又建议补回 A，或者反复提出已经被团队拒绝过的方案。

## 设计结论

V1 采用：

```text
ProjectFlow 自建 ProjectMemory 治理表（SQLite/SQLModel）
+ 默认本地检索引擎（SQLite FTS5 关键词 + jieba 中文分词 + 字段过滤）
+ 可选向量增强（sqlite-vec + 本地 embedding，通过 `memory-vector` optional extra 启用）
+ Markdown 导出作白盒展示
```

事实源是 ProjectFlow 自己的 SQLite。检索引擎不是事实源，不决定一条记忆是否有效、是否可见、是否能注入 Agent 上下文。

整体链路：

```text
Memory Source Event
→ ProjectFlow MemoryExtractor（FastAPI 侧，事务后同步、吞异常）
→ ProjectMemory 表 + ProjectMemorySync 表
→ MemoryIndexBackend.index()（默认 FTS5，optional sqlite-vec）
→ MemoryRetriever（召回 → 回查 SQLite 二次过滤 → 场景重排）
→ Agent Context（token 预算注入）
→ Markdown 导出（项目记忆页面）
```

## 设计目标

1. 记住历史决策的理由，而不是只保存结论。
2. V1 只从 4 类 Memory Source Event 写入长期记忆，防止普通聊天污染记忆。
3. 让所有可影响 Agent 判断的记忆都有来源、状态、可见性和生命周期。
4. 本地检索引擎为零配置默认（FTS5+jieba+字段过滤），`MemoryIndexBackend` 抽象保留未来可替换和向量增强。
5. Agent 每次只注入相关、有效、当前 viewer 可见的记忆。
6. 旧记忆不能被直接删除，只能 archived、superseded 或因 `valid_until` 失效。
7. V1 避免图谱编辑器、关系边表和独立短期记忆表，先做稳定闭环。
8. 记忆对用户白盒可读：支持 Markdown 导出，用户能检视和导出自己项目的记忆。
9. V1 必须有最小评测 harness，召回质量可量化。

## 非目标

V1 不做 LongTermMemoryNode + LongTermMemoryEdge 图结构。关系、冲突、支持、派生作为后续扩展。

V1 不做独立 ShortTermMemory 表。临时但会影响未来判断的约束，如果来自 Memory Source Event，可以写成带 `valid_until` 的 ProjectMemory；普通临时上下文继续从当前项目状态、check-in 和 Pulse 数据读取。

V1 不接入阶段计划确认、任务拆解确认、高风险处理结论、成员约束更新、Pulse/check-in 确认事实等事件。这些事件放 V1.1。

V1 不把普通聊天、一次性问答、按钮反馈或 Agent 中间思考沉淀为长期记忆。**不自动捕获对话**（这是采纳腾讯方案时明确拒绝的能力——腾讯 TencentDB-Agent-Memory 默认每 N 轮自动抽 L1，违反 ProjectFlow "Memory Source Event 驱动" 硬约束）。

V1 不调用 LLM 抽取 ProjectMemory，也不提供 optional LLM extractor 写入开关。MemoryExtractor 只做 deterministic extractor：读取 schema 校验后的 Memory Source Event payload 与关联实体展示字段，通过固定规则和中文模板生成 ProjectMemory candidate。

V1 不允许用户手动创建、编辑、删除长期记忆，也不开放人工维护记忆关系。但允许 Markdown 只读导出。

V1 不做自我约束能力。项目记忆只负责存储、检索和呈现历史上下文，不负责在输出前做方向、阶段、依据或人工确认检查。

V1 不做范围裁决模块。

V1 不做 reranker（cross-encoder / LLM rerank）。V1 默认用 FTS5 BM25 + jieba 预分词 + 字段过滤 + 场景重排，召回质量靠最小评测 harness 兜底；sqlite-vec cosine + RRF 融合作为 optional `memory-vector` 增强能力，reranker 留 V1.1。

V1 不做显式时间衰减函数。`valid_until` + `superseded` 已足够让过期记忆退出注入；指数衰减留 V1.1。

## 核心原则

项目记忆采用"治理层 + 检索层 + 展示层"结构：

```text
Memory Source Event 指向的业务决策记录是事实源
ProjectMemory 是 ProjectFlow 自己的治理层
MemoryIndexBackend 是可替换的本地索引和召回层
MemoryRetriever 二次过滤后产出 Agent 上下文切片
Markdown 导出是白盒展示层
```

ProjectFlow 自己决定：

1. 什么事件可以写长期记忆。
2. 记忆类型是什么。
3. `source_type`、`source_id`、`source_hash` 是什么。
4. `status` 是 `active`、`superseded` 还是 `archived`。
5. `visibility` 是什么。
6. `valid_until` 和 `superseded_by_memory_id` 怎么设置。
7. 当前 viewer 触发 Agent 时，这条记忆是否能被注入上下文。

`MemoryIndexBackend` 负责：

1. `index(memory)`：写入索引（向量 + 全文）。
2. `search(query, filters, top_k)`：返回候选 `list[MemoryIndexCandidate]`，每条带 `memory_id`、`score`、`backend`。

候选必须用 `memory_id` 回查 ProjectMemory 表，由 ProjectFlow 二次过滤。**任何检索引擎返回的结果都不得直接注入 Agent。**

## 外部依赖策略

V1 默认部署零新服务、零外部 API、零模型下载、零重型 embedding runtime：

```text
SQLite FTS5（SQLite 内置全文检索，external content + Python 预分词）
+ jieba 中文分词
+ SQLite 字段过滤 fallback
+ optional sqlite-vec + 本地 embedding（通过 `memory-vector` extra 启用）
```

`MemoryIndexBackend` 是抽象层。V1 默认实现是 `Fts5MemoryIndexBackend`（FTS5 + jieba + 字段过滤）。`SqliteVecMemoryIndexBackend` 是可选增强实现，只有显式安装 `memory-vector` extra 且 sqlite-vec 扩展、embedding runtime、模型均可用时才启用。抽象保留是为了未来可替换（切 Mem0/Graphiti 不改业务层）。

### 依赖与检索后端默认策略

默认安装命令 `python -m pip install -e ".[dev]"` 必须能跑通 ProjectMemory 的写入、FTS5 建索引、候选回查 SQLite、可见性过滤、Markdown 导出和 Agent 上下文注入。默认依赖可以包含轻量 `jieba`，但不包含 `torch`、`sentence-transformers` 或任何 embedding 模型下载。

向量检索不是 V1 默认安装依赖，而是 optional extra：

```bash
python -m pip install -e ".[dev,memory-vector]"
```

`memory-vector` extra 可包含 `sqlite-vec`、`sentence-transformers`、`torch` 等向量检索依赖。bge-small-zh-v1.5 模型文件仍然不进 git；只有安装了 `memory-vector` extra 并显式运行 `python -m app.memory.warmup` 或首次启用向量 backend 时，系统才下载/加载模型。

`python -m app.memory.warmup` 的语义：

1. 未安装 `memory-vector` extra → 输出 "vector backend not installed; skip warmup"，退出码 0。
2. 已安装 extra 但 sqlite-vec 扩展加载失败 → 输出清晰错误，默认 FTS5 路径不受影响。
3. 已安装 extra 且模型未下载 → 下载并预热模型。
4. 默认运行路径不依赖 warmup；warmup 没跑过不能导致 ProjectMemory 检索报错。

`memory_backend` 的取值 `vector | fts5 | sqlite_field | none` 表示**本次请求实际生效的检索后端**，不是安装期承诺。默认安装通常解析为 `fts5`；只有向量 extra 已安装、扩展加载成功且模型就绪时，才可能解析为 `vector`。

降级链：

1. 向量 extra 未安装、sqlite-vec 加载失败或 embedding 模型未就绪 → 跳过向量，只走 FTS5。
2. FTS5 可用 → 关键词检索。
3. FTS5 也失败 → 退到 SQLite 字段过滤（按 memory_type、scope、related_* 直匹配）。
4. 全部失败 → `memory_backend = none`，Agent 只读当前项目状态，不阻塞。

## 技术选型

### 结论

```text
ProjectFlow ProjectMemory 治理表
+ Fts5MemoryIndexBackend 作 V1 默认实现（FTS5 + jieba + 字段过滤）
+ SqliteVecMemoryIndexBackend 作 optional `memory-vector` 增强实现（sqlite-vec + 本地 embedding + RRF）
+ Markdown 导出
```

### 为什么默认用 FTS5 + jieba

1. **零配置是 ProjectFlow 硬约束**。默认安装不能拉 `torch`、`sentence-transformers` 或下载 embedding 模型。FTS5 是 SQLite 内置能力，jieba 是轻量 Python 依赖，更符合本地演示优先。
2. **记忆量级小**。V1 只从 4 类 Memory Source Event 写入，单项目估计几十到几百条记忆；同时还有 `memory_type`、`scope`、`related_*`、`status`、`visibility` 等结构化过滤。关键词检索 + 场景重排足够先闭环。
3. **中文可控**。jieba `cut_for_search` + 自定义词典可以覆盖项目专有名词、成员约束、拒绝原因等高频中文检索场景。
4. **可解释、易调试**。默认检索命中来自 FTS5 token 和结构化字段，排查比 dense retrieval 更直观。
5. **向量增强保留**。`MemoryIndexBackend` 抽象不变，安装 `memory-vector` extra 后可启用 sqlite-vec + 本地 embedding + RRF；未来切 Mem0/Graphiti 也不改业务层。

### 候选项目对比（V1 选型记录）

| 候选 | V1 | 理由 |
|---|---|---|
| FTS5 + jieba + 字段过滤 | **默认采用** | 零配置、本地、中文可控、量级够用 |
| sqlite-vec + 本地 embedding + RRF | optional `memory-vector` 增强 | 可提升同义改写召回，但不能进入默认安装路径 |
| Mem0 OSS + Qdrant | V1.1 候选 | 召回质量更高，但破坏零配置、坑多；V1 不实现，默认/增强召回不够再评估 |
| Graphiti / Zep | V2 候选 | 时序图谱，需 Neo4j，V1 不做图结构 |
| Cognee | V2 知识库候选 | 文档 ingestion pipeline 过宽 |
| Letta | 不采用 | stateful agent harness，接管 runtime，和 T41 sidecar 重叠 |
| LangGraph / LangMem | 借鉴 | checkpointer/store 思路参考，不引入主实现 |
| TencentDB-Agent-Memory | 借鉴 pattern | 存储栈和分层思想借鉴，框架不采纳（TS、自动捕获、对话画像形状） |
| echovault / recall-loom | 借鉴 pattern | "decisions as markdown" 思路借鉴，是编码 agent 工具非 Python 库 |
| pgvector | V2 考虑 | 若未来迁 Postgres |

## Memory Source Event（记忆来源事件）

长期记忆只能从 Memory Source Event 生成。V1 只接入 4 类事件：

1. 方向卡确认（`direction_card_confirmed`）
2. proposal 拒绝原因（`proposal_rejected`，仅当 `rejection_reason` 非空）
3. 分工最终确认（`assignment_confirmed`）
4. replan 确认或拒绝（`replan_confirmed` / `replan_rejected`）

### 4 类事件在当前代码里的落点与改造（关键对齐）

V3 假设这 4 类事件已存在，但核对源码发现没有一处直接对得上。必须先改造 service 层让 Memory Source Event 可被抽取：

| source_type | 当前代码实际路径 | 改造方案 |
|---|---|---|
| `direction_card_confirmed` | `agent_proposal_service.confirm_proposal(proposal_type="clarify")` → `_persist_clarification` 写 `Project.direction_card` | 不新增独立事件。在 `confirm_proposal` 末尾按 `proposal_type` 分派 extractor：`proposal_type=="clarify"` 且 payload 含 direction_card → 调 `memory_service.extract_from_event(source_type="direction_card_confirmed", source_id=proposal.id)`。不扩 `AgentEventType` enum。 |
| `proposal_rejected` | `reject_proposal()` 只翻 status + 存 `rejection_reason`，**不写 AgentEvent**；当前前端固定传 `reason: null`，需改为要求用户填写拒绝原因 | **不写 AgentEvent**。`AgentProposal` 本身就是拒绝的事实记录（`status=rejected` + `rejection_reason`）。前端拒绝 Agent Proposal 时必须提交非空原因；后端可兼容空原因旧调用，但 extractor 遇到空 `rejection_reason` 必须跳过，不写 ProjectMemory。extractor 在 `reject_proposal` 末尾直接调，`source_id=AgentProposal.id`。不扩 `AgentEventStatus`，不污染 timeline。 |
| `assignment_confirmed` | `assignment_service.finalize_assignment_proposal()`（独立 `AssignmentProposal` 模型，status→`finalized`） | 在 `finalize_assignment_proposal` 末尾 hook extractor，`source_id=AssignmentProposal.id`。extractor 支持两类 source（`AgentProposal` 和 `AssignmentProposal`）。成员 accept/reject 不抽记忆，只 finalize 抽。 |
| `replan_confirmed` / `replan_rejected` | **两条路径并存**：(a) `confirm_proposal(proposal_type="replan")` → `_persist_replan`；(b) `replan_service.confirm_replan()` 不创建 AgentProposal | **V1 只 hook 路径 (a)**。前端 replan confirm 实际全走路径 (a)（`confirmAgentProposal` → AgentProposal confirm），路径 (b) `routes_replans.py:/replans/confirm` 是 live API 但前端无调用方，仅后端测试用到。路径 (b) 的统一属于 T41 范围（记为 T41 待办，进 T41 issue tracker），不阻塞 T42。replan 拒绝 hook 在 `reject_proposal(proposal_type="replan")`。 |

### source_id 语义统一

4 类事件的 `source_id` 统一为**产生该正式决策的 proposal 对象 id**：

```text
direction_card_confirmed → AgentProposal.id（proposal_type=clarify）
proposal_rejected        → AgentProposal.id（status=rejected）
assignment_confirmed     → AssignmentProposal.id（status=finalized）
replan_confirmed         → AgentProposal.id（proposal_type=replan）
replan_rejected          → AgentProposal.id（proposal_type=replan, status=rejected）
```

两类 typed source（`AgentProposal`、`AssignmentProposal`），语义统一。extractor 按 `source_type` 知道该用哪类 model 回查。

Memory Source Event 需要满足三个条件：

1. 它改变或确认了项目事实。
2. 它有明确来源对象。
3. 它能被用户在产品中回溯。

补充约束：`proposal_rejected` 只有在 `rejection_reason` 非空时才是可写入记忆的 Memory Source Event。无原因拒绝只表示用户当前不采纳该 proposal，不沉淀长期记忆。

普通聊天、一次性问答、按钮成功反馈、Agent 自己的中间分析，都不是 Memory Source Event。

### replan 路径 (b) 已知覆盖缺口

V1 已知：通过 `routes_replans.py` 的 `/replans/confirm` 确认的 replan **不产生 ProjectMemory**（因为 V1 只 hook 路径 (a)）。当前前端不走这个端点，实际影响为零；但 API 层面是覆盖空洞。**T41 统一 replan 路径后此缺口自动补上**。验收标准里单列此条。

## 数据模型

V1 新增两张表：`ProjectMemory`（治理主表）和 `ProjectMemorySync`（索引同步元数据，拆出来让主表干净）。

```python
class ProjectMemory(SQLModel, table=True):
    id: str
    workspace_id: str
    project_id: str

    memory_type: str
    # direction / boundary / plan / assignment / tradeoff / rejection / member_constraint

    scope: str
    # V1: project / stage / task / member（risk 推 V1.1）

    content: str           # 可被 Agent 引用的结论
    rationale: str         # 当时为什么这么决定

    source_type: str       # 5 种枚举（见下）
    source_id: str         # 产生该决策的 proposal 对象 id
    source_hash: str | None = None   # SHA256 of 稳定 JSON 序列化

    status: str = "active"            # active / superseded / archived
    visibility: str = "team"          # team / subject_and_owner（V1 只两档）

    subject_user_id: str | None = None
    owner_user_id_snapshot: str | None = None
    related_stage_id: str | None = None
    related_task_id: str | None = None
    related_risk_id: str | None = None

    valid_until: datetime | None = None
    superseded_by_memory_id: str | None = None

    extractor_version: str = "v1"
    schema_version: str = "v1"

    created_at: datetime
    updated_at: datetime


class ProjectMemorySync(SQLModel, table=True):
    memory_id: str = Field(foreign_key="project_memories.id", primary_key=True)
    backend: str = "fts5"             # fts5 / vector
    backend_memory_id: str | None = None
    sync_status: str = "pending"      # pending / synced / failed
    last_synced_at: datetime | None = None
    last_error: str | None = None
```

V1 `source_type` 只允许：

```text
direction_card_confirmed
proposal_rejected
assignment_confirmed
replan_confirmed
replan_rejected
```

字段说明：

- `content` 是可被 Agent 引用的结论。
- `rationale` 是当时为什么这么决定。
- `source_type` 和 `source_id` 指向产生该正式决策的 proposal 对象。
- `source_hash` 用于幂等写入。计算方式：对 Memory Source Event 中会影响记忆抽取的字段做稳定 JSON 序列化（剔除 `created_at`、`updated_at`、临时状态、同步状态），然后 SHA256。
- `status` 表示这条记忆当前是否仍然有效。
- `visibility` 决定用户能否看到，也决定能否注入该用户触发的 Agent 上下文。V1 只实现 `team` 和 `subject_and_owner`；`owner_only` 推 V1.1。
- `owner_user_id_snapshot` 是写入时解析出的 owner 快照，用于稳定判定 `subject_and_owner` 可见性，避免未来 task/stage/project owner 变化导致历史记忆的可见范围漂移。
- `valid_until` 表示明确到期时间。
- `superseded_by_memory_id` 替代原方案的 `supersedes` 辫。

索引（含幂等唯一索引）：

```sql
CREATE UNIQUE INDEX idx_memory_idemp
  ON project_memories(project_id, source_type, source_id, memory_type, source_hash);
CREATE INDEX idx_memory_project_status ON project_memories(project_id, status);
CREATE INDEX idx_memory_workspace_project ON project_memories(workspace_id, project_id);
CREATE INDEX idx_memory_source ON project_memories(source_type, source_id);
CREATE INDEX idx_memory_valid_until ON project_memories(valid_until);
CREATE INDEX idx_memory_superseded ON project_memories(superseded_by_memory_id);
CREATE INDEX idx_memory_subject_proj ON project_memories(project_id, subject_user_id);
CREATE INDEX idx_memory_owner_snapshot_proj ON project_memories(project_id, owner_user_id_snapshot);
CREATE INDEX idx_memory_sync_status ON project_memory_sync(sync_status);
```

### 幂等写入规则（skip or supersede）

extractor 写入前查幂等键 `(project_id, source_type, source_id, memory_type, source_hash)`：

1. **幂等键命中**（同 `source_hash`）→ **跳过**。事件内容没变，记忆不用重生。
2. **幂等键不命中，但同 `project_id + source_type + source_id + memory_type` 有 active memory** → 说明同事件内容变了 → 新建 memory + 把旧的标 `superseded`（旧 `superseded_by_memory_id` 指新 memory id）。
3. **全新事件**（同 `project_id + source_type + source_id + memory_type` 无 active memory）→ 直接新建。

唯一索引 `idx_memory_idemp` 在 DB 层兜底防重复。

### V1 source-level 幂等边界

V1 采用 source-level idempotency，不引入 `source_item_key` 或 `memory_key`。同一 `project_id + source_type + source_id + memory_type` 在同一 `source_hash` 下最多写入 1 条 ProjectMemory。

这意味着一个 Memory Source Event 可以生成不同 `memory_type` 的多条记忆，例如 `direction_card_confirmed` 生成 1 条 `direction` 和 1 条 `boundary`，但不能生成多条同为 `boundary` 的记忆。

如果同一来源事件中出现多个同类候选，extractor 必须在写库前处理：

1. 可以安全合并时，先按稳定字段排序、规范化，再聚合成 1 条同类记忆。
2. 合并会破坏 visibility、scope、subject 或 related id 语义时，跳过该类记忆。
3. 不允许为了保留多条同类候选而伪造更精细的 `related_stage_id`、`related_task_id` 或 `subject_user_id`。
4. `source_hash` 始终代表来源事件稳定字段，不按候选项拆分。

## 记忆类型与范围

V1 保留少量稳定类型：

```text
direction：项目方向判断
boundary：方向卡内确认的 MVP 或范围边界
plan：仅指 replan 确认/拒绝后形成的计划调整判断
assignment：分工与资源安排
tradeoff：方案取舍
rejection：被拒绝方案及原因
member_constraint：从分工确认中抽取的成员可用时间、偏好或限制
```

`risk` 和普通 `stage_plan` 类型保留给 V1.1。

V1 可写入范围：

```text
project：项目级方向、边界、全局取舍
stage：replan 涉及的阶段调整
task：proposal 拒绝或 replan 涉及的任务取舍
member：分工确认中的成员约束、分工依据、可用时间变化
```

不单独做 `summary` 类长期记忆。摘要只适合展示，不适合作为 Agent 判断依据。

## 状态与生命周期

ProjectMemory 三个状态，V1 只写入前两个：

```text
active：当前有效，可被检索和注入
superseded：被正式新事实替代，保留追溯但不注入
archived：系统归档（V1 不写入，字段保留给 V1.1 归档流程）
```

V1 让记忆退出注入靠 `superseded`（幂等规则第 2 条触发）和 `valid_until` 到期。`archived` 字段在模型里保留但 V1 没有写入路径。

默认生命周期：

```text
方向 / MVP 边界：active，直到被新方向或新边界 supersede
proposal 拒绝原因：active，直到 replan 或新正式决策明确推翻
分工确认：active，直到新分工确认或 replan supersede
replan 确认/拒绝：active，直到下一次 replan 或正式项目决策 supersede
```

系统不能直接删除旧记忆。旧记忆只通过以下方式退出 Agent 注入：

1. `status` 改为 `superseded`。
2. `status` 改为 `archived`。
3. `valid_until` 到期。
4. 当前 viewer 没有可见权限。

## 可见性

原则：凡是会进入 Agent 上下文、影响 Agent 判断的记忆，都必须对当前 viewer 可见。

### Viewer Identity Context（MVP 身份上下文）

ProjectFlow V1 当前没有真实登录系统。前端 `currentUserId`（本地用户切换器）与 API 中的 `viewer_user_id` **不是认证凭据**，仅表示"本次请求以哪个成员视角查看或触发项目上下文"。后端必须将其视为未经认证的 Viewer Identity Context，并在每次请求中重新执行 workspace membership、project scope 与 ProjectMemory visibility 校验。

V1 采用显式 viewer 传递：

```text
GET /projects/{project_id}/memories?viewer_user_id=...
GET /projects/{project_id}/memories.md?viewer_user_id=...
POST Agent run 创建接口 body: { "viewer_user_id": "..." }
```

规则：

1. `viewer_user_id` 缺失或格式非法 → `400 Bad Request`。
2. project 不在该 viewer 的 workspace 作用域内 → `404 Not Found`。
3. 不 fallback 到 `Project.created_by` / owner 视角，不推断"默认 viewer"。
4. JSON 列表、Markdown 导出和 Agent context injection 必须复用同一套 `can_view_memory(memory, viewer_context)` 逻辑。
5. `/memories` 与 `/memories.md` 响应加 `Cache-Control: no-store`，避免本地用户切换时复用上一 viewer 的结果。
6. 当前阶段的已知限制：由于没有真实 auth，同 workspace 内成员身份可在本地演示环境中被切换或伪造；V1 只保证服务端不会跨 workspace/project 泄露，也不会绕过 ProjectMemory 治理表。

V1 可见范围（只两档）：

```text
team：团队可见
subject_and_owner：相关成员本人和负责人可见
```

`owner_only` 推 V1.1，不作为 T42 阻塞项。

owner 在写入 ProjectMemory 时解析并固化到 `owner_user_id_snapshot`：

```text
scope=project → Project.created_by
scope=stage  → 阶段负责人（若模型没有，fallback 到 Project.created_by）
scope=task   → Task.owner_user_id（若未分配，fallback 到 Project.created_by）
scope=member → Project.created_by
```

默认规则：

```text
方向 / MVP 边界 / replan 取舍：team
分工限制 / 成员可用时间 / 个人偏好：subject_and_owner
proposal 拒绝原因：team
```

如果一条记忆的可见性不足以让当前 viewer 查看，它不能被注入到这个 viewer 触发的 Agent 上下文中。

`team` 记忆对 project 所在 workspace 成员可见。`subject_and_owner` 记忆只对 `subject_user_id` 本人和 `owner_user_id_snapshot` 可见。若 `visibility=subject_and_owner` 但缺少 `subject_user_id` 或 `owner_user_id_snapshot`，系统必须失败关闭：拒绝写入，或读取时视为对普通成员不可见，绝不能自动降级为 `team`。

**Agent 输出可见性**：Agent 生成的建议如果参考了 `subject_and_owner` 记忆，建议本身也标 `subject_and_owner`，防止泄露给无权用户。

跨项目记忆（同一成员在多项目的约束）V1 不做。若 V1.1 需要，新增独立 `UserMemory` 表，不混入 ProjectMemory。

## 写入流程

写入只由 V1 允许的 4 类 Memory Source Event 触发。

```text
confirm_proposal(proposal_type=clarify/replan)
reject_proposal()
finalize_assignment_proposal()
  → session.commit()  （Memory Source Event 指向的业务决策先落库）
  → memory_service.extract_from_event(...)  （同步调用，包在 try/except 里）
  → MemoryExtractor 读取事件和关联项目状态（开新 session）
  → 输出已完成同类聚合/跳过的 ProjectMemory candidates
  → 校验 content、rationale、source_id、visibility（proposal_rejected 还要求 rejection_reason 非空）
  → 幂等检查（idx_memory_idemp，skip or supersede）
  → 写入 ProjectMemory + ProjectMemorySync
  → 必要时 supersede 旧记忆
  → best effort 调 MemoryIndexBackend.index()
```

### Extractor 调用机制（同步 + 吞异常）

V1 用**同步调用 + try/except 吞异常**，不引入后台任务基础设施（无 FastAPI BackgroundTasks、无 celery/rq、无 asyncio.create_task）：

1. extractor 在业务 service `session.commit()` **之后**、`return` **之前**同步调用，包在 `try/except` 里。
2. extractor 内部开**新 session** 写 ProjectMemory（不复用 Memory Source Event 的 session，避免回滚污染）。
3. 失败只记日志，**不抛异常、不回滚 Memory Source Event 指向的业务决策**（符合"记忆抽取失败不阻塞业务决策"）。
4. 延迟可接受：默认 FTS5 + jieba 写入快，extractor + 索引同步约 50–200ms，对业务决策响应是可接受的一次性代价；optional vector 同步失败只影响向量增强，不影响默认检索。
5. V1.1 若延迟成问题再上 FastAPI BackgroundTasks。

写入规则：

1. **extractor 在 FastAPI 侧，不在 sidecar**。sidecar 不感知记忆写入。
2. 缺少 `content`、`rationale`、`source_type`、`source_id` 的候选记忆不入库，记 extractor validation failed；`proposal_rejected` 如果缺少非空 `rejection_reason`，记 validation skipped，不写 ProjectMemory。
3. 新记忆如果正式替代旧记忆，创建新行，并把旧行标记为 `superseded`（按幂等规则第 2 条）。
4. 同一来源事件的同类候选必须在写入前聚合或跳过，不能把唯一索引冲突当作正常控制流。
5. 新记忆如果只是潜在冲突，V1 不自动裁决；抽取器应避免写入会形成两个 active 约束的结果。
6. 索引同步失败只更新 `ProjectMemorySync.sync_status = failed`，不回滚 Memory Source Event 指向的业务决策。
7. V1 不开放外部 extract API。抽取只在业务 service 内部调用。

### MemoryExtractor V1 策略（deterministic）

V1 MemoryExtractor **完全不调用 LLM**，也不提供 optional LLM extractor 写入开关。extractor 只读取 schema 校验后的 Memory Source Event payload 与少量关联实体展示字段，按固定规则和中文模板生成 ProjectMemory candidate。

总体规则：

1. `content` 只写可被 Agent 引用的结论，不夹带推测。
2. `rationale` 只由 source event 中的显式字段按固定顺序拼接，不补写、不猜测、不润色成额外因果。
3. 所有用户可见文本必须使用 `display_name`、`title`、中文枚举文案或安全占位词，禁止输出 raw `user_id`、`task_id`、`stage_id` 等内部 ID。
4. `source_hash` 只基于 source event 中影响抽取语义的稳定字段，不基于 extractor 生成的自然语言文本。
5. 同一 `source_type + source_id + extractor_version` 输入应得到稳定可复现的 `content` / `rationale`。
6. 缺少生成某条 memory 所必需的字段时，执行 validation skipped，不落库、不阻塞正式业务。
7. 同一 `source_type + source_id + memory_type` 最多输出 1 条 candidate；多个同类子项必须先稳定排序并聚合，不能安全聚合时跳过该 `memory_type`。

事件映射：

| source_type | deterministic 输出 |
|---|---|
| `direction_card_confirmed` | 默认生成 1 条 `direction` 记忆；只有 payload 明确包含 MVP/范围边界时，额外生成最多 1 条 `boundary` 记忆。多个边界点按稳定顺序聚合为同一条 `boundary`。`visibility=team`，`scope=project`。 |
| `proposal_rejected` | 仅在 `rejection_reason` 非空时生成 1 条 `rejection` 记忆。`content` 表达未采纳哪个方案，`rationale` 只引用拒绝原因。默认 `visibility=team`。 |
| `assignment_confirmed` | 生成 1 条 team 可见的 `assignment` 记忆；只有 payload 明确包含单个 subject 的可复用成员限制/偏好/可用性约束时，才额外生成最多 1 条 `member_constraint` 记忆。批量多成员约束 V1 跳过 `member_constraint`，不合并私人约束。`member_constraint` 必须 `visibility=subject_and_owner`，并写入 `subject_user_id` 与 `owner_user_id_snapshot`。 |
| `replan_confirmed` | 默认生成 1 条 `plan` 记忆；只有 payload 明确包含范围取舍、延期/暂缓/替换理由时，才额外生成最多 1 条 `tradeoff` 或最多 1 条 `boundary` 记忆。多个调整项按稳定顺序聚合；跨阶段/跨任务时使用 `scope=project`，不得伪造精确 related id。默认 `visibility=team`。 |
| `replan_rejected` | 仅在存在明确拒绝理由时生成 1 条 `rejection` 记忆；没有理由则 skipped。 |

DisplayResolver 负责把结构字段解析为展示名：

```text
user_id    → member.display_name 或 "该成员"
task_id    → task.title 或 "该任务"
stage_id   → stage.title 或 "该阶段"
project_id → project.name 或 "该项目"
```

内部 ID 只保留在结构字段中供过滤、关联和可见性判断使用，不进入 `content` 或 `rationale`。

### 代码位置

```text
backend/app/services/memory_service.py        # 业务逻辑层：extract_from_event / get_context_for_agent / sync_to_backend
backend/app/agent/memory/                      # Agent 域：extractor / retriever / index backend 实现
backend/app/agent/memory/extractor.py          # MemoryExtractor
backend/app/agent/memory/retriever.py          # MemoryRetriever
backend/app/agent/memory/fts5_backend.py       # Fts5MemoryIndexBackend（V1 默认实现）
backend/app/agent/memory/vector_retriever.py   # VectorRetriever（optional memory-vector 增强，lazy import）
backend/app/agent/memory/fts5_index.py         # FTS5 external content + jieba 预分词
backend/app/models/project_memory.py           # ProjectMemory + ProjectMemorySync 模型
```

## 检索流程

```text
Agent run 开始（FastAPI 组装 run input 前）
→ memory_service.get_context_for_agent(project_id, event_type, viewer_user_id)
→ 构造 query（基于 event_type + 当前项目状态）
→ MemoryIndexBackend.search()：
    - 默认 FTS5 关键词召回 top 50（jieba 预分词，JOIN project_memories 按 project_id + status 前置过滤）
    - optional vector 向量召回 top 50（memory-vector 安装且模型就绪时，同样按 project scope 前置过滤）
    - 向量可用时 RRF 融合；向量不可用时直接使用 FTS5 排名
→ 从候选取 memory_id 回查 ProjectMemory 表
→ 过滤 status != active
→ 过滤 valid_until 已过期
→ 过滤当前 viewer 不可见 memory
→ 过滤 workspace_id / project_id 不匹配
→ 不使用绝对 score 阈值；质量通过 strict/relaxed 两阶段检索、token coverage 和评测指标控制
→ 按 event_type 场景重排
→ token 预算截断（见下）
→ 返回结构化记忆列表
→ FastAPI 将 memory_context 放入 RunStartResponse
→ sidecar context-builder 在 <project_memory_context> XML 标签中注入 model prompt
```

二次过滤规则：

1. `status` 必须为 `active`。
2. `valid_until` 为空或晚于当前时间。
3. 当前 viewer 必须满足 `visibility`。
4. `workspace_id`、`project_id` 必须匹配当前项目。
5. score 不使用绝对 BM25 阈值（受语料规模和词频影响，无法稳定迁移）；改用 strict/relaxed 命中来源、token coverage、top-k 上限和评测指标（bad-first rate、irrelevant rate）控制质量。
6. 如果当前事件绑定了 stage、task、risk 或 member，直接关联记忆优先。
7. 如果检索引擎返回的 `memory_id` 不存在于 SQLite，直接丢弃。

### FTS5 + jieba 实现路径（external content + Python 预分词）

SQLite FTS5 内置 tokenizer（`simple`/`unicode61`）不支持 jieba 中文分词。V1 用 **FTS5 external content + Python 预分词**路径，零扩展依赖、跨平台一致：

1. **写入时**：Python 侧用 jieba.cut 把 `content + rationale` 分词成空格分隔的 token 串，存进 FTS5 虚拟表（external content 模式，content 表指向 `project_memories` 主表，FTS5 只存 token 串索引）。
2. **检索时**：同样用 jieba.cut 分词 query，再查 FTS5。
3. **索引同步**：ProjectMemory 写入/删除/supersede 时同步 FTS5 行（这是默认 `MemoryIndexBackend.index()` 的职责）；optional vector 启用时再同步 sqlite-vec 向量索引。
4. **不编译 C 扩展、不加载 .so/.dylib/.dll**，保持零配置。

### 场景重排

```text
clarification / direction：direction > boundary > tradeoff > rejection
replanning：direction > boundary > plan > tradeoff > rejection
assignment / negotiation：member_constraint > assignment > plan > tradeoff
proposal_rejection：rejection > tradeoff > boundary > direction
```

同分优先级：

1. 与当前对象直接关联。
2. 最近更新。
3. 来源更正式。
4. `memory_type` 更匹配当前 `event_type`。

### 降级链

1. `memory-vector` 未安装、sqlite-vec 加载失败或 embedding 模型未就绪 → 跳过向量，只走 FTS5。
2. FTS5 关键词检索可用 → 按 memory_type 优先级排序。
3. FTS5 失败 → SQLite 字段过滤（按 project_id、status、visibility、valid_until、related_* 直匹配）。
4. 全部失败 → `memory_backend = none`，Agent 只读当前项目状态，不阻塞。

降级执行规则：

1. 不尝试修复检索引擎。
2. 不阻塞 Agent。
3. 在 AgentEvent 的轻量快照中记录记忆使用情况。

## Agent Context 注入

Agent 只接收过滤后的结构化记忆。Prompt 中按项目既有规则使用 XML 标签隔离用户数据，并对 JSON 内容做转义。

```xml
<project_memories>
  <memory>
    <type>boundary</type>
    <scope>project</scope>
    <content>本项目 MVP 不做复杂外部集成。</content>
    <rationale>团队在方向卡确认时认为当前截止日期前应优先完成核心闭环。</rationale>
    <source>方向卡确认</source>
    <valid_until></valid_until>
  </memory>
</project_memories>
```

注入规则：

1. **token 预算注入**：最多 2000 token（按 content + rationale 累加，超预算停），条数硬顶 10 条。不按固定条数限（单条长度不一，按条数限会信息过多或过少）。
2. 不注入 `superseded`、`archived`、过期或不可见记忆。
3. 不把检索引擎原始结果直接注入 Agent。
4. Agent 用户可见输出可以说"参考了 X 条项目记忆"，但不能暴露当前 viewer 不可见的记忆内容。
5. 用户可见文本继续遵守项目规则：不展示原始 `user_id`、`task_id` 等内部 ID。

## T41 集成边界

记忆系统是 T42 功能增强，必须遵守 T41 底座边界（以 T41 设计文档为准）：

1. **记忆上下文作为 context-builder 的固定输入，不作为 LLM-callable tool**。FastAPI 在创建 AgentRun 前从 run 创建请求体读取必填 `viewer_user_id`，调 `memory_service.get_context_for_agent(..., viewer_user_id=viewer_user_id)`，结果作为 run input 的 `project_memories` 字段传给 sidecar。sidecar context-builder 放进 dynamic suffix，用 `<project_memories>` XML 包裹。sidecar 不解析、不推断 viewer 身份。
2. **不注册 `get_project_memory_context` 为 LLM-callable tool**（避免 agentic retrieval 复杂度，V1.1 再考虑）。
3. **检索时机 = 每次 run 开始一次**（不是每 tool call），简单可控。
4. **sidecar 不直连检索引擎**，符合 "sidecar 不读业务事实"。所有检索走 FastAPI。
5. **MemoryExtractor 在 FastAPI 侧**，事务后同步、吞异常。sidecar 不感知记忆写入。
6. **不扩 `AgentEventType` / `AgentEventStatus` enum**。`proposal_rejected` 不写 AgentEvent（P0-1 决策），source_id 直接指 `AgentProposal.id`。
7. **记忆使用只记 `AgentEvent.output_snapshot`，不进 `AgentRunState.side_effects`**。记忆是 context 输入不是 tool side effect。`AgentRunState.side_effects` 只记 tool 副作用。
8. AgentEvent 的 `output_snapshot` 加记忆使用 metadata（`_memory` 命名空间）：
   ```json
   {
     "_memory": {
       "used": true,
       "backend": "vector | fts5 | sqlite_field | none",
       "used_memory_ids": ["..."],
       "retrieval_count": 50,
       "injected_count": 5,
       "latency_ms": 120
     }
   }
   ```
   `_memory.backend = none` 表示无可用记忆或检索整体失败。
9. **skill 不在 `allowed-tools` 声明记忆工具**（因为记忆不是 tool）。skill 的 SKILL.md 可以指导 Agent 如何利用记忆（如"参考历史拒绝原因"），但记忆注入是 context-builder 的职责，不是 skill 的职责。

## Markdown 导出与展示

借鉴 TencentDB-Agent-Memory（L2/L3 存 Markdown）和 echovault / recall-loom（decisions as markdown）的白盒 pattern。ProjectFlow 的治理表用 SQL，但**展示和导出用 Markdown**，让用户能白盒检视自己项目的记忆。

```text
GET /projects/{project_id}/memories.md
→ 按 5 个主题聚合（方向与边界 / 被拒绝方案 / 分工与资源 / 重排取舍 / 被替代或归档的历史判断）
→ 每条记忆渲染成 Markdown：
   ### <content>
   - 理由：<rationale>
   - 来源：<source_type 中文>
   - 状态：<status>
   - 有效期：<valid_until 或 "长期">
   - 关联：<related 对象 title>
   - 可见范围：<visibility 中文>
→ 返回 text/markdown
```

项目记忆页面（前端）直接渲染这份 Markdown。用户可导出 `.md` 文件，可 git 版本化。

**Markdown 只作展示/导出，不作存储**。治理需求（visibility 过滤、status、supersede、幂等）需要 SQL，Markdown 文件做不了这些。

## 产品入口

项目内增加"项目记忆"入口，是可见性和可追溯入口，不是编辑器。

默认按主题聚合：

```text
方向与边界
被拒绝方案
分工与资源
重排取舍
被替代或归档的历史判断
```

每条记忆展示：结论、理由、来源、状态、有效期、关联对象、可见范围。

V1 不提供手动创建、编辑、删除 ProjectMemory。提供 Markdown 导出。

Agent 生成重要建议时，可以显示"参考了 X 条项目记忆"。用户可以点开查看这次实际注入的结构化记忆列表。

## API 边界

V1 开放：

```text
GET /projects/{project_id}/memories?viewer_user_id=...       # 只读列表（JSON，给前端页面）
GET /projects/{project_id}/memories.md?viewer_user_id=...    # 只读 Markdown 导出
```

内部 service：

```text
memory_service.extract_from_event(...)        # 业务 service 内部调用
memory_service.get_context_for_agent(..., viewer_user_id=...)     # FastAPI 组装 run input 时调用
memory_service.sync_to_backend_best_effort(...)  # 索引同步
```

CLI：

```text
python -m app.memory.warmup    # 仅在安装 memory-vector extra 时预下载 + 预加载 embedding 模型；默认安装下 skip 并 0 退出
```

V1 不提供：

```text
POST /project-memories
PATCH /project-memories/{id}
DELETE /project-memories/{id}
POST /projects/{project_id}/memories/extract
POST /projects/{project_id}/memories/sync/retry
```

ProjectMemory 的变化只能来自 Memory Source Event、系统抽取、系统同步和生命周期规则。

API contract 补充：

1. `/memories` 与 `/memories.md` 必须显式携带 `viewer_user_id` query 参数。
2. 所有会触发 ProjectMemory 注入的 Agent run 创建接口必须在 request body 中携带 `viewer_user_id`。
3. 缺失或格式非法返回 `400`；viewer 不在 project workspace 作用域内返回 `404`。
4. 不使用 GET body；不把 `viewer_user_id` 放入 header 作为 V1 主路径。
5. `/memories`、`/memories.md`、`get_context_for_agent` 必须复用同一套可见性过滤逻辑，Markdown 导出不得绕过 visibility。

## 失败处理

如果记忆抽取失败，不阻塞 Memory Source Event 指向的业务决策本身。V1 记录失败日志，不实现后台自动补偿。

如果抽取器输出缺少来源、理由或可见性，不写入 ProjectMemory，记 extractor validation failed。

如果 deterministic extractor 遇到缺关键字段、空拒绝理由、无法确定 `memory_type` / `scope`、`subject_and_owner` 缺少 `subject_user_id` 或 `owner_user_id_snapshot`、展示字段无法解析且没有安全占位策略，则记 validation skipped，不落库、不阻塞正式业务。

如果索引同步失败，`ProjectMemorySync.sync_status = failed`。Agent 检索走降级链。

如果检索引擎返回旧记忆、不可见记忆或已 superseded 记忆，回查 ProjectMemory 后丢弃。

如果检索失败，Agent 降级为只读取当前项目状态，输出标记"未使用项目记忆"（`memory_backend = none`）。

如果 `memory-vector` 未安装、sqlite-vec 加载失败、embedding 模型未就绪（首次下载中或离线），检索走默认 FTS5，`memory_backend = fts5`。

如果发现 active 记忆之间存在冲突，V1 不自动裁决。系统等待后续 Memory Source Event 产生新记忆并 supersede 旧记忆。

如果系统升级抽取器后需要重建，V1 只保留版本字段，不实现自动重建流程。

## 数据重建与版本化

每条 ProjectMemory 记录 `source_hash`、`extractor_version`、`schema_version`。V1 不实现自动重建。

`schema_version` 表示 ProjectMemory 数据模型版本，例如 `pm-schema-v1`。`extractor_version` 表示抽取算法与模板版本，例如 `det-v1.0-zh`。模板或 deterministic 映射规则变化时必须 bump `extractor_version`，但 `source_hash` 仍只基于 source event 稳定字段，不基于生成后的 `content` / `rationale`。

schema 演进用 expand-contract：新增字段先加列允许 NULL → 新代码并行写 → 验证后回填 → 删旧列。`schema_version` 记录创建时模型版本，读老数据按版本 upcast。

## 评估

V1 必做最小评测 harness（不跑 BEAM/LongMemEval，自建小套），拆成默认 FTS5 查询集和 optional vector 增强查询集：

1. **场景构造**：固定项目（2 阶段、5 任务、3 成员）+ 手工插 30–80 条 ProjectMemory，覆盖方向边界、拒绝原因、分工约束、replan 取舍、成员事项。
2. **默认 FTS5 查询集**：40–60 条中文查询，以 MVP 真实 query 为主（关键词存在、改写较轻、项目术语明确）。每条标注期望召回的 memory_id。
3. **optional vector 增强查询集**：覆盖同义改写、弱关键词、长自然语言模糊查询。只有安装 `memory-vector` extra 时运行，不阻塞默认 CI。
4. **执行**：在 mock provider 环境下调 `memory_service.get_context_for_agent(..., viewer_user_id=...)`，断言：
   - 默认 FTS5 查询集 `recall@10 >= 90%`（允许少量漏召回，不硬卡 100%）
   - 无关记忆不出现（precision，无关占比趋近 0）
   - 延迟 < 500ms
5. **进 CI**：默认 FTS5 查询集每次改检索逻辑都跑；optional vector 查询集在安装向量 extra 的专项 job 或本地增强验收中跑。

关键指标（埋点 + 评测）：

```text
默认 FTS5 检索召回率（recall@10）：目标 >= 90%
optional vector 增强召回率（recall@10）：单独记录，不阻塞默认安装
检索精确率（precision）：无关记忆占比趋近 0
检索延迟：目标 < 500ms
降级触发率：目标 < 5%
记忆库增长率：每天新增条数（监控用，无硬目标）
一致性失效率：source_id 对不上的记忆条数（目标 0）
```

参考基准（不直接跑，作标尺）：Mem0 在 LoCoMo ~92.5%、LongMemEval ~94.4% recall。V1 默认 FTS5 评测只针对 ProjectFlow MVP 的真实中文关键词场景；同义改写和弱关键词查询进入 optional vector 增强评测。

## 与 Project Pulse 的关系

Project Pulse 负责主动巡检和生成"今日待确认"。Project Memory 负责记住历史原因和正式约束。

```text
PulseRun 摘要不直接进入 ProjectMemory
PulseItem 回复不默认进入 ProjectMemory
PulseItem 的处理结果即使被确认，也放到 V1.1 再接入
ProjectMemory 可以被 Pulse 巡检读取，用于避免重复追问和重复建议
```

## V1 范围

V1 交付的核心体验：

1. 项目有 `ProjectMemory` + `ProjectMemorySync` 两张治理表。
2. 只从 4 类事件抽取记忆（方向卡确认、proposal 拒绝、分工最终确认、replan 确认/拒绝）。
3. MemoryExtractor 为 deterministic extractor，V1 不调用 LLM、不提供 optional LLM extractor 写入开关。
4. 每条记忆必须包含 `content`、`rationale`、`source_type`、`source_id`、`memory_type`、`status`、`visibility`。
5. `source_type` 只允许 5 种枚举；`source_id` 统一指产生该决策的 proposal 对象 id。
6. ProjectMemory 同步到默认本地检索引擎（FTS5 + jieba + 字段过滤）；optional vector 启用时同步 sqlite-vec，向量同步失败不影响业务流程。
7. Agent run 开始前检索 top_k=50；默认使用 FTS5 排名，optional vector 可用时做 RRF 融合；候选必须回查 SQLite 二次过滤。
8. 回查后过滤 `status`、`visibility`、`valid_until`、`project_id` 和当前 viewer 可见性。不使用绝对 score 阈值；质量通过 strict/relaxed 两阶段检索、token coverage 和评测指标控制。
9. Agent 按 token 预算（2000 token，硬顶 10 条）注入当前 viewer 可见的 ProjectMemory。
10. 检索引擎不可用时降级到 FTS5 → 字段过滤 → none；`memory-vector` 未安装、sqlite-vec 加载失败或模型未就绪时走默认 FTS5。AgentEvent 记录 `memory_backend` 和 `used_memory_ids`。
11. 项目页面提供当前 viewer 可见的只读 ProjectMemory 列表 + Markdown 导出。
12. 最小评测 harness 进 CI，断言召回率/精确率/延迟。
13. 同一 `source_type + source_id + memory_type` 在 V1 最多生成 1 条 ProjectMemory；多个同类子项必须聚合或跳过。
14. 不做 edge，不做 ShortTermMemory，不做 rebuild，不做人工编辑，不做 archive 流程，不做 reranker，不做时间衰减。

## 后续扩展

V1.1：

1. 阶段计划确认、任务拆解确认、高风险处理、成员约束更新、Pulse/check-in 确认事实等更多事件接入。
2. reranker（cross-encoder 或小型学习排序）。
3. agentic retrieval（LLM 按需调检索 tool）。
4. LLM extractor 评估：只有接入非结构化来源、具备中文 gold set、schema guardrail、prompt isolation、成本/延迟预算和 shadow evaluation 结果后，才允许进入正式写入路径候选。
5. 显式时间衰减函数。
6. `owner_only` 可见性。
7. `confidence` / `consequences` / `evidence` 字段（ADR 风格）。
8. `valid_from` 时态字段。
9. 跨项目 `UserMemory` 表。
10. BEAM / LongMemEval 大规模评测。
11. Mem0 OSS 切换评估（若默认 FTS5 和 optional vector 增强召回仍不够）。
12. `source_item_key`：当更多事件确实需要同一 `source_type + source_id + memory_type` 下多条记忆时再引入。目标唯一键变为 `project_id + source_type + source_id + memory_type + source_item_key + source_hash`；`source_item_key` 必须稳定，例如 `task:{task_id}`、`subject:{user_id}`、`stage:{stage_id}`、`boundary:{slug}`。迁移时避免 SQLite unique index 中 nullable 字段的 NULL 语义陷阱，优先使用 expand-contract 和 `NOT NULL DEFAULT 'default'` 或过渡期 `COALESCE` 表达式索引。
13. extractor 改 FastAPI BackgroundTasks（若同步延迟成问题）。

V2：

1. LongTermMemoryEdge 或轻量关系表。
2. 记忆冲突解决流程。
3. 独立短期记忆表。
4. 更细的检索评分和 reranker。
5. 按阶段生成记忆审计摘要。
6. 更完整的记忆重建后台任务。
7. 与范围裁决模块联动。
8. 与自我约束能力联动。
9. **分层记忆（借鉴腾讯 4 层金字塔）**：L0 事件 → L1 决策记忆（V1 的 ProjectMemory）→ L2 阶段聚合 → L3 项目画像。V2 加 L2/L3 聚合，用 Markdown 存上层。
10. Graphiti 时序图谱（从 ProjectMemory 事件流平滑迁移）。

## 验收标准

1. 普通聊天不会写入 ProjectMemory。
2. 只有方向卡确认、proposal 拒绝、分工最终确认、replan 确认/拒绝会触发 ProjectMemory 抽取；其中 proposal 拒绝必须有非空 `rejection_reason` 才能生成 ProjectMemory。
3. Memory Source Event 能生成包含 `content`、`rationale`、`source_type`、`source_id`、`memory_type`、`status`、`visibility` 的 ProjectMemory。
4. `source_hash` 不受 `created_at`、`updated_at` 等无关字段影响。
5. `source_type` 超出 V1 枚举时不能写入 ProjectMemory。
6. 同一 `project_id + source_type + source_id + memory_type + source_hash` 不重复写入（唯一索引兜底）；同事件内容变了按幂等规则 supersede。
7. ProjectMemory 创建后 best effort 同步到检索引擎，`ProjectMemorySync` 记录 `backend_memory_id` 和 `sync_status`。
8. 检索引擎返回的候选必须通过 SQLite 回查，不能直接注入 Agent。
9. `superseded`、`archived`、过期、当前 viewer 不可见、项目不匹配的记忆不会注入 Agent 上下文。不使用绝对 score 阈值；质量通过 strict/relaxed 两阶段检索、token coverage 和评测指标控制。
10. 检索引擎同步或检索失败不阻塞正式项目流程；走降级链（向量不可用 → FTS5 → 字段过滤 → none）。
11. AgentEvent 记录 `_memory.used`、`_memory.backend`、`_memory.used_memory_ids`、`_memory.latency_ms`；记忆使用不进 `AgentRunState.side_effects`。
12. 用户能在项目内查看当前 viewer 可见的只读结构化记忆，分类只含 5 个主题；能导出当前 viewer 可见的 Markdown；JSON 列表、Markdown 导出和 Agent context 必须复用同一 authorization predicate（`can_view_memory`）；Agent context 在此基础上追加 active status、expiry 和 retrieval eligibility 过滤，因此三个入口的可见记忆集合不必完全一致——展示入口可包含 superseded/archived 历史判断，Agent 注入只允许 active 且未过期记录。
13. 最小评测 harness 进 CI；默认 FTS5 查询集 `recall@10 >= 90%`、延迟 < 500ms、降级率 < 5%；optional vector 增强查询集单独记录，不阻塞默认安装。
14. V1 不暴露写 API、不做 rebuild、不做 edge、不做 ShortTermMemory、不做人工编辑、不做 archive 流程、不做 reranker、不做时间衰减。
15. **replan 路径 (b) 已知覆盖缺口**：通过 `routes_replans.py` 的 `/replans/confirm` 确认的 replan 不产生 ProjectMemory（V1.1/T41 统一 replan 路径后补）。当前前端不走此端点，实际影响为零。
16. **embedding 模型不进 git 且不进默认安装路径**：默认 `python -m pip install -e ".[dev]"` 不安装 `torch` / `sentence-transformers`，不下载 embedding 模型；安装 `memory-vector` extra 后模型文件在 `backend/data/models/`（gitignore），`python -m app.memory.warmup` 可预下载，未安装 extra 时 warmup skip 并 0 退出。
17. **proposal_rejected 不写 AgentEvent**：`AgentEventStatus` 不扩，timeline 不被拒绝事件污染，`source_id` 直接指 `AgentProposal.id`。
18. **Viewer Identity Context 显式传递**：`/memories`、`/memories.md`、Agent run 创建接口必须提供 `viewer_user_id`；缺失/格式错返回 `400`，viewer 不在 project workspace 作用域内返回 `404`，不得 fallback 到 owner 视角。
19. **`subject_and_owner` 失败关闭**：ProjectMemory 写入时固化 `owner_user_id_snapshot`；`subject_and_owner` 只对 `subject_user_id` 和 `owner_user_id_snapshot` 可见，缺少 subject 或 owner 信息不得降级为 `team`。
20. **MemoryExtractor 不调用 LLM**：V1 extractor 输出在 `LLM_PROVIDER=mock`、无 provider、真实 provider 三种环境下必须一致；不得有 optional LLM extractor 写入开关。
21. **deterministic 输出稳定**：同一 Memory Source Event、同一 `extractor_version` 重放时，`content` / `rationale` 必须稳定一致；`source_hash` 不受模板文案变化影响，只基于 source event 稳定字段。
22. **用户可见文本不泄露 raw ID**：`content`、`rationale`、Markdown 导出、Agent context 中不得出现 raw `user_id`、`task_id`、`stage_id`；解析失败时使用安全占位词。
23. **source-level idempotency**：V1 中同一 `project_id + source_type + source_id + memory_type + source_hash` 最多写入 1 条 ProjectMemory，extractor 不生成 `source_item_key` / `memory_key`，也不允许同一来源事件拆出多条相同 `memory_type`。
24. **同类子项聚合或跳过**：多个同类子项能安全合并时必须稳定排序并聚合成 1 条；如果合并会破坏 visibility、scope、subject 或 related id 语义，必须跳过该 `memory_type`，不得伪造精确关联字段或合并私人成员约束。

## 审核决策落地

本节记录 V4 审核（`v4-audit.md`）的 P0/P1/P2 决策如何 fold 进本方案：

| 审核项 | 决策 | 落地位置 |
|---|---|---|
| P0-1 `reject_proposal` 写 AgentEvent 语义 | 选 (b)：不写 AgentEvent，source_id 直接指 `AgentProposal.id` | 「4 类事件落点」表 + 「source_id 语义统一」节 + 验收标准 17 |
| P0-2 FTS5 + jieba 实现路径 | 选 (a)：FTS5 external content + Python 预分词 | 「FTS5 + jieba 实现路径」节 |
| P0-3 extractor 异步机制 | 选 (b)：同步 + try/except 吞异常 | 「Extractor 调用机制」节 |
| P1-1 replan 路径 (b) 覆盖缺口 | V1 接受已知缺口，推 T41 统一 | 「replan 路径 (b) 已知覆盖缺口」节 + 验收标准 15 |
| P1-2 幂等 skip/supersede 规则 | 三条规则明确 | 「幂等写入规则」节 |
| P1-3 `memory_backend` 枚举 | 统一 `vector \| fts5 \| sqlite_field \| none`（V1 无 mem0） | 「T41 集成边界」节埋点 + 降级链 |
| P1-4 eval recall 目标 | 统一 `>= 90%` | 「评估」节 + 验收标准 13 |
| P1-5 source_id 语义不一致 | P0-1 选 (b) 后统一 | 「source_id 语义统一」节 |
| P2-1 embedding 懒加载 | 改为 optional vector extra 后才加载；默认安装不加载 embedding | 「依赖与检索后端默认策略」节 |
| P2-2 `memory_service` 位置 | `services/memory_service.py` + `agent/memory/` | 「代码位置」节 |
| P2-3 100MB 模型下载 | 修订为 FTS5 默认、向量 optional extra；模型不进 git，也不进入默认安装路径 | 「依赖与检索后端默认策略」节 + 验收标准 16 |
| T41 对齐 AgentRunState | 记忆不进 `side_effects`，只记 `output_snapshot` | 「T41 集成边界」节第 7 条 + 验收标准 11 |
| 用户决策 Q1 | replan 只 hook 路径 (a) | 「4 类事件落点」表 + 验收标准 15 |
| 用户决策 Q2 | 原 embedding 默认策略已被用户决策 Q5 修订 | 「依赖与检索后端默认策略」节 |
| 用户决策 Q3 | proposal 拒绝必须有非空 `rejection_reason` 才写记忆 | 「4 类事件落点」表 + 验收标准 2 |
| 用户决策 Q4 | 显式 `viewer_user_id` identity context + `owner_user_id_snapshot` | 「可见性」节 + 「API 边界」节 + 验收标准 18/19 |
| 用户决策 Q5 | FTS5 + jieba 默认，sqlite-vec + embedding 作为 `memory-vector` optional extra | 「依赖与检索后端默认策略」节 + 验收标准 13/16 |
| 用户决策 Q6 | MemoryExtractor V1 完全 deterministic，不调用 LLM、不提供 optional LLM 写入开关 | 「MemoryExtractor V1 策略」节 + 验收标准 20/21/22 |
| 用户决策 Q7 | V1 采用 source-level idempotency，同一来源事件不能生成多条相同 `memory_type`；未来如需拆分，V1.1 引入 `source_item_key` | 「V1 source-level 幂等边界」节 + 「MemoryExtractor V1 策略」节 + 验收标准 23/24 |

## 与 V3 的差异

| 项 | V3 | V4.1 |
|---|---|---|
| 默认检索引擎 | Mem0 OSS + Qdrant | FTS5 + jieba + 字段过滤（sqlite-vec + embedding 为 optional `memory-vector` 增强，Mem0 不进 V1） |
| 零配置 | 破坏（要起 Qdrant） | 保持 |
| 中文分词 | 未提 | jieba（FTS5 external content + Python 预分词） |
| embedding 模型 | 未提 | 不进默认安装；安装 `memory-vector` extra 后可用 bge-small-zh-v1.5，模型不进 git，未启用时默认 FTS5 |
| top_k | 12 | 50 |
| 注入限制 | 固定 6 条 | token 预算 2000，硬顶 10 条 |
| score 阈值 | 无 | 不使用绝对 BM25 阈值；改用 strict/relaxed 命中来源 + token coverage + top-k + 评测指标 |
| 表结构 | ProjectMemory 单表 | ProjectMemory + ProjectMemorySync 拆表 |
| 幂等索引 | 未提 | 唯一索引 idx_memory_idemp + source-level idempotency + skip/supersede 三条规则 |
| 可见性 | 3 档 | V1 只 2 档，owner 按作用域定义 |
| 4 类事件落点 | 假设已存在 | 逐条给代码改造方案 |
| proposal_rejected | 写 AgentEvent（重载 failed） | 不写 AgentEvent，source_id 指 AgentProposal.id |
| source_id 语义 | 混用 | 统一指产生该决策的 proposal 对象 id |
| replan 路径 | 未提两路径 | V1 只 hook 路径 (a)，路径 (b) 已知缺口推 T41 |
| extractor 机制 | "异步"未定 | 同步 + try/except 吞异常 |
| extractor 抽取方式 | 未提 | deterministic extractor，不调用 LLM，不提供 optional LLM 写入开关 |
| T41 集成 | 模糊 | 明确：context-builder 固定输入，每 run 一次，extractor 在 FastAPI 事务后同步，不进 side_effects |
| Markdown 导出 | 无 | 有（借鉴腾讯/echovault） |
| 评测 | 无 | 最小 harness 进 CI + 默认 FTS5 查询集 `recall@10 >= 90%` + optional vector 增强查询集 |
| reranker | V1 不做 | V1 不做（一致），明确 V1.1 加 |
| AgentEvent 埋点 | memory_used/backend/ids | _memory 命名空间（used/backend/used_memory_ids/retrieval_count/injected_count/latency_ms），枚举统一 |
| V2 分层 | 未提 | 借鉴腾讯 4 层金字塔，V2 加 L2/L3 |

## 自检

本方案 V1 从完整图谱方案收敛为 ProjectMemory 治理表 + 本地检索引擎 + Markdown 导出。

本方案没有让任何检索引擎成为事实源。所有状态、可见性、生命周期和注入资格都由 SQLite 中的 ProjectMemory 决定。

本方案没有开放人工维护长期记忆。用户通过改变正式项目事实来改变记忆。

本方案没有引入独立短期记忆表。

本方案没有引入自我约束能力。

本方案没有实现自动重建。

本方案没有自动捕获对话（拒绝腾讯方案的默认能力）。

本方案没有让 LLM 参与 ProjectMemory 写入。V1 MemoryExtractor 只做 deterministic schema-to-template 映射，缺字段 skipped，不补写、不猜测。

本方案没有把同一来源事件拆成多条相同类型的 ProjectMemory。V1 保持 source-level idempotency；多同类子项只能聚合或跳过，细粒度 `source_item_key` 留到 V1.1。

本方案保持零配置默认部署（FTS5 内置，jieba 轻量依赖，默认不安装 torch/sentence-transformers，不下载 embedding 模型；sqlite-vec + embedding 仅作为 optional `memory-vector` 增强）。

本方案遵守 T41 底座边界：sidecar 不读 DB、4 层写入、Proposal-Confirm 唯一人类确认边界、read-only 纯读、记忆注入走 context-builder 不走 LLM tool、记忆使用不进 AgentRunState.side_effects、不扩 AgentEventType/AgentEventStatus。
