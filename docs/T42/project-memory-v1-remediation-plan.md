# ProjectMemory V1 修复规划

状态：Completed（R1-R6、R8；R7 延后到需单独审批的 V1.1）
日期：2026-07-10
适用范围：T42 ProjectMemory V1 在 T41 sidecar 成为主 Agent Runtime 后的完整性修复
前置文档：`project-memory-design-v4.1.md`、`project-memory-v1-closure.md`、`project-memory-retrieval-implementation.md`

## 1. 结论

ProjectMemory V1 当前不是完全不可用，也不能继续按“已完整关闭”处理。

已经成立的部分：

- 确定性 Memory Source Event 抽取。
- ProjectMemory 持久化、source-level 幂等和 supersede。
- `team`、`subject_and_owner` 可见性与 viewer 校验。
- JSON 列表、Markdown 导出和前端只读面板。
- 默认 FTS5 检索、SQLite 字段降级和 `none` 降级。
- legacy Coordinator 路径中的 memory context 注入与 AgentEvent metadata。

阻止 V1 完整验收的部分：

1. 当前主路径已经迁到 sidecar，但 FastAPI 返回的 `memory_context` 没有进入 sidecar 模型上下文。
2. FTS5 在全库取 top-k 后才按 project 过滤，存在跨项目结果挤占。
3. 当前评测只证明高词面重合查询，无法证明自然语言查询效果。
4. `ProjectMemorySync` 没有完成状态流转，记录长期停留在 `pending`。
5. API 只返回 active memory，设计中的历史主题无法展示。
6. optional vector 只有依赖护栏和底层组件，没有生产索引与 Agent 使用闭环。
7. V4.1、closure、运行时代码在 backend 枚举、上下文预算和完成状态上已经漂移。

本轮修复的核心目标是先恢复默认 FTS5 路径的完整产品闭环，再决定 optional vector 是否进入 V1.1。

## 2. 本地证据基线

### 2.1 当前验证结果

2026-07-10 本地验证：

| 检查项 | 结果 |
|---|---|
| ProjectMemory 专项测试 | 129 passed |
| Backend 全量测试 | 506 passed, 4 skipped |
| Frontend 全量测试 | 56 passed |
| Agent bridge 全量测试 | 540 passed |
| Agent bridge typecheck | passed |
| Backend ruff | failed，1 个与 ProjectMemory 无关的 unused import |
| Frontend lint | failed，1 个 settings error，2 个 warnings |

### 2.2 反例验证结果

| Probe | 结果 | 结论 |
|---|---|---|
| 官方固定查询集 | 10/10 query Recall@10 = 100%，max latency 7.84ms | 可作为关键词回归 smoke |
| 自然语言 robustness query | 8/8 query 未召回，mean Recall@10 = 0% | 100% 不能代表真实查询效果 |
| 跨项目 80 条高相关干扰 | 目标项目 memory 被全库 top-50 挤出 | project filter 必须前移 |
| ProjectMemorySync | 新记录为 `pending`，`backend_memory_id` 为空 | 同步状态闭环未实现 |
| superseded history | DB 中存在 active + superseded，API 只返回 active | 历史主题永远为空 |

### 2.3 主路径断链证据

当前 sidecar 启动流程：

```text
Frontend / FastAPI conversation proxy
  -> agent-bridge /runs or /runs/stream
  -> FastAPI POST /internal/agent-runs
  -> FastAPI builds RunStartResponse.memory_context
  -> agent-bridge only reads run_id
  -> executeRun receives parsed.workspace_state
  -> context-builder has no memoryContext field
  -> model prompt contains no ProjectMemory
```

因此，当前 ProjectMemory 可以被查看和检索，但不能影响主 Agent Runtime。

## 3. 修复原则

1. FastAPI 继续是 ProjectMemory 事实源和可见性裁决方。
2. sidecar 不读数据库，不重新执行 memory visibility 判断。
3. memory context 使用独立 typed field，不混入 `workspace_state`。
4. 所有 project、status、expiry、visibility 过滤必须在权威 SQLite 数据上完成。
5. 检索候选不能先被其他 project 的记录消耗 top-k 配额。
6. 用户可查看历史与 Agent 可注入历史是两套生命周期语义，但必须复用同一授权语义。
7. 默认 FTS5 是 V1 release gate；optional vector 不能掩盖默认路径问题。
8. 先补测试再改实现，每个 slice 独立验收。
9. 不通过修改 `.env`、安装模型或真实 API key 来让默认测试通过。
10. 涉及数据库 schema 或数据迁移时必须单独说明风险并获得用户批准。

