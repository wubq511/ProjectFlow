"""Demo blocker/availability-change scenario for risk and replan demonstration.

This module documents the scenario used in the demo to trigger risk detection
and replanning. It does NOT create additional data — the scenario is already
embedded in the main seed data (demo_projectflow.py).

Scenario summary:
- 小张 reports a blocker on backend API (SQLite foreign key constraint error)
- 小张's available hours drop from 8 to 6 per week
- backend API task (due 07-10) is 4 days overdue when detected on 07-14
- This triggers: dependency risk, workload risk, deadline risk
- Agent recommends: 小林 takes over backend API, 小张 shifts to data model,
  frontend proceeds with mock data independently
- Mid-phase replan confirmed: backend API due extended to 07-16,
  testing phase (07-16~07-17) non-negotiable
"""

# This file is intentionally minimal — the actual scenario data lives in
# demo_projectflow.py. This module exists to:
# 1. Satisfy the TECH-DESIGN directory structure
# 2. Provide a place to add more scenarios later
# 3. Be importable for documentation generation

SCENARIO_DESCRIPTION = """
## Blocker + Availability Change + Overdue Scenario

### Setup
- ProjectFlow 项目处于"核心实现"阶段（07-06~07-15）
- 3 个 P0 任务并行：前端 Shell、后端 API、Agent 核心
- 分工已 finalized：小王(前端)、小张(后端)、小赵(Agent)
- 后端 API 原定 due 07-10，前端 Shell due 07-10，Agent 核心 due 07-14

### Trigger (07-14 签到)
1. 小张在 check-in 中报告 blocker："SQLite 外键约束报错，还在排查"
2. 小张可用时间从 8 小时/周降至 6 小时/周
3. 后端 API 任务已逾期 4 天（due 07-10 → detection 07-14）

### Agent Detection
- **dependency risk** (medium): 后端 API blocker 阻塞前端联调 & 任务逾期
- **workload risk** (high): 小张时间不足 + 后端 API 逾期，两项叠加
- **deadline risk** (medium): 核心实现阶段仅剩 1 天，测试窗口不可压缩

### Agent Recommendation (07-14 replan, confirmed)
- 小林（后端技能 4 级）接手后端 API 外键修复
- 小张转为辅助，专注数据模型一致性和测试用例
- 后端 API due 从 07-10 推迟至 07-16
- 前端先走 mock 数据独立验证，不等后端阻塞解除
- 测试阶段 07-16 启动不可推迟
- 重排方案已确认并写入 ProjectMemory (plan + tradeoff types)

### Expected Demo Flow
1. 展示 check-in 结果（含 blocker + 逾期数据）
2. 展示 Task 列表（后端 API 标注"已逾期"）
3. 运行 risk analysis → 显示 3 个风险卡（含逾期证据）
4. 展示重排前后的 timeline 差异
5. 展示 Agent Timeline（7 个事件：含 replan + rejected proposal）
6. 展示 ProjectMemory（7 条：含 rejection + member_constraint 隐私边界）
7. 展示历史会话（Agent 引用记忆给出答辩建议）
8. 导出评审摘要
"""
