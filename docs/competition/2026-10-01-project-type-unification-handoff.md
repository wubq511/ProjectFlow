# ProjectFlow 项目类型统一与演示数据同步交接

状态：本地实施与验证完成；GitHub 网络不可达，等待人工执行推送（2026-10-01）

分支：`codex/unify-project-types-demo-seed-20261001`

工作目录：`C:\Users\53506\Documents\ChatGPT\AI+\ProjectFlow-opc-project-type`

## 基线与隔离

- 本分支从 `codex/opc-project-intake-20261001` 的本地 `6b5a914` 创建。
- 基线包含上一轮项目类型持久化提交 `29934ef`、handoff 提交 `23450eb`，以及用户后续加入的 Windows 本地启动指南提交 `6b5a914`。
- 推送目标仅为 fork `https://github.com/scy404/ProjectFlow.git` 的同名新分支；不修改 `origin/main`、`upstream/main` 或桌面原仓库。

## 目标

1. 当前 ProjectFlow 演示工作区和演示项目明确使用 `competition`，避免默认落入 `general`。
2. 工作区与项目共用 `general/coursework/competition/startup/research` 五种基础枚举和同一套中文标签。
3. 产品层不再使用“主要场景/其他/自定义场景”概念；旧 `use_case` 数据只参与兼容迁移。
4. 工作区类型作为新建项目的默认类型，用户仍可在项目表单中修改。

## 修改台账

| 序号 | 文件 | 修改及原因 | 验证 |
| --- | --- | --- | --- |
| 1 | `backend/app/models/workspace.py` | 将工作区领域字段从自由文本 `use_case` 改为 `project_template`，默认 `general` | API 与迁移测试 |
| 2 | `backend/app/schemas/workspace.py` | 创建/读取 DTO 使用 `ProjectTemplate` 枚举；后端拒绝 `other` 等枚举外值 | `test_project_template.py` |
| 3 | `backend/app/services/workspace_service.py` | 创建工作区时持久化规范枚举值 | API 测试 |
| 4 | `backend/app/core/database.py` | 为已有 SQLite 工作区增加 `project_template`；把 `course/coursework`、比赛、创业、研究迁移到对应枚举，其他旧值归入 `general`；迁移可重复执行 | `test_database_migrations.py` |
| 5 | `backend/app/seed/demo_projectflow.py` | 主演示工作区和主演示项目均显式写入 `competition` | 种子重置测试 |
| 6 | `backend/app/seed/demo_seed.py` | 旧版课程型演示工作区和项目均显式写入 `coursework` | 后端相关回归 |
| 7 | `frontend/src/components/project/project-template-options.ts` | 新建唯一的五枚举中文标签与图标来源，供工作区和项目表单共用 | 前端测试、构建 |
| 8 | `frontend/src/lib/types.ts`、`frontend/src/lib/api.ts` | 工作区类型和创建请求改用 `project_template`，请求体与后端对齐 | ESLint、TypeScript 构建 |
| 9 | `frontend/src/components/workspace/workspace-create-form.tsx` | “主要场景”改为“项目类型”；替换为五枚举；删除“其他/自定义场景”；提交 `project_template` | 新增表单测试 |
| 10 | `frontend/src/components/workspace/new-workspace-dialog.tsx` | 同步五枚举；并修复该入口此前未提交 `team_size` 和类型的既有断链 | 前端全量测试、构建 |
| 11 | `frontend/src/components/project/project-intake-form.tsx`、`new-project-dialog.tsx`、`workspace-content.tsx` | 项目创建展示同一套五枚举；工作区类型成为新项目默认值，项目仍可单独改选 | 项目表单测试 |
| 12 | `frontend/src/components/project/project-content.tsx` | 项目页用共享标签显示类型，`general` 也显示为“通用项目” | ESLint、TypeScript 构建 |
| 13 | `frontend/src/components/project/project-intake-form.test.tsx` | 覆盖显式选型、默认 `general`、继承工作区类型 | 3 项通过 |
| 14 | `frontend/src/components/workspace/workspace-create-form.test.tsx` | 覆盖精确五选项、无“其他”、类型和团队规模提交 | 1 项通过 |
| 15 | `backend/app/tests/test_project_template.py`、`test_database_migrations.py`、`test_seed_reset_export.py` | 覆盖工作区枚举、非法值、旧数据迁移、主演示数据 | 相关 39 项通过 |
| 16 | 本文件 | 记录分支基线、产品决策、逐文件修改、验证结果、已知基线问题和推送状态 | 人工复核 |

