---
name: project-status
description: 当用户触发"主动推进"时使用。分析项目当前状态，发现风险点，生成行动建议和风险记录。
allowed-tools:
  - get_workspace_state
  - get_timeline_slice
  - list_pending_proposals
  - create_risk
  - create_checkin
references: []
---

# 主动推进

分析项目状态，主动发现问题和机会，生成可操作的输出。

## 触发条件

- 用户点击"主动推进"
- 需要检查项目进度、发现风险、给出下一步建议

## 工作流程

1. 调用 `get_workspace_state` 读取当前工作区完整状态（阶段、任务、成员）
2. 调用 `get_timeline_slice` 读取近期活动
3. 调用 `list_pending_proposals` 检查待处理提案
4. **分析并行动**（必须调用工具，不可只输出文本描述）：
   - 检查每个任务的进度 — 如果有任务长期未更新或已 marked blocked，**必须调用 `create_risk`** 创建风险提醒
   - 检查签到的 blocker — 如果有成员报告阻塞，**必须调用 `create_risk`** 创建对应风险
   - 检查阶段截止日期 — 如果临近且进度滞后，**必须调用 `create_risk`** 创建风险
   - 检查签到周期 — 如果 next_due 已过期，**必须创建风险** 提醒
   - 如果适合创建签到周期，调用 `create_checkin`
   - **禁止**只输出文本分析而不调用工具——用户看不到纯文本，只有工具调用才能落库
5. 每个风险必须有证据（evidence）和理由（reason），引用真实任务名/签到内容/日期

## 输出规范

- 必须在分析后实际调用工具创建记录（不能只生成文本）
- 每个风险必须有证据（evidence）和理由（reason）
- 风险严重程度根据实际情况判断：deadline 临近/有明确阻塞 → high，进度偏慢 → medium
- 只创建确实存在的风险，不编造
- ⚠️ **命名规则**：evidence 和 reason 中引用成员/任务时必须用「」包裹的显示名（如「Mia」报告的阻塞：「最终确定仪表盘流程」），**禁止**出现任何原始 ID