## 4. 架构决策

### AD-1：memory context 作为独立 runtime input

决定：

- `RunStartResponse.memory_context` 进入 agent-bridge wire contract。
- `executeRun` input 新增 `memoryContext`。
- `ContextBuildInput` 新增 typed `memoryContext`。
- `context-builder` 在 `<project_memory_context>` 标签中注入文本。
- sidecar 只消费 FastAPI 已完成可见性过滤和预算截断的结果。

不采用：

- 把 memory 拼进 `workspace_state`。
- sidecar 再调数据库或 ProjectMemory API。
- 前端直接读取 memory 后传给 sidecar。

理由：保持 T41 的数据库所有权、隐私和 narrow context boundary。

### AD-2：project filter 必须发生在 FTS LIMIT 前

决定：使用 FTS 表和 `project_memories` 权威表 JOIN，在 SQL 中先约束 `project_id` 和 active status，再排序和 LIMIT。

建议形状：

```sql
SELECT f.memory_id, f.rank
FROM project_memory_fts AS f
JOIN project_memories AS pm ON pm.id = f.memory_id
WHERE project_memory_fts MATCH :query
  AND pm.project_id = :project_id
  AND pm.status = 'active'
ORDER BY f.rank
LIMIT :limit;
```

最终仍需回查并执行 expiry、workspace membership 和 visibility 过滤。

该方案不修改数据库 schema，不需要迁移。

### AD-3：展示可见性与注入资格分离

决定：

- authorization visibility：决定 viewer 是否有权读取记录。
- display lifecycle：列表和 Markdown 可以展示 active、superseded、archived。
- injection eligibility：Agent context 只允许 active 且未过期记录。

因此，原“JSON、Markdown、Agent context 必须返回完全相同 memory set”需要改为：

> 三个入口必须复用同一 authorization predicate；Agent context 在此基础上追加 active、expiry 和 retrieval eligibility 过滤。

这能同时满足白盒历史追溯和防止过时记忆注入。

### AD-4：默认检索采用 strict + relaxed 两阶段

现有 FTS 查询把所有 token 连接为隐式 AND，口语中的额外词会造成整条查询失败。

决定：

1. 对 query 进行确定性规范化、去重和通用停用词过滤。
2. 第一阶段运行 strict AND，保留当前高精度行为。
3. 候选不足时运行 relaxed OR。
4. 合并去重，strict 命中优先，其次按 BM25 和 token coverage 排序。
5. project/status 过滤在两阶段 LIMIT 前完成。
6. visibility、valid_until 仍在权威行回查后过滤。

本轮不引入 LLM query rewrite，不依赖 embedding，不增加网络调用。

### AD-5：不使用绝对 BM25 score threshold

SQLite FTS5 的 BM25 值受当前语料规模和词频影响，绝对阈值难以稳定迁移。

决定使用：

- strict/relaxed 命中来源。
- 有意义 token coverage。
- top-k 上限。
- bad-first 和 irrelevant rate 评测。

需要同步修订 V4.1 中“score threshold”要求。如果后续数据证明必须使用阈值，再从标注集校准相对阈值。

### AD-6：optional vector 从默认 V1 gate 中解耦

当前状态只能称为：

```text
vector dependency guardrail + lazy backend scaffold
```

不能称为生产可用的 vector retrieval，因为：

- 生产写入没有调用 `VectorRetriever.index_memory()`。
- 已有 ProjectMemory 没有 backfill/reindex 路径。
- `build_memory_context()` 默认把 `prefer_vector` 固定为 false。
- `ProjectMemorySync` 当前只能用一个 `memory_id` 主键，无法准确追踪 FTS5 和 vector 两个 backend。

本轮默认决定：

- 修复 FTS5 闭环。
- closure 更正为“vector scaffold/guardrails 已实现，end-to-end 未完成”。
- vector 完整化拆到 V1.1 独立 issue。

如果要求本轮完成 vector，需要先批准 `ProjectMemorySync` 多 backend schema 变更和数据迁移方案。

## 5. 修复 Slices

### R0：规范与验收基线校正

优先级：P0
依赖：无
代码修改：无

修改内容：

