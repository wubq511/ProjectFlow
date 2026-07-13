# T44 Post-Implementation Production Canary — 2026-07-13

## Verdict

T44 post-implementation evidence passes the frozen release gates. The final evidence set contains 15 isolated observations per model across answer, status, risk-replan, planning and assignment/privacy scenarios. DeepSeek V4 Flash and Pro both achieved 100% routing, outcome, privacy and latency pass rates.

Flash remains the default. Pro remains an explicit quality-escalation option rather than same-provider outage fallback: it costs more and is slower, while both models satisfy the same deterministic outcome/privacy gates.

## Method

- Public seam: `POST /runs/stream` through the tracked `agent-bridge/scripts/run-agent-canary.ts` runner.
- Isolation: every observation resets and seeds a dedicated temporary SQLite backend, fetches fresh workspace state and creates a new private conversation. Primary/fallback models and all repeats run sequentially.
- Repeats: three per scenario and model.
- Frozen latency gates: answer 30s; status/planning/privacy 90s; risk-replan 120s.
- Privacy: final output checked against actual workspace IDs and UUIDs; raw conversation content is not included in the report.
- Usage semantics: Pi normalizes provider prompt usage into `input` (non-cached input), `cacheRead` and `cacheWrite`. Cache hit rate is `cacheRead / (input + cacheRead + cacheWrite)`; subtracting cache reads from `input` again is incorrect.
- Evidence composition: the first canonical 30-observation run exposed one Pro risk-replan latency outlier. The tool response was then compacted to stop echoing analysis already persisted in AgentEvent, and only risk-replan was rerun for both models (six observations). The final set uses the unchanged 24 observations plus the six post-fix risk-replan observations.

Raw local evidence:

- Full run: `/tmp/projectflow-t44-canonical-RG9fIS/canary-output.json`
- Post-fix risk rerun: `/tmp/projectflow-t44-risk-rerun-hHU7qs/canary-output.json`
- Backend/sidecar logs remain beside each raw report. Dedicated processes were stopped after each run.

An earlier delegated attempt rewrote the runner in temporary Python and was stopped after five partial Flash observations. It is excluded from all evidence and comparison figures; its provider cost was not recoverable.

## Final Composite Results

| Metric | Flash | Pro |
|---|---:|---:|
| Observations | 15 | 15 |
| Routing / outcome / privacy / latency pass rate | 100% / 100% / 100% / 100% | 100% / 100% / 100% / 100% |
| P95 latency | 38.384s | 99.294s |
| Mean latency | 20.971s | 51.449s |
| Non-cached input | 41,802 | 66,880 |
| Output tokens | 31,174 | 45,969 |
| Cache-read tokens | 556,416 | 964,224 |
| Cache-write tokens | 0 | 0 |
| Total prompt tokens | 598,218 | 1,031,104 |
| Cache hit rate | 93.01% | 93.51% |
| Provider cost | $0.0161389648 | $0.0725811420 |
| Mean cost / observation | $0.0010759310 | $0.0048387428 |

All optional usage fields had full 15/15 coverage. DeepSeek/Pi reported reasoning and cache-write as explicit zero, not unavailable.

## Per-Scenario Evidence

### Flash

| Scenario | Pass | Latency mean / median / P95 / stddev | Mean non-cached input | Mean output | Cache hit | Mean cost |
|---|---:|---:|---:|---:|---:|---:|
| answer-no-tool | 3/3 | 8.467 / 9.014 / 9.723 / 1.601s | 414 | 620 | 94.89% | $0.0002531573 |
| status-read | 3/3 | 22.963 / 23.228 / 26.145 / 3.322s | 4,578 | 2,412 | 90.44% | $0.0014376320 |
| risk-proposal | 3/3 | 36.509 / 37.463 / 38.384 / 2.493s | 4,080 | 3,309 | 94.50% | $0.0016938376 |
| planning | 3/3 | 21.023 / 23.494 / 25.814 / 6.396s | 3,695 | 2,264 | 91.41% | $0.0012612488 |
| privacy | 3/3 | 15.894 / 14.412 / 18.933 / 2.632s | 1,167 | 1,786 | 95.56% | $0.0007337792 |

### Pro

| Scenario | Pass | Latency mean / median / P95 / stddev | Mean non-cached input | Mean output | Cache hit | Mean cost |
|---|---:|---:|---:|---:|---:|---:|
| answer-no-tool | 3/3 | 20.562 / 19.677 / 25.521 / 4.581s | 414 | 866 | 94.89% | $0.0009613500 |
| status-read | 3/3 | 54.223 / 54.305 / 54.764 / 0.586s | 6,088 | 3,072 | 88.03% | $0.0054833103 |
| risk-proposal | 3/3 | 88.730 / 85.558 / 99.294 / 9.389s | 5,301 | 6,622 | 95.73% | $0.0085847443 |
| planning | 3/3 | 48.120 / 47.298 / 51.512 / 3.064s | 6,379 | 2,309 | 93.10% | $0.0050950680 |
| privacy | 3/3 | 45.611 / 46.551 / 58.318 / 13.202s | 4,112 | 2,454 | 90.71% | $0.0040692413 |

## Before / After Interpretation

The accepted pre-T44 baseline contains one observation per scenario, while the post-T44 set has three. Raw totals are therefore not directly comparable; per-observation figures are used.

| Metric | Flash pre → post | Pro pre → post |
|---|---:|---:|
| Mean non-cached input / observation | 18,794 → 2,787 (-85.2%) | 19,513 → 4,459 (-77.2%) |
| Mean cost / observation | $0.00341294 → $0.00107593 (-68.5%) | $0.01174582 → $0.00483874 (-58.8%) |
| Mean output / observation | 2,072 → 2,078 (+0.3%) | 2,977 → 3,065 (+2.9%) |
| Cross-scenario P95 latency | 32.655 → 38.384s (+17.5%) | 92.711 → 99.294s (+7.1%) |

Outcome and privacy remain at 100%. Non-cached input and normalized cost improved materially without reducing output volume. Cross-scenario P95 latency did not improve; the repeated post-T44 sample is stricter and still stays inside every frozen per-scenario gate.

The first post-T44 Pro risk-replan sample had one 141.206s outlier. Removing duplicated persisted analysis from the tool response reduced Pro risk-replan mean latency from 110.611s to 88.730s (-19.8%), P95 from 141.206s to 99.294s (-29.7%), mean non-cached input from 7,735 to 5,301 (-31.5%) and mean cost from $0.00992461 to $0.00858474 (-13.5%).

Canonical paid measurement cost was $0.1242190356: $0.0933832898 for the full run and $0.0308357458 for the targeted rerun. This is measurement spend, not the final composite cost. The excluded delegated partial run adds an unknown amount.

## Remaining Boundaries

- Keep Flash as default; do not infer an automatic routing/failover policy from same-provider comparisons.
- Pro still costs about 4.5x Flash per observation and should remain explicit escalation.
- One post-fix Pro risk observation paged a large `get_workspace_state` result. It stayed below the latency gate; compact read views are a future optimization, not a release blocker.
- Free-text member-constraint evidence remains completeness-only. Semantic enforcement still requires a structured constraint model.
