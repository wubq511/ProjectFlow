"use client";

import { CheckCircle, ChevronDown, ChevronUp, Loader2, Sparkles, XCircle } from "lucide-react";
import { useState } from "react";
import { useInlineConfirm } from "@/lib/use-inline-confirm";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DirectionDecisionView } from "@/components/agent/direction-decision-view";
import type { AgentProposal, AgentEvent } from "@/lib/types";
import { MultilineText } from "@/components/ui/multiline-text";
import { translateStatus } from "@/lib/utils";

const TYPE_LABELS: Record<string, string> = {
  clarify: "方向卡",
  plan: "阶段计划",
  breakdown: "任务分解",
  replan: "计划调整",
};

const TYPE_DESCRIPTIONS: Record<string, string> = {
  clarify: "Agent 分析了项目信息，生成了方向建议",
  plan: "Agent 根据方向卡规划了项目阶段",
  breakdown: "Agent 将阶段拆解为具体任务",
  replan: "Agent 根据签到和风险信号生成了计划调整建议",
};

const STATUS_LABELS: Record<string, string> = {
  success: "成功",
  repaired: "已修复",
  fallback: "基础建议",
  failed: "失败",
};

const STATUS_CLASSES: Record<string, string> = {
  success: "bg-moss/15 text-moss",
  repaired: "bg-citron/40 text-ink",
  fallback: "bg-harbor/15 text-harbor",
  failed: "bg-coral/15 text-coral",
};

const REPLAN_LABELS: Record<string, string> = {
  before: "调整前",
  after: "调整后",
  impact: "影响",
  reason: "原因",
  requires_confirmation: "需要确认",
  stage_adjustments: "阶段调整",
  task_changes: "任务变更",
  action_cards: "新行动卡",
  task: "任务",
  title: "标题",
  status: "状态",
  due_date: "截止日期",
  priority: "优先级",
  type: "类型",
  content: "内容",
  goal: "目标",
  description: "描述",
  deliverable: "交付物",
  name: "名称",
  summary: "摘要",
  new_start_date: "新开始日期",
  new_end_date: "新结束日期",
  estimated_hours: "预估工时",
  can_cut: "可砍",
  // LLM-generated dynamic fields
  stages: "阶段",
  deadline: "截止日期",
  end_date: "结束日期",
  start_date: "开始日期",
  risks: "风险",
  risks_mitigated: "已缓解风险",
  issues: "问题点",
  actions: "应对措施",
  mitigation: "缓解方案",
  evidence_refs: "",
  // Suppressed fields
  stage_id: "",
  task_id: "",
  owner_user_id: "",
  user_id: "",
  backup_owner_user_id: "",
  blocker: "阻塞",
};

function replanLabel(key: string) {
  const label = REPLAN_LABELS[key];
  if (label === "") return "";
  if (label !== undefined) return label;
  return key.replace(/_/g, " ");
}

function replanValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "object" && item !== null) {
        return Object.entries(item as Record<string, unknown>)
          .map(([k, v]) => { const l = replanLabel(k); return l ? `${l}: ${replanValue(v)}` : ""; })
          .filter(Boolean).join("、");
      }
      return String(item);
    }).join("；");
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .filter(([, itemValue]) => itemValue !== null && itemValue !== undefined)
      .map(([key, itemValue]) => {
        const label = replanLabel(key);
        if (!label) return null;
        return `${label}: ${replanValue(itemValue)}`;
      })
      .filter(Boolean)
      .join(" | ");
  }
  return translateStatus(String(value));
}

function ReplanField({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
    return null;
  }
  return (
    <div className="rounded-md border border-ink/8 bg-paper px-3 py-2">
      <p className="text-xs font-semibold tracking-wider text-ink/40">{label}</p>
      <MultilineText text={replanValue(value)} className="mt-1 text-sm text-ink/70" />
    </div>
  );
}

