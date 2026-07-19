/**
 * T46-4 (Issue #97 §6) - Evidence-constrained issue clustering.
 *
 * Clusters observations ONLY when they share cause evidence. Two
 * observations with the same symptom but different evidence MUST NOT
 * merge. Clustering never relies on text similarity or LLM embeddings.
 *
 * Boundary invariants (enforced and tested):
 *  - Two observations can merge ONLY when they share at least one
 *    EvidenceRecord.evidenceId OR when their hypotheses' candidate
 *    code surfaces intersect on a direct_component_evidence surface.
 *  - Same symptom text + different evidence => REFUSE merge.
 *  - Different viewers, privacy boundaries, or contract violations
 *    cannot merge even when symptom text matches.
 *  - Every cluster records its members, shared evidence, and refused
 *    merge candidates with a reason.
 *  - Clustering does NOT promote status: the cluster's status is the
 *    highest among members (with unresolved dominating when present),
 *    and the cluster's confidence is the lowest among members.
 */

import type {
  DiagnosisCausalStatus,
  DiagnosisConfidenceLevel,
  DiagnosisRecord,
  IssueCluster,
} from "./diagnosis-contract.js";
import { confidenceAtLeast } from "./diagnosis-contract.js";
import { sha256 } from "./validation.js";

// ---------------------------------------------------------------------------
// §1 Cluster inputs
// ---------------------------------------------------------------------------

/** A diagnosis under consideration for clustering. */
export interface ClusterCandidate {
  diagnosis: DiagnosisRecord;
  /** Viewer (if applicable). Different viewers cannot merge. */
  viewer?: string;
  /** Privacy boundary (if applicable). Different boundaries cannot merge. */
  privacyBoundary?: string;
  /** Contract violation type (if applicable). Different violation types
   *  cannot merge. */
  contractViolationType?: string;
}

// ---------------------------------------------------------------------------
// §2 Shared-evidence predicate - the ONLY merge condition
// ---------------------------------------------------------------------------

/** Return true when two candidates share cause evidence.
 *
 *  Sharing means:
 *   - They share at least one EvidenceRecord.evidenceId (the same
 *     evidence record supports both), OR
 *   - Their hypotheses' candidate code surfaces intersect on a
 *     direct_component_evidence surface (a stronger signal).
 *
 *  Text similarity is NOT considered. */
export function sharesCauseEvidence(
  a: ClusterCandidate,
  b: ClusterCandidate,
): boolean {
  // §1 Hard refusal: different viewers, privacy boundaries, or contract
  // violation types cannot merge even when evidence overlaps.
  if (a.viewer !== b.viewer) return false;
  if (a.privacyBoundary !== b.privacyBoundary) return false;
  if (a.contractViolationType !== b.contractViolationType) return false;

  // §2 Evidence ID intersection.
  const aEvidenceIds = new Set<string>();
  for (const h of a.diagnosis.hypotheses) {
    for (const e of h.supportingEvidence) aEvidenceIds.add(e);
  }
  for (const e of a.diagnosis.evidence) {
    aEvidenceIds.add(e.evidenceId);
  }
  const bEvidenceIds = new Set<string>();
  for (const h of b.diagnosis.hypotheses) {
    for (const e of h.supportingEvidence) bEvidenceIds.add(e);
  }
  for (const e of b.diagnosis.evidence) {
    bEvidenceIds.add(e.evidenceId);
  }
  for (const id of aEvidenceIds) {
    if (bEvidenceIds.has(id)) return true;
  }

  // §3 Direct component evidence surface intersection.
  const aSurfaces = directComponentSurfaces(a.diagnosis);
  const bSurfaces = directComponentSurfaces(b.diagnosis);
  for (const s of aSurfaces) {
    if (bSurfaces.has(s)) return true;
  }

  return false;
}

/** Return the set of direct_component_evidence surface component
 *  paths declared by a diagnosis. */
