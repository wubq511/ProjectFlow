# ProjectFlow 本地启动与全功能测试指南

面向队友：从零开始把 ProjectFlow 跑起来，完成全功能人工测试。

## 环境要求

| 工具 | 最低版本 | 验证命令 |
|------|---------|---------|
| Python | 3.11+ | `python --version` |
| Node.js | 18+（Next.js 16 需要） | `node --version` |
| npm | 9+ | `npm --version` |
| Git | 任意 | `git --version` |

Windows 用户全程使用 PowerShell。

## 第一步：拉取仓库

```bash
git clone <仓库地址> ProjectFlow
cd ProjectFlow
```

## 第二步：后端启动

### 2.1 创建虚拟环境并安装依赖

```bash
cd backend
python -m venv .venv
```

Windows PowerShell 激活：

```powershell
.venv\Scripts\Activate.ps1
```

macOS/Linux 激活：

```bash
source .venv/bin/activate
```

安装：

```bash
pip install -e ".[dev]"
```

### 2.2 配置环境变量

复制示例文件：

```bash
cp .env.example .env
```

编辑 `backend/.env`，按需修改。**默认配置即可启动**，无需任何改动就能跑 mock 模式：

```bash
APP_ENV=development
DATABASE_URL=sqlite:///./data/projectflow.sqlite
LLM_PROVIDER=mock
LLM_API_KEY=
LLM_BASE_URL=https://api.modelarts-maas.com/v2/chat/completions
LLM_MODEL=glm-5.1
LLM_TIMEOUT_SECONDS=60.0
LLM_AGENT_TIMEOUT_SECONDS=120.0
INTERNAL_SERVICE_TOKEN=dev-internal-service-token
```

> `.env` 已被 Git 忽略，不会提交。**永远不要把真实 API Key 提交到仓库。**

### 2.3 启动后端

```bash
python -m uvicorn app.main:app --reload --port 8000
```

Windows PowerShell 如果已经在本仓库工作区，建议直接固定使用项目虚拟环境解释器，避免系统 Python 与 `.venv` 包混用：

