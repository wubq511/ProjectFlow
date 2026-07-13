import { createHttpPublicSeamRunner, type PublicSeamIdentity } from "../src/evaluation/http-public-seam-runner.js";
import { runModelCanary } from "../src/evaluation/model-conformance.js";
import { selectReleaseScenarios, type ObservationContext } from "../src/evaluation/scenario-eval.js";
import { provisionObservationFixture } from "../src/evaluation/fixture-provisioner.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const repeats = Math.max(1, parseInt(process.env.EVAL_REPEATS ?? "1", 10) || 1);
const scenarios = selectReleaseScenarios(process.env.EVAL_SCENARIO_IDS);

// Provisioner path: EVAL_REPEATS > 1 requires backend provisioning for isolation.
// Static path: EVAL_REPEATS = 1 uses the existing static EVAL_CONVERSATION_ID + EVAL_WORKSPACE_STATE_JSON.
if (repeats > 1 && !process.env.EVAL_BACKEND_BASE_URL?.trim()) {
  throw new Error("EVAL_REPEATS > 1 requires EVAL_BACKEND_BASE_URL for per-observation fixture provisioning");
}

const sidecarBaseUrl = process.env.SIDECAR_BASE_URL ?? "http://localhost:4000";
const ctx: ObservationContext | undefined = repeats > 1 ? { beforeObservation: async () => {} } : undefined;

if (repeats > 1) {
  // Provisioner path: create a mutable identity that gets refreshed before each observation.
  const backendBaseUrl = required("EVAL_BACKEND_BASE_URL");
  const provisionerConfig = {
    backendBaseUrl,
    workspaceId: required("EVAL_WORKSPACE_ID"),
    projectId: required("EVAL_PROJECT_ID"),
    viewerUserId: required("EVAL_VIEWER_USER_ID"),
    adminToken: process.env.EVAL_DEMO_ADMIN_TOKEN?.trim() || undefined,
  };

  // Mutable identity: provisioner replaces it, runner reads it via identityProvider.
  let currentIdentity: PublicSeamIdentity | undefined;

  // The beforeObservation hook provisions a fresh fixture and updates currentIdentity.
  ctx!.beforeObservation = async () => {
    currentIdentity = await provisionObservationFixture(provisionerConfig);
  };

  const runner = createHttpPublicSeamRunner({
    baseUrl: sidecarBaseUrl,
    identityProvider: async () => {
      if (!currentIdentity) throw new Error("Fixture not provisioned: beforeObservation did not run");
      return currentIdentity;
    },
  });

  const report = await runModelCanary(
    required("EVAL_PRIMARY_MODEL"),
    required("EVAL_FALLBACK_MODEL"),
    scenarios,
    runner,
    repeats,
    ctx,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} else {
  // Static path: EVAL_REPEATS = 1, no provisioning needed.
  const workspaceState = JSON.parse(required("EVAL_WORKSPACE_STATE_JSON")) as Record<string, unknown>;
  const runner = createHttpPublicSeamRunner({
    baseUrl: sidecarBaseUrl,
    identity: {
      conversationId: required("EVAL_CONVERSATION_ID"),
      workspaceId: required("EVAL_WORKSPACE_ID"),
      projectId: required("EVAL_PROJECT_ID"),
      viewerUserId: required("EVAL_VIEWER_USER_ID"),
      workspaceState,
    },
  });

  const report = await runModelCanary(
    required("EVAL_PRIMARY_MODEL"),
    required("EVAL_FALLBACK_MODEL"),
    scenarios,
    runner,
    repeats,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