- 更新 `project-memory-design-v4.1.md` 中的 runtime 主路径。
- 将 backend 枚举统一为代码实际值：`vector | fts5 | sqlite_field | none`。
- 将 memory metadata 统一为 `_memory.used/backend/used_memory_ids/retrieval_count/injected_count/latency_ms`，或在 R1 中确定新的 T41 metadata contract。
- 校正默认 budget：决定保留代码的 2000 token/10 条，还是回到设计的 1500 token/8 条。
- 修订“可见集合完全一致”为 AD-3 的授权一致性语义。
- 更正 closure 的 vector 完成声明。
- 将 closure 状态从 accepted 调整为 remediation in progress。

验收：

- 文档不再同时出现旧、新 backend 枚举。
- 文档中的主 Agent 路径与 sidecar 代码一致。
- 每条已知限制都有 issue/slice 对应。

### R1：修复 sidecar memory context 注入

优先级：P0
依赖：R0

预计修改文件：

- `agent-bridge/src/types/wire.ts`
- `agent-bridge/src/server/routes/start-run.ts`
- `agent-bridge/src/server/routes/start-run-stream.ts`
- `agent-bridge/src/runtime/pi-runtime.ts`
- `agent-bridge/src/runtime/context-builder.ts`
- `agent-bridge/tests/unit/wire.test.ts`
- `agent-bridge/tests/unit/context-builder.test.ts`
- 新增或扩展 start-run route 测试
- `backend/app/tests/test_memory_retrieval.py`

实现任务：

1. 给 `WireRunStartResponse` 增加 `memory_context` typed field。
2. 在普通和 SSE 两个 start-run route 中读取 FastAPI 返回值。
3. 把 memory context 传入 `executeRun`。
4. 在 model context 中添加独立 XML block。
5. 对 text 执行 XML escape，禁止标签突破。
6. sidecar 不信任前端传入的 memory 字段，只接受 FastAPI response。
7. 空 memory context 不产生空标签和 UI 噪音。
8. 保留 `AgentRunState.side_effects` 不记录 memory usage 的约束。

测试：

- Wire response 正确解析 memory context。
- `/runs` 与 `/runs/stream` 都传递 memory context。
- 最终 model user message 包含可见 memory 文本和 rationale。
- 无权 viewer 的私有 memory 不会出现在 context。
- memory 内容中的 XML 特殊字符被转义。
- FastAPI memory 构建失败时 run 正常降级。
- 非 memory 运行输出不发生行为回归。

验收：

- 从真实 Memory Source Event 写入到 sidecar model context 有一条自动化集成证据。
- 同一 run 的 `used_memory_ids` 与实际注入条目一致。
- 当前聊天和快捷 Agent flow 都走修复后的路径。

### R2：补齐 T41 memory observability

优先级：P1
依赖：R1

问题：legacy AgentEvent 有 `_memory` metadata，但 sidecar 主路径没有等价的可观测记录。

实现方向：

- 不把 memory 写进 `AgentRunState.side_effects`。
- 在既有 runtime event/trace envelope 中记录：
  - backend
  - retrieval_count
  - injected_count
  - used_memory_ids
  - latency_ms
- 优先扩展已有 `agent.started` 或 context-built payload，不新增无必要的状态机节点。
- debug payload 可以显示完整 text；普通 trace 只记录 IDs 和统计值。

测试：

- runtime event 可追踪一次 run 使用了哪些 memory。
- sensitive debug 关闭时不持久化完整私有 memory 文本。
- side effects 中不存在 memory 字段。

验收：

- 能从 run_id 反查 memory backend 和 used IDs。
- 隐私文本不进入默认 trace。

### R3：修复 FTS project scope 和跨项目挤占

优先级：P0
依赖：R0

预计修改文件：

- `backend/app/agent/memory/retriever.py`
- `backend/app/tests/test_memory_retrieval.py`
- `backend/app/tests/test_retrieval_eval.py`

实现任务：

1. FTS SQL 在 LIMIT 前 JOIN `project_memories` 并约束 project/status。
2. 保持回查后的 project、expiry、visibility 二次过滤。
3. sqlite_field fallback 保持 project scope。
4. vector V1.1 同样必须在 top-k 前解决 project scope，不能复制当前问题。

必须新增的反例测试：