```powershell
D:\ProjectFlow\backend\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

首次启动会自动创建 `backend/data/projectflow.sqlite` 数据库文件。

### 2.4 验证后端

新开一个终端：

```bash
curl http://localhost:8000/api/health
```

预期返回：

```json
{"status":"ok","service":"projectflow-backend"}
```

## 第三步：前端启动

### 3.1 安装依赖

```bash
cd frontend
npm install
```

### 3.2 启动开发服务器

```bash
npm run dev
```

浏览器打开 http://localhost:3000 。

如果 3000 端口被占用：

```bash
npm run dev -- --port 3001
```

## 第四步：跑测试

### 后端测试

```bash
cd backend
.venv\Scripts\python -m pytest app/tests/ -v
.venv\Scripts\python -m ruff check app
```

预期：后端测试全部通过，ruff 无问题。2026-07-11 的测试基线为 `644 passed, 4 skipped`。

### 前端验证

```bash
cd frontend
npm run test
npm run lint
npm run build
```

预期：57 个前端测试通过，lint 无错误（有 2 个既有 React hook warnings），build 成功。`npm run test` / `npm run lint` / `npm run build` 会先或后归一 `next-env.d.ts`，避免 Next.js dev/build 类型路径切换污染 git diff。

### Agent Bridge 测试

```bash
cd agent-bridge
npx vitest run
npx tsc --noEmit
```

预期：552 个 agent-bridge 测试通过（19 文件），typecheck 通过。

## 第五步：启动 Agent Bridge Sidecar

### 5.1 安装依赖

```bash
cd agent-bridge
npm install
```

### 5.2 配置模型（可选）

Sidecar 使用 `agent-bridge/model-configs.json` 管理多模型配置。默认 4 条预设：

| 配置 ID | 供应商 | 模型 | 默认 |
|---------|--------|------|------|
| deepseek-v4-flash | DeepSeek | deepseek-v4-flash | ✅ |
| deepseek-v4-pro | DeepSeek | deepseek-v4-pro | |
| mimo-v2.5 | Xiaomi | mimo-v2.5 | |
| mimo-v2.5-cn | Xiaomi (国内 Token 计费) | mimo-v2.5 | |

API Key 通过 agent-bridge 自己的 `.env` 文件配置（`agent-bridge/.env`，不是 backend 的 `.env`），不在 JSON 中存储：

```bash
DEEPSEEK_API_KEY=sk-你的key
XIAOMI_API_KEY=你的key
XIAOMI_TOKEN_PLAN_CN_API_KEY=你的key
INTERNAL_SERVICE_TOKEN=change-me
```

> `INTERNAL_SERVICE_TOKEN` 必须与 `backend/.env` 中的值一致，sidecar 通过它认证后端内部 API。

也可以在前端设置对话框中管理模型配置（点击导航栏齿轮按钮）。

### 5.3 启动 Sidecar

```bash
cd agent-bridge
npx tsx src/index.ts
```

默认监听 `127.0.0.1:4000`。预期输出：

```
[agent-bridge] 模型配置已加载: 2/4 有效
[agent-bridge] 文件监听已启动: ...
[agent-bridge] listening on 127.0.0.1:4000
[agent-bridge] fastapi target: http://localhost:8000
[agent-bridge] default model: DeepSeek V4 Flash (deepseek:deepseek-v4-flash)
```

"2/4 有效"表示 2 个模型配置了 API Key，2 个未配置（Xiaomi）——这是正常的。

### 5.4 验证 Sidecar

```bash
curl http://localhost:4000/health
```

预期返回：

```json
{"status":"ok"}
```

查看模型配置：

```bash
curl http://localhost:4000/config/models
```

## 第六步：加载演示数据

后端运行状态下：

```bash
curl -X POST http://localhost:8000/api/seed/demo
```

这会创建一个 6 人学生团队、完整项目、4 个阶段、10 个任务、分工建议、签到、风险、行动卡和 Agent 时间线。

然后在浏览器打开 http://localhost:3000 ，首页会显示"加载演示数据"按钮，点击即可跳转到演示项目。

## 第七步：全功能人工测试流程

以下按状态机顺序，覆盖所有 Agent 功能。

### 7.1 账号与 Workspace

1. 打开 http://localhost:3000
2. 点击"开始使用"，进入 onboarding
3. 填写显示名称，提交后进入工作区创建
4. 创建 Workspace（2 步向导：基本信息 + 团队上下文）
5. 完成负责人 3 步成员档案向导（基本信息 / 技能与经验 / 可用时间）
6. 回到工作台，通过成员管理添加团队成员并填写资料

### 7.2 项目录入

1. 点击"新建项目"
2. 选择项目类型（课程作业/竞赛/创业/研究）
3. 填写项目想法、截止日期、交付物
4. 添加交付物标签
5. 添加资源（文本输入）
6. 提交，进入项目仪表盘

### 7.3 Agent：澄清方向

1. 仪表盘"规划"阶段高亮
2. 点击"澄清方向"按钮
3. Agent 运行，返回 `proposal_id`（确认后才持久化）
4. 方向卡面板显示 proposal：problem、users、value、deliverables、boundaries、risks
5. 确认 proposal → 方向卡写入项目状态
6. 拒绝 proposal → 方向卡不写入

### 7.4 Agent：阶段规划

1. 点击"生成阶段计划"
2. Agent 返回 `proposal_id`
3. 阶段计划板显示提议的阶段（目标、日期、交付物）
4. 确认 proposal → 阶段持久化

### 7.5 Agent：任务分解

1. 点击"分解任务"
2. Agent 返回 `proposal_id`
3. 任务分解板显示任务（优先级、依赖、验收标准）
4. 确认 proposal → 任务持久化

### 7.6 Agent：分工推荐

1. 仪表盘进入"分工"阶段
2. 点击"推荐分工"
3. 分工建议出现：推荐 owner、备选 owner、理由、引用字段（技能/时间/意向/约束匹配）
4. 接受建议 → owner 状态变更
5. 拒绝建议 → 显示"偏好任务"和"原因"字段
6. 提交拒绝 → 创建协调记录
7. 协调面板显示交换建议
8. 最终确认分工 → task owner 锁定

### 7.7 Agent：主动推进

1. 仪表盘进入"执行"阶段
2. 点击"主动推进"
3. 行动卡出现：标题、内容、理由、目标、启动建议、完成标准
4. 个人行动卡区显示当前用户的卡片
5. 关闭/完成行动卡

### 7.8 签到

1. 进入"签到与状态"标签
2. 提交签到（做了什么、可选卡点、可用时间、信心）
3. 更新任务状态（not_started/in_progress/done/blocked + 进度说明）

### 7.9 Agent：风险分析

1. 进入"风险与调整"标签
2. 点击"风险分析"
3. 风险卡出现：类型、结构化证据（含 detail）、状态
4. 接受/忽略/解决风险

### 7.10 Agent：调整计划

1. 点击"调整计划"
2. 重排差异显示 before/after 对比、影响、理由
3. "需要确认"标记出现在高影响变更上
4. 确认重排 → 变更生效
5. 尝试修改已确认分工的 owner → 被拒绝

### 7.11 时间线与导出

1. 进入"时间线与导出"标签
2. Agent 时间线显示事件（success/fallback/repaired/failed 状态）
3. 点击导出 → 生成评审摘要 Markdown

### 7.12 演示重置

1. 仪表盘点击"重置演示"按钮
2. 数据重置并重新播种
3. 或使用 `curl -X POST http://localhost:8000/api/demo/reset`

