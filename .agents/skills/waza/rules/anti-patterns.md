# Anti-Patterns: Cross-Skill AI Behavior

Always-on behavioral guardrails. These apply regardless of which skill is active. Per-skill gotchas stay in each SKILL.md.

| # | Pattern | Wrong | Right |
|---|---------|-------|-------|
| 1 | Act before reading | Start editing after the first sentence of the request | Read the entire message, then act |
| 2 | Hallucinate paths | Reference `src/components/Auth.tsx` from memory | `grep -r` to confirm the file exists before referencing |
| 3 | Serial interrogation | Ask 5 separate questions across 5 messages | Batch all questions into one message |
| 4 | Scope creep | User asks to fix one bug, refactor the entire file | Touch only what was requested |
| 5 | Confidence without evidence | "This should work" | Run the command, paste the output |
| 6 | Trust stale memory | "We discussed this earlier" | Re-verify the current state before acting |
| 7 | Format overkill | Simple answer wrapped in headers + list + summary | Match response complexity to question complexity |
| 8 | Premature abstraction | Extract a helper after seeing two similar lines | Wait until repetition is proven and stable |
| 9 | Announce instead of act | "I will now proceed to update the file" | Update the file, state what changed |
| 10 | Summarize unsolicited | Append a "changes made" recap after every edit | Stop after the deliverable unless the user asks for a summary |
| 11 | Invent missing data | Fill a gap with plausible-sounding content | Mark the gap and ask the user |
| 12 | Ignore error output | Command fails, continue as if it passed | Read the error, diagnose, fix or report |
| 13 | Unsolicited version bump | Bump version number without being asked | Only bump when the user explicitly requests a release or version change |
| 14 | Create files unprompted | Create new files the user never asked for | Only create files that the user requested or that are required by the task |
| 15 | Additive interpretation | "Fix X" becomes "fix X + refactor Y + add Z" | Do exactly what was asked, nothing more |