- Workspace A/Project A 有目标 memory。
- Workspace A/Project B 有 80 条更高相关度干扰 memory。
- 查询 Project A 时目标 memory 仍进入 top-k。
- Workspace B 再加入 80 条干扰，结果不变。
- 非成员 viewer 仍返回拒绝语义，不因 JOIN 改动泄露存在性。

验收：

- 跨项目、跨 workspace 干扰下 Recall@10 不下降。
- 查询结果中不存在其他 project memory ID。

### R4：提升默认 FTS 自然语言鲁棒性

优先级：P1
依赖：R3

预计修改文件：

- `backend/app/agent/memory/retriever.py`
- 可选新增 `backend/app/agent/memory/query_normalizer.py`
- `backend/app/agent/memory/retrieval_eval.py`
- `backend/app/tests/test_retrieval_eval.py`

实现任务：

1. 提取 query normalization 为纯函数。
2. 生成 strict AND 和 relaxed OR 两种安全 FTS 表达式。
3. 建立小型、可审计的中文通用停用词表。
4. ASCII token 保留原大小写归一化结果。
5. 合并候选并记录 retrieval mode，方便调试。
6. 计算 token coverage，防止单个过宽词长期占据 rank 1。
7. 不把 relaxed query 用于绕过 project/visibility 过滤。

评测 query slices：

| Slice | 最小数量 | 示例 |
|---|---:|---|
| exact keyword | 10 | `MVP 范围边界` |
| paraphrase | 10 | `我们是不是决定不接学校系统` |
| short/elliptical | 5 | `后端谁做` |
| typo/noisy | 5 | `MVP 边届` |
| mixed Chinese/English | 5 | `backend API owner` |
| conflict/lifecycle | 5 | 新旧方向、superseded、expired |
| project/workspace distractor | 5 | 相同项目名、相同成员名、相同任务名 |
| privacy negative | 5 | 无权 viewer 查询私有约束 |

第一阶段至少 50 条 query。fixture 必须同时包含相关和近义无关记录。

指标：

- Recall@3
- Recall@10
- MRR@10
- bad-first rate
- irrelevant@10
- privacy leakage count
- p50/p95 latency

建议 gate：

| 指标 | Gate |
|---|---:|
| exact Recall@10 | >= 95% |
| paraphrase Recall@10 | >= 80% |
| overall Recall@3 | >= 80% |
| MRR@10 | >= 0.75 |
| bad-first rate | <= 2% |
| privacy leakage | 0 |
| p95 latency，1k memory | < 500ms |

阈值需要用首轮 baseline 校准，但 privacy、cross-project contamination、superseded contamination 始终为零容忍。

### R5：修复历史记忆展示语义

优先级：P1
依赖：R0

预计修改文件：

- `backend/app/services/memory_service.py`
- `backend/app/api/routes_memories.py`
- `backend/app/tests/test_project_memory.py`
- `frontend/src/components/project/project-memory-panel.test.tsx`

实现任务：

1. 将授权过滤和 active 注入过滤拆为两个明确函数。
2. JSON/Markdown 读取允许返回 viewer 有权查看的 superseded/archived。
3. Agent retrieval 继续只接受 active、未过期记录。
4. 历史记录仍按原 visibility 校验。
5. expired memory 是否进入历史展示需要在 R0 明确：建议展示并标记已过期，但不注入。
6. UI 第五主题使用真实 API 数据，不再是不可达分支。

测试：

- supersede 后列表同时包含 active 和 superseded。
- Markdown 出现“被替代或归档的历史判断”。
- Agent context 只包含 active。
- 私有历史 memory 仍只对 subject/owner 可见。

验收：

- 用户可以追溯旧决策。
- Agent 不会使用旧决策。

### R6：修复 ProjectMemorySync 状态闭环

优先级：P1
依赖：R3

预计修改文件：

- `backend/app/services/memory_service.py`
- `backend/app/agent/memory/retriever.py`
- `backend/app/tests/test_project_memory.py`

实现任务：

1. `index_memory()` 返回明确成功结果，或抛出可捕获的 backend error。
2. FTS 写入成功后：
   - `backend = fts5`
   - `backend_memory_id = memory.id`
   - `sync_status = synced`
   - `last_synced_at = now`
   - `last_error = null`
3. FTS 写入失败后：
   - ProjectMemory 仍提交。
   - `sync_status = failed`
   - `last_error` 使用截断后的安全错误文本。
4. supersede 时删除 FTS 失败要有可观测状态。
5. 不在本 slice 里改变 `ProjectMemorySync` schema。

