# ProjectFlow 项目类型持久化改造交接

状态：代码与验证已提交（2026-10-01）

分支：`codex/opc-project-intake-20261001`

工作目录：`C:\Users\53506\Documents\ChatGPT\AI+\ProjectFlow-opc-project-type`

## 基线与隔离

- 上游：`https://github.com/wubq511/ProjectFlow.git`；fork：`https://github.com/scy404/ProjectFlow.git`。
- 用户在本工作目录执行 `git fetch upstream main`、`git fetch origin main` 后，`upstream/main`、`origin/main` 与本分支 `HEAD` 均为 `f374ec55ea3aa1d5f3c6ad64f2c3a98e8d966038`。
- 本工作目录由桌面仓库的本地 `main` 复制而来；桌面仓库和两个远端的 `main` 不在此任务中修改。
- 代码与测试提交：`29934ef`（`fix(project): persist intake template and expose workspace metadata`）。本 handoff 单独提交，便于按提交追溯实现和验收。

## 问题与范围

创建表单已有课程、比赛、创业、研究四类选择，但提交请求不带该值；工作区规模在项目表单中重复询问且不保存。工作区模型已保存 `team_size` 和 `use_case`，响应模式却遗漏两字段。

本次将项目类型以 `project_template` 保存为项目事实，并在项目 API 和 Agent 工作区状态中返回。旧项目默认 `general`。项目表单移除无效的团队规模输入；不改变工作区创建时的规模填写。本次不改变 Agent 的模板策略，也不增加新的 OPC 专用表单选项。

## 修改台账

| 序号 | 文件 | 修改及原因 | 验证 |
| --- | --- | --- | --- |
| 1 | `docs/competition/2026-10-01-project-intake-handoff.md` | 记录基线、范围、逐文件变更、测试与剩余事项 | 本台账 |
| 2 | `backend/app/models/enums.py`, `backend/app/models/project.py` | 定义五种项目模板；项目表增加 `project_template`，旧项目默认 `general` | API 与迁移测试 |
| 3 | `backend/app/schemas/project.py`, `backend/app/services/project_service.py` | 创建请求校验模板值并保存；未传模板的旧客户端继续创建普通项目 | `test_project_template.py` |
| 4 | `backend/app/api/routes_projects.py`, `backend/app/services/project_state_service.py` | 单项目、项目列表和项目聚合读取都返回模板 | `test_project_template.py` |
| 5 | `backend/app/schemas/workspace_state.py`, `backend/app/services/workspace_state_service.py` | Agent 所读工作区状态包含项目模板，供后续模板策略使用 | `test_project_template.py` |
| 6 | `backend/app/core/database.py`, `backend/app/tests/test_database_migrations.py` | 幂等迁移旧 SQLite 项目表，并验证原有行保留为 `general` | 迁移测试两次启动通过 |
| 7 | `backend/app/schemas/workspace.py` | `WorkspaceRead` 返回已保存的 `team_size` 和 `use_case` | 创建、列表、详情与项目状态 API 测试 |
| 8 | `frontend/src/lib/types.ts`, `frontend/src/lib/api.ts` | 同步前端数据契约；创建请求显式传模板 | TypeScript 检查与表单测试 |
| 9 | `frontend/src/components/project/project-intake-form.tsx` | 保存用户选的类型；未选用 `general`；移除不生效且与工作区重复的团队规模输入和草稿字段 | 表单测试 |
| 10 | `frontend/src/components/project/project-content.tsx` | 项目总览显示已保存的课程、比赛、创业或研究类别；普通旧项目不增加无意义标签 | TypeScript 与 ESLint |
| 11 | `backend/app/tests/test_project_template.py`, `frontend/src/components/project/project-intake-form.test.tsx` | 覆盖四种类型、默认值、非法值、各读取路径及 UI 提交 | 下方验证记录 |
| 12 | 本机忽略配置：`backend/.env`, `agent-bridge/.env`, `agent-bridge/.env.model-configs.json`, `frontend/.env.local` | 配置本地 Mock 模型、服务地址及共享内部令牌；文件均被 `.gitignore` 排除，令牌不进入文档或提交 | 三服务实际启动与 HTTP 检查 |
| 13 | `docs/competition/ProjectFlow_Windows本地启动指南.md` | 记录零基础用户每次启动、停止、首次安装和故障排查步骤 | 按指南完成本次启动 |

## 验证记录

- `python -m pytest app/tests/test_project_template.py app/tests/test_database_migrations.py app/tests/test_project_state_endpoint.py app/tests/test_api_workspace_project.py -q`：16 passed。
- `python -m ruff check`（本次改动的后端文件）：通过。
- `npx tsc --noEmit`：通过。
- `npx eslint`（本次改动的前端文件）：通过。
- `npx vitest run src/components/project/project-intake-form.test.tsx`：2 passed。初次在受限环境启动时无法读取配置；使用允许的执行环境重跑通过。测试输出有既有 `TagInput`/`Input` ref 警告，不影响本次断言。
- `npm run build`：初次因执行环境不能连接 Google Fonts 而失败；联网重跑后 Next.js 编译、TypeScript、静态页面生成全部通过。
- `git diff --check`：通过。
- `npm ci --offline --ignore-scripts`：因缺少 `zwitch` 缓存而失败；随后 `npm ci --ignore-scripts` 成功安装锁定依赖。安装输出报告 21 项依赖审计问题，未在本次功能修复中变更依赖版本。
- 本地启动验收（2026-10-01）：后端 `127.0.0.1:8000/docs` 返回 200；Agent Bridge `127.0.0.1:4000/health` 返回 200 且加载 `mock:mock-model`；前端 `127.0.0.1:3000` 返回 200。
- `git check-ignore` 确认四个本机配置文件均被忽略；配置中的共享内部令牌未写入提交文档。

## 剩余事项

- 新字段目前提供事实数据和 Agent 状态输入；类别专属的 Agent Skill 策略属于后续产品改造，不在本次 2.1 修复内。
- 表单按现有产品设计系统收敛：删除重复规模输入，保留四种类型的原有选择方式；项目总览只在有明确类型时显示类别标签。
- 推送目标为 fork 的 `origin/codex/opc-project-intake-20261001`。推送状态见本 handoff 后续记录或 Git 远端分支；不推送 `main`。
