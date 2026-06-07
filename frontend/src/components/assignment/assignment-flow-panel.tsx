"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRightLeft, CheckCircle2, ShieldCheck, UserCheck, XCircle, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
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

function cleanJsonString(text: string) {
  if (!text) return text;
  // Replace raw dictionary strings like {'name': '产品设计', 'level': 3} with just the name
  return text.replace(/\{['"]name['"]:\s*['"]([^'"]+)['"][^}]*\}/g, '$1');
}

function MatchText({ label, text }: { label: string; text: string }) {
  let cleanedText = cleanJsonString(text);
  
  // Strip duplicate label prefix if it exists (e.g., removing "技能匹配：" from "技能匹配：XXX")
  const labelWithoutColon = label.replace(/[：:]$/, '');
  const prefixRegex = new RegExp(`^${labelWithoutColon}[：:]\\s*`);
  if (prefixRegex.test(cleanedText)) {
    cleanedText = cleanedText.replace(prefixRegex, '');
  }

  return (
    <p>
      <span className="font-semibold text-ink/70">{label}</span> {cleanedText}
    </p>
  );
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
  const [expandedProposals, setExpandedProposals] = useState<Record<string, boolean>>({});

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const activeStage = stages.find((stage) => stage.status === "active") ?? stages[0];

  const canRespond = (status: AssignmentProposal["status"]) => status === "proposed";

  const terminalMessages: Partial<Record<AssignmentProposal["status"], string>> = {
    owner_confirmed: "成员已接受，等待负责人最终确认。",
    owner_rejected: "成员已拒绝，需协调。",
    negotiating: "协商中，需处理。",
    finalized: "已定稿，任务负责人已正式写入。",
  };

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

  const confirmedCount = proposals.filter(p => p.status === "owner_confirmed" || p.status === "finalized").length;
  const negotiatingCount = proposals.filter(p => p.status === "owner_rejected" || p.status === "negotiating").length;
  const pendingCount = proposals.filter(p => p.status === "proposed").length;
  const totalCount = proposals.length;

  const toggleExpand = (id: string) => {
    setExpandedProposals(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <section className="rounded-xl border border-ink/10 bg-white shadow-sm overflow-hidden flex flex-col relative">
      {/* Global Status Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/5 p-5 bg-paper/30">
        <div>
          <h2 className="text-lg font-bold text-ink">当前阶段：{totalCount} 个任务待分工</h2>
          <p className="mt-1 text-sm text-ink/60">
            {confirmedCount} 个已确认，{negotiatingCount} 个需协调，{pendingCount} 个待处理
          </p>
        </div>
        {(pendingCount > 0 || negotiatingCount > 0) && (
          <Badge className="bg-citron/40 text-ink">需处理</Badge>
        )}
      </div>

      <div className="p-5 pb-24">
        {proposals.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ink/15 bg-paper/70 p-6 text-sm text-ink/55 text-center">
            暂无分工推荐。请在任务创建后运行分工推荐。
          </div>
        ) : (
          <div className="grid gap-4">
            {proposals.map((proposal) => {
              const task = taskById.get(proposal.task_id);
              const isRejecting = rejectingProposalId === proposal.id;
              const selectedPreferredTask = preferredTaskId ? taskById.get(preferredTaskId) : null;
              const isConfirmed = proposal.status === "owner_confirmed" || proposal.status === "finalized";
              const isNegotiating = proposal.status === "owner_rejected" || proposal.status === "negotiating";
              const isProposed = proposal.status === "proposed";
              const isExpanded = expandedProposals[proposal.id];

              // Find related negotiation
              const relatedNegotiations = negotiations.filter(
                n => n.desired_task_id === proposal.task_id || n.from_user_id === proposal.recommended_owner_user_id
              );

              return (
                <motion.article
                  key={proposal.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                  className={`rounded-lg border transition-colors ${
                    isNegotiating 
                      ? "border-coral/50 bg-coral/5" 
                      : isConfirmed
                        ? "border-ink/5 bg-paper/30 opacity-85"
                        : "border-ink/10 bg-white"
                  }`}
                >
                  {/* Card Header (Always visible) */}
                  <div 
                    className={`flex flex-wrap items-start justify-between gap-3 p-4 ${isConfirmed && !isExpanded ? "cursor-pointer hover:bg-ink/5" : ""}`}
                    onClick={() => isConfirmed && toggleExpand(proposal.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {isConfirmed ? (
                          <CheckCircle2 className="h-4 w-4 text-moss" />
                        ) : isNegotiating ? (
                          <AlertCircle className="h-4 w-4 text-coral" />
                        ) : (
                          <UserCheck className="h-4 w-4 text-harbor" />
                        )}
                        <h3 className={`font-semibold ${isConfirmed ? "text-ink/80" : "text-ink"}`}>
                          {task?.title ?? "未知任务"}
                        </h3>
                        <Badge className={statusClass(proposal.status)}>{statusLabel(proposal.status)}</Badge>
                      </div>
                      
                      {isConfirmed && !isExpanded && (
                        <p className="mt-1 text-sm text-ink/60 flex items-center gap-2">
                          分配给：<span className="font-medium text-ink">{memberName(members, proposal.recommended_owner_user_id)}</span>
                          <span className="text-ink/40 flex items-center text-xs ml-2"><ChevronDown className="w-3 h-3 mr-1"/> 展开详情</span>
                        </p>
                      )}
                    </div>
                    
                    {(!isConfirmed || isExpanded) && (
                      <div className="shrink-0 min-w-32 rounded-lg bg-white/60 p-2.5 text-sm border border-ink/5">
                        <p className="font-semibold text-ink">
                          <span className="text-ink/60 font-normal mr-1">推荐:</span>
                          {memberName(members, proposal.recommended_owner_user_id)}
                        </p>
                        <p className="text-ink/60 mt-0.5 text-xs">
                          备选: {memberName(members, proposal.backup_owner_user_id)}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Card Body (Visible for Proposed/Negotiating, or Expanded Confirmed) */}
                  {(!isConfirmed || isExpanded) && (
                    <div className="px-4 pb-4">
                      {isConfirmed && (
                        <div className="flex justify-end mb-2">
                          <button onClick={() => toggleExpand(proposal.id)} className="text-xs text-ink/50 hover:text-ink flex items-center">
                            <ChevronUp className="w-3 h-3 mr-1" /> 收起
                          </button>
                        </div>
                      )}
                      
                      <div className={isNegotiating ? "opacity-60" : ""}>
                        <p className="text-sm text-ink/75">{cleanJsonString(proposal.reason)}</p>
                        {(proposal.skill_match || proposal.availability_match || proposal.preference_match || proposal.constraint_respected) && (
                          <div className="mt-3 grid gap-1.5 text-xs text-ink/60 bg-paper/50 p-3 rounded-md border border-ink/5">
                            {proposal.skill_match && <MatchText label="技能匹配：" text={proposal.skill_match} />}
                            {proposal.availability_match && <MatchText label="时间匹配：" text={proposal.availability_match} />}
                            {proposal.preference_match && <MatchText label="偏好匹配：" text={proposal.preference_match} />}
                            {proposal.constraint_respected && <MatchText label="限制检查：" text={proposal.constraint_respected} />}
                          </div>
                        )}
                        {proposal.risk_note && (
                          <p className="mt-3 rounded-md bg-coral/10 px-3 py-2 text-xs text-coral border border-coral/20">
                            <AlertCircle className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
                            {proposal.risk_note}
                          </p>
                        )}
                      </div>

                      {/* Negotiation Block */}
                      {isNegotiating && relatedNegotiations.length > 0 && (
                        <div className="mt-4 space-y-3">
                          {relatedNegotiations.map((negotiation) => (
                            <div key={negotiation.id} className="rounded-md bg-white border border-coral/30 p-3 shadow-sm relative">
                              <div className="absolute -top-2 left-4 bg-coral text-white text-[10px] font-bold px-2 py-0.5 rounded">
                                成员拒绝 & 协商
                              </div>
                              <p className="text-sm text-ink/80 mt-2 font-medium">来自 {memberName(members, negotiation.from_user_id)} 的反馈：</p>
                              <p className="text-sm text-ink/70 mt-1 italic">&quot;{negotiation.agent_message}&quot;</p>
                              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                                <Badge variant="outline" className="bg-paper/50 text-ink/60">
                                  偏好接手：{taskById.get(negotiation.desired_task_id)?.title ?? "未知任务"}
                                </Badge>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Actions */}
                      {canRespond(proposal.status) && (
                        <div className="mt-5 flex flex-wrap items-center gap-3 pt-4 border-t border-ink/5">
                          <Button
                            disabled={pending}
                            className="bg-moss text-white hover:bg-moss/85 h-9"
                            onClick={() =>
                              onRespondToAssignment?.(
                                proposal.id,
                                proposal.recommended_owner_user_id,
                                "accept",
                              )
                            }
                          >
                            <CheckCircle2 className="h-4 w-4 mr-1.5" />
                            接受分工
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-9"
                            disabled={pending}
                            onClick={() => setRejectingProposalId(isRejecting ? null : proposal.id)}
                          >
                            <XCircle className="h-4 w-4 mr-1.5" />
                            拒绝并协商
                          </Button>
                        </div>
                      )}

                      {/* Reject Form */}
                      <AnimatePresence>
                        {canRespond(proposal.status) && isRejecting && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.2, ease: "easeOut" }}
                            className="overflow-hidden"
                          >
                            <div className="mt-4 pt-4 border-t border-ink/5 flex flex-col gap-4">
                              <div className="space-y-2">
                                <Label htmlFor={`reason-${proposal.id}`} className="text-xs font-semibold text-ink/70">
                                  补充说明 <span className="text-coral">*</span>
                                </Label>
                                <Textarea
                                  id={`reason-${proposal.id}`}
                                  value={reason}
                                  onChange={(event) => setReason(event.target.value)}
                                  rows={2}
                                  className="resize-none py-2 text-sm bg-white"
                                  placeholder="例如：本周时间不够，或技能不匹配..."
                                />
                              </div>
                              <div className="flex flex-wrap items-end justify-between gap-4">
                                <div className="space-y-2 flex-1 min-w-[200px] max-w-sm">
                                  <Label htmlFor={`preferred-${proposal.id}`} className="text-xs font-semibold text-ink/70">
                                    想换成哪个任务？ (可选)
                                  </Label>
                                  <Select value={preferredTaskId} onValueChange={(v) => setPreferredTaskId(v ?? "")}>
                                    <SelectTrigger id={`preferred-${proposal.id}`} className="h-9 bg-white">
                                      <span data-slot="select-value" className="flex flex-1 text-left text-sm">
                                        {selectedPreferredTask?.title ?? "选择更合适的任务"}
                                      </span>
                                    </SelectTrigger>
                                    <SelectContent>
                                      {tasks.map((task) => (
                                        <SelectItem key={task.id} value={task.id} className="text-sm">
                                          {task.title}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    className="h-9 text-ink/60"
                                    onClick={() => setRejectingProposalId(null)}
                                  >
                                    取消
                                  </Button>
                                  <Button
                                    type="button"
                                    disabled={pending || !reason.trim()}
                                    onClick={() => submitRejection(proposal)}
                                    className="bg-ink text-white hover:bg-ink/85 h-9 min-w-24"
                                  >
                                    提交
                                  </Button>
                                </div>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </motion.article>
              );
            })}
          </div>
        )}
      </div>

      {/* Sticky Global Action Footer */}
      <div className="absolute bottom-0 left-0 right-0 border-t border-blue-200 bg-blue-50/90 backdrop-blur-sm p-4 flex flex-col sm:flex-row items-center justify-between gap-4 z-10 shadow-[0_-4px_20px_-10px_rgba(0,0,0,0.05)]">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-full ${pendingCount === 0 && negotiatingCount === 0 ? "bg-moss/15 text-moss" : "bg-blue-200/50 text-blue-700"}`}>
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-semibold text-blue-950 text-sm">最终分工确认</h3>
            <p className="text-xs text-blue-800/70">
              {pendingCount > 0 || negotiatingCount > 0 
                ? "请先处理所有待定和协商中的分工" 
                : "所有分工已就绪，定稿后正式生效"}
            </p>
          </div>
        </div>
        <Button
          type="button"
          disabled={pending || !activeStage || pendingCount > 0 || negotiatingCount > 0}
          onClick={() => activeStage && onFinalizeAssignments?.(activeStage.id)}
          className={`h-10 px-6 ${pendingCount === 0 && negotiatingCount === 0 ? "bg-moss text-white hover:bg-moss/90" : "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-100 disabled:text-blue-400"}`}
        >
          {pendingCount === 0 && negotiatingCount === 0 ? "确认定稿，正式生效" : "确认当前阶段分工"}
        </Button>
      </div>
    </section>
  );
}
