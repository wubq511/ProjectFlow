# T41 Multi-Model & Multi-Provider Configuration

> **状态**: 设计确认，待实施
> **日期**: 2026-07-08
> **范围**: Agent Bridge Sidecar + Frontend

## 1. 需求

- 支持多模型、多供应商的配置和切换
- 前端可查看已配置模型，可添加新配置（写入 sidecar），也可直接编辑 sidecar 配置文件
- 前端 Agent Sidebar 支持模型切换，切换后保持直到再次切换

## 2. 决策汇总

| # | 决策点 | 结论 | 理由 |
|---|--------|------|------|
| D1 | 配置存储 | `agent-bridge/model-configs.json` | 部署级配置非业务数据，人类可读可编辑，git 可 diff |
| D2 | 配置 owner | Sidecar | Sidecar 是唯一 LLM 调用者，职责对齐；已有 `.env` 中 API key |
| D3 | 模型切换语义 | 选了就保持，直到主动再换 | 类 ChatGPT/Claude 主流 Agent 交互模式 |
| D4 | Sidebar 选择器 | 单个下拉，显示 `displayName` | 配置少时最清晰，displayName 已含足够信息 |
| D5 | 预置模型 | 4 条（见 §3） | 只预置明确要用的，其余用户按需加 |
| D6 | 添加新模型交互 | Provider 下拉 → catalog 模型下拉；或"自定义"手填 | 主流操作是选不是打，自定义端点也能支持 |
| D7 | API Key 管理 | 显示变量名 + 状态，"设置 Key"按钮写 `.env` | 配置和 key 一步完成，不用切文件 |
| D8 | `.env` 写并发 | 内存 Promise 队列串行化 | 零依赖，彻底消除并发问题 |
| D9 | 设置入口 | 导航栏齿轮图标 | 全局可达 |
| D10 | 设置 UI 结构 | 通用设置弹窗 + 左侧 tab 栏 | 未来加设置项只需加 tab，避免返工 |
| D11 | Provider 加载 | 动态 `import()` 按需加载 | 只加载配置中声明了的 provider |
| D12 | 无效配置处理 | 启动时校验 warn + 标记 invalid，不阻塞启动 | 容错，前端灰显引导修复 |
| D13 | 配置 reload | fs.watch 自动 + `POST /config/reload` 手动兜底 | 实时感知文件变化 + 可靠兜底 |
| D14 | 设置 UI 形态 | 弹窗（Dialog） | 不丢当前页面上下文，低频操作不需要独立路由 |

## 3. `model-configs.json` 格式

```json
{
  "models": [
    {
      "id": "deepseek-v4-flash",
      "provider": "deepseek",
      "name": "deepseek-v4-flash",
      "displayName": "DeepSeek V4 Flash",
      "apiKeyEnvVar": "DEEPSEEK_API_KEY",
      "isDefault": true,
      "capabilities": { "thinking": true, "vision": false }
    },
    {
      "id": "deepseek-v4-pro",
      "provider": "deepseek",
      "name": "deepseek-v4-pro",
      "displayName": "DeepSeek V4 Pro",
      "apiKeyEnvVar": "DEEPSEEK_API_KEY",
      "isDefault": false,
      "capabilities": { "thinking": true, "vision": false }
    },
    {
      "id": "mimo-v2.5",
      "provider": "xiaomi",
      "name": "mimo-v2.5",
      "displayName": "MiMo V2.5",
      "apiKeyEnvVar": "XIAOMI_API_KEY",
      "isDefault": false,
      "capabilities": { "thinking": true, "vision": true }
    },
    {
      "id": "mimo-v2.5-cn",
      "provider": "xiaomi-token-plan-cn",
      "name": "mimo-v2.5",
      "displayName": "MiMo V2.5（国内 Token 计费）",
      "apiKeyEnvVar": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
      "isDefault": false,
      "capabilities": { "thinking": true, "vision": true }
    }
  ]
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 唯一标识，用于 CRUD 和前端选择 |
| `provider` | string | ✅ | Pi SDK provider 名（deepseek / openai / anthropic / xiaomi / xiaomi-token-plan-cn / openrouter / openai-compatible / mock / …） |
| `name` | string | ✅ | Pi SDK 模型 ID 或自定义模型名 |
| `displayName` | string | ✅ | 前端显示名 |
| `baseUrl` | string | ❌ | 自定义端点 URL（openai-compatible 必填，其他 provider 可选覆盖） |
| `baseUrlEnvVar` | string | ❌ | 从 `.env` 读 baseUrl 的变量名（与 `baseUrl` 二选一） |
| `apiKeyEnvVar` | string | ✅ | 引用 `.env` 中 API key 的变量名 |
| `isDefault` | boolean | ✅ | 是否默认模型（应恰好一条为 true） |
| `capabilities` | object | ✅ | `{ thinking: boolean, vision: boolean }` |

**安全约束**：
- API key 本体只存 `.env`，不进 JSON，不进前端
- 前端只看到 `apiKeyEnvVar`（变量名）和 `apiKeySet: boolean`（是否已配置）
- 已配置 key 脱敏显示末 4 位（如 `sk-***4b8`）

## 4. Sidecar API

### 模型配置 CRUD

| 端点 | 方法 | 说明 |
|------|------|------|
| `/config/models` | GET | 列出所有模型配置（apiKey 脱敏，返回 `apiKeySet` + `apiKeySuffix`） |
| `/config/models` | POST | 添加新模型配置（写入 `model-configs.json`） |
| `/config/models/:id` | PUT | 更新模型配置 |
| `/config/models/:id` | DELETE | 删除模型配置 |

### API Key 管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/config/models/:id/api-key` | PUT | 设置 API key（写入 `.env`，走串行队列） |

