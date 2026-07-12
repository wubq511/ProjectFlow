"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, PauseCircle, Play, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getRunSnapshot, resumeRun, sendSteering } from "@/lib/api";
import type { RunSnapshot } from "@/lib/api";
import type { WorkStateStatus } from "@/lib/types";
import { WORK_STATE_LABELS } from "@/lib/types";
import { cn } from "@/lib/utils";

interface AgentRunControlsProps {
  runId: string | null;
  connectionStatus?: string | null;
  onCancel?: () => void;
}

const TERMINAL_TRANSPORT = new Set(["completed", "failed", "cancelled"]);

function workStateFromSnapshot(snapshot: RunSnapshot | null): WorkStateStatus | null {
  if (!snapshot) return null;
  const checkpoint = snapshot.latest_checkpoint;
  if (checkpoint && typeof checkpoint === "object") {
    const raw = checkpoint as Record<string, unknown>;
    const workState = (raw.workState ?? raw.work_state) as Record<string, unknown> | undefined;
    if (workState && typeof workState.status === "string") return workState.status as WorkStateStatus;
  }
  for (const event of [...snapshot.recent_events].reverse()) {
    const record = event as Record<string, unknown>;
    if (record.type !== "work_state.changed") continue;
    const payload = record.payload as Record<string, unknown> | undefined;
    if (typeof payload?.status === "string") return payload.status as WorkStateStatus;
  }
  return null;
}

export function AgentRunControls({ runId, connectionStatus, onCancel }: AgentRunControlsProps) {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!runId) return;
    try {
      setSnapshot(await getRunSnapshot(runId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "暂时无法读取运行状态");
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [runId, refresh]);

  const workState = useMemo(() => workStateFromSnapshot(snapshot), [snapshot]);
  const transportStatus = snapshot?.status ?? connectionStatus ?? "";
  const canResume = Boolean(runId && (connectionStatus === "disconnected" || transportStatus === "failed"));
  const isTerminal = TERMINAL_TRANSPORT.has(transportStatus);
  const awaitingUser = workState === "awaiting_user";
  const awaitingApproval = workState === "awaiting_approval";

  const steer = async (type: "constraint" | "plan_change" | "clarification_answer", content: string) => {
    if (!runId || !content.trim()) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await sendSteering(runId, type, content.trim(), crypto.randomUUID());
      setDraft("");
      setMessage(type === "clarification_answer" ? "回答已提交" : "约束已加入当前运行");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败");
    } finally { setBusy(false); }
  };

  const approve = async (approved: boolean) => {
    if (!runId) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await sendSteering(runId, "approval_response", approved ? "approved" : "denied", crypto.randomUUID(), { approved });
      setMessage(approved ? "已批准这次操作" : "已拒绝这次操作");
      if (approved) await resumeRun(runId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "审批失败");
    } finally { setBusy(false); }
  };

  const resume = async () => {
    if (!runId) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await resumeRun(runId);
      setMessage("已从最近检查点恢复");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "恢复失败");
    } finally { setBusy(false); }
  };

  if (!runId) return null;

  return (
    <section className="mb-3 rounded-md border border-neutral-200 bg-white p-3" aria-label="Agent 运行控制">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-neutral-800">当前运行</p>
          <p className="mt-0.5 text-[11px] text-neutral-500" aria-live="polite">
            {workState ? WORK_STATE_LABELS[workState] : "正在同步状态"}
          </p>
        </div>
        {canResume ? (
          <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={busy} onClick={resume}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            恢复运行
          </Button>
        ) : !isTerminal && onCancel ? (
          <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-neutral-500" disabled={busy} onClick={onCancel}>
            <PauseCircle className="h-3.5 w-3.5" />停止运行
          </Button>
        ) : null}
      </div>

      {awaitingApproval ? (
        <div className="mt-3 rounded-md bg-amber-50 p-2.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900">
            <AlertTriangle className="h-3.5 w-3.5" />此操作需要你批准后才能继续
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" className="h-8 gap-1.5" disabled={busy} onClick={() => approve(true)}><Check className="h-3.5 w-3.5" />批准操作</Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={busy} onClick={() => approve(false)}><X className="h-3.5 w-3.5" />拒绝操作</Button>
          </div>
        </div>
      ) : !isTerminal && !canResume ? (
        <div className="mt-3 space-y-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={awaitingUser ? "补充 Agent 需要的信息" : "追加约束或修正当前计划"}
            className="min-h-20 resize-none text-xs"
            maxLength={1000}
            aria-label={awaitingUser ? "回答 Agent" : "追加运行约束"}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="h-8 gap-1.5" disabled={busy || !draft.trim()} onClick={() => steer(awaitingUser ? "clarification_answer" : "constraint", draft)}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {awaitingUser ? "提交回答" : "追加约束"}
            </Button>
            {!awaitingUser && (
              <Button size="sm" variant="outline" className="h-8" disabled={busy || !draft.trim()} onClick={() => steer("plan_change", draft)}>
                调整计划
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {(message || error) && (
        <p className={cn("mt-2 text-[11px]", error ? "text-coral" : "text-moss")} role={error ? "alert" : "status"}>
          {error ?? message}
        </p>
      )}
    </section>
  );
}
