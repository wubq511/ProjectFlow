---
name: waza
description: 'Engineering skills for Codex: think (architecture), design (UI), check (code review), hunt (debugging), write (prose), learn (research), read (URL/PDF fetch), health (config audit). Triggers on slash commands or intent.'
---

# Waza: Engineering Skills Dispatcher

Prefix your first line with 🥷 inline, not as its own paragraph.

You have eight skills available. Match the user's intent to the right skill, read its SKILL.md, and execute it.

## Routing Table

| Intent | Skill | File |
|--------|-------|------|
| New feature, architecture, "how should I design this", value judgment | think | `skills/think/SKILL.md` |
| UI, component, page, visual interface, frontend | design | `skills/design/SKILL.md` |
| Code review, before merge, "review this", triage issues/PRs | check | `skills/check/SKILL.md` |
| Error, crash, test failure, unexpected behavior, "why broken" | hunt | `skills/hunt/SKILL.md` |
| Writing, editing prose, polish, remove AI tone | write | `skills/write/SKILL.md` |
| Deep research, unfamiliar domain, compile sources into output | learn | `skills/learn/SKILL.md` |
| Any URL or PDF in the message, "read this", "summarize this link" | read | `skills/read/SKILL.md` |
| Codex ignoring instructions, config audit, hooks/MCP broken | health | `skills/health/SKILL.md` |

## How This Works

1. Read the user's message and match it to a skill from the table above.
2. Read the matched file from the routing table in full.
3. Execute that skill's instructions exactly.

If the message could match multiple skills, use these disambiguation rules:

1. Most specific wins: `/design` is more specific than `/think` for UI decisions.
2. URL in message: start with `/read`. If the content is research material, chain to `/learn`.
3. Code already done vs. code broken: done/PR -> `/check`; error/broken -> `/hunt`.
4. Config vs. code: Codex misbehaving/hooks/MCP -> `/health`; user code errors -> `/hunt`.
5. From scratch vs. editing: new long-form output -> `/learn`; existing draft to polish -> `/write`.
6. "Judge this" + error -> `/hunt`; "judge this" + should we keep it -> `/think`.
7. Still ambiguous: read both skills' "Not for" sections; use exclusion. If still unclear, ask the user.

## Path Resolution

In this distribution, sub-skill scripts live at `skills/{name}/scripts/`. Resolve all relative paths from this file's directory, not from `$HOME/.agents/`.

## Chaining

Skills chain manually, not automatically. Each skill completes and waits for the user's next action.

Common chains: `/think` -> implement -> `/check` | `/read` -> `/learn` -> `/write` | `/hunt` -> fix -> `/check`