### 配置 Reload

| 端点 | 方法 | 说明 |
|------|------|------|
| `/config/reload` | POST | 从文件重新加载 `model-configs.json` + `.env` |

### Provider Catalog 查询

| 端点 | 方法 | 说明 |
|------|------|------|
| `/config/providers/:provider/models` | GET | 列出该 provider 的 Pi SDK catalog 模型（用于前端"添加模型"时选择） |

## 5. 架构变更

### 5.1 ModelRouter 升级

**当前**：只有 `defaultProvider + defaultModel`，从 env 读。

**目标**：从 `model-configs.json` 读注册表，支持按 id 查找、列出所有、获取默认。

```ts
class ModelRouter {
  private registry: Map<string, ModelConfigEntry>;  // id → config
  private defaultId: string;

  resolve(id?: string): ModelConfigEntry;   // 按 id 查，fallback 到 default
  list(): ModelConfigEntry[];               // 列出所有（含 valid/invalid 状态）
  getDefault(): ModelConfigEntry;           // 获取默认
  reload(): Promise<void>;                  // 从文件重新加载
}
```

### 5.2 `getPiProvider()` → 动态 import

**当前**：静态 import `deepseekProvider` + `openaiProvider`，switch-case。

**目标**：动态 `import()` 按需加载，支持任意 Pi SDK provider。

```ts
async function getPiProvider(provider: string): Promise<Provider | undefined> {
  switch (provider) {
    case "deepseek":              return (await import("@earendil-works/pi-ai/providers/deepseek")).deepseekProvider();
    case "openai":                return (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider();
    case "anthropic":             return (await import("@earendil-works/pi-ai/providers/anthropic")).anthropicProvider();
    case "xiaomi":                return (await import("@earendil-works/pi-ai/providers/xiaomi")).xiaomiProvider();
    case "xiaomi-token-plan-cn":  return (await import("@earendil-works/pi-ai/providers/xiaomi-token-plan-cn")).xiaomiTokenPlanCnProvider();
    case "openrouter":            return (await import("@earendil-works/pi-ai/providers/openrouter")).openrouterProvider();
    case "openai-compatible":     return (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider();
    default:                      return undefined;
  }
}
```

### 5.3 `resolveRealModel()` → async + 自定义模型支持

**当前**：同步，从 Pi SDK catalog 查找，找不到就 throw。

**目标**：
1. 变 async（因 `getPiProvider()` 变 async）
2. catalog 模型：从 provider catalog 查找
3. 自定义模型（`openai-compatible` + 自定义 name）：手动构造 `Model<Api>` 对象
4. API key override：返回 `{ model, apiKeyOverride? }` 供 `executeRun()` 透传到 `StreamOptions.apiKey`