function directComponentSurfaces(diagnosis: DiagnosisRecord): Set<string> {
  const result = new Set<string>();
  for (const h of diagnosis.hypotheses) {
    for (const s of h.candidateCodeSurfaces) {
      if (s.evidenceLevel === "direct_component_evidence") {
        result.add(s.component);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// §3 Refusal reasons - explain why merge was refused
// ---------------------------------------------------------------------------

/** Return a human-readable reason (Chinese) explaining why two candidates
 *  cannot merge. Returns undefined when they CAN merge. */
export function mergeRefusalReason(
  a: ClusterCandidate,
  b: ClusterCandidate,
): string | undefined {
  if (a.viewer !== b.viewer) {
    const av = a.viewer ?? "<undefined>";
    const bv = b.viewer ?? "<undefined>";
    return "viewer 不同: \"" + av + "\" vs \"" + bv + "\"";
  }
  if (a.privacyBoundary !== b.privacyBoundary) {
    const ap = a.privacyBoundary ?? "<undefined>";
    const bp = b.privacyBoundary ?? "<undefined>";
    return "privacyBoundary 不同: \"" + ap + "\" vs \"" + bp + "\"";
  }
  if (a.contractViolationType !== b.contractViolationType) {
    const ac = a.contractViolationType ?? "<undefined>";
    const bc = b.contractViolationType ?? "<undefined>";
    return "contractViolationType 不同: \"" + ac + "\" vs \"" + bc + "\"";
  }
  if (!sharesCauseEvidence(a, b)) {
    // Check whether they share symptom text but not evidence - this is
    // the classic anti-pattern the clusterer must refuse.
    const sameSymptom = a.diagnosis.observedSymptom === b.diagnosis.observedSymptom;
    if (sameSymptom) {
      return "症状文本相同但证据不共享；禁止仅凭文本相似度合并";
    }
    return "无共享 cause evidence";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// §4 Cluster aggregation
// ---------------------------------------------------------------------------

/** Pick the cluster's causal status: the highest among members, with
 *  unresolved dominating when present. */
function pickClusterStatus(statuses: DiagnosisCausalStatus[]): DiagnosisCausalStatus {
  if (statuses.length === 0) return "unresolved";
  if (statuses.includes("unresolved")) return "unresolved";
  const order: DiagnosisCausalStatus[] = [
    "observed_failure",
    "localized_hypothesis",
    "intervention_supported",
    "fault_injection_confirmed",
  ];
  let best: DiagnosisCausalStatus = "observed_failure";
  for (const s of statuses) {
    if (order.indexOf(s) > order.indexOf(best)) best = s;
  }
  return best;
}

/** Pick the cluster's confidence: the lowest among members. */
function pickClusterConfidence(
  confidences: DiagnosisConfidenceLevel[],
): DiagnosisConfidenceLevel {
  if (confidences.length === 0) return "very_low";
  const order: DiagnosisConfidenceLevel[] = [
    "very_low",
    "low",
    "medium",
    "high",
    "very_high",
  ];
  let lowest: DiagnosisConfidenceLevel = "very_high";
  for (const c of confidences) {
    if (order.indexOf(c) < order.indexOf(lowest)) lowest = c;
  }
  return lowest;
}

// ---------------------------------------------------------------------------
// §5 Shared evidence collection
// ---------------------------------------------------------------------------

/** Collect the evidence IDs shared by all members of a cluster. */
function collectSharedEvidence(
  members: ClusterCandidate[],
): string[] {
  if (members.length === 0) return [];
  const sets = members.map((m) => {
    const ids = new Set<string>();
    for (const h of m.diagnosis.hypotheses) {
      for (const e of h.supportingEvidence) ids.add(e);
    }
    for (const e of m.diagnosis.evidence) ids.add(e.evidenceId);
    return ids;
  });
  const [first, ...rest] = sets;
  if (!first) return [];
  const shared: string[] = [];
  for (const id of first) {
    if (rest.every((s) => s.has(id))) shared.push(id);
  }
  return shared.sort();
}

/** Collect the shared cause summary from members. */
function collectSharedCause(members: ClusterCandidate[]): string {
  // The shared cause is the candidate cause of the highest-status
  // member's top-1 hypothesis. When multiple members have the same
  // status, prefer the one with the most supporting evidence.
  if (members.length === 0) return "";
  const sorted = [...members].sort((a, b) => {
    const sa = statusRank(a.diagnosis.causalStatus);
    const sb = statusRank(b.diagnosis.causalStatus);
    if (sa !== sb) return sb - sa;
    const ea = a.diagnosis.evidence.length;
    const eb = b.diagnosis.evidence.length;
    return eb - ea;
  });
  const top = sorted[0];
  if (!top) return "";
  const top1 = top.diagnosis.hypotheses[0];
  return top1?.candidateCause ?? top.diagnosis.observedSymptom;
}

function statusRank(s: DiagnosisCausalStatus): number {
  const order: DiagnosisCausalStatus[] = [
    "unresolved",
    "observed_failure",
    "localized_hypothesis",
    "intervention_supported",
    "fault_injection_confirmed",
  ];
  return order.indexOf(s);
}

// ---------------------------------------------------------------------------
// §6 Clustering algorithm - deterministic, single pass
// ---------------------------------------------------------------------------

export interface ClusterResult {
  clusters: IssueCluster[];
  /** Candidates that were never merged into any cluster (singletons). */
  singletons: IssueCluster[];
}

/** Cluster candidates by shared cause evidence. Deterministic single-pass
 *  algorithm:
 *   1. Sort candidates by (runId, diagnosisId) for stable order.
 *   2. For each candidate, try to merge it into an existing cluster.
 *      The first cluster that shares cause evidence with it accepts it.
 *   3. If no cluster accepts it, start a new cluster.
 *   4. Record every refused merge with a reason.
 *
 *  This is O(n*k) where k is the number of clusters. It does NOT use
 *  text similarity or LLM embeddings. */
export function clusterObservations(
  candidates: ClusterCandidate[],
  runId: string,
  createdAt?: string,
): ClusterResult {
  if (candidates.length === 0) {
    return { clusters: [], singletons: [] };
  }
  // §1 Stable sort by (runId, diagnosisId).
  const sorted = [...candidates].sort((a, b) => {
    const ra = a.diagnosis.runId;
    const rb = b.diagnosis.runId;
    if (ra !== rb) return ra.localeCompare(rb);
    return a.diagnosis.diagnosisId.localeCompare(b.diagnosis.diagnosisId);
  });

  const clusters: ClusterCandidate[][] = [];
  const clusterRefusals: Array<Array<{
    candidate: ClusterCandidate;
    refusalReason: string;
  }>> = [];

  // §2 Single pass.
  for (const candidate of sorted) {
    let merged = false;
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      if (!cluster) continue;
      // Try to merge with the first member of the cluster (canonical
      // representative). This is deterministic.
      const representative = cluster[0];
      if (!representative) continue;
      const refusal = mergeRefusalReason(representative, candidate);
      if (refusal === undefined) {
        cluster.push(candidate);
        merged = true;
        break;
      } else {
        if (!clusterRefusals[i]) clusterRefusals[i] = [];
        clusterRefusals[i]!.push({ candidate, refusalReason: refusal });
      }
    }
    if (!merged) {
      clusters.push([candidate]);
      clusterRefusals.push([]);
    }
  }

  // §3 Build cluster records.
  const ts = createdAt ?? new Date().toISOString();
  const allClusters: IssueCluster[] = clusters.map((members, i) => {
    const sharedEvidence = collectSharedEvidence(members);
    const sharedCause = collectSharedCause(members);
    const status = pickClusterStatus(members.map((m) => m.diagnosis.causalStatus));
    const confidence = pickClusterConfidence(members.map((m) => m.diagnosis.confidence));
    const clusterId = "cluster-" + sha256(
      runId + "|" + members.map((m) => m.diagnosis.diagnosisId).join(","),
    ).slice(0, 16);
    const refused = (clusterRefusals[i] ?? []).map((r) => ({
      scenarioId: r.candidate.diagnosis.scenarioId,
      observationId: r.candidate.diagnosis.observationId,
      refusalReason: r.refusalReason,
    }));
    return {
      clusterId,
      runId,
      sharedCauseEvidence: sharedEvidence,
      sharedCause,
      members: members.map((m) => ({
        scenarioId: m.diagnosis.scenarioId,
        observationId: m.diagnosis.observationId,
        diagnosisId: m.diagnosis.diagnosisId,
      })),
      refusedMerge: refused,
      createdAt: ts,
      confidence,
      causalStatus: status,
    };
  });

  // §4 Separate clusters with 1 member from clusters with >1 members.
  const realClusters = allClusters.filter((c) => c.members.length > 1);
  const singletons = allClusters.filter((c) => c.members.length === 1);

  return { clusters: realClusters, singletons };
}

// ---------------------------------------------------------------------------
// §7 Cluster validation
// ---------------------------------------------------------------------------

/** Verify cluster invariants. Returns a list of violations (empty = OK). */
export function verifyClusterInvariants(cluster: IssueCluster): string[] {
  const violations: string[] = [];
  if (cluster.members.length === 0) {
    violations.push("cluster " + cluster.clusterId + " 没有成员");
  }
  if (cluster.sharedCauseEvidence.length === 0 && cluster.members.length > 1) {
    violations.push(
      "cluster " + cluster.clusterId + " 有多个成员但无共享 cause evidence；禁止仅凭文本相似度合并",
    );
  }
  // Status must be one of the allowed values.
  const allowedStatuses: DiagnosisCausalStatus[] = [
    "observed_failure",
    "localized_hypothesis",
    "intervention_supported",
    "fault_injection_confirmed",
    "unresolved",
  ];
  if (!allowedStatuses.includes(cluster.causalStatus)) {
    violations.push(
      "cluster " + cluster.clusterId + " causalStatus 非法: " + cluster.causalStatus,
    );
  }
  // Confidence must be one of the allowed values.
  const allowedConfidences: DiagnosisConfidenceLevel[] = [
    "very_low",
    "low",
    "medium",
    "high",
    "very_high",
  ];
  if (!allowedConfidences.includes(cluster.confidence)) {
    violations.push(
      "cluster " + cluster.clusterId + " confidence 非法: " + cluster.confidence,
    );
  }
  return violations;
}

/** Verify that the cluster's confidence is the lowest among its members.
 *  Used by tests to verify the aggregation invariant. */
export function clusterConfidenceIsLowest(
  cluster: IssueCluster,
  memberConfidences: DiagnosisConfidenceLevel[],
): boolean {
  if (memberConfidences.length === 0) return true;
  const lowest = memberConfidences.reduce((min, c) =>
    confidenceAtLeast(min, c) ? c : min,
  );
  return cluster.confidence === lowest;
}
