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
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_TIMEOUT_SECONDS=120.0
```

> `.env` 已被 Git 忽略，不会提交。**永远不要把真实 API Key 提交到仓库。**

### 2.3 启动后端

```bash
python -m uvicorn app.main:app --reload --port 8000
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
```

预期：146 个测试全部通过。

### 前端验证

```bash
cd frontend
npm run test
npm run lint
npm run build
```

预期：7 个测试通过，lint 无错误，build 成功。

## 第五步：加载演示数据

后端运行状态下：

```bash
curl -X POST http://localhost:8000/api/seed/demo
```

这会创建一个 6 人学生团队、完整项目、4 个阶段、10 个任务、分工建议、签到、风险、行动卡和 Agent 时间线。

然后在浏览器打开 http://localhost:3000 ，首页会显示"加载演示数据"按钮，点击即可跳转到演示项目。

## 第六步：全功能人工测试流程

以下按状态机顺序，覆盖所有 Agent 功能。

### 6.1 账号与 Workspace

1. 打开 http://localhost:3000
2. 点击"开始使用"，进入 onboarding
3. 填写显示名称，提交
4. 完成 3 步成员档案向导（基本信息 / 技能与经验 / 可用时间）
5. 创建 Workspace（2 步向导：基本信息 + 团队上下文）
6. 邀请成员（复制邀请链接）

### 6.2 项目录入

1. 点击"新建项目"
2. 选择项目类型（课程作业/竞赛/创业/研究）
3. 填写项目想法、截止日期、交付物
4. 添加交付物标签
5. 添加资源（文本输入）
6. 提交，进入项目仪表盘

### 6.3 Agent：澄清方向

1. 仪表盘"规划"阶段高亮
2. 点击"澄清方向"按钮
3. Agent 运行，返回 `proposal_id`（确认后才持久化）
4. 方向卡面板显示 proposal：problem、users、value、deliverables、boundaries、risks
5. 确认 proposal → 方向卡写入项目状态
6. 拒绝 proposal → 方向卡不写入

### 6.4 Agent：阶段规划

1. 点击"生成阶段计划"
2. Agent 返回 `proposal_id`
3. 阶段计划板显示提议的阶段（目标、日期、交付物）
4. 确认 proposal → 阶段持久化

### 6.5 Agent：任务分解

1. 点击"分解任务"
2. Agent 返回 `proposal_id`
3. 任务分解板显示任务（优先级、依赖、验收标准）
4. 确认 proposal → 任务持久化

### 6.6 Agent：分工推荐

1. 仪表盘进入"分工"阶段
2. 点击"推荐分工"
3. 分工建议出现：推荐 owner、备选 owner、理由、引用字段（技能/时间/意向/约束匹配）
4. 接受建议 → owner 状态变更
5. 拒绝建议 → 显示"偏好任务"和"原因"字段
6. 提交拒绝 → 创建协调记录
7. 协调面板显示交换建议
8. 最终确认分工 → task owner 锁定

### 6.7 Agent：主动推进

1. 仪表盘进入"执行"阶段
2. 点击"主动推进"
3. 行动卡出现：标题、内容、理由、目标、启动建议、完成标准
4. 个人行动卡区显示当前用户的卡片
5. 关闭/完成行动卡

### 6.8 签到

1. 进入"签到与状态"标签
2. 提交签到（做了什么、可选卡点、可用时间、信心）
3. 更新任务状态（not_started/in_progress/done/blocked + 进度说明）

### 6.9 Agent：风险分析

1. 进入"风险与调整"标签
2. 点击"风险分析"
3. 风险卡出现：类型、结构化证据（含 detail）、状态
4. 接受/忽略/解决风险

### 6.10 Agent：调整计划

1. 点击"调整计划"
2. 重排差异显示 before/after 对比、影响、理由
3. "需要确认"标记出现在高影响变更上
4. 确认重排 → 变更生效
5. 尝试修改已确认分工的 owner → 被拒绝

### 6.11 时间线与导出

1. 进入"时间线与导出"标签
2. Agent 时间线显示事件（success/fallback/repaired/failed 状态）
3. 点击导出 → 生成评审摘要 Markdown

### 6.12 演示重置

1. 仪表盘点击"重置演示"按钮
2. 数据重置并重新播种
3. 或使用 `curl -X POST http://localhost:8000/api/demo/reset`

## 第七步：配置真实 LLM（可选）

Mock 模式下 Agent 返回确定性 fallback 数据，适合 UI 测试和演示。要体验真实 AI 输出，需要配置 LLM API。

### 7.1 获取 API Key

支持任何 OpenAI 兼容的 chat-completions API：

- OpenAI 官方（gpt-4o-mini、gpt-4o 等）
- DeepSeek
- Azure OpenAI
- 本地代理（如 Ollama + 兼容接口）
- 大模型 API 聚合平台

### 7.2 修改 `.env`

编辑 `backend/.env`：

```bash
LLM_PROVIDER=openai
LLM_API_KEY=sk-你的真实key
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_TIMEOUT_SECONDS=30.0
```

如果使用 OpenAI 兼容提供商：

```bash
LLM_PROVIDER=openai-compatible
LLM_API_KEY=你的提供商key
LLM_BASE_URL=https://你的提供商地址/v1
LLM_MODEL=模型名称
LLM_TIMEOUT_SECONDS=30.0
```

### 7.3 重启后端

Ctrl+C 停止后端，重新运行：

```bash
python -m uvicorn app.main:app --reload --port 8000
```

### 7.4 验证 LLM 连通性

```bash
curl http://localhost:8000/api/llm/diagnostic
```

预期返回：

```json
{"provider":"openai","model":"gpt-4o-mini","base_url":"...","status":"ok","detail":"Provider responded successfully"}
```

如果返回 `"status":"error"`，检查 API Key、Base URL 和网络连通性。

### 7.5 真实 LLM 模式下的测试要点

- Agent 响应中 `"status": "success"` 表示 LLM 调用成功
- `"status": "fallback"` 或 `"used_fallback": true` 表示 LLM 调用失败后降级
- 高影响输出（澄清/规划/分解）仍需人工确认后才持久化
- 如果 LLM 超时或返回无效 JSON，系统会自动重试 2 次后降级为 fallback

### 7.6 切回 Mock 模式

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