实现提交：`452bea18e0ade2edd8ae980d7bb0d9a314d1472a`（`fix(project): unify workspace and project templates`）。

## 验证记录

- `python -m pytest app/tests/test_project_template.py app/tests/test_database_migrations.py app/tests/test_seed_reset_export.py app/tests/test_project_state_endpoint.py app/tests/test_api_workspace_project.py`：`39 passed`。
- `npm test`：`28` 个测试文件通过，`337 passed / 6 skipped`；其中本次新增/修改的表单测试 `4 passed`。
- `npm run lint`：通过，无 ESLint 错误。
- `npm run build`：通过，Next.js 生产构建、TypeScript、静态页面生成均成功。
- `git diff --cached --check`：通过，无空白错误。
- 后端全量 `pytest`：`851 passed / 4 skipped / 67 failed / 2 errors`。失败来自旧测试把 `2026-08-01`、`2026-08-15` 等日期写死为未来截止日；在当前日期 `2026-10-01` 会先触发“截止日期已过去”的 422，后续测试再因响应没有 `id` 连锁失败。此次改动相关的专项 39 项均通过。
- 后端全量 Ruff：仓库当前基线有 `489` 条既有规范问题，分布于 Agent、种子和旧测试等大量未改代码；本分支没有进行越界的全仓格式化。

## 兼容说明

- 新请求和响应只暴露统一字段 `project_template`，允许值固定为五种基础枚举。
- 旧 SQLite 数据库升级时保留物理 `use_case` 列，避免破坏式删列；产品模型和 API 不再读取或返回它。
- 旧值 `course` 迁移为 `coursework`；旧 `other`、自定义文本、空值和未知值迁移为 `general`。
- 新数据库不会创建 `use_case` 列；迁移函数可重复执行，不会覆盖已经存在的 `project_template`。
- 工作区类型是创建项目时的初始默认值，不会强制锁死项目类型，用户可以在项目表单中改选。

## 可见产品变化

- 两个“新建工作区”入口都显示：通用项目、课程作业、比赛、创业、研究。
- “主要场景”和“其他/自定义场景”入口被移除，统一称为“项目类型”。
- 从某工作区新建项目时，会默认选中该工作区的项目类型。
- 演示数据重置后，ProjectFlow 演示项目详情显示“比赛”。

## 推送记录

- 目标仅为 `origin/codex/unify-project-types-demo-seed-20261001`。
- 2026-10-01 自动推送共尝试三次：沙箱内一次立即无法连接；获准联网后一次连接被重置、一次连接 21 秒后超时。三次均在建立/维持 HTTPS 连接阶段失败，没有远端写入成功的证据。
- 失败前本地确认：`origin/main` 和 `upstream/main` 均为 `f374ec55ea3aa1d5f3c6ad64f2c3a98e8d966038`，本次未切换或提交到 `main`。
- 网络恢复后在 PowerShell 执行：

  ```powershell
  cd 'C:\Users\53506\Documents\ChatGPT\AI+\ProjectFlow-opc-project-type'
  git push -u origin codex/unify-project-types-demo-seed-20261001
  git ls-remote origin refs/heads/codex/unify-project-types-demo-seed-20261001 refs/heads/main
  git status --short --branch
  ```

- 预期：新分支远端 SHA 与本地 `HEAD` 一致；远端 `main` 仍为 `f374ec55ea3aa1d5f3c6ad64f2c3a98e8d966038`；工作区干净。

## PR #2 合并状态审计（2026-10-05）

- PR：`https://github.com/scy404/ProjectFlow/pull/2`
- GitHub API 审计时返回：`mergeable=false`、`mergeable_state=dirty`。
- PR base：`main` @ `f374ec55ea3aa1d5f3c6ad64f2c3a98e8d966038`。
- 审计前 PR head：`codex/unify-project-types-demo-seed-20261001` @ `b69ce4f48606792254bd2b861eec869bec414958`。
- 本地使用上述精确 SHA 执行三方合并检查，Git 返回 `Already up to date`；`git merge-base` 同样返回 base SHA，且 `git merge-base --is-ancestor` 成功。
- 结论：base 是 head 的直接祖先，代码和文件层面不存在需要人工取舍的冲突；GitHub 的 `dirty` 与提交图不一致，属于陈旧的合并状态计算，而非真实内容冲突。
- 处理方式：不制造无意义的冲突取舍或改写业务代码；通过本审计提交更新 PR head，触发 GitHub 重新计算 mergeability。