测试：

- 正常写入后 sync 为 synced。
- 模拟 FTS 初始化和写入失败后 sync 为 failed。
- 业务 proposal confirm/finalize 不因索引失败回滚。
- 日志和 sync error 不包含敏感 memory 正文。

验收：

- 不再存在无原因永久 pending 的新 FTS 记录。
- 能区分“memory 已写入但索引失败”和“完整成功”。

### R7：optional vector V1.1 完整化

优先级：P2，独立项目
依赖：R3、R4、R6
状态：需要数据库变更审批

需要解决：

1. `ProjectMemorySync` 改为每个 memory/backend 一条记录。
2. 新 memory 同步 FTS5 后，再 best effort 写 vector。
3. supersede/archived 时同时移除 vector entry。
4. warmup 与 reindex/backfill 语义分开。
5. 提供仅内部 CLI 的可恢复 backfill，不开放公开写 API。
6. `MEMORY_VECTOR_ENABLED` 必须真正贯穿 Agent context production path。
7. vector 查询也必须在 top-k 前按 project scope。
8. vector 失败继续降级到 FTS5，并记录实际 backend。

数据库红线：

- 当前 `ProjectMemorySync.memory_id` 是单主键，无法表达多个 backend。
- 推荐改为复合唯一键 `(memory_id, backend)` 或新增独立 ID。
- 该变更属于数据库 schema 变更和数据迁移，实施前必须单独提交方案并请求用户同意。

在获得批准前，本 slice 只保留规划，不实施。

### R8：端到端 Agent 效果评估

优先级：P1 release evidence
依赖：R1、R2、R3、R4
状态：**已完成**。初始 150 paired trials / 300-call sidecar 正式 Pilot 完成后，按失败项选择性复验 S1/S2；综合证据通过 7/7 gates。详见 `project-memory-v1-ab-pilot-report.md` 与 `project-memory-v1-ab-selective-rerun-report.md`。

实现产物：

- `backend/app/agent/memory/ab_eval.py`：5 场景定义 + A/B runner + 确定性指标计算 + Markdown 报告 + gate
- `backend/app/agent/memory/ab_eval_cli.py`：CLI 实现；`ab_eval.py` 的模块入口会委托到该 CLI
- `backend/app/tests/test_ab_eval.py`：Mock 结构测试与真实 sidecar runner 请求契约测试

目的：回答 memory 是否改善 Agent 决策，而不只是能否检索。

场景：

1. 成员约束：避免把任务分给时间不匹配成员。
2. 拒绝历史：避免重复提出已拒绝方案。
3. MVP 边界：避免扩展到已排除范围。
4. supersede：只遵守最新 active 决策。
5. 隐私：无权 viewer 的输出不受私有约束影响。

实验设计：

- A 组：同一 FastAPI-built run input，不注入 memory context。
- B 组：注入对应可见 memory context。
- 固定 model、prompt、workspace state、viewer、tool registry 和 runtime budget。
- Pilot 使用 10 instance x 3 repeat x 5 scenario x A/B，共 150 个 paired trials、300 次模型执行。
- 10 个 instance 必须是 10 个不同 prompt framing，不得把相同 prompt 重复十次冒充不同实例。
- 每个 framing 重复 3 次，A/B 执行顺序按 cell 确定性交错，降低 provider 时间漂移偏差。
- A/B 标识对人工评审隐藏；盲审 worksheet 与 unblinding key 分文件保存。
- 隐私、raw ID、越权结果由确定性规则和人工最终裁定，不交给 LLM judge 单独决定。
- 五个场景分别使用五个专用项目和五个空 Agent conversation，避免已有 memory、对话工具或项目状态污染。

指标：

- decision compliance rate
- repeated rejected proposal rate
- boundary violation rate
- active-memory preference rate
- privacy leakage rate
- hallucinated memory rate
- token overhead
- end-to-end latency

建议 gate：

- B 组关键决策通过率比 A 组提升至少 15 percentage points。
- repeated rejected proposal rate 相对下降至少 70%。
- superseded/expired contamination 为 0。
- privacy leakage 为 0。
- hallucinated memory rate <= 1%。
- memory token overhead 不超过既定 context budget。

执行方式：