## 第八步：配置真实 LLM（可选）

Mock 模式下 Agent 返回确定性 fallback 数据，适合 UI 测试和演示。要体验真实 AI 输出，需要配置 LLM API。

现在有两种配置方式：

1. **Sidecar 多模型配置（推荐）**：通过前端设置对话框或 `model-configs.json` + `.env` 配置，支持多供应商、多模型切换
2. **Backend 单模型配置（旧方式）**：通过 `backend/.env` 的 `LLM_PROVIDER`/`LLM_API_KEY` 配置，仅支持单一模型

### 8.1 方式一：Sidecar 多模型配置

#### 获取 API Key

支持以下供应商（Pi SDK 内置 provider）：

- DeepSeek（deepseek-v4-flash, deepseek-v4-pro 等）
- Xiaomi / MiMo（mimo-v2.5 等）
- OpenAI（gpt-4o-mini, gpt-4o 等）
- Anthropic（claude-sonnet 等）
- OpenRouter（聚合多模型）
- 自定义 OpenAI 兼容端点

#### 在前端设置

1. 点击导航栏齿轮按钮 → "模型配置" tab
2. 查看已配置的模型列表（默认 4 条预设）
3. 点"设置 Key"为需要的模型配置 API Key
4. 在 Agent sidebar 的"模型"下拉选择要使用的模型

#### 手动编辑配置

编辑 `agent-bridge/model-configs.json` 添加/修改模型，编辑 `.env` 添加 API Key。Sidecar 会在 500ms 内自动重载。

#### 添加自定义 OpenAI 兼容端点

1. 在设置对话框点"添加模型"
2. 供应商选"openai-compatible"
3. 填写 Base URL、模型名称、API Key 环境变量名
4. 设置 API Key

### 8.2 方式二：Backend 单模型配置（旧方式）

支持任何 OpenAI 兼容的 chat-completions API：

- OpenAI 官方（gpt-4o-mini、gpt-4o 等）
- DeepSeek
- Azure OpenAI
- 本地代理（如 Ollama + 兼容接口）
- 大模型 API 聚合平台

#### 修改 `.env`

编辑 `backend/.env`：

