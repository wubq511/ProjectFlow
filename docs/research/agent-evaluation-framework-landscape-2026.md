# Agent Evaluation Framework Landscape（2024–2026）

Date: 2026-07-16
Scope: 面向 ProjectFlow Agent 的评测系统外部调研。本文只使用官方文档、官方源码仓库和论文等一手资料；重点回答「哪些组件和设计可以直接借鉴」，不提出最终 ProjectFlow 实现方案。

## 1. 结论先行

对“让本机 Codex、Claude Code、Trae 等 coding agent 通过自然语言自动运行评测并返回结果”这一目标，最接近现成答案的是 **Promptfoo 的本地 MCP server**：它把运行、查询、筛选评测和查看结果直接暴露为 MCP tools；同时有 YAML/JS 配置、HTTP/自定义 provider、JSON/JSONL/JUnit 导出和面向 Codex/Claude/OpenCode 的 coding-agent provider。它解决的是 **agent-first 控制面**，不是最强的状态化评测内核。[Promptfoo MCP](https://www.promptfoo.dev/docs/integrations/mcp-server/)；[coding-agent evals](https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/)；[CLI](https://www.promptfoo.dev/docs/usage/command-line/)

对 **可恢复、可并行、可复现的 agent eval runner**，Inspect AI 是本次调研中最完整的开源基座：`Task = dataset + solver/agent + scorer + sandbox`，支持外部 agent bridge、Docker sandbox、完整 transcript、重跑/断点续跑、多 epoch、stderr、日志导出和对运行中任务的 JSON 控制通道。它甚至明确支持在 sandbox 中运行 Claude Code、Codex CLI、Gemini CLI。[Tasks](https://inspect.aisi.org.uk/tasks.html)；[Agent Bridge](https://inspect.aisi.org.uk/agent-bridge.html)；[Eval Sets](https://inspect.aisi.org.uk/eval-sets.html)；[Control Channel](https://inspect.aisi.org.uk/control-channel.html)

对 **没有专家、没有用户反馈时的可靠 oracle**，最值得借鉴的不是 LLM-as-a-judge，而是：

1. τ-bench：比较 episode 前后数据库状态与目标状态，并用多次试验的 `pass^k` 衡量稳定成功率。[论文](https://arxiv.org/abs/2406.12045)
2. ToolSandbox：保存每一步 world-state snapshot，用 Milestone DAG 表达“必要状态可有多条路径，但先后约束必须满足”。[官方仓库](https://github.com/apple/ToolSandbox)
3. AgentDojo：每个任务同时定义自然语言目标、`utility()`/`security()` 可执行判定器和可运行的 ground-truth tool-call pipeline；把“完成用户任务”和“未执行攻击目标”拆成两个独立分数。[Task Suite and Tasks](https://agentdojo.spylab.ai/concepts/task_suite_and_tasks/)
4. SWE-bench：在固定、隔离、可复现的环境里用真实测试作为最终 oracle，并先用 gold patch 验证 harness 自身有效。[Quickstart](https://github.com/SWE-bench/SWE-bench/blob/main/docs/guides/quickstart.md)

因此，最可借鉴的组合不是“整体引入一个 SaaS”，而是：**Promptfoo 式 agent 控制面 + Inspect 式 runner/log contract + τ-bench/ToolSandbox/AgentDojo 式确定性 oracle**。Phoenix、LangSmith、Braintrust 更适合做实验管理与可视化；DeepEval、Pydantic Evals 更适合做嵌入现有 Python 测试栈的轻量 evaluator 层。

OpenAI 的托管 Evals/trace grading 不应成为新系统的核心依赖：官方文档已宣布 Evals 在 2026-10-31 只读、2026-11-30 下线。开源 `openai/evals` 仍是 MIT 许可的历史实现，可借鉴 registry、JSONL 和 completion function protocol，但 agent/runtime 能力落后于 Inspect 等新框架。[OpenAI Evals deprecation](https://developers.openai.com/api/docs/guides/evals)；[openai/evals](https://github.com/openai/evals)

## 2. 研究维度

本文按以下维度比较：

- 数据模型：suite/task/case/run/trace/score 如何表达；
- runner：CLI、SDK、API、MCP、并发、重试、恢复、筛选；
- 场景：单轮、对话、状态化工具、真实环境、攻击场景；
- 轨迹：tool calls、messages、spans、world-state snapshots 是否一等公民；
- oracle：确定性 grader、状态 diff、测试、轨迹约束、LLM judge；
- 统计：重复试验、稳定性、stderr、baseline diff、回归门禁；
- agent-first：本机 coding agent 能否直接发现、运行、监控和解析结果；
- 复用与许可：是否开源、自托管、许可限制、是否绑定托管平台。

## 3. 通用框架与平台对比

| 系统 | 核心数据模型 | Runner / agent-first 接口 | 轨迹与 grader | 回归与统计 | 自托管 / 许可 | 对本目标的判断 |
|---|---|---|---|---|---|---|
| **Inspect AI** | `Task(dataset, solver/agent, scorer, sandbox)`；`Sample(input,target,metadata)`；EvalLog 保存 sample、score、events、usage | `inspect eval` / `eval-set`；Python API；`inspect ctl ... --json`；agent bridge 可接 CLI/custom agent | 完整 messages/tool/model events；确定性 scorer、model-graded scorer、sandbox-state scorer、多 scorer | epochs/reducers、mean/stderr、重试、恢复、样本复用、跨模型并行 | 完整本地运行；MIT | **最适合作 runner 内核与日志契约**；agent-first 尚缺 MCP，但 CLI/JSON 已足够被 coding agent 驱动 |
| **Promptfoo** | declarative config：prompts/providers/tests/assertions；结果含 test/provider/response/gradingResult/trace | CLI、Node library、JSON/JSONL/JUnit；本地 HTTP/STDIO MCP server 提供运行/查询工具；HTTP/custom provider | JS/assertions、LLM rubric、cost/latency、trajectory assertions、OTel trace | `--repeat`、并发、baseline/export；适合 CI | 本地开源；MIT | **最适合作自然语言控制面**；可直接把 ProjectFlow HTTP/sidecar 包成 provider，但复杂状态 oracle 仍需自定义代码 |
| **Pydantic Evals** | `Dataset -> Case`；`Experiment -> task + evaluators + case results` | Python code-first；同步/异步 API；结果可落盘/终端显示 | deterministic/custom/LLM judge；可用 OpenTelemetry span tree 检查内部行为 | 并发、retry、report-level evaluators、KS 统计 | 本地库；MIT（随 pydantic-ai repo） | **轻量嵌入 FastAPI/Python 的好选择**，但缺成熟 CLI/MCP/独立 trace UI |
| **OpenAI Evals OSS** | YAML registry + JSONL samples + Eval class + metrics | `oaieval model eval`；completion function protocol | 主要 final-output/model-graded eval；JSONL event logs | accuracy 等聚合；可写 custom eval | 本地；MIT | 历史设计可借鉴，但不是当前 agent eval 首选 |
| **OpenAI Evals / trace grading platform** | eval definition + test inputs + graders + runs；trace grading面向 end-to-end agent trace | Dashboard + API | structured score/label 覆盖 decisions、tool calls、reasoning steps | run 对比、回归分析 | 托管服务；2026-11-30 下线 | **不要作为新依赖**；只借鉴“对 trace 分层打标签”概念 |
| **LangSmith** | Dataset/Example；Experiment；Run/Trace/Thread；Feedback | Python/TS SDK，pytest/Vitest/Jest；托管 UI/API | final、single-step、trajectory；AgentEvals 提供 strict/unordered/subset/superset 和 LLM judge | repetitions 的均值/标准差、pairwise、summary evaluator、experiment compare | SDK MIT；平台 SaaS；全自托管是 Enterprise add-on | 轨迹匹配模式很实用；小团队本地优先场景不宜让核心评测依赖平台 |
| **Phoenix** | OTel trace/span/session；Dataset/Example；Experiment/Run；Annotation/Evaluation | Python/TS SDK + UI；本地 `phoenix serve`；无同等成熟的 eval MCP 控制面 | OpenInference/Otel；code/LLM evaluators；judge 自身也被 tracing | dataset experiment compare、dry run、生产 trace 转 dataset | 可自托管；核心仓库 ELv2，不是宽松 OSS | 很适合可视化 ProjectFlow 已有 trace/event；不适合作唯一 runner |
| **Braintrust** | Data + Task + Scores；Experiment 是不可变快照；trace/span | `bt eval`（Python/TS）、JSON/JSONL、CI；MCP 可供 coding agent 查询实验/日志；`bt setup` 支持 Codex/Claude/OpenCode 等 | code scorer、LLM judge、trace scorer；remote eval / cloud sandbox | immutable experiments、baseline diff、regression gate、multi-trial grouping | SDK Apache-2.0；平台/控制面商业；自托管 data plane 仍配 Braintrust control plane | agent-first 很强，但平台依赖和部署成本高于本地个人项目需求 |
| **DeepEval** | Golden -> LLMTestCase/ConversationalTestCase；Dataset；TestRun；trace/span | `deepeval test run` 基于 pytest；TUI `deepeval inspect`；Python API | task completion、tool/argument correctness、plan adherence、step efficiency、GEval；多数 agent metric 是 LLM judge | repeat、cache、threshold、official baseline（云端集成） | 核心库 Apache-2.0；Confident AI 平台另算 | evaluator 现成度高，但需警惕 referenceless agent metrics 全依赖 judge；可用作补充而非唯一 oracle |

Sources: [Inspect Tasks](https://inspect.aisi.org.uk/tasks.html), [Inspect Logs](https://inspect.aisi.org.uk/eval-logs.html), [Promptfoo outputs](https://www.promptfoo.dev/docs/configuration/outputs/), [Pydantic Evals](https://pydantic.dev/docs/ai/evals/evals/), [OpenAI trace grading](https://developers.openai.com/api/docs/guides/trace-grading), [LangSmith concepts](https://docs.langchain.com/langsmith/evaluation-concepts), [Phoenix overview](https://arize.com/docs/phoenix), [Braintrust evaluate](https://www.braintrust.dev/docs/evaluate), [DeepEval agent metrics](https://deepeval.com/guides/guides-ai-agent-evaluation-metrics).

## 4. 可直接借鉴的系统

### 4.1 Inspect AI：runner 与证据日志的最佳参考

Inspect 的最小抽象非常稳定：一个 task 至少有 dataset、solver 和 scorer；solver 可换成 Agent；sandbox、setup、cleanup、model roles、checkpoint 都是 task 配置的一部分。[Task API](https://inspect.aisi.org.uk/reference/inspect_ai.html)

最值得直接借鉴的部分：

- **任务与执行解耦**：task 可以替换 solver/agent，因此同一 ProjectFlow 场景能比较不同 model/harness，而不是把场景写死到某个 Agent 实现。[Tasks](https://inspect.aisi.org.uk/tasks.html)
- **外部 agent bridge**：可把 OpenAI Responses、Anthropic API、Google API 或任意语言的 sandbox agent 桥接进统一运行时；官方示例直接包含 Claude Code 和 Codex CLI。[Agent Bridge](https://inspect.aisi.org.uk/agent-bridge.html)
- **可恢复 eval set**：跨任务/模型运行，失败重试、已完成 sample 复用、重复执行同一命令后从上次中断处继续。[Eval Sets](https://inspect.aisi.org.uk/eval-sets.html)
- **机器可读监控**：`inspect ctl` 可读取运行中 task/sample 状态、错误、token、score、完整 transcript events，所有命令都有 `--json`，官方明确说这适合脚本和 Claude Code 等 coding agent。[Control Channel](https://inspect.aisi.org.uk/control-channel.html)
- **结果可复现**：日志保存 inputs/targets/scores/events/config/model/usage；`inspect log export-config` 可从 log 导出 run config 再运行。[Eval Logs](https://inspect.aisi.org.uk/eval-logs.html)
- **agent 场景评分**：scorer 可读取 sandbox 文件，适合用外部状态或测试结果判定，而不是只看最后一段文字。[Multiple Scorers](https://inspect.aisi.org.uk/multiple-scorers.html)
- **随机性处理**：epochs 支持 mean/median/mode/at-least-N 等 reducer；metrics 可报告 stderr。[Metrics](https://inspect.aisi.org.uk/metrics.html)

不应照搬的部分：Inspect 的默认对象仍围绕“模型调用”和模型 provider；ProjectFlow 的事实源在 FastAPI/SQLite，不能为了迎合 Inspect 把业务状态复制成另一个事实源。若使用，应把 Inspect 当外部 runner 和 evidence store，而不是项目状态管理层。

### 4.2 Promptfoo：最贴合“用户只对 coding agent 说自然语言”

Promptfoo 在 2026 年已提供本地 MCP server：STDIO 面向桌面/coding agent，HTTP 面向远程工具。MCP 暴露 `run_evaluation`、`list_evaluations`、`get_evaluation_details`、config validation、provider testing、assertion debugging 和 red-team tools 等 14 个工具。[MCP docs](https://www.promptfoo.dev/docs/integrations/mcp-server/)；[CLI MCP reference](https://www.promptfoo.dev/docs/usage/command-line/)

最值得直接借鉴的部分：

- **自然语言入口已经存在**：MCP-compatible agent 可直接“运行某个 eval、只跑某些 case、查失败详情”。
- **ProjectFlow 接入门槛低**：HTTP provider 可把 prompt 和 test vars 映射成任意 HTTP 请求并提取结果；复杂逻辑可写 JS/TS custom provider。[HTTP provider](https://www.promptfoo.dev/docs/providers/http/)；[custom provider](https://www.promptfoo.dev/docs/providers/custom-api/)
- **机器结果完整**：CLI 可导出 JSON、JSONL、JUnit XML、HTML；单条结果含 success、score、response、grader reason 和 component results。[Output formats](https://www.promptfoo.dev/docs/configuration/outputs/)
- **trajectory assertions**：对有 OTel/tool spans 的 coding agent，可断言命令、tool 使用次数、顺序和 reasoning steps；还可直接限制 cost/latency。[Coding-agent guide](https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/)
- **本机多 agent 适配**：官方 provider 覆盖 Codex SDK/app-server、Claude Agent SDK、OpenCode SDK；不过这些 provider 评的是 coding agent 本身，ProjectFlow 应使用 HTTP/custom provider 评被测 Agent，不要混淆“评测执行 agent”和“被测 ProjectFlow agent”。

主要风险：MCP server 与 CLI 拥有本地用户同等权限，可读取 config、运行脚本、写输出、调用 provider；官方安全说明明确把 config/assertions/transforms 视为可信代码。因此只能接可信本地 agent，运行目录、秘密和 side effects 必须隔离。[Security model](https://github.com/promptfoo/promptfoo/security)

### 4.3 Pydantic Evals：最小本地嵌入层

Pydantic Evals 的数据模型清楚：Dataset 包含 Cases；Experiment 对一个 Task 用多个 Evaluator 跑所有 Cases并产生 case results。Case 可含 input、expected output、metadata、case-specific evaluators；report 可序列化或显示在终端。[Overview](https://pydantic.dev/docs/ai/evals/evals/)

它最适合借鉴的是：

- 使用 Pydantic 类型约束场景和 evaluator 输入输出；
- deterministic evaluator 与 LLM judge 使用同一接口；
- evaluator 可读取 OpenTelemetry `span_tree`，检查 tool call、执行流和 timing；
- case lifecycle hooks 可做每例 setup/teardown，适合重置 SQLite fixture。[Lifecycle hooks](https://pydantic.dev/docs/ai/api/pydantic_evals/lifecycle/)

它不是完整 agent eval platform：没有 Inspect 级 sandbox/recovery，也没有 Promptfoo 的本地 eval MCP。适合作为 Python 侧 typed evaluator API 的参考或小规模实现依赖。

### 4.4 Braintrust：成熟的 agent/coding-agent 操作面，但平台偏重

Braintrust 的 `bt eval` 能发现并运行 Python/TS eval 文件，支持 deterministic sampling、matrix parameters、watch、JSON/JSONL、worker 并发和 CI non-interactive 模式。[CLI](https://www.braintrust.dev/docs/reference/cli/eval)

其 2026 年的 `bt setup` 可为 Claude、Copilot、Cursor、Codex、Gemini、OpenCode、Qwen 配置 skill 文档和 MCP；MCP 可让 coding agent 查询 experiments、生产日志和文档。[bt setup](https://www.braintrust.dev/docs/reference/cli/setup)；[MCP](https://www.braintrust.dev/docs/integrations/developer-tools/mcp)

可直接借鉴：不可变 Experiment 快照、baseline experiment、逐 case score delta、improvement/regression/tradeoff/tie、git branch 默认基线、CI `fail_on_regression` 和 `min_score`。[Compare experiments](https://www.braintrust.dev/docs/evaluate/compare-experiments)

限制是平台耦合：敏感数据可放自托管 data plane，但 UI/auth/control plane 仍是 Braintrust-managed SaaS；全套自托管需要明显高于个人项目的基础设施。[Architecture](https://www.braintrust.dev/docs/admin/self-hosting/architecture)

## 5. 观测与评估平台

### 5.1 LangSmith

LangSmith 的核心数据层次为：Dataset/Example（输入、可选 reference、metadata）→ Experiment（每个 example 的 output、scores、trace）→ production Run/Trace/Thread。它区分 offline reference-based evaluation 与 online reference-free monitoring。[Evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts)

最有价值的是 `agentevals` 的 trajectory match 语义：

- `strict`：相同 tool/message 顺序；
- `unordered`：同一组 tool calls，顺序不限；
- `subset`：实际轨迹不得超出 reference；
- `superset`：至少包含 reference 规定步骤；
- LLM judge：语义评估整条 trajectory，可附 reference trajectory。[Trajectory evals](https://docs.langchain.com/langsmith/trajectory-evals)

这四种确定性模式应直接成为任何 agent trajectory evaluator 的基础词汇。实际应用时，不要给所有场景强行写 strict reference：只在安全/审批/状态迁移顺序唯一时 strict；信息读取和独立检查更适合 unordered 或 required-subsequence。

LangSmith 支持每个 example 多次 repetitions，并显示平均与标准差；pairwise evaluator 可随机交换 A/B 位置降低 position bias。[Repetitions](https://docs.langchain.com/langsmith/repetition)；[Pairwise](https://docs.langchain.com/langsmith/evaluate-pairwise)

限制：SDK 开源 MIT，但平台不等于开源本地产品；self-hosted observability/evaluation 是 Enterprise add-on。[SDK](https://github.com/langchain-ai/langsmith-sdk)；[Self-hosted](https://docs.langchain.com/langsmith/self-hosted)

### 5.2 Arize Phoenix

Phoenix 建在 OpenTelemetry + OpenInference 上：trace 捕获 model、retrieval、tool 和 custom spans；session 把多轮 trace 串成 conversation；dataset/experiment 用同一输入比较版本。[Overview](https://arize.com/docs/phoenix)；[Sessions](https://arize.com/docs/phoenix/tracing/tutorial/sessions)

可借鉴部分：

- evaluator 参数可按名称绑定 `input/output/expected/metadata/trace_id`；
- code evaluator 与 LLM evaluator 可混用；
- evaluator 自身也进入专门的 OTel project，保存 judge prompt、model、score、explanation、timing，便于“审计 judge”；
- dry run 可确定性抽样少量 examples，不发送到 server；
- failure traces 可直接提升为 dataset，再跑 experiments。[Using Evaluators](https://arize.com/docs/phoenix/datasets-and-experiments/how-to-experiments/using-evaluators)；[Run Experiments](https://arize.com/docs/phoenix/datasets-and-experiments/how-to-experiments/run-experiments)；[Evaluator traces](https://arize.com/docs/phoenix/evaluation/llm-evals/evaluator-traces)

Phoenix 最适合做现有 ProjectFlow AgentEvent/sidecar trace 的可视化后端。它不替代任务 fixture、状态 reset 和 deterministic oracle。许可也需注意：当前官方仓库为 Elastic License 2.0，而不是 Apache/MIT。[LICENSE](https://github.com/Arize-ai/phoenix/blob/main/LICENSE)

### 5.3 DeepEval

DeepEval 的核心开源库基于 pytest：`deepeval test run` 支持并行、repeat、cache、失败退出；`deepeval inspect` 是本地 terminal trace-tree viewer。[CLI](https://deepeval.com/docs/command-line-interface)

Agent metric 覆盖三层：plan quality/adherence、tool/argument correctness、task completion/step efficiency。后两类可读完整 trace，但 task completion、step efficiency 等通常是 referenceless LLM-as-a-judge，不应作为高影响回归的唯一门禁。[Agent metrics](https://deepeval.com/guides/guides-ai-agent-evaluation-metrics)；[Step Efficiency](https://deepeval.com/docs/metrics-step-efficiency)

它也能从文档、context、scratch 或少量 goldens 生成 synthetic goldens，并模拟对话用户。但官方明确提醒：synthetic data 应补充而不是替代真实数据，高风险 workflow 仍要人工检查。这正说明“没有专家/用户”时，合成数据只能扩覆盖，不能自动成为可信 oracle。[Datasets](https://deepeval.com/docs/evaluation-datasets)；[Synthetic data caution](https://deepeval.com/docs/synthetic-data-generation-introduction)

## 6. OpenAI Evals 与 trace grading

### 6.1 开源 `openai/evals`

开源 Evals 使用 YAML registry 注册 eval，JSONL 存 sample，`oaieval` CLI 运行，结果写 JSONL event log；复杂链路可通过 Completion Function Protocol 适配。[README](https://github.com/openai/evals)；[Custom eval](https://github.com/openai/evals/blob/main/docs/custom-eval.md)

可借鉴：

- `<eval>.<split>.<version>` 的版本命名；
- eval definition 与 dataset 分离；
- completion adapter 隔离被测系统；
- 私有 eval 数据可留在本地；
- primary metric 与完整事件日志并存。

不足：架构主要为 completion/result evaluation，缺状态化 world、sandbox snapshot、现代 OTel trace 和可靠 episode resume。不要为了兼容其 registry 反向限制 ProjectFlow 场景模型。

### 6.2 托管 Evals / trace grading

OpenAI 把 trace grading 定义为：给 agent 的 end-to-end decisions、tool calls 和 reasoning steps 赋结构化 score/label，并在多个 traces 上跑 trace eval 以发现 regression 和 orchestration 问题。[Trace grading](https://developers.openai.com/api/docs/guides/trace-grading)

该概念值得借鉴，但产品不可作为新系统依赖：官方已标记 Evals 为 legacy，并给出 2026-10-31 read-only、2026-11-30 shutdown 的明确时间表。[Working with evals](https://developers.openai.com/api/docs/guides/evals)

## 7. Benchmark / Environment 对比

| Benchmark | 测什么 | 场景与轨迹 | Oracle / 指标 | Runner 与复用价值 | 许可 / 限制 |
|---|---|---|---|---|---|
| **AgentBench** | 8 类异构环境中的 autonomous agent 能力：OS、DB、KG、card game、puzzle、ALFWorld、WebShop、web browsing | 多轮 agent-environment interaction；每环境自己实现 worker/server | 环境特定成功率，跨环境聚合 | 有 Docker/worker/controller 体系，但依赖旧 Python、Redis 和重型服务；适合借“环境 adapter + 统一 controller”，不适合直接作为 ProjectFlow runner | Apache-2.0；部分环境高内存且官方说明 ALFWorld 会泄漏资源 [repo](https://github.com/THUDM/AgentBench) |
| **τ-bench / τ²/τ³** | 用户对话、domain policy、tool API、状态改变、可靠性 | LLM user simulator 与 agent 动态对话；domain = policy + tools + tasks；新版本可有 user tools | episode 结束的 DB state 与 annotated goal state 对比；原论文提出 `pass^k` | **直接借状态 goal、policy、user simulator、repeat reliability**；当前 `tau2` CLI 可选 domain/tasks/trials 并保存 simulation | MIT；业务 domain 需重写 [paper](https://arxiv.org/abs/2406.12045) [repo](https://github.com/sierra-research/tau2-bench) |
| **GAIA** | 通用助手的 browsing、files、多模态、reasoning、tool use | 466 个问题，可附文件；不规定工具或路径；3 个难度层级 | 短、唯一 factual answer 的 quasi-exact match | 借鉴“把目标压成可自动验证的短答案”和按能力/难度分层；它不评细粒度 tool trajectory，不能覆盖 ProjectFlow 的状态/隐私/确认边界 | 数据/leaderboard 在 HF；题目创建依赖人工多重验证 [paper](https://arxiv.org/abs/2311.12983) |
| **SWE-bench** | coding agent 能否解决真实 issue | 每例固定 repo commit、issue、tests；Docker 隔离；输入 prediction patch | patch 是否应用 + FAIL_TO_PASS / PASS_TO_PASS tests | **直接借 hermetic fixture、gold solution 校验 harness、test-based oracle、per-instance logs**；不借 patch contract 本身 | MIT；环境构建成本高 [quickstart](https://github.com/SWE-bench/SWE-bench/blob/main/docs/guides/quickstart.md) [runner](https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/run_evaluation.py) |
| **ToolSandbox** | stateful conversational tool use、依赖、澄清、工具干扰 | 每 turn 保存 world-state snapshot；Scenario 从 base state 扩展；user simulator；工具 augmentation | Milestone DAG；snapshot/add/remove/update/guardrail/tool-trace-dependent similarity；在任意有效轨迹中找最优 milestone 映射 | **最适合借 milestone DAG + state snapshots + invariant guardrail**；其具体 phone settings/contact/message world 不复用 | Apple sample-code license；旧 Python/依赖；不是容器 sandbox [repo](https://github.com/apple/ToolSandbox) [license](https://github.com/apple/ToolSandbox/blob/main/LICENSE) |
| **AgentDojo** | agent utility 与 indirect prompt injection security | TaskSuite = typed environment + tools + user/injection tasks + injection vectors；保存 traces | `utility()` 和 `security()` 分开；ground-truth function-call pipeline 校验任务可解；报告 utility、utility-under-attack、targeted ASR | **直接借双目标评分、ground-truth pipeline、自定义 suite 验证器、恶意 tool output 组合** | MIT；API 仍在演进 [docs](https://agentdojo.spylab.ai/concepts/task_suite_and_tasks/) [results](https://agentdojo.spylab.ai/results/) |

### 7.1 为什么公开 benchmark 不能直接当 ProjectFlow 评测

- AgentBench/GAIA 测通用 capability，无法判断 ProjectFlow 的 Proposal-Confirm、viewer privacy、state transition、中文可见文本等领域约束。
- SWE-bench 的正确性来自项目测试；ProjectFlow 也需要领域 tests/state assertions，而不是套用其 issue/patch 数据。
- τ-bench 和 ToolSandbox 最接近状态化项目管理 Agent，但它们的 world schema 是零售/航司/手机设置，直接复用任务数据没有意义；应复用 scenario/oracle pattern。
- AgentDojo 专测 prompt injection，但其“utility 与 security 分离”是通用设计：安全不能被揉进单一平均总分，否则高 utility 会掩盖越权。

## 8. 没有专家、没有用户时如何建立 oracle

### 8.1 原则：能从系统状态计算的，不交给 LLM 判断

优先级应为：

1. **可执行的业务后置条件**：DB/state/API 返回是否达到目标；
2. **必须保持的不变量**：未确认 proposal 不改变 Primary Project State、只读工具不写库、private conversation 不跨 viewer；
3. **轨迹中的强约束**：是否调用正确 tool、args 是否合法、顺序/审批边界是否满足；
4. **结构/格式约束**：schema、中文、日期格式、禁原始 ID、事件终态互斥；
5. **LLM judge**：只评无法程序化的解释清晰度、建议合理性、信息充分性。

τ-bench 证明可用 episode 结束状态与 annotated goal state 做高效自动评估；ToolSandbox 进一步证明不需要规定唯一轨迹，只需在整个 snapshot 序列上匹配必要 milestone DAG。[τ-bench](https://arxiv.org/abs/2406.12045)；[ToolSandbox](https://github.com/apple/ToolSandbox#evaluation)

### 8.2 六类不依赖专家标注的 oracle

#### A. State-diff oracle

输入是 fixture 的初始 state，输出是 episode 后 state；grader 只比较允许/必须/禁止改变的字段：

- `required_changes`: 必须发生；
- `allowed_changes`: 可发生但不计分；
- `forbidden_changes`: 一旦发生即 hard fail；
- `must_remain_equal`: 全量相等。

τ-bench 的 final DB state 和 ToolSandbox 的 addition/removal/update/guardrail similarity 都是直接依据。[τ-bench paper](https://arxiv.org/abs/2406.12045)；[ToolSandbox evaluation](https://github.com/apple/ToolSandbox#evaluation)

#### B. Executable invariant oracle

把 ProjectFlow 已有业务规则写成 invariant 函数，而不是 reference answer，例如：

- 任一 AgentRun 不能同时产生 completed 和 failed；
- LLM-callable tool 不得 finalize proposal；
- rejected proposal 在无 reason 时不得写 rejection memory；
- viewer 看不到不属于自己的 private conversation/memory；
- read-only tool 调用前后 state hash 相同。

这种 oracle 不需要专家判断输出“好不好”，只需要领域规则已在代码/规范中成立。AgentDojo 的 `utility()`/`security()` 以及 ground-truth pipeline 提供了可复用接口范式。[AgentDojo tasks](https://agentdojo.spylab.ai/concepts/task_suite_and_tasks/)

#### C. Milestone / partial-order oracle

不要要求唯一完整轨迹。定义：

- required milestone；
- milestone 之间的 DAG edge；
- forbidden milestone；
- 允许并行或换序的独立步骤。

ToolSandbox 使用拓扑约束在任意长 trajectory 中寻找 milestone 的最优对应，解决“多个正确路径”的问题。[ToolSandbox](https://github.com/apple/ToolSandbox#evaluation)

LangSmith 的 strict/unordered/subset/superset 可作为较简单的离散版：审批前查询必须 strict；多个独立 read tools 可 unordered；安全白名单适合 subset；最低必做动作适合 superset。[Trajectory evaluation](https://docs.langchain.com/langsmith/trajectory-evals)

#### D. Ground-truth program oracle

为每个 scenario 提供一个确定性 reference program/tool-call sequence，仅用于：

- 验证 fixture 可解；
- 生成期望 final state；
- 测试 grader 本身；
- 不要求被测 Agent 复制同一路径。

AgentDojo 的 `ground_truth()` 返回可执行 FunctionCalls，并有 `check-suites` 验证任务与注入任务是否真实可完成；SWE-bench 用 gold patch 验证 harness 是同一思想。[AgentDojo](https://agentdojo.spylab.ai/concepts/task_suite_and_tasks/)；[SWE-bench gold check](https://github.com/SWE-bench/SWE-bench/blob/main/docs/guides/quickstart.md)

#### E. Metamorphic oracle

没有参考答案时，可以验证“语义不变变换不应改变关键结果”：

- 改写用户措辞、空格、标点、同义词；
- 重排不相干上下文；
- 增加 distraction tools；
- tool 名字/参数描述做受控弱化；
- 把足够信息删掉，期望 Agent 澄清而不是编造；
- 同一业务事实换 display name 或 ID，期望仍遵守 privacy/output rule。

ToolSandbox 原生支持 distraction tools、tool-name scrambling、argument description/type removal，并把 insufficient-information 单独作为场景类别。[Tool augmentations](https://github.com/apple/ToolSandbox#tool-augmentations)

#### F. Differential oracle

把当前 main/baseline 与候选版本在同一 frozen suite、seed、model 配置下配对比较。它只能说明“变好/变坏/不同”，不能证明两者正确；因此应作为 regression signal，不可替代 absolute invariants。Braintrust 的 immutable experiment + baseline diff 和 LangSmith pairwise/repetition 是成熟参考。[Braintrust compare](https://www.braintrust.dev/docs/evaluate/compare-experiments)；[LangSmith pairwise](https://docs.langchain.com/langsmith/evaluate-pairwise)

### 8.3 合成用户可以生成交互，但不能生成真理

τ-bench 用 LLM user simulator 驱动动态对话；DeepEval 提供 ConversationSimulator 和 synthetic goldens。这适合覆盖澄清、拒绝、改主意、多轮状态依赖，但 simulator 的自然语言输出不能直接当 success oracle。成功仍应由 state/invariants/tool trace 判断。[τ-bench](https://arxiv.org/abs/2406.12045)；[DeepEval datasets](https://deepeval.com/docs/evaluation-datasets)

建议区分三种生成资产：

- `scenario generator`：扩输入覆盖；
- `user simulator`：产生下一轮消息；
- `oracle`：程序化检查最终/中间状态。

前两者可以是 LLM，第三者优先不是。

### 8.4 如何验证 grader 自身

即使没有专家，也可以做 grader mutation tests：

- 用 reference program/gold state 应当全过；
- 删除一个 required step 必须失败；
- 加一个 forbidden write 必须 hard fail；
- 只改表述、不改状态，state grader 不应受影响；
- 交换允许换序的 tool calls 应继续通过；
- 人为制造 raw ID 泄露、跨 viewer 数据、双终态 event，专属 grader 必须捕获；
- judge grader 用明显优/劣的 anchor outputs 做 sanity check，若不能区分则不得进入 gate。

这借鉴了 SWE-bench 的 gold patch harness validation、AgentDojo 的 ground-truth pipeline 和 Phoenix 对 evaluator 自身 tracing 的做法。[SWE-bench](https://github.com/SWE-bench/SWE-bench/blob/main/docs/guides/quickstart.md)；[AgentDojo](https://agentdojo.spylab.ai/concepts/task_suite_and_tasks/)；[Phoenix evaluator tracing](https://arize.com/docs/phoenix/evaluation/llm-evals/evaluator-traces)

## 9. LLM-as-a-judge 的正确位置

G-Eval 证明使用明确 criteria、逐步评估和结构化 form filling 能提升与人工评价的相关性，但这不等于 judge 是 ground truth。[G-Eval paper](https://aclanthology.org/2023.emnlp-main.153/)

MT-Bench/Chatbot Arena 研究明确记录 position、verbosity 和 self-enhancement bias；2024 的系统研究也在 12 个 judges、超过 10 万次比较中确认 position bias 并非随机噪声。[MT-Bench judge paper](https://arxiv.org/abs/2306.05685)；[Position bias study](https://arxiv.org/abs/2406.07791)

没有专家标注时，judge 应遵循：

- 只评程序无法判断的维度；
- 一次只评一个清晰 criterion，返回结构化 label/score + reason；
- 输入包含 task、可见 state、policy、candidate output 和已算出的 deterministic facts；
- 不把隐藏 chain-of-thought 当证据；优先使用 tool trace、state diff、final text；
- pairwise 时随机交换 A/B 顺序并测 position consistency；
- candidate 与 judge 尽量不用同一模型家族，降低 self-preference；
- 多次 judge 或多 judge 时报告 disagreement，不把平均值伪装成确定真值；
- judge score 只做 soft metric；除非后续有可靠 anchor/calibration，不做唯一 hard gate。

LangSmith 的 pairwise `randomize_order` 是可直接借鉴的 position-bias 缓解；Phoenix 强制 structured output 并把 judge 本身 trace 下来，也值得借鉴。[LangSmith pairwise](https://docs.langchain.com/langsmith/evaluate-pairwise)；[Phoenix evals](https://arize.com/docs/phoenix/evaluation/llm-evals/evaluator-traces)

## 10. 统计、稳定性与回归

### 10.1 不只报告单次 pass rate

Agent 的每个 tool decision 都会放大随机性。LangSmith 官方建议对 agent 做 repetitions，并展示均值与标准差；Inspect 使用 epochs/reducers/stderr；Promptfoo coding-agent guide 建议 `--repeat` 测 variance。[LangSmith repetitions](https://docs.langchain.com/langsmith/repetition)；[Inspect metrics](https://inspect.aisi.org.uk/metrics.html)；[Promptfoo coding agents](https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/)

最少要分开：

- `pass@1`：单次成功概率估计；
- `pass^k`：k 次都成功的可靠性，τ-bench 用它暴露偶发成功不等于可靠；
- `pass@k`：k 次至少一次成功，适合允许多次尝试/候选采样的产品，但会奖励不稳定系统；
- `all-invariant-pass`：所有 hard invariants 全过；
- 每场景失败率、均值、标准差/置信区间；
- latency p50/p95、token/cost、tool count、retry count、error/timeout rate。

### 10.2 回归比较必须配对

候选与 baseline 应使用同一 scenario version、fixture seed、model snapshot、judge config 和 repetition count；按 scenario_id 配对比较，而不是比较两个不相干总体均值。Braintrust 用 comparison key 对齐 cases 并输出 per-case delta；其 CI 能对 regression/min score 设 gate。[Braintrust compare](https://www.braintrust.dev/docs/evaluate/compare-experiments)

### 10.3 聚合不能掩盖关键失败

至少按以下 slice 报告：

- workflow stage / capability；
- single-turn / multi-turn；
- read-only / advisory write / proposal / confirmation；
- normal / insufficient-info / conflict / adversarial；
- privacy visibility；
- model / provider / thinking level；
- deterministic hard score 与 judge soft score。

Security、privacy、confirmation-boundary 不得与 helpfulness 做加权平均后相互抵消。AgentDojo 把 utility、utility under attack、attack success rate 分列正是正确范式。[AgentDojo Results](https://agentdojo.spylab.ai/results/)

## 11. Agent-first CLI / API / MCP 应满足的契约

这里不是最终 ProjectFlow CLI 设计，而是从现有系统抽出的可复用要求。

### 11.1 Coding agent 必须能完成完整闭环

1. `list suites/cases/runs`：发现可用评测与上次结果；
2. `validate`：不花模型费用地验证 config、fixture、grader、credentials；
3. `run --suite/--case/--tag --repeat --seed --model`：有界运行；
4. `status --json`：长任务轮询，能看到 pending/running/completed/error；
5. `report --json`：返回 summary、hard failures、top regressions、artifact paths；
6. `show case/run/trace`：下钻 evidence，而不是只给总分；
7. `compare --baseline`：对齐同一 cases，输出 delta；
8. `resume/retry`：重用已完成 samples，不从头烧 token；
9. 明确 exit code：infra error、eval hard-fail、partial/soft regression 分开；
10. 所有可变操作显式声明，默认隔离 fixture，不触碰真实项目数据。

对应的一手参考：Promptfoo MCP 的 run/list/details/validate/test-provider，[MCP](https://www.promptfoo.dev/docs/integrations/mcp-server/)；Inspect `ctl --json` 和 eval-set resume，[Control Channel](https://inspect.aisi.org.uk/control-channel.html)；Braintrust `bt eval --json/--jsonl --no-input`，[CLI](https://www.braintrust.dev/docs/reference/cli/eval)。

### 11.2 MCP 与 CLI 的分工

- CLI 是稳定、可脚本化、可在 CI 运行的事实接口；
- MCP 是给 coding agent 的发现和自然语言控制层；
- MCP tool 内部应调用同一 runner/service，不另写一套评测逻辑；
- 每个 MCP tool 返回小型结构化 summary + artifact locator，避免把全部 transcript 塞回 agent context；
- read-only 查询与 run/cancel/retry 等 effect tool 分开；
- secrets 不出现在 command args、result JSON 或 trace。

Promptfoo 的 MCP 直接包装 eval 能力，是最接近该模式的实现；Braintrust MCP 更偏查询平台数据，实际运行仍以 `bt eval`/平台为主。[Promptfoo MCP](https://www.promptfoo.dev/docs/integrations/mcp-server/)；[Braintrust MCP](https://www.braintrust.dev/docs/integrations/developer-tools/mcp)

### 11.3 结果必须返回证据而非“AI 总结”

给上层 coding agent 的结果至少要包含：

- suite/scenario/version/run/config hashes；
- model/provider/harness/commit；
- passed/failed/error/skipped；
- deterministic grader breakdown；
- judge score、judge model/prompt version、reason、disagreement；
- state before/after diff 或其摘要；
- tool/message/event trajectory locator；
- tokens/cost/latency/retries；
- baseline delta；
- reproducible command/config artifact。

Inspect EvalLog、Phoenix evaluator trace、Promptfoo JSON output、Braintrust immutable experiment 都证明这类证据模型可行。[Inspect Logs](https://inspect.aisi.org.uk/eval-logs.html)；[Phoenix evaluator traces](https://arize.com/docs/phoenix/evaluation/llm-evals/evaluator-traces)；[Promptfoo outputs](https://www.promptfoo.dev/docs/configuration/outputs/)；[Braintrust experiments](https://www.braintrust.dev/docs/evaluate/run-evaluations)

## 12. 复用优先级

### 第一优先：直接借设计与接口

1. **Inspect**：task/solver/scorer/sandbox 分层、EvalLog、eval-set resume、epochs/stderr、JSON control channel。
2. **Promptfoo**：本地 STDIO/HTTP MCP tools、CLI JSON/JSONL/JUnit、HTTP/custom provider、trajectory/cost/latency assertions。
3. **τ-bench**：domain policy + tools + tasks；final state goal；`pass^k`。
4. **ToolSandbox**：world snapshot、Milestone DAG、guardrail equality、insufficient-information 与 distraction transformations。
5. **AgentDojo**：typed environment、`utility/security/ground_truth` 三件套、attack × user-task matrix。
6. **SWE-bench**：hermetic fixture、gold-solution harness validation、execution-based final oracle。

### 第二优先：按需采用库或平台

- Pydantic Evals：typed local evaluator 与 span tree；
- DeepEval：现成 agent metrics 作为 soft diagnostics；
- Phoenix：OTel/OpenInference trace UI 与 experiment dataset；
- LangSmith/Braintrust：若未来需要团队协作、线上 trace-to-dataset、托管 experiment compare 再考虑。

### 不建议作为核心

- OpenAI 托管 Evals/trace grading：已给出 shutdown 日期；
- GAIA/AgentBench 数据集：可做外部 capability smoke benchmark，但不能代表 ProjectFlow 领域正确性；
- 纯 LLM-as-a-judge 总分：在无人工校准时尤其不可靠。

## 13. 许可与部署注意

| 项目 | 许可 / 部署事实 | 影响 |
|---|---|---|
| Inspect AI | MIT；本地/容器运行 [LICENSE](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/LICENSE) | 可自由复用代码与模式 |
| Promptfoo | MIT；本地 CLI/UI/MCP [LICENSE](https://github.com/promptfoo/promptfoo/blob/main/LICENSE) | 最适合直接试验 agent-first 控制面 |
| Pydantic AI/Evals | MIT [LICENSE](https://github.com/pydantic/pydantic-ai/blob/main/LICENSE) | 可嵌入现有 Python backend 工具链 |
| OpenAI Evals OSS | MIT [LICENSE](https://github.com/openai/evals/blob/main/LICENSE.md) | 可借 registry/adapter，托管平台另算 |
| LangSmith SDK | MIT；平台 self-host 是 Enterprise add-on [SDK](https://github.com/langchain-ai/langsmith-sdk) | SDK 开源不等于平台可免费自托管 |
| Phoenix | ELv2 [LICENSE](https://github.com/Arize-ai/phoenix/blob/main/LICENSE) | 可自托管使用，但分发/托管服务用途需审查 ELv2 |
| Braintrust SDK | Apache-2.0 [LICENSE](https://github.com/braintrustdata/braintrust-sdk/blob/main/LICENSE) | SDK 可复用；平台/control plane 仍是商业产品 |
| DeepEval | Apache-2.0 [LICENSE](https://github.com/confident-ai/deepeval/blob/master/LICENSE.md) | 核心测试库可本地使用 |
| AgentBench | Apache-2.0 [LICENSE](https://github.com/THUDM/AgentBench/blob/main/LICENSE) | 可复用环境/controller 代码，但依赖较旧 |
| τ-bench | MIT [LICENSE](https://github.com/sierra-research/tau2-bench/blob/main/LICENSE) | 可直接研究/复用其 domain/task/oracle 抽象 |
| SWE-bench | MIT [LICENSE](https://github.com/SWE-bench/SWE-bench/blob/main/LICENSE) | harness pattern 与代码均易复用 |
| ToolSandbox | Apple sample-code license [LICENSE](https://github.com/apple/ToolSandbox/blob/main/LICENSE) | 允许 use/modify/redistribute，但不是标准 MIT/Apache，复用代码前保留通知并审查条款 |
| AgentDojo | MIT [LICENSE](https://github.com/ethz-spylab/agentdojo/blob/main/LICENSE) | 适合复用 task suite/security evaluation 抽象 |

## 14. 最终判断

本调研没有找到一个现成系统同时满足：ProjectFlow 领域状态建模、Proposal-Confirm/隐私等定制 oracle、本地多 coding-agent 自然语言控制、可恢复 runner、完整轨迹、无人工校准的可信评分。这个缺口是真实的，不能靠“选一个评测平台”消除。

但不需要从零发明所有层：

- agent-first 操作面已有 Promptfoo MCP 的直接参考；
- runner/日志/恢复已有 Inspect 的成熟实现；
- 无专家 oracle 已有 τ-bench、ToolSandbox、AgentDojo、SWE-bench 的强模式；
- 实验比较与 trace UI 可后置接 Phoenix/LangSmith/Braintrust；
- LLM judge 只能填程序化 oracle 覆盖不到的语义空白。

真正需要 ProjectFlow 自己拥有的，是 **领域 scenario schema、fixture reset、state/invariant graders、privacy/security cases 和统一 result contract**。这些恰好也是 ProjectFlow Agent 的差异化知识，不应外包给通用 benchmark 或 SaaS。