- 结构烟测：`python -m app.agent.memory.ab_eval --mock --instances 1 --repeats 1 --output ab_eval_report.md`。
- 真实评测：必须显式提供既有 workspace、project、conversation、owner/member/viewer 标识；A 组通过内部 `memory_mode=disabled` 禁用 FastAPI memory 注入，B 组保持 FastAPI-built 可见 context。
- `--prepare-fixtures` 会向指定项目写入幂等的 R8 fixture；该开关默认关闭，避免意外写入已有项目数据。
- `--runs` 是派生校验值，必须与选定 instance、repeat、scenario 和 A/B 组计算出的总模型执行数一致。
- Direct API 模式只用于模型敏感性校准，不经过 viewer/检索/sidecar，不能作为 release evidence；API key 只允许从环境变量读取。
- fixture-backed sidecar 模式每次只允许一个场景，并要求该场景使用专用空项目；隐私场景的无权 viewer context 必须为空。
- `--release-pilot` 强制单场景 `10 variants × 3 repeats × A/B = 60 calls`，且只允许 sidecar 端到端 runner；每个切片必须输出 `--runs-output` bundle。
- 最终聚合强制校验五个场景、五个不同 project/conversation、同一模型、150 对/300 calls；S1-S4 的 B 组必须有 context，A 组和 S5 无权 viewer 必须为空。
- 先用 `--aggregate-inputs ... --review-output ... --review-key-output ...` 生成盲审表，再填写适用标签，最后用 `--release-pilot --reviewed-input ...` 回灌并裁定 Gate。
- raw run bundle 含模型输出、memory context 和 memory IDs，属于本地敏感评测产物，不应提交到 Git 或公开分享。

正式 Pilot 分三步执行：

1. 对 `member_constraint`、`rejection_history`、`mvp_boundary`、`supersede`、`privacy` 分别运行一次切片。每次替换为该场景专用的 project/conversation ID：

```powershell
cd D:\ProjectFlow\backend
.venv\Scripts\python -m app.agent.memory.ab_eval `
  --release-pilot --prepare-fixtures `
  --scenarios member_constraint --instances 10 --repeats 3 --runs 60 `
  --workspace-id <workspace-id> --project-id <dedicated-project-id> `
  --conversation-id <empty-conversation-id> `
  --owner-user-id <owner-id> --member-user-id <member-id> `
  --viewer-user-id <authorized-viewer-id> `
  --privacy-viewer-user-id <unauthorized-member-id> `
  --runs-output artifacts/r8/member_constraint-runs.json `
  --output artifacts/r8/member_constraint-preliminary.md