```ts
interface ResolvedModel {
  model: Model<Api>;
  /** Per-request API key override (when apiKeyEnvVar differs from provider default) */
  apiKeyOverride?: string;
}

async function resolveRealModel(entry: ModelConfigEntry): Promise<ResolvedModel>
```

### 5.4 `executeRun()` 适配

- `resolveRealModel()` 调用加 `await`
- `AgentLoopConfig` 构建时透传 `apiKeyOverride`（通过 stream options）
- 从 `ModelRouter` 注册表获取当前选中模型的完整配置条目

### 5.5 `.env` 写入队列

```ts
class DotEnvWriter {
  private queue: Promise<void> = Promise.resolve();

  /** 串行写入 .env（追加或更新变量） */
  async setVar(key: string, value: string): Promise<void> {
    this.queue = this.queue.then(() => this._writeVar(key, value));
    return this.queue;
  }

  private async _writeVar(key: string, value: string): Promise<void> {
    // 读 → 改 → 写（原子：写临时文件 → rename）
  }
}
```

### 5.6 配置校验

启动时逐条校验：
- `id` 唯一
- `provider` 可加载（动态 import 不抛错）
- `name` 在 catalog 中存在（catalog 模型时）
- `apiKeyEnvVar` 在 env 中有值 → `apiKeySet: true`
- 恰好一条 `isDefault: true`

无效条目标记 `valid: false, invalidReason: string`，不阻塞启动，日志 warn。

### 5.7 文件 Watch

- `fs.watch` 监听 `model-configs.json` 和 `.env`
- 文件变化时 debounce 500ms 后 reload
- reload 失败时 log error，不 crash
- watch 初始化失败时 log warn，降级为仅手动 reload

## 6. 前端变更

### 6.1 类型定义

`frontend/src/lib/types.ts` 新增：

```ts
export type ModelConfigEntry = {
  id: string;
  provider: string;
  name: string;
  displayName: string;
  baseUrl?: string | null;
  baseUrlEnvVar?: string | null;
  apiKeyEnvVar: string;
  apiKeySet: boolean;
  apiKeySuffix?: string | null;  // 脱敏末 4 位
  isDefault: boolean;
  capabilities: { thinking: boolean; vision: boolean };
  valid: boolean;
  invalidReason?: string | null;
};

export type ProviderCatalogModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
};
```

### 6.2 API 函数

`frontend/src/lib/api.ts` 新增：

```ts
getModelConfigs(): Promise<ModelConfigEntry[]>
addModelConfig(entry: ...): Promise<ModelConfigEntry>
updateModelConfig(id: string, entry: ...): Promise<ModelConfigEntry>
deleteModelConfig(id: string): Promise<void>
setModelApiKey(id: string, apiKey: string): Promise<void>
reloadModelConfigs(): Promise<void>
getProviderCatalogModels(provider: string): Promise<ProviderCatalogModel[]>
```

### 6.3 Agent Sidebar 模型选择器

- 在 thinking level 选择器上方加模型下拉（单选，显示 displayName）
- 选中值存 React state，跨 session 持久化到 localStorage
- 初始值 = `isDefault: true` 的模型
- 发起 run 时传 `runtime_config.model = { provider, name }`
- invalid 模型在下拉中灰显，不可选

### 6.4 设置弹窗

- 导航栏齿轮图标 → 打开 Settings Dialog
- 左侧 tab 栏：当前只有"模型配置"tab
- 模型配置 tab 内容：
  - 已配置模型列表（卡片式），每张卡片显示：displayName、provider、apiKeyEnvVar、apiKeySet 状态、isDefault 标记、valid/invalid 状态
  - 每张卡片操作：编辑、删除、设置 API Key
  - "添加模型"按钮 → 打开添加表单
  - "重新加载配置"按钮（调 reload 端点）
- 添加/编辑表单：
  - Provider 下拉（内置 provider 列表 + "自定义（OpenAI 兼容）"）
  - 选内置 provider → 模型名从 catalog 下拉选，capabilities 自动填充
  - 选"自定义" → 模型名手填 + baseUrl 必填 + capabilities 手选
  - displayName 手填
  - apiKeyEnvVar 手填（默认根据 provider 推荐变量名）
  - isDefault 开关

## 7. 切换流程

