# ProjectFlow Seed Scenarios

Status: current as of 2026-07-16.

Documents the scenarios embedded in the demo seed data (`backend/app/seed/demo_projectflow.py`, 1456 lines).

## Seed Overview

11 任务 / 8 Agent 事件 / 7 ProjectMemories（全覆盖 7 种 V1 memory_type + subject_and_owner 隐私边界）/ 5 AgentProposal（4 confirmed + 1 rejected）/ 3 AgentConversation（18 messages）/ 1 AssignmentNegotiation / 12 TaskStatusUpdate / 3 AssignmentResponse / 6 CheckIn responses（3 个日期分散）/ 3 Risks / 5 ActionCards。

Timeline aligned to real ProjectFlow development (05-28→07-17)。详细见 `docs/demo-script.md`。

## Scenario 1: Blocker + Availability Change

### Context
ProjectFlow 项目处于"核心实现"阶段（07-05~07-14）。3 个 P0 任务并行：前端框架（小王，due 07-10）、后端 API（小张，due 07-10）、Agent 核心（小赵，due 07-14）。

### Trigger (07-12 check-in → 07-14 detection)
1. 小张在 07-12 check-in 报告 blocker："SQLite 外键约束报错"
2. 小张可用时间从 8h→6h
3. 后端 API 逾期 4 天（due 07-10 → detection 07-14）

### Agent Detection
- **dependency risk** (medium): 后端 API 外键约束问题，逾期 4 天
- **workload risk** (high): 小张可用时间下降 + 后端逾期叠加
- **deadline risk** (medium): 核心实现阶段逾期 2 天，测试窗口仅剩 1 天

### Replan (07-14, confirmed)
- 小林接手后端 API 修复
- 后端 due 07-10→07-16
- 前端先走 mock 数据独立验证

## Scenario 2: Assignment Negotiation (07-06)
- 小王 accept 前端分工后反馈动效耗时偏高
- Agent 建议小刘（design 4 + animation 3）接手动画
- 协商 resolved——展示 Agent 在分工确认后的实时协调能力

## Scenario 3: Scope Expansion Rejection (07-08)
- 有人提议支持多 Agent 架构
- 否决并记录为 proposal_rejected memory（rejection 类型），防止重复讨论

## Conversation Scenarios (3 team conversations, 18 messages)
1. **Agent 与后端边界怎么划** (06-08, 小林): 提案确认模式、sidecar 分离原因、create_risk 权限边界
2. **LLM JSON 输出不稳定怎么兜底** (07-08, 小赵): Pydantic→JSON 修复→fallback 三层 + 超时自动兜底
3. **模型怎么选 & Agent 记不记得我们的决策** (07-14, 小林): Flash Pro 实测差异、记忆引用验证、隐私边界确认