```

2. 聚合五个 `*-runs.json`，生成未标组别的 review worksheet 和单独的 key。此步骤只生成材料，不裁定 release：

```powershell
$runs = Get-ChildItem artifacts/r8/*-runs.json | Select-Object -ExpandProperty FullName
.venv\Scripts\python -m app.agent.memory.ab_eval `
  --aggregate-inputs $runs `
  --review-output artifacts/r8/blinded-review.json `
  --review-key-output artifacts/r8/unblinding-key.json `
  --output artifacts/r8/automatic-preliminary.md
```

3. 评审者不查看 `unblinding-key.json`。S1-S4 填 `decision_compliant`，S2 另填 `repeats_rejected_plan`，所有场景填 `hallucinated_memory`，S5 另填 `privacy_leak`；不适用字段保持 `null`。完成后回灌最终裁定：

```powershell
$runs = Get-ChildItem artifacts/r8/*-runs.json | Select-Object -ExpandProperty FullName
.venv\Scripts\python -m app.agent.memory.ab_eval `
  --aggregate-inputs $runs `
  --release-pilot `
  --reviewed-input artifacts/r8/blinded-review.json `
  --output artifacts/r8/project-memory-v1-ab-final.md
```

真实模型评测需要已有 provider 凭据。本修复不会自行修改 `.env`、token 或 provider 配置。

## 6. 执行顺序

```text
R0 规范校正
  -> R1 sidecar 注入
  -> R2 runtime observability
  -> R3 project-scoped FTS
  -> R4 natural-language retrieval
  -> R5 history display
  -> R6 sync status
  -> R8 Agent A/B evidence

R7 vector V1.1 在数据库变更审批后独立执行
```

建议交付批次：

| Batch | Slices | 目标 |
|---|---|---|
| Batch A | R0 + R1 + R3 | 恢复主 Agent memory 闭环，修复错误召回边界 |
| Batch B | R2 + R4 | 可观测、可评测、自然语言可用 |
| Batch C | R5 + R6 | 补齐白盒历史与同步治理 |
| Batch D | R8 | 形成 V1 是否关闭的效果证据 |
| V1.1 | R7 | optional vector 完整化 |

## 7. 测试策略

每个 slice 必须按以下顺序验证：

1. 新增失败测试，证明问题存在。
2. 最小实现修复。
3. 跑对应专项测试。
4. 跑 ProjectMemory 129-test baseline。
5. 跑 backend、frontend、agent-bridge 全量回归。
6. 对 sidecar 注入、跨项目挤占和历史展示保留独立反例测试。

最低命令集：

```powershell
cd D:\ProjectFlow\backend
.venv\Scripts\python -m ruff check app --output-format=concise
.venv\Scripts\python -m pytest app/tests/test_project_memory.py app/tests/test_assignment_memory.py app/tests/test_proposal_rejection_memory.py app/tests/test_replan_memory.py app/tests/test_memory_retrieval.py app/tests/test_retrieval_eval.py app/tests/test_memory_vector_guardrails.py -q
.venv\Scripts\python -m pytest app/tests/ -q

cd D:\ProjectFlow\agent-bridge
npm run test
npm run typecheck
npm run build

cd D:\ProjectFlow\frontend
npm run test
npm run lint
npm run build
```

注意：frontend 脚本会运行 `tools/normalize-next-env.mjs`，执行前后必须检查并保留用户已有的 `frontend/next-env.d.ts` 工作区状态。

## 8. Release Gates

ProjectMemory V1 只有同时满足以下条件才能重新标记为 accepted：

- [x] 当前 sidecar 主路径实际注入 FastAPI 构建的 memory context。
- [x] 无权 viewer 的私有 memory 在 prompt、trace、输出中均不出现。
- [x] project/workspace 干扰不能消耗目标项目 top-k。
- [x] superseded、archived、expired 不进入 Agent context。
- [x] 用户能查看有权限的历史判断，或规范明确取消历史主题。
- [x] FTS sync 状态不再永久 pending。
- [x] 50-query 分层 eval 达到 R4 gate。
- [x] p95 latency 在目标数据规模下小于 500ms。
- [x] 150 paired trials / 300-call sidecar A/B Pilot 与选择性复验的综合证据达到 R8 的 7/7 gates。
- [x] backend、frontend、agent-bridge 全量测试通过。
- [x] lint、typecheck、build 通过，或与 ProjectMemory 无关的既有失败被单独记录并批准豁免。
- [x] closure 文档与实际代码、测试数字同步。

## 9. 风险与回滚

| 风险 | 预防 | 回滚方式 |
|---|---|---|
| sidecar context 变长影响模型输出 | 独立 budget、hard count、A/B token 统计 | 关闭 memoryContext 注入但保留 retrieval |
| relaxed OR 引入无关记忆 | strict-first、coverage、bad-first gate | 回到 strict-only 并保留 project filter |
| 历史展示暴露私有旧记忆 | 复用同一 authorization predicate | API 暂时恢复 active-only |
| sync 错误阻塞业务确认 | index best effort，异常不跨业务事务 | 降级为 failed sync，不回滚 ProjectMemory |
| runtime trace 泄露正文 | 默认只存 IDs/统计，全文仅 sensitive debug | 关闭 debug full text |
| vector schema 迁移风险 | V1 不实施，独立审批 | 保持单 backend sync 模型 |

## 10. 明确非目标

本轮不做：

- 自动从普通聊天抽取长期记忆。
- LLM extractor 或 LLM query rewrite。
- 图记忆、edge、时间衰减和人工编辑。
- 把 sidecar 变成 ProjectMemory 数据库客户端。
- 因 vector 未完成而引入默认 torch/sentence-transformers 依赖。
- 未经批准修改数据库 schema、迁移现有数据或修改 `.env`。

## 11. 完成产物

修复结束应提交：

1. 更新后的 V4.1 设计和 closure review。
2. 每个 slice 的代码与自动化测试。
3. 50-query retrieval eval 数据及结果。
4. 150 paired trials / 300-call sidecar Agent A/B Pilot 报告。
5. ProjectMemory V1 最终验收报告，明确：
   - 已完成能力。
   - 已知限制。
   - 默认 FTS5 指标。
   - Agent 实际收益。
   - privacy 结果。
   - optional vector 状态。
   - 是否允许关闭 PRD。
