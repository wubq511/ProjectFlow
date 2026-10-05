# ProjectFlow Windows 本地启动指南

适用目录：`C:\Users\53506\Documents\ChatGPT\AI+\ProjectFlow-opc-project-type`

本指南默认使用 Mock 模型。Mock 不产生模型费用，不需要 API Key，适合本地开发和功能演示。

## 一、每次启动只需要做什么

项目包含后端、Agent Bridge 和前端三个服务。每个服务要占用一个 PowerShell 窗口，三个窗口都不能关闭。

### 窗口 1：启动后端

打开 PowerShell，复制并执行：

```powershell
cd 'C:\Users\53506\Documents\ChatGPT\AI+\ProjectFlow-opc-project-type\backend'
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

看到下面的信息说明成功：

```text
Application startup complete.
Uvicorn running on http://127.0.0.1:8000
```

### 窗口 2：启动 Agent Bridge

再打开一个 PowerShell，复制并执行：

```powershell
cd 'C:\Users\53506\Documents\ChatGPT\AI+\ProjectFlow-opc-project-type\agent-bridge'
npm run dev
```

看到下面的信息说明成功：

```text
模型配置已加载: 1/1 有效
listening on 127.0.0.1:4000
default model: Mock（离线演示） (mock:mock-model)
```

### 窗口 3：启动前端

再打开一个 PowerShell，复制并执行：

```powershell
cd 'C:\Users\53506\Documents\ChatGPT\AI+\ProjectFlow-opc-project-type\frontend'
npm run dev
```

看到 `Ready` 后，在浏览器打开：

<http://localhost:3000>

## 二、如何确认三个服务都正常

在浏览器分别打开：

- 产品页面：<http://localhost:3000>
- 后端接口文档：<http://localhost:8000/docs>
- Agent Bridge 健康页：<http://localhost:4000/health>

健康页显示 `"status":"ok"` 即表示 Agent Bridge 正常。

创建项目时选择“比赛”，创建后项目总览应出现“比赛”标签；刷新页面后标签仍然存在。

## 三、如何停止项目

回到三个 PowerShell 窗口，在每个窗口分别按：

```text
Ctrl + C
```

如果询问是否终止批处理任务，输入 `Y` 后回车。

关闭浏览器页面不会停止服务，关闭对应的 PowerShell 窗口才会停止该服务。

## 四、只有第一次或依赖变化时才需要执行

日常启动不需要重复安装。只有 `.venv`、`node_modules` 不存在，或者依赖文件发生变化时，再执行下面的安装命令。

### 后端依赖

```powershell
cd 'C:\Users\53506\Documents\ChatGPT\AI+\ProjectFlow-opc-project-type\backend'
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
```

### Agent Bridge 依赖

```powershell
cd 'C:\Users\53506\Documents\ChatGPT\AI+\ProjectFlow-opc-project-type\agent-bridge'
npm ci
```

### 前端依赖

```powershell
cd 'C:\Users\53506\Documents\ChatGPT\AI+\ProjectFlow-opc-project-type\frontend'
npm ci
```

## 五、本机配置文件

本地使用以下文件：

```text
backend\.env
agent-bridge\.env
agent-bridge\.env.model-configs.json
frontend\.env.local
```

这些文件保存本机地址、Mock 模型选择和内部服务令牌，均已被 Git 忽略。不要删除、上传或提交它们，也不要把令牌复制到截图和公开文档中。

如果重新克隆项目，需要重新创建这些本机配置；它们不会随 Git 分支下载。

## 六、常见问题

### 页面打不开

确认前端窗口仍显示运行状态，并检查是否打开了正确地址：`http://localhost:3000`。

### 页面能打开，但请求失败

确认后端窗口没有报错，并访问 `http://localhost:8000/docs`。如果该页面打不开，先重启后端。

### Agent 无法运行

检查 Agent Bridge 窗口是否包含：

```text
default model: Mock（离线演示） (mock:mock-model)
```

再访问 `http://localhost:4000/health`。如果健康页打不开，重启 Agent Bridge。

### 提示端口已被占用

通常是上一次启动的服务还没有关闭。找到之前的 PowerShell 窗口并按 `Ctrl + C`，然后重新启动。

### `npm` 命令不存在

需要安装项目要求的 Node.js 和 npm。当前 Agent Bridge 声明 Node.js `24.15.0`、npm `11.12.1`；尽量使用相同版本。

### Python 命令或模块不存在

先确认 `backend\.venv\Scripts\python.exe` 存在。如果不存在，按“后端依赖”一节重新创建虚拟环境。

## 七、推荐启动顺序

每次都按下面的顺序启动：

```text
后端 8000 → Agent Bridge 4000 → 前端 3000 → 打开浏览器
```

这样 Agent Bridge 启动时就能访问后端，前端打开时两个服务也已经就绪。
