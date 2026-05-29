"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRightLeft, CheckCircle2, ShieldCheck, UserCheck, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  AssignmentNegotiation,
  AssignmentProposal,
  Stage,
  Task,
  User,
} from "@/lib/types";

type AssignmentFlowPanelProps = {
  proposals: AssignmentProposal[];
  negotiations: AssignmentNegotiation[];
  stages: Stage[];
  tasks: Task[];
  members: User[];
  pending?: boolean;
  onRespondToAssignment?: (
    proposalId: string,
    userId: string,
    response: "accept" | "reject",
    preferredTaskId?: string,
    reason?: string,
  ) => void | Promise<void>;
  onStartNegotiation?: (
    proposalId: string,
    fromUserId: string,
    desiredTaskId: string,
  ) => void | Promise<void>;
  onFinalizeAssignments?: (stageId: string) => void | Promise<void>;
};

function memberName(members: User[], userId?: string | null) {
  if (!userId) return "未分配";
  return members.find((member) => member.user_id === userId)?.display_name ?? userId;
}

function statusLabel(status: AssignmentProposal["status"]) {
  const labels: Record<AssignmentProposal["status"], string> = {
    proposed: "待确认",
    owner_confirmed: "已确认",
    owner_rejected: "已拒绝",
    negotiating: "协商中",
    finalized: "已定稿",
  };
  return labels[status] ?? status;
}

function statusClass(status: AssignmentProposal["status"]) {
  if (status === "finalized") return "bg-moss/15 text-moss";
  if (status === "owner_rejected") return "bg-coral/15 text-coral";
  if (status === "negotiating") return "bg-citron/40 text-ink";
  if (status === "owner_confirmed") return "bg-harbor/15 text-harbor";
  return "bg-white text-ink/60";
}

export function AssignmentFlowPanel({
  proposals,
  negotiations,
  stages,
  tasks,
  members,
  pending,
  onRespondToAssignment,
  onStartNegotiation,
  onFinalizeAssignments,
}: AssignmentFlowPanelProps) {
  const [rejectingProposalId, setRejectingProposalId] = useState<string | null>(null);
  const [preferredTaskId, setPreferredTaskId] = useState("");
  const [reason, setReason] = useState("");

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const activeStage = stages.find((stage) => stage.status === "active") ?? stages[0];
  const firstNegotiation = negotiations[0];

  const submitRejection = async (proposal: AssignmentProposal) => {
    await onRespondToAssignment?.(
      proposal.id,
      proposal.recommended_owner_user_id,
      "reject",
      preferredTaskId || undefined,
      reason.trim() || undefined,
    );
    if (preferredTaskId) {
      await onStartNegotiation?.(proposal.id, proposal.recommended_owner_user_id, preferredTaskId);
    }
    setRejectingProposalId(null);
    setPreferredTaskId("");
    setReason("");
  };

  return (
    <section className="rounded-lg border border-ink/10 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">分工流程</h2>
          <p className="mt-1 text-sm text-ink/60">
            推荐分工在成员响应和负责人确认前保持待定状态
          </p>
        </div>
        <Badge className="bg-citron/40 text-ink">需确认</Badge>
      </div>

      {proposals.length === 0 ? (
        <div className="mt-5 rounded-lg border border-dashed border-ink/15 bg-paper/70 p-6 text-sm text-ink/55">
          暂无分工推荐。请在任务创建后运行分工推荐。
        </div>
      ) : (
        <div className="mt-5 grid gap-3">
          {proposals.map((proposal) => {
            const task = taskById.get(proposal.task_id);
            const isRejecting = rejectingProposalId === proposal.id;
            return (
              <motion.article
                key={proposal.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className="rounded-lg border border-ink/10 bg-paper/60 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <UserCheck className="h-4 w-4 text-moss" />
                      <h3 className="font-semibold text-ink">{task?.title ?? "未知任务"}</h3>
                      <Badge className={statusClass(proposal.status)}>{statusLabel(proposal.status)}</Badge>
                    </div>
                    <p className="mt-2 text-sm text-ink/70">{proposal.reason}</p>
                    {proposal.risk_note && (
                      <p className="mt-2 rounded-md bg-coral/10 px-3 py-2 text-xs text-coral">{proposal.risk_note}</p>
                    )}
                  </div>
                  <div className="min-w-40 rounded-lg bg-white p-3 text-sm">
                    <p className="font-semibold text-ink">负责人: {memberName(members, proposal.recommended_owner_user_id)}</p>
                    <p className="mt-1 text-ink/60">备选: {memberName(members, proposal.backup_owner_user_id)}</p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    disabled={pending}
                    className="bg-moss text-white hover:bg-moss/85"
                    onClick={() =>
                      onRespondToAssignment?.(
                        proposal.id,
                        proposal.recommended_owner_user_id,
                        "accept",
                      )
                    }
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    接受分工
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => setRejectingProposalId(isRejecting ? null : proposal.id)}
                  >
                    <XCircle className="h-4 w-4" />
                    拒绝分工
                  </Button>
                </div>

                <AnimatePresence>
                  {isRejecting && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                      className="overflow-hidden"
                    >
                      <div className="mt-4 grid gap-3 rounded-lg border border-ink/10 bg-white p-4 md:grid-cols-[220px_1fr_auto] md:items-end">
                        <div className="space-y-2">
                          <Label htmlFor={`preferred-${proposal.id}`}>偏好任务</Label>
                          <Select value={preferredTaskId} onValueChange={(v) => setPreferredTaskId(v ?? "")}>
                            <SelectTrigger id={`preferred-${proposal.id}`}>
                              <SelectValue placeholder="选择任务" />
                            </SelectTrigger>
                            <SelectContent>
                              {tasks.map((task) => (
                                <SelectItem key={task.id} value={task.id}>
                                  {task.title}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor={`reason-${proposal.id}`}>原因</Label>
                          <Textarea
                            id={`reason-${proposal.id}`}
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                            rows={2}
                            placeholder="说明限制或更合适的理由"
                          />
                        </div>
                        <Button
                          type="button"
                          disabled={pending || !reason.trim()}
                          onClick={() => submitRejection(proposal)}
                          className="bg-ink text-white hover:bg-ink/85"
                        >
                          提交拒绝
                        </Button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.article>
            );
          })}
        </div>
      )}

      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-ink/10 bg-paper/70 p-4">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4 text-harbor" />
            <h3 className="font-semibold text-ink">协商面板</h3>
          </div>
          {firstNegotiation ? (
            <div className="mt-3 rounded-md bg-white p-3">
              <p className="text-sm text-ink/75">{firstNegotiation.agent_message}</p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-ink/55">
                <Badge variant="outline">来自 {memberName(members, firstNegotiation.from_user_id)}</Badge>
                <Badge variant="outline">状态 {firstNegotiation.status}</Badge>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-ink/50">暂无交换提议。</p>
          )}
        </div>

        <div className="rounded-lg border border-ink/10 bg-ink p-4 text-white">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-citron" />
            <h3 className="font-semibold">最终分工确认</h3>
          </div>
          <p className="mt-3 text-sm text-white/78">负责人仅在最终确认后生效。</p>
          <p className="mt-1 text-xs text-white/55">
            推荐分工供审阅，定稿后由负责人确认生效。
          </p>
          <Button
            type="button"
            disabled={pending || !activeStage}
            onClick={() => activeStage && onFinalizeAssignments?.(activeStage.id)}
            className="mt-4 bg-citron text-ink hover:bg-citron/90"
          >
            确认当前阶段分工
          </Button>
        </div>
      </div>
    </section>
  );
}
