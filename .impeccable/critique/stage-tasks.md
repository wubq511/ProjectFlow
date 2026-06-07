---
target: "阶段任务 (Stage Plan + Task Breakdown)"
total_score: 24
p0_count: 0
p1_count: 2
p2_count: 2
p3_count: 1
date: 2026-06-07
---

# Critique: 阶段任务 (Stage Plan + Task Breakdown)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Progress bar, status badges, timeline nodes all present |
| 2 | Match System / Real World | 3 | Timeline metaphor natural; task priority/status labels clear |
| 3 | User Control and Freedom | 2 | No drag-to-reorder; no inline status update; no undo |
| 4 | Consistency and Standards | 3 | Consistent badge vocabulary across stages and tasks |
| 5 | Error Prevention | 3 | Pending proposals clearly marked; empty states guide next action |
| 6 | Recognition Rather Than Recall | 3 | Color-coded stage headers, priority badges, status labels visible |
| 7 | Flexibility and Efficiency | 1 | No filtering, sorting, or grouping options; no keyboard shortcuts |
| 8 | Aesthetic and Minimalist Design | 3 | Clean timeline design; task cards compact; no decorative clutter |
| 9 | Error Recovery | 2 | Can re-run breakdown; no inline error states on tasks |
| 10 | Help and Documentation | 1 | No tooltips, no inline help, no explanation of priority levels |
| **Total** | | **24/40** | **Acceptable** |

## Anti-Patterns Verdict

**LLM assessment**: Most polished of the three views. Timeline with connector lines is distinctive, not a generic card grid. Color-coded stage headers create instant scanning. `shadow-sm` on every task card creates uniform visual noise but isn't a banned pattern.

**Deterministic scan**: `shadow-sm` on task cards (`task-breakdown-board.tsx:306`) and section containers. Inconsistent border colors across components. No banned patterns found.

## Priority Issues

- **[P1]** No direct task interaction — add hover action row: status dropdown, assign button, expand
- **[P1]** Pending proposal preview duplicates PendingProposalBanner — keep only top-level banner
- **[P2]** Timeline connector line extends past last stage — calculate height from last non-empty stage
- **[P2]** Task cards lack hover state differentiation — add `hover:border-primary/30`
- **[P3]** Empty stage placeholder too subtle — increase size, add icon, improve contrast
