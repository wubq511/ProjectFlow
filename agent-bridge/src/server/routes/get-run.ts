/**
 * GET /runs/:runId — Get run status.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunContext } from "./utils.js";
import { sendJson } from "./utils.js";

export async function handleGetRun(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  const runId = params.runId ?? "";
  const run = ctx.sessionStore.get(runId);

  if (!run) {
    sendJson(res, 404, { error: "not_found", message: `运行 ${runId} 未找到` });
    return;
  }

  sendJson(res, 200, {
    run_id: run.runId,
    status: run.status,
    current_turn: run.currentTurn,
    current_step: run.currentStep,
    last_event_seq: run.lastEventSeq,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    completed_at: run.completedAt ?? null,
    tool_results: run.toolResults.map((tr) => ({
      tool_name: tr.toolName,
      side_effect_status: tr.sideEffectStatus,
      observation: tr.observation,
      ...(tr.proposalId ? { proposal_id: tr.proposalId } : {}),
      ...(tr.createdIds?.length ? { created_ids: tr.createdIds } : {}),
    })),
  });
}
