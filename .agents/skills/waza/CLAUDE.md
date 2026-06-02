# Waza

Personal skill collection for Claude Code. Eight skills covering the complete engineering workflow: think, design, check, hunt, write, learn, read, health.

## Structure

```
skills/
├── RESOLVER.md   -- central trigger → skill routing table
├── check/        -- code review before merging
│   ├── agents/   -- reviewer-security.md, reviewer-architecture.md
│   └── references/  -- persona-catalog.md
├── design/       -- production-grade frontend UI
├── health/       -- Claude Code config audit
│   └── agents/   -- inspector-context.md, inspector-control.md
├── hunt/         -- systematic debugging
├── learn/        -- research to published output
├── read/         -- fetch URL or PDF as Markdown
├── think/        -- design and validate before building
└── write/        -- natural prose in Chinese and English
    └── references/  -- write-zh.md, write-en.md
.claude-plugin/
  marketplace.json    -- plugin registry for npx/plugin distribution
```

Each skill has a `SKILL.md` (loaded on demand by Claude). Supporting content lives in subdirectories. `skills/RESOLVER.md` is the human-readable index of "which trigger goes to which skill"; keep it in sync when you change a skill's scope.

## Skill vs Script: Latent vs Deterministic

Before adding a new capability, decide which layer it belongs in. Waza's eight skills are all **fat skills** (Markdown carrying judgment). Anything that is pure verification, lookup, or table-driven enforcement belongs in `scripts/` or `rules/`, not in a SKILL.md.

| Question | YES → | NO → |
|----------|-------|------|
| Does the user need the model to think, adapt, or ask? | **Skill** | Script / rule |
| Does the same input always produce the same output? | **Script / rule** | Skill |
| Does it depend on the user's project environment? | **Skill** | Script / rule |
| Is it a lookup, list, or status check? | **Script / rule** | Probably skill |
| Does behavior shift with conversation context? | **Skill** | Script / rule |

Examples in this repo:
- `verify-skills.sh` = script (frontmatter / references / version parity, all deterministic)
- `rules/english.md` = rule (applies in every session, no judgment needed)
- `rules/chinese.md` = rule (anti-AI patterns for Chinese output, deterministic)
- `/think`, `/hunt`, `/check` = skills (each reads the situation and decides)
- `/health` diagnostics = skill (tier-aware, context-sensitive)
- Six-layer tier assessment = skill (needs judgment about project size and signals)

Rule of thumb: if you catch yourself writing "if X then Y" enumeration inside a SKILL.md, it probably wants to be a script. If you catch yourself writing "the agent should use good judgment" inside a shell script, that part wants to be a skill.

## Verification

Run `./scripts/verify-skills.sh` before any commit. If the diff is non-trivial, also run `/check`.

## Commit Convention

`{type}: {description}` -- types: feat, fix, refactor, docs, chore

## Release Convention (tw93/Mole style)

- Title: `V{version} {Codename} {emoji}` -- e.g., V3.8.0 Forge 🔨
- Tag: `v{version}` (lowercase v)
- Body: Markdown format, structure as follows:

```
<div align="center">
  <img src="..." width="120" />
  <h1>Waza V{version}</h1>
  <p><em>tagline</em></p>
</div>

### Changelog

1. **SkillName**: One sentence on what changed and its user effect.
2. ...

### 更新日志

1. **技能名**: 一句话说清楚改了什么以及对用户的影响。
2. ...

Update: `npx skills add tw93/Waza@latest` · [Claude Desktop](https://github.com/tw93/Waza/releases/latest/download/waza.zip) · ⭐ [tw93/Waza](https://github.com/tw93/Waza)
```

- Each item: `**Label**: one sentence` -- bold label is the skill or module name, description leads with what changed
- Style: engineer-facing, no marketing language; one-to-one bilingual mapping
- Footer: update command + star + repo link

## Distribution

Two distribution paths coexist:

- **npx**: `npx skills add tw93/Waza` reads `.claude-plugin/marketplace.json`, installs each skill separately
- **Claude Desktop ZIP**: `dist/waza.zip` is built by `scripts/package-skill.sh`, uses root `SKILL.md` as a dispatcher that routes to `skills/X/SKILL.md`

Rebuild with `make package`. CI auto-uploads the ZIP to GitHub releases on each published release.
