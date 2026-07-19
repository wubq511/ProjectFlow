/**
 * T46-3 (Issue #96 §8) — Reliability statistics and reporting.
 *
 * Six metrics with explicit numerator/denominator/excluded/assumptions/
 * sample_size:
 *  - observed_trial_pass_rate: passes / denominator
 *  - empirical_all_k_reliability: (# of trials where all k invocations
 *    passed) / total k-trial groups
 *  - pass_at_k: 1 - ((1 - p)^k) where p is the observed pass rate
 *    (modeled, not empirical)
 *  - modeled_pass_k: same formula but with a Beta prior on p
 *  - all_invariant_pass: # of trials where all hard invariants passed
 *    / denominator
 *  - confidence_interval: Wilson score interval on the observed pass rate
 *
 * These metrics are NOT interchangeable. The report explicitly tags each
 * metric so consumers cannot confuse pass@k with pass^k or single-trial
 * pass rate.
 *
 * demo/smoke presets CANNOT claim statistical significance. When the
 * sample size is below {@link MIN_STATISTICAL_SIGNIFICANCE_SAMPLE_SIZE},
 * the report sets `insufficientEvidence=true` and
 * `statisticalSignificanceClaimAllowed=false`.
 */

import type {
  ReliabilityMetric,
  ReliabilityMetricKind,
  ReliabilityReport,
} from "./contract-v3.js";

/** Minimum sample size to claim statistical significance. */
export const MIN_STATISTICAL_SIGNIFICANCE_SAMPLE_SIZE = 30 as const;

/** Default confidence level for Wilson intervals. */
export const DEFAULT_CONFIDENCE_LEVEL = 0.95 as const;

export interface ReliabilityTrial {
  scenarioId: string;
  /** Whether the trial passed (Agent score denominator only). */
  passed: boolean;
  /** Whether the trial was excluded (simulator_error, infrastructure_error). */
  excluded: boolean;
  /** Whether all hard invariants passed (when a hardGrader was attached). */
  allInvariantsPassed: boolean;
  /** When part of a k-repeat group: the group ID. */
  repeatGroupId?: string;
  /** The pass/fail results of each repeat in this trial's group (when
   *  empirical all-k reliability is being computed). */
  repeatGroupResults?: boolean[];
}

/** Compute the full reliability report for a list of trials. */
export function computeReliabilityReport(
  trials: ReliabilityTrial[],
  options: { preset: "demo" | "smoke" | "smoke-v2" | "full"; confidenceLevel?: number },
): ReliabilityReport {
  const confidenceLevel = options.confidenceLevel ?? DEFAULT_CONFIDENCE_LEVEL;
  const included = trials.filter((t) => !t.excluded);
  const excluded = trials.filter((t) => t.excluded);
  const totalTrials = trials.length;
  const excludedTrials = excluded.length;
  const denominator = included.length;
  const passed = included.filter((t) => t.passed).length;
  const allInvariantPassed = included.filter((t) => t.allInvariantsPassed).length;

  // §1 observed_trial_pass_rate
  const observedTrialPassRate: ReliabilityMetric = {
    kind: "observed_trial_pass_rate",
    value: denominator > 0 ? passed / denominator : null,
    numerator: passed,
    denominator,
    excluded: excludedTrials,
    assumptions: ["每个 trial 是独立同分布的伯努利试验"],
    sampleSize: denominator,
    sufficientEvidence: denominator > 0,
  };

  // §2 empirical_all_k_reliability
  const repeatGroups = groupRepeatGroups(included);
  const empiricalAllK = computeEmpiricalAllK(repeatGroups);

  // §3 pass_at_k (modeled, k=1)
  const passAtK1 = computePassAtK(passed, denominator, 1);

  // §4 modeled_pass_k (Beta prior, k=1)
  const modeledPassK1 = computeModeledPassK(passed, denominator, 1);

  // §5 all_invariant_pass
  const allInvariantPass: ReliabilityMetric = {
    kind: "all_invariant_pass",
    value: denominator > 0 ? allInvariantPassed / denominator : null,
    numerator: allInvariantPassed,
    denominator,
    excluded: excludedTrials,
    assumptions: ["所有声明的 hard invariants 都被检查"],
    sampleSize: denominator,
    sufficientEvidence: denominator > 0,
  };

  // §6 confidence_interval (Wilson score interval on observed pass rate)
  const ci = computeWilsonInterval(passed, denominator, confidenceLevel);

  const metrics: ReliabilityMetric[] = [
    observedTrialPassRate,
    empiricalAllK,
    passAtK1,
    modeledPassK1,
    allInvariantPass,
    ci,
  ];

  const insufficientEvidence = denominator < MIN_STATISTICAL_SIGNIFICANCE_SAMPLE_SIZE;
  const statisticalSignificanceClaimAllowed =
    options.preset === "full" && !insufficientEvidence;

  const perScenario = computePerScenarioMetrics(trials, confidenceLevel);

  return {
    metrics,
    insufficientEvidence,
    statisticalSignificanceClaimAllowed,
    totalTrials,
    excludedTrials,
    perScenario,
  };
}