function ProposalContent({ proposal }: { proposal: AgentProposal }) {
  const payload = proposal.payload;

  if (proposal.proposal_type === "clarify") {
    const p = payload as {
      problem?: string;
      users?: string;
      value?: string;
      deliverables?: string[];
      boundaries?: string[];
      risks?: string[];
      suggested_questions?: string[];
      reason?: string;
    };
    return (
      <DirectionDecisionView content={p} compact />
    );
  }

  if (proposal.proposal_type === "plan") {
    const p = payload as {
      stages?: Array<{
        name?: string;
        goal?: string;
        start_date?: string;
        end_date?: string;
        deliverable?: string;
        order_index?: number;
      }>;
      reason?: string;
    };
    return (
      <div className="space-y-3 text-sm">
        {p.reason && <MultilineText text={p.reason} className="text-ink/60" />}
        {p.stages && p.stages.length > 0 && (
          <div>
            <p className="font-semibold text-ink">阶段列表（{p.stages.length} 个阶段）</p>
            <div className="mt-2 space-y-2">
              {p.stages.map((s, i) => (
                <div key={i} className="rounded-md border border-ink/8 bg-paper p-3">
                  <div className="flex items-center gap-2">
                    <Badge className="bg-ink/10 text-ink/60 text-[10px]">#{s.order_index ?? i + 1}</Badge>
                    <span className="font-semibold text-ink">{s.name}</span>
                  </div>
                  {s.goal && <MultilineText text={s.goal} className="mt-1 text-ink/70" />}
                  {s.start_date && s.end_date && (
                    <p className="mt-1 text-xs text-ink/45">{s.start_date} → {s.end_date}</p>
                  )}
                  {s.deliverable && (
                    <div className="mt-1 text-xs text-ink/55">
                      交付: <MultilineText text={s.deliverable} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (proposal.proposal_type === "breakdown") {
    const p = payload as {
      tasks?: Array<{
        title?: string;
        description?: string;
        priority?: string;
        estimated_hours?: number;
        stage_id?: string;
      }>;
      reason?: string;
    };
    return (
      <div className="space-y-3 text-sm">
        {p.reason && <MultilineText text={p.reason} className="text-ink/60" />}
        {p.tasks && p.tasks.length > 0 && (
          <div>
            <p className="font-semibold text-ink">任务列表（{p.tasks.length} 个任务）</p>
            <div className="mt-2 space-y-2">
              {p.tasks.map((t, i) => (
                <div key={i} className="rounded-md border border-ink/8 bg-paper p-3">
                  <div className="flex items-center gap-2">
                    <Badge className={
                      t.priority === "P0" ? "bg-coral/15 text-coral text-[10px]" :
                      t.priority === "P1" ? "bg-amber/15 text-amber text-[10px]" :
                      "bg-ink/10 text-ink/50 text-[10px]"
                    }>
                      {t.priority ?? "P2"}
                    </Badge>
                    <span className="font-semibold text-ink">{t.title}</span>
                  </div>
                  {t.description && <MultilineText text={t.description} className="mt-1 text-ink/70" />}
                  {t.estimated_hours != null && (
                    <p className="mt-1 text-xs text-ink/45">预估 {t.estimated_hours}h</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (proposal.proposal_type === "replan") {
    const p = payload as Record<string, unknown>;
    return (
      <div className="space-y-3 text-sm">
        <ReplanField label="原因" value={p.reason} />
        <ReplanField label="影响" value={p.impact} />
        <div className="grid gap-2 sm:grid-cols-2">
          <ReplanField label="调整前" value={p.before} />
          <ReplanField label="调整后" value={p.after} />
        </div>
        <ReplanField label="阶段调整" value={p.stage_adjustments} />
        <ReplanField label="任务变更" value={p.task_changes} />
        <ReplanField label="新行动卡" value={p.action_cards} />
      </div>
    );
  }

  return <pre className="text-xs text-ink/60">{JSON.stringify(payload, null, 2)}</pre>;
}

/** Build a map from agent_event_id → AgentEvent status */
function buildStatusMap(
  proposals: AgentProposal[],
  timeline: AgentEvent[],
): Record<string, string> {
  const map: Record<string, string> = {};
  const eventById: Record<string, AgentEvent> = {};
  for (const event of timeline) {
    eventById[event.id] = event;
  }
  for (const proposal of proposals) {
    if (proposal.agent_event_id && eventById[proposal.agent_event_id]) {
      map[proposal.id] = eventById[proposal.agent_event_id].status;
    }
  }
  return map;
}

function StatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  return (
    <Badge className={STATUS_CLASSES[status] ?? "bg-ink/8 text-ink/55"}>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

function PendingProposalItem({
  proposal,
  status,
  isExpanded,
  confirmingId,
  pending,
  onToggle,
  onConfirm,
  onReject,
}: {
  proposal: AgentProposal;
  status?: string;
  isExpanded: boolean;
  confirmingId: string | null;
  pending?: boolean;
  onToggle: () => void;
  onConfirm: (id: string) => void;
  onReject?: (id: string, reason: string) => void;
}) {
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");

  const handleSubmitReject = () => {
    const trimmed = rejectionReason.trim();
    if (!trimmed) return;
    onReject?.(proposal.id, trimmed);
    setShowRejectForm(false);
    setRejectionReason("");
  };

  const handleCancelReject = () => {
    setShowRejectForm(false);
    setRejectionReason("");
  };

  return (
    <div className="rounded-lg border border-moss/20 bg-moss/5">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between p-4 text-left"
      >
        <div className="flex items-center gap-2">
          <Badge className="bg-moss/15 text-moss">{TYPE_LABELS[proposal.proposal_type] ?? proposal.proposal_type}</Badge>
          <StatusBadge status={status} />
          <span className="text-sm text-ink/60">{TYPE_DESCRIPTIONS[proposal.proposal_type]}</span>
        </div>
        {isExpanded ? <ChevronUp className="h-4 w-4 text-ink/40" /> : <ChevronDown className="h-4 w-4 text-ink/40" />}
      </button>

      {isExpanded && (
        <div className="border-t border-moss/15 px-4 pb-4 pt-3">
          <ProposalContent proposal={proposal} />
          <div className="mt-4 flex items-center gap-2">
            <Button
              size="sm"
              className="bg-moss text-white hover:bg-moss/85"
              disabled={pending || confirmingId === proposal.id}
              onClick={() => onConfirm(proposal.id)}
            >
              {confirmingId === proposal.id ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> 确认中...</>
              ) : (
                <><CheckCircle className="h-4 w-4" /> 确认应用</>
              )}
            </Button>
            {!showRejectForm ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending || confirmingId === proposal.id}
                onClick={() => setShowRejectForm(true)}
              >
                <XCircle className="h-4 w-4" /> 拒绝
              </Button>
            ) : null}
          </div>
          {showRejectForm && (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-ink/70">请输入拒绝理由（拒绝理由将作为项目记忆保存，避免后续重复提出类似方案）：</p>
              <Textarea
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="例如：方案未考虑团队成员的时间约束"
                rows={2}
                className="text-sm"
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || !rejectionReason.trim()}
                  onClick={handleSubmitReject}
                  className="border-coral/40 text-coral hover:bg-coral/10"
                >
                  <XCircle className="h-4 w-4" /> 确认拒绝
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={handleCancelReject}
                >
                  取消
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type AgentProposalPanelProps = {
  proposals: AgentProposal[];
  pending?: boolean;
  timeline?: AgentEvent[];
  onConfirm?: (proposalId: string) => void | Promise<void>;
  onReject?: (proposalId: string, reason: string) => void | Promise<void>;
};

export function AgentProposalPanel({ proposals, pending, timeline = [], onConfirm, onReject }: AgentProposalPanelProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const safeProposals = proposals ?? [];
  const statusMap = buildStatusMap(safeProposals, timeline ?? []);
  const pendingProposals = safeProposals.filter((p) => p.status === "pending");
  const confirmedProposals = safeProposals.filter((p) => p.status === "confirmed");

  if (pendingProposals.length === 0 && confirmedProposals.length === 0) {
    return null;
  }

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = async (id: string) => {
    setConfirmingId(id);
    try {
      await onConfirm?.(id);
    } finally {
      setConfirmingId(null);
    }
  };

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-moss" />
        <h2 className="text-lg font-bold text-ink">Agent 提案</h2>
        {pendingProposals.length > 0 && (
          <Badge className="bg-moss/15 text-moss">{pendingProposals.length} 待确认</Badge>
        )}
      </div>
      <p className="mt-1 text-sm text-ink/60">
        Agent 生成的建议需要你确认后才会应用到项目
      </p>

      <div className="mt-4 space-y-3">
        {pendingProposals.map((proposal) => (
          <PendingProposalItem
            key={proposal.id}
            proposal={proposal}
            status={statusMap[proposal.id]}
            isExpanded={expandedIds.has(proposal.id)}
            confirmingId={confirmingId}
            pending={pending}
            onToggle={() => toggleExpand(proposal.id)}
            onConfirm={handleConfirm}
            onReject={onReject}
          />
        ))}

        {confirmedProposals.length > 0 && (
          <details className="rounded-lg border border-ink/10 bg-ink/3">
            <summary className="cursor-pointer p-4 text-sm font-semibold text-ink/50">
              已确认的提案（{confirmedProposals.length}）
            </summary>
            <div className="space-y-2 px-4 pb-4">
              {confirmedProposals.map((proposal) => (
                <div key={proposal.id} className="flex items-center gap-2 text-sm text-ink/45">
                  <CheckCircle className="h-3.5 w-3.5 text-moss" />
                  <Badge className="bg-ink/10 text-ink/50 text-[10px]">{TYPE_LABELS[proposal.proposal_type]}</Badge>
                  <StatusBadge status={statusMap[proposal.id]} />
                  <span>{new Date(proposal.confirmed_at ?? proposal.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}
