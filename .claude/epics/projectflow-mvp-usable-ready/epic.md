---
name: projectflow-mvp-usable-ready
status: backlog
created: 2026-05-29T13:07:13Z
updated: 2026-05-29T13:11:38Z
progress: 0%
prd: .claude/prds/projectflow-mvp-usable-ready.md
github: https://github.com/wubq511/ProjectFlow/issues/15
---

# Epic: projectflow-mvp-usable-ready

## Overview

This epic moves ProjectFlow from "demo-ready MVP" to "usable MVP." The existing system has the right data model, routes, UI surfaces, seed/reset flow, and fallback Agent workflow. The missing product-quality layer is real LLM operation, explicit Agent status transparency, confirm-to-persist behavior for planning outputs, and real-project verification.

## Architecture Decisions

- Keep the single Coordinator Agent architecture.
- Keep mock mode as a first-class offline/test provider.
- Use OpenAI-compatible chat completions as the real-provider contract.
- Keep all LLM calls in the backend.
- Do not write or modify `.env`; provide `.env.example` and runbook instructions only.
- Add explicit Agent run status to API/UI rather than hiding fallback behind generic success.
- Persist high-impact Agent outputs only through explicit confirmation.

## Technical Approach

### Frontend Components

- Add Agent run status badges and failure/retry states to dashboard Agent actions.
- Add review panels for direction card, stage plan, task breakdown, assignment, risk, and replan outputs.
- Clearly label fallback output and repaired output.
- Add loading copy that reflects context analysis without claiming unsupported work.

### Backend Services

- Harden LLM provider configuration and error mapping.
- Add provider diagnostic endpoint or dry-run service.
- Extend Agent flow responses with user-facing status/error metadata.
- Add confirm endpoints/services for direction card, stage plan, and task breakdown.
- Improve prompt modules and schema validation for real project context.
- Add tests for provider errors, confirm-to-persist behavior, fallback labeling, and real-output schema fixtures.

### Infrastructure

- Add `.env.example` and runbook guidance.
- Keep secrets ignored.
- Preserve deterministic tests using mock provider.

## Implementation Strategy

1. Establish a gap baseline and acceptance checklist.
2. Harden real LLM provider configuration and diagnostics.
3. Implement confirm-to-persist for planning outputs.
4. Improve prompts and output schema behavior for real project state.
5. Make Agent status/fallback transparent in frontend.
6. Validate the end-to-end flow with real provider mode and update docs.

## Cross-Cutting Skill Guidance

各 task 的 Recommended Skills 已写入对应 task 文件。以下是跨 task 的高价值 skill 使用策略：

### Agent 开发核心 Skill（贯穿 #16/#17/#18/#20）

| Skill | 核心价值 | 适用 task |
|-------|----------|-----------|
| `prompt-engineer` | Agent 输出质量直接决定产品可用性，用 RTF/RISEN/RODES 框架结构化 prompt 比随意改写有效得多 | #18, #20 |
| `agentic-eval` | 不只是改 prompt，还要能度量改进效果，evaluator-optimizer 循环是验证 prompt 改进的关键手段 | #18, #20 |
| `instructor` | 用 Instructor 包装 LLM 调用，自动 Pydantic 校验 + 失败重试，比手写 JSON 解析 + 校验更可靠 | #16, #18 |
| `python-backend` | FastAPI + Pydantic + service 模式，后端四个 task 都需要 | #16, #17, #18, #20, #21 |

### 前端 & 动画设计 Skill（#19 核心，#20 辅助）

| Skill | 核心价值 | 适用 task |
|-------|----------|-----------|
| `design-taste-frontend` | 反模板化设计，确保 Agent status 区分度清晰、review 面板布局合理 | #19, #20 |
| `shadcn-ui` | 项目已用 shadcn/ui，构建 status badge、review card、confirm dialog 时直接用 | #19, #20 |
| `nextjs` | 项目已用 Next.js App Router，处理 Agent status 数据流、review panel 页面 | #19 |
| `framer-motion-animator` | 项目已用 Framer Motion，四种 Agent status 切换动画、loading 进度动画 | #19 |
| `high-end-visual-design` | 确保 review 面板设计质感、信息层级清晰 | #19 |

### 流程编排 Skill

| Skill | 核心价值 | 适用 task |
|-------|----------|-----------|
| `workflow-orchestrator` | 多步骤确认流程编排（#17 的 clarification→confirm→persist）和端到端验证流程编排（#21 的 mock + real-provider 双路径） | #17, #21 |

### Skill 调用时机参考

```
1. 读取 task 文件中的 Recommended Skills → 按 table 中的"何时使用"触发
2. 后端 LLM 调用改造 → instructor + python-backend
3. Prompt 改写 → prompt-engineer，改完后用 agentic-eval 评估效果
4. 前端 Agent status UI → design-taste-frontend + shadcn-ui + framer-motion-animator
5. 多步骤确认流程 → workflow-orchestrator
```

## Task Breakdown Preview

- Provider readiness and diagnostics can proceed in parallel with prompt/schema hardening.
- Frontend Agent status work depends on the backend response shape.
- Confirm-to-persist services should land before final end-to-end validation.

## Dependencies

- Existing ProjectFlow MVP on `main`.
- User-provided local LLM credentials for manual real-provider validation.

## Success Criteria (Technical)

- Backend supports `mock`, `openai`, and `openai-compatible` modes with clear diagnostics.
- Agent APIs expose accurate status, attempts, fallback usage, and error messages.
- Clarification, planning, and breakdown outputs can be confirmed into persisted project state.
- UI does not present fallback as successful model intelligence.
- Real-provider manual flow passes from intake through review export.
- Backend tests, frontend tests, lint, build, and audit pass.

## Estimated Effort

- Size: L
- Estimated total: 30-40 hours

## Tasks Created

- [ ] #16 - Real LLM Provider Readiness and Diagnostics (parallel: true)
- [ ] #17 - Agent Output Persistence and Confirmation (parallel: false)
- [ ] #18 - Prompt and Schema Quality Hardening (parallel: true)
- [ ] #19 - Frontend Agent Status and Review UX (parallel: false)
- [ ] #20 - Assignment, Push, Risk, and Replan Usability Pass (parallel: true)
- [ ] #21 - Real-Provider Verification and MVP Usable Runbook (parallel: false)

Total tasks: 6
Parallel tasks: 3
Sequential tasks: 3
Estimated total effort: 36 hours
