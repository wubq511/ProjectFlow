# T41 Agent Runtime Implementation — Member A Handoff (TS Runtime, Skills & Frontend)

## 角色

你是 T41 Agent Runtime 重构的 TypeScript Runtime、Skills 和 Frontend 负责人，负责 sidecar 骨架、read-only tools、assignment proposal tool、Skills 系统、debug 模式和前端集成。

## 总体背景

ProjectFlow 要从固定 CoordinatorAgent 升级为工具化 Agent Runtime。架构：TypeScript Agent Bridge Sidecar + Pi 组件级 Runtime + ProjectFlow Tool Contract + Durable AgentRunState + Proposal-Confirm Commit。

**核心原则：**
- FastAPI/DB 是唯一事实源，sidecar 不直接访问 DB
- LLM-callable tools 不能 commit Primary Project State
- Proposal Confirmation 是当前唯一的人类确认边界
- Read-only tools 不能修复或推进 Stage/Project
- Skills 不能绕过 manifest 的 allowed-tools 约束
- snake_case 作为 canonical wire format

## 关键文档

先读这些：

### 核心设计文档

| # | 文档 | 重点章节 | 参考时机 |
|---|------|----------|----------|
| 1 | `docs/PRD-Agent-Runtime.md` | 完整 PRD | 了解需求全貌 |
| 2 | `docs/T41/ProjectFlow_Agent_Runtime_Team_TDD.md` | §2 推荐架构、§4 架构原则、§5 系统边界 | 架构决策、边界确认 |
| 3 | `docs/T41/ProjectFlow_Agent_Runtime_Foundation_Design.md` | §2 进程边界、§3 Sidecar 模块、§4 Runtime Loop、§6 Model/Provider、§7 Tool Hooks、§10 Event Bridge | S3/S5/S8 实现参考 |
| 4 | `docs/T41/ProjectFlow_Agent_Tools_Skills_Design.md` | §3 Manifest、§4.1-4.3 read-only tools、§4.8 assignment、§9-11 Skills | S5/S8/S14 工具和 Skills 定义 |

### 领域知识

| # | 文档 | 说明 | 参考时机 |
|---|------|------|----------|
| 5 | `CONTEXT.md` | 领域词汇表 | 遇到领域术语时查阅 |

### 架构决策记录 (ADR)

| # | 文档 | 决策 | 参考时机 |
|---|------|------|----------|
| 6 | `docs/adr/0001-agent-runtime-confirmation-boundary.md` | ToolExecutionApproval 是未来扩展，不进入当前 runtime | 边界确认 |
| 7 | `docs/adr/0002-tiered-agent-write-boundary.md` | 四层写入边界：runtime_metadata/reviewable_draft/advisory_write/primary_commit | S5/S8 工具分类 |

### 参考实现

| 资源 | 说明 | 获取方式 | 参考时机 |
|------|------|----------|----------|
| `@earendil-works/pi-ai` | Pi 模型/provider 层 | `npm install @earendil-works/pi-ai` | S3 Model Router |
| `@earendil-works/pi-agent-core` | Pi Agent loop、tool call、hooks | `npm install @earendil-works/pi-agent-core` | S3 Runtime Adapter |
| `vendor_imports/research/agent-runtime/repos/pi/` | Pi 完整源码参考（仅本地） | 本地查看，未推送远程 | S3 实现细节参考 |

## Issue Tracker

- PRD: https://github.com/wubq511/ProjectFlow/issues/45
- 你的 slices: #48 (S3), #50 (S5), #53 (S8), #56 (S11), #59 (S14), #61 (S16)
- Lead (Robert) 的 slices: #46 (S1), #47 (S2), #54 (S9), #55 (S10), #60 (S15)
- Member B 的 slices: #49 (S4), #51 (S6), #52 (S7), #57 (S12), #58 (S13)

## 同步点与依赖关系

### 同步点 1：S5 (Read-only tools) — 你实现，等其他人完成前置

```
Robert: S1 → S2 ──────┐
你: S3 (等 S1) ────────┼→ S5 (你实现) → S8 (你) / S6+S7+S13 (B) / S9 (Robert) / S14 (你) 三线并行
Member B: S4 ──────────┘
```

- **S3 阻塞**：等 Robert 的 S1 (schemas) 完成。
- **S5 阻塞**：等 S1+S2+S3+S4 全部完成。
- **你的动作**：拿到 S1 类型后开始 S3。S3 完成后检查 S2/S4 是否完成。全部完成后开始 S5。
- **合流信号**：S5 完成后，通知 Robert 和 Member B。

### 同步点 2：S11 (Frontend integration) — 等 Robert 的 S10 完成

```
S9 (Robert) → S10 (Robert) → S11 (你)
```

- S11 需要 S10 (event bridge) 完成。
- **你的动作**：S8 完成后如果 S10 还没完成，可以先做 UI 骨架和 mock stream。

### 你的 slices 执行顺序