```bash
LLM_PROVIDER=openai-compatible
LLM_API_KEY=sk-你的真实key
LLM_BASE_URL=https://你的提供商地址/v1
LLM_MODEL=模型名称
LLM_TIMEOUT_SECONDS=60.0
LLM_AGENT_TIMEOUT_SECONDS=120.0
INTERNAL_SERVICE_TOKEN=dev-internal-service-token
```

支持的 provider 值：`mock`（默认）、`openai`（官方 OpenAI）、`openai-compatible`（任何 OpenAI 兼容端点，如 DeepSeek、Azure OpenAI、华为云 ModelArts 等）。

以华为云 ModelArts 为例：

```bash
LLM_PROVIDER=openai-compatible
LLM_API_KEY=sk-你的真实key
LLM_BASE_URL=https://api.modelarts-maas.com/v2/chat/completions
LLM_MODEL=glm-5.1
LLM_TIMEOUT_SECONDS=60.0
LLM_AGENT_TIMEOUT_SECONDS=120.0
INTERNAL_SERVICE_TOKEN=dev-internal-service-token
```

#### 重启后端

Ctrl+C 停止后端，重新运行：

```bash
python -m uvicorn app.main:app --reload --port 8000
```

Windows PowerShell 可直接使用项目虚拟环境解释器：

```powershell
D:\ProjectFlow\backend\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

#### 验证 LLM 连通性

```bash
curl http://localhost:8000/api/llm/diagnostic
```

预期返回：

```json
{"provider":"openai-compatible","model":"glm-5.1","base_url":"...","status":"ok","detail":"Provider responded successfully"}
```

如果返回 `"status":"error"`，检查 API Key、Base URL 和网络连通性。

### 8.3 真实 LLM 模式下的测试要点

- Agent 响应中 `"status": "success"` 表示 LLM 调用成功
- `"status": "fallback"` 或 `"used_fallback": true` 表示 LLM 调用失败后降级
- 高影响输出（澄清/规划/分解）仍需人工确认后才持久化
- 如果 LLM 超时或返回无效 JSON，系统会自动重试 2 次后降级为 fallback

### 8.4 切回 Mock 模式

测试完毕后，编辑 `backend/.env`：

```bash
LLM_PROVIDER=mock
```

重启后端即可。Mock 模式不消耗 API 额度。

## 常见问题

### PowerShell 执行策略报错

```
.venv\Scripts\Activate.ps1 无法加载，因为在此系统上禁止运行脚本
```

解决：

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### 端口被占用

后端 8000 端口：

```bash
python -m uvicorn app.main:app --reload --port 8001
```

前端 3000 端口：

```bash
npm run dev -- --port 3001
```

如果改了后端端口，前端需要设置环境变量：

```bash
$env:NEXT_PUBLIC_API_BASE_URL="http://localhost:8001/api"
npm run dev
```

### 数据库损坏 / 想要全新状态

删除数据库文件后重启后端：

```bash
del backend\data\projectflow.sqlite
```

后端启动时自动重建。

### 后端测试失败

确保虚拟环境已激活且依赖已安装：

```bash
cd backend
.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
.venv\Scripts\python -m pytest app/tests/ -v
.venv\Scripts\python -m ruff check app
```

### 前端 build 失败

清除缓存重试：

```bash
cd frontend
Remove-Item -Recurse -Force .next
npm run build
```

## 项目文档索引

| 文档 | 内容 |
|------|------|
| [技术设计](TECH-DESIGN.md) | 架构、数据模型、Agent 设计、API 设计 |
| [API 契约](api-contract.md) | 已实现的全部 API 端点 |
| [运维手册](runbook.md) | 环境变量、LLM 模式、验证基线 |
| [演示脚本](demo-script.md) | 5 分钟演示路径 |
| [种子场景](seed-scenarios.md) | 演示数据中的 blocker/风险/重排场景 |
| [交接状态](handoff.md) | 当前完成状态和下一步工作 |