```
1. Frontend 启动 → GET /config/models → 获取可用模型列表
2. Agent Sidebar 下拉初始值 = isDefault 模型（或 localStorage 缓存的上次选择）
3. 用户切换模型 → 更新 React state + localStorage
4. 用户点击操作按钮 → runAgentFlow 传 runtime_config.model = { provider, name }
5. Sidecar 收到 run 请求 → 从注册表查配置条目 → 动态 import provider → resolve model → 读 API key → 创建 Pi SDK Model → 调 LLM
```

## 8. 直接编辑文件流程

```
1. 编辑 agent-bridge/model-configs.json 或 .env
2. fs.watch 自动触发 reload（debounce 500ms）
   或 调 POST /config/reload
   或 重启 sidecar
3. 无效条目 warn + 标记 invalid，前端灰显
```

## 9. 关键文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `agent-bridge/model-configs.json` | 新增 | 模型配置文件 |
| `agent-bridge/src/runtime/model-router.ts` | 重构 | 从单默认升级为注册表 |
| `agent-bridge/src/runtime/pi-runtime.ts` | 修改 | resolveRealModel 变 async + 自定义模型 + API key override |
| `agent-bridge/src/server/config.ts` | 修改 | 加 modelConfigsPath 配置 |
| `agent-bridge/src/server/routes/start-run.ts` | 修改 | 从注册表获取模型配置 |
| `agent-bridge/src/server/routes/config-models.ts` | 新增 | /config/models CRUD + /config/reload |
| `agent-bridge/src/server/routes/config-api-key.ts` | 新增 | /config/models/:id/api-key |
| `agent-bridge/src/server/routes/config-providers.ts` | 新增 | /config/providers/:provider/models |
| `agent-bridge/src/config/model-config-store.ts` | 新增 | model-configs.json 读写 + 校验 + reload |
| `agent-bridge/src/config/dotenv-writer.ts` | 新增 | .env 串行写入队列 |
| `agent-bridge/src/config/file-watcher.ts` | 新增 | fs.watch + debounce |
| `agent-bridge/src/types/model-config.ts` | 新增 | ModelConfigEntry 类型定义 |
| `agent-bridge/src/server/app.ts` | 修改 | 注册新路由 + 启动时加载模型配置 |
| `agent-bridge/src/index.ts` | 修改 | 启动时初始化模型配置 + 文件 watch |
| `frontend/src/lib/types.ts` | 修改 | 新增 ModelConfigEntry、ProviderCatalogModel 类型 |
| `frontend/src/lib/api.ts` | 修改 | 新增模型配置 API 函数 |
| `frontend/src/components/project/agent-sidebar.tsx` | 修改 | 加模型选择器下拉 |
| `frontend/src/components/settings/` | 新增目录 | 设置弹窗组件 |
| `frontend/src/components/settings/settings-dialog.tsx` | 新增 | 设置弹窗主组件 |
| `frontend/src/components/settings/model-config-tab.tsx` | 新增 | 模型配置 tab |
| `frontend/src/components/settings/model-config-card.tsx` | 新增 | 模型配置卡片 |
| `frontend/src/components/settings/model-config-form.tsx` | 新增 | 添加/编辑表单 |
| `frontend/src/components/settings/api-key-input.tsx` | 新增 | API Key 设置输入框 |
| `frontend/src/components/ui/` | 可能新增 | 复用 shadcn/ui 组件 |

## 10. 验证计划

1. `cd agent-bridge && npx vitest run` — 全部通过
2. `cd agent-bridge && npx tsc --noEmit` — typecheck 通过
3. `cd frontend && npm run test` — api.test.ts 通过
4. `cd frontend && npm run build` — 构建通过
5. E2E：启动 sidecar + backend
   - GET /config/models 返回预置 4 条
   - 前端 sidebar 模型下拉显示 4 个选项
   - 切换到 mimo-v2.5 → 发起 run → sidecar 动态 import xiaomi provider
   - 添加自定义模型 → POST /config/models → 文件更新
   - 设置 API Key → PUT /config/models/:id/api-key → .env 更新
   - 直接编辑 model-configs.json → fs.watch 触发 reload → 前端刷新列表
   - 无效配置（provider 拼错）→ 启动 warn → 前端灰显
