---
target: "方向卡 (Direction Card)"
total_score: 24
p0_count: 0
p1_count: 2
p2_count: 2
p3_count: 1
date: 2026-06-07
---

# Critique: 方向卡 (Direction Card)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Step guide shows progress; badge shows confirmed/pending |
| 2 | Match System / Real World | 3 | "方向卡" metaphor is domain-specific but explained via tooltip |
| 3 | User Control and Freedom | 2 | Can re-run clarification; but no way to edit card content directly |
| 4 | Consistency and Standards | 3 | Consistent with project vocabulary; badge styles match |
| 5 | Error Prevention | 3 | Clarification must run before confirmation; step guide prevents skipping |
| 6 | Recognition Rather Than Recall | 2 | Step guide requires remembering what each step means |
| 7 | Flexibility and Efficiency | 2 | Single-path workflow; no bulk actions or shortcuts |
| 8 | Aesthetic and Minimalist Design | 3 | Clean two-column layout; MVP boundary color-coding effective |
| 9 | Error Recovery | 2 | Can re-run clarification on failure; no partial save |
| 10 | Help and Documentation | 2 | Info tooltip on title; Agent questions shown contextually |
| **Total** | | **24/40** | **Acceptable** |

## Anti-Patterns Verdict

**LLM assessment**: Avoids most AI tells. Step guide is legitimate onboarding. MVP boundary color-coding is functional. `uppercase tracking-[0.14em]` on "项目进度" and "方向澄清历史" is the banned eyebrow pattern. `break-all` on Chinese text will break mid-character.

**Deterministic scan**: `text-xs font-semibold uppercase tracking-[0.14em]` at `direction-card-panel.tsx:216,226`. `break-all` at `direction-decision-view.tsx:50,125,138,155,169`. Inconsistent font weight hierarchy.

## Priority Issues

- **[P1]** `break-all` on Chinese text causes ugly mid-character breaks — replace with `break-words`
- **[P1]** Uppercase eyebrow text on helper panels — replace with normal-case muted text
- **[P2]** Direction history shows by default even with one entry — only show for 2+ events
- **[P2]** No direct editing of direction card content — add inline edit for key fields
- **[P3]** Step guide "确认方向" step doesn't explain how — add confirmation button or clarify description