```
S3 (等 S1) → S5 (等 S1+S2+S3+S4) → S8 ──→ S11 (等 S10)
                                  → S14 ─┘
S16 (等 S3) ──────────────────────────┘
```

- **S3**：等 S1 完成后直接开始
- **S5**：等 S1+S2+S3+S4 全部完成
- **S8**：等 S5 完成后直接开始（不依赖 S6/S7/S9/S13）
- **S14**：等 S5 完成后直接开始（不依赖 S6/S7/S8/S9/S13）
- **S16**：等 S3 完成后直接开始（可与 S5/S8/S14 并行）
- **S11**：等 S10 完成后直接开始

## 你的 Slices（6 条）

### S3: Sidecar skeleton + Pi runtime adapter + mock tool loop → #48

**Blocked by S1 (Robert)。拿到 schemas 后立即开始。**

- 新建 `agent-bridge/` TypeScript 项目，模块结构：runtime/, tools/, skills/, policy/, events/, server/
- 引入 `@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`
- Pi runtime adapter：封装 Agent session + runAgentLoop
  - `beforeToolCall` → policy gate（Foundation Design §7.1）
  - `afterToolCall` → result normalization（Foundation Design §7.2）
  - `StreamFn` 失败 → agent.failed/tool.failed/runtime.error event
  - `transformContext` → Context Builder（不读 DB，只转换 FastAPI 输入为模型上下文）
- Runtime API：POST /runs, POST /runs/{run_id}/cancel, GET /runs/{run_id}, GET /health
- FastAPI client：service-to-service token，不绕过 FastAPI
- Mock provider + mock tools 跑通完整 loop
- Policy engine：read_only→allow, draft_only→allow proposal only, destructive→block
- Event mapper：Pi event → ProjectFlow event
- Budget/timeout/cancel 机制
- **Context Builder**：stable prefix（system instructions, domain rules, tool manifests, skill metadata）+ dynamic suffix（user message, WorkspaceState summary, pending proposals, recent messages, timeline slice, tool observations）。WorkspaceState 压缩为任务相关摘要，不塞完整 DB dump。
- **Model router**：支持多 provider（OpenAI-compatible, OpenRouter, DeepSeek, Anthropic 等），密钥解析在 sidecar 内部完成。

**验收标准：**
- [x] `agent-bridge/` 项目结构创建完成
- [x] Pi runtime adapter 封装完成
- [x] `POST /runs` 跑通完整 mock tool loop
- [x] Cancel/timeout/budget/policy 测试通过
- [x] sidecar 不持有 DB 凭据
- [x] Context Builder 正确组装 stable prefix + dynamic suffix
- [x] Model router 支持多 provider 配置

### S5: Read-only tools → #50

**同步点 1。等 S1+S2+S3+S4 全部完成后开始。**

- 实现 4 个 read-only tools 的 sidecar registration + manifest → Pi tool schema 转换：
  - `get_workspace_state` — POST /internal/agent-tools/workspace-state
  - `get_agent_conversation` — POST /internal/agent-tools/conversation
  - `list_pending_proposals` — POST /internal/agent-tools/pending-proposals
  - `get_timeline_slice` — POST /internal/agent-tools/timeline-slice
- 所有 manifest：risk_category=read_only, effects.effect_type=none, execution.mode=parallel
- read-only batch 允许 parallel execution
- provider parallel tool calls 只在所有暴露工具全是 read-only 且 manifest 允许时开启

**验收标准：**
- [x] 4 个 tools 注册完成，manifest 正确
- [x] sidecar 能通过 FastAPI client 调用这些 endpoints
- [x] read-only 无副作用 contract test 通过
- [x] parallel execution 测试通过

### S8: Typed assignment proposal tool → #53

**Blocked by S5。S5 完成后直接开始。**

- `recommend_assignment` tool：risk_category=draft_only, effects.effect_type=proposal_create
- Internal endpoint POST /internal/agent-tools/assignment-recommendation
- 创建 AssignmentProposal（recommended owner + backup owner + reasons），不写 Task.owner_user_id
- side_effect_status=proposal_persisted, 返回 created_ids
- Idempotency：同 key 不重复创建

**验收标准：**
- [ ] tool manifest 和 endpoint 实现完成
- [ ] 创建 AssignmentProposal 不写 Task.owner_user_id
- [ ] idempotency 测试通过
- [ ] 现有 assignment flow 测试继续通过

### S14: Skills system: skill-index, loader, selector, 6 SKILL.md → #59

**Blocked by S5。与 S8/S16 并行。**

- **skill-index.ts** — 启动时扫描 `agent-bridge/skills/` 目录，加载 frontmatter（name, description, location, allowed-tools），不加载 SKILL.md 正文
- **skill-loader.ts** — 匹配任务后加载 SKILL.md，references 按引用逐个加载
- **Skill selector** — 根据用户消息和 WorkspaceState 匹配 skill（依据 description 中的触发条件）
- **Skill frontmatter schema**：name (max 64 chars), description (max 1024 chars, 描述触发条件), allowed-tools[], references[]
- **6 个 SKILL.md**：
  - project-intake（触发：目标模糊、缺 direction card）
  - project-planning（触发：需阶段计划）
  - task-breakdown（触发：需拆任务）
  - assignment-planning（触发：需分工）
  - risk-replan（触发：阻塞/风险/重新规划）
  - project-status（触发：进展查询）
- **Tests**：metadata 加载、skill 匹配、allowed-tools 约束、references 按需加载

**验收标准：**
- [x] skill-index/loader/selector 实现完成
- [x] 6 个 SKILL.md 编写完成
- [x] skill 匹配测试通过
- [x] allowed-tools 约束测试通过

### S11: Frontend integration → #56

**同步点 2。等 Robert 的 S10 完成后开始。**

- 前端发起 Agent run（调 POST /runs），接收 SSE/WebSocket stream
- 展示 runtime status、token stream、tool timeline
- Proposal：pending proposal 带 confirm/reject action
- Advisory：Risk/ActionCard 展示为 "已记录"，有 dismiss/resolve/done
- AssignmentProposal：展示推荐 owner，支持 response/finalize
- Run state 展示 + cancel 按钮
- Sidecar fallback 路径清晰

**验收标准：**
- [ ] stream 接收和展示
- [ ] proposal confirm/reject
- [ ] advisory dismiss/resolve
- [ ] `../scripts/npm run test` / `lint` / `build` 通过

### S16: Debug raw payload mode → #61

**Blocked by S3。可与 S5/S8/S14 并行。**

- sidecar runtime config 增加 `trace_include_sensitive_data`（默认 false）
- 默认模式：AgentEvent 只含 hash/redacted summary/schema version
- Debug 模式：raw prompt/tool input/output 进入受控存储，单独 retention
- 不进入默认 AgentEvent

**验收标准：**
- [x] `trace_include_sensitive_data` config 实现
- [x] 默认模式 trace 不含 sensitive data
- [x] debug 模式 raw payload 进入受控存储

## 与其他成员的接口

**Lead (Robert) 产出、你消费：**
- S1 schemas → S3 需要类型定义
- S2 append API → S3 sidecar 需要调用此 API
- S10 event bridge → S11 前端需要消费 event stream

**你产出、Lead 消费：**
- S3 sidecar → S10 event bridge 需要 sidecar event stream
- S14 skills → S15 需要测试 skill selection

**你产出、Member B 消费：**
- S5 read-only tools → S6/S7/S13 需要 list_pending_proposals 避免重复 proposal

## 开发环境

```bash
# Sidecar (新建)
cd agent-bridge
npm install   # 或 pnpm install

# Frontend
cd frontend
../scripts/npm install
../scripts/npm run dev

# 测试
cd frontend
../scripts/npm run test
../scripts/npm run lint
../scripts/npm run build
```

## Pi 组件安装与参考

S3/S5/S8/S14 需要使用 Pi 的两个核心包：

### 安装

```bash
cd agent-bridge
npm install @earendil-works/pi-ai @earendil-works/pi-agent-core
```

### 包说明

| 包名 | 用途 | 主要 API |
|------|------|----------|
| `@earendil-works/pi-ai` | 模型/provider 层 | 注册 provider、model catalog、tool schema 转换 |
| `@earendil-works/pi-agent-core` | Agent loop、tool call、hooks、runtime events | `runAgentLoop`、`beforeToolCall`/`afterToolCall` hooks、`StreamFn` |

### 参考资源

- **npm 包源码**：安装后查看 `node_modules/@earendil-works/pi-ai/` 和 `node_modules/@earendil-works/pi-agent-core/`
- **类型定义**：包内包含完整的 TypeScript 类型定义（`.d.ts` 文件）
- **官方文档**：https://pi.dev
- **本地参考**：`vendor_imports/research/agent-runtime/repos/pi/` 有完整源码（仅本地参考，未推送到远程）

### 使用示例

```typescript
// 引入 Pi 组件
import { createProvider } from '@earendil-works/pi-ai';
import { runAgentLoop, type ToolCallHook } from '@earendil-works/pi-agent-core';

// 详见 Foundation Design §6 Model/Provider 和 §7 Tool Execution Hooks
```

### 注意事项

1. **不要把 Pi types 暴露给 FastAPI** — sidecar 内部使用，FastAPI 只接收 ProjectFlow event
2. **密钥解析在 sidecar 内部完成** — 不进入 AgentRunState 或 trace
3. **参考现有实现**：`vendor_imports/research/agent-runtime/repos/pi/packages/agent/src/` 有 agent loop 和 hooks 的参考实现

## 安全约束

- 不发布 npm 包
- 密钥不进代码/commit/日志
- sidecar 不持有 DB 凭据
- Pi types 不暴露给 FastAPI
- Skills 不能绕过 manifest allowed-tools