/** Group trials by repeatGroupId. */
function groupRepeatGroups(trials: ReliabilityTrial[]): ReliabilityTrial[][] {
  const groups = new Map<string, ReliabilityTrial[]>();
  for (const t of trials) {
    if (!t.repeatGroupId) continue;
    const group = groups.get(t.repeatGroupId);
    if (group) {
      group.push(t);
    } else {
      groups.set(t.repeatGroupId, [t]);
    }
  }
  return [...groups.values()];
}

function computeEmpiricalAllK(groups: ReliabilityTrial[][]): ReliabilityMetric {
  if (groups.length === 0) {
    return {
      kind: "empirical_all_k_reliability",
      value: null,
      numerator: 0,
      denominator: 0,
      excluded: 0,
      assumptions: ["trial 必须按 repeatGroupId 分组，每组 k 次重复"],
      sampleSize: 0,
      sufficientEvidence: false,
    };
  }
  const allPassed = groups.filter((g) => g.length > 0 && g.every((t) => t.passed)).length;
  const total = groups.length;
  return {
    kind: "empirical_all_k_reliability",
    value: total > 0 ? allPassed / total : null,
    numerator: allPassed,
    denominator: total,
    excluded: 0,
    assumptions: ["每个 group 内 k 次重复之间独立", "all-k reliability = group 全部通过的比例"],
    sampleSize: total,
    sufficientEvidence: total > 0,
  };
}

function computePassAtK(passed: number, denominator: number, k: number): ReliabilityMetric {
  if (denominator === 0) {
    return {
      kind: "pass_at_k",
      value: null,
      numerator: 0,
      denominator: 0,
      excluded: 0,
      assumptions: [`k=${k}`, "p = 观察通过率", "pass@k = 1 - (1-p)^k"],
      sampleSize: 0,
      sufficientEvidence: false,
      k,
    };
  }
  const p = passed / denominator;
  const value = 1 - Math.pow(1 - p, k);
  return {
    kind: "pass_at_k",
    value,
    numerator: passed,
    denominator,
    excluded: 0,
    assumptions: [`k=${k}`, "p = 观察通过率", "pass@k = 1 - (1-p)^k", "各次尝试独立同分布"],
    sampleSize: denominator,
    sufficientEvidence: denominator > 0,
    k,
  };
}

function computeModeledPassK(passed: number, denominator: number, k: number): ReliabilityMetric {
  // Beta(α=1, β=1) uniform prior; posterior is Beta(1+passed, 1+failed).
  // E[1 - (1-p)^k | data] = 1 - E[(1-p)^k | data].
  // For Beta(a, b), E[(1-p)^k] = Γ(b+k)Γ(a+b) / (Γ(b)Γ(a+b+k)).
  // For integer k, this is ∏_{i=0}^{k-1} (b+i) / (a+b+i).
  if (denominator === 0) {
    return {
      kind: "modeled_pass_k",
      value: null,
      numerator: 0,
      denominator: 0,
      excluded: 0,
      assumptions: [`k=${k}`, "先验: Beta(1,1) 均匀分布", "后验: Beta(1+passed, 1+failed)"],
      sampleSize: 0,
      sufficientEvidence: false,
      k,
    };
  }
  const a = 1 + passed;
  const b = 1 + (denominator - passed);
  let eOneMinusPK = 1;
  for (let i = 0; i < k; i++) {
    eOneMinusPK *= (b + i) / (a + b + i);
  }
  const value = 1 - eOneMinusPK;
  return {
    kind: "modeled_pass_k",
    value,
    numerator: passed,
    denominator,
    excluded: 0,
    assumptions: [
      `k=${k}`,
      "先验: Beta(1,1) 均匀分布",
      "后验: Beta(1+passed, 1+failed)",
      "modeled pass^k = 1 - E[(1-p)^k | data]",
    ],
    sampleSize: denominator,
    sufficientEvidence: denominator > 0,
    k,
  };
}

function computeWilsonInterval(
  passed: number,
  denominator: number,
  confidenceLevel: number,
): ReliabilityMetric {
  if (denominator === 0) {
    return {
      kind: "confidence_interval",
      value: null,
      numerator: 0,
      denominator: 0,
      excluded: 0,
      assumptions: [`confidenceLevel=${confidenceLevel}`, "Wilson score interval"],
      sampleSize: 0,
      sufficientEvidence: false,
      confidenceLevel,
    };
  }
  const p = passed / denominator;
  const n = denominator;
  // z for confidence level (approximate; uses precomputed common values).
  const z = zForConfidenceLevel(confidenceLevel);
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return {
    kind: "confidence_interval",
    value: center,
    numerator: passed,
    denominator,
    excluded: 0,
    assumptions: [
      `confidenceLevel=${confidenceLevel}`,
      "Wilson score interval",
      "近似正态; 小样本下不可信",
    ],
    sampleSize: denominator,
    sufficientEvidence: denominator >= MIN_STATISTICAL_SIGNIFICANCE_SAMPLE_SIZE,
    lowerBound: lower,
    upperBound: upper,
    confidenceLevel,
  };
}

