# Changelog

All notable changes to ProjectFlow are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] - 2026-07-07

### T42 ProjectMemory V1

- Implemented governed ProjectMemory backend/runtime slices for issues #71-#77: deterministic extraction, source hooks, visibility, retrieval, Agent context injection, evaluation harness, and optional vector guardrails.
- Stabilized ProjectMemory acceptance path in commit `03e7bda`; backend ruff passes and backend test baseline is 514 passed / 4 skipped.
- Added T42 closure review documenting the remaining V1 frontend memory list/export UI gap.

### T41 Agent Runtime Sidecar

- S3: Sidecar 骨架（HTTP server、config、health endpoint）
- S5: Read-only tools（get_project_state、get_workspace_state、timeline slice）路由至统一 internal contract
- S6: Stage Plan Proposal Tool
- S7: Advisory Risk/ActionCard Tool + advisory write tools（create_risk、create_checkin）
- S8: AssignmentProposalTool
- S9: Check-in/replan migration（checkin task updates 走 replan proposals）
- S10: Event bridge + trace envelope + debug payload store
- S11: Frontend integration（advisory write tools + frontend test fixes）
- S12: Legacy Coordinator parity + cutover safety net
- S13: Direction Card + Task Breakdown Proposal Tools
- S14: Skills 系统（6 SKILL.md 文件）
- S15: Unit/Eval/Privacy 测试（559 agent-bridge tests）
- S16: Debug 模式

### Fixed

- Agent 失败事件与完成事件不再共存于同一 run（event-mapper 修正 stopReason 映射）
- Tool result metadata 在 runtime 循环中正确保留
- Advisory write tools 安全加固（harden after review）
- 阻止重复 pending replan proposals
- 移除 unsafe as-any casts，添加 typed WorkspaceState
- S5 read-only tools 路由至统一 internal contract
- S10 audit patch：agent.failed event、run.state_changed auto-gen、state transition validation、ToolManifest alignment

### Docs

- 同步 S5/S9/S10/S12/S13/S15 完成状态至 CLAUDE.md、handoff、code-wiki
- T41 文档对齐 + 参考表

## [0.1.0] - 2026-06-08

### Added

- MVP 闭环跑通（Phase 0-41）
- Next.js 前端 + FastAPI 后端 + SQLite 数据库
- 状态机驱动 Agent 工作流
- 项目仪表盘三栏布局
- Agent sidebar UI
- 安全加固 + 性能优化 + 前端体验打磨