function zForConfidenceLevel(level: number): number {
  // Common levels; default to 1.96 for 0.95.
  if (level >= 0.99) return 2.576;
  if (level >= 0.975) return 2.241;
  if (level >= 0.95) return 1.96;
  if (level >= 0.90) return 1.645;
  if (level >= 0.80) return 1.282;
  return 1.96;
}

function computePerScenarioMetrics(
  trials: ReliabilityTrial[],
  confidenceLevel: number,
): Array<{ scenarioId: string; metrics: ReliabilityMetric[] }> {
  const byScenario = new Map<string, ReliabilityTrial[]>();
  for (const t of trials) {
    const list = byScenario.get(t.scenarioId);
    if (list) {
      list.push(t);
    } else {
      byScenario.set(t.scenarioId, [t]);
    }
  }
  const result: Array<{ scenarioId: string; metrics: ReliabilityMetric[] }> = [];
  for (const [scenarioId, scenarioTrials] of byScenario) {
    const included = scenarioTrials.filter((t) => !t.excluded);
    const excluded = scenarioTrials.filter((t) => t.excluded);
    const passed = included.filter((t) => t.passed).length;
    const denominator = included.length;
    const allInvariantPassed = included.filter((t) => t.allInvariantsPassed).length;
    result.push({
      scenarioId,
      metrics: [
        {
          kind: "observed_trial_pass_rate",
          value: denominator > 0 ? passed / denominator : null,
          numerator: passed,
          denominator,
          excluded: excluded.length,
          assumptions: ["每个 trial 是独立同分布的伯努利试验"],
          sampleSize: denominator,
          sufficientEvidence: denominator > 0,
        },
        {
          kind: "all_invariant_pass",
          value: denominator > 0 ? allInvariantPassed / denominator : null,
          numerator: allInvariantPassed,
          denominator,
          excluded: excluded.length,
          assumptions: ["所有声明的 hard invariants 都被检查"],
          sampleSize: denominator,
          sufficientEvidence: denominator > 0,
        },
        computeWilsonInterval(passed, denominator, confidenceLevel),
      ],
    });
  }
  return result;
}

/** Check whether a metric has sufficient evidence to be reported. */
export function hasSufficientEvidence(metric: ReliabilityMetric): boolean {
  return metric.sufficientEvidence;
}

/** Check whether a report is allowed to claim statistical significance. */
export function canClaimStatisticalSignificance(report: ReliabilityReport): boolean {
  return report.statisticalSignificanceClaimAllowed;
}

/** Check whether a metric is empirical (computed from observed data)
 *  vs modeled (computed from a model assumption). */
export function isEmpiricalMetric(kind: ReliabilityMetricKind): boolean {
  return kind === "observed_trial_pass_rate" || kind === "empirical_all_k_reliability" || kind === "all_invariant_pass";
}

/** Check whether a metric is modeled (relies on distributional assumptions). */
export function isModeledMetric(kind: ReliabilityMetricKind): boolean {
  return kind === "pass_at_k" || kind === "modeled_pass_k" || kind === "confidence_interval";
}

/** Pretty-print a metric for human-readable reports (Chinese). */
export function formatMetric(metric: ReliabilityMetric): string {
  const valueStr = metric.value === null ? "null" : metric.value.toFixed(4);
  const base = `${metric.kind}: ${valueStr} (numerator=${metric.numerator}, denominator=${metric.denominator}, excluded=${metric.excluded}, sampleSize=${metric.sampleSize})`;
  if (metric.kind === "confidence_interval" && metric.lowerBound !== undefined && metric.upperBound !== undefined) {
    return `${base} [${metric.lowerBound.toFixed(4)}, ${metric.upperBound.toFixed(4)}] @ ${(metric.confidenceLevel ?? 0.95).toString()}`;
  }
  if (metric.k !== undefined) {
    return `${base} k=${metric.k}`;
  }
  return base;
}

/** Pretty-print an entire reliability report (Chinese). */
export function formatReliabilityReport(report: ReliabilityReport): string {
  const lines: string[] = [];
  lines.push("=== 可靠性报告 ===");
  lines.push(`总 trials: ${report.totalTrials}`);
  lines.push(`排除 trials: ${report.excludedTrials}`);
  lines.push(`证据不足: ${report.insufficientEvidence ? "是" : "否"}`);
  lines.push(`允许声称统计显著性: ${report.statisticalSignificanceClaimAllowed ? "是" : "否"}`);
  lines.push("");
  lines.push("=== 聚合指标 ===");
  for (const metric of report.metrics) {
    lines.push(formatMetric(metric));
  }
  lines.push("");
  lines.push("=== 每场景指标 ===");
  for (const scenarioMetrics of report.perScenario) {
    lines.push(`场景 ${scenarioMetrics.scenarioId}:`);
    for (const metric of scenarioMetrics.metrics) {
      lines.push(`  ${formatMetric(metric)}`);
    }
  }
  return lines.join("\n");
}