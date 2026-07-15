"use client";

import { ArrowRight, GitBranch, Minus, Plus, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MultilineText } from "@/components/ui/multiline-text";
import { translateStatus } from "@/lib/utils";
import type { AgentProposal, Task } from "@/lib/types";

type ReplanDiffProps = {
  before: Task[];
  after: Task[];
  /** Replan proposal metadata — when available, show before/after/impact/reason/confirmation */
  proposal?: {
    before: Record<string, unknown> | unknown[];
    after: Record<string, unknown> | unknown[];
    impact: string;
    reason: string;
    requires_confirmation: boolean;
  } | null;
  /** Pending replan proposal from backend — drives confirm/reject UI */
  pendingProposal?: AgentProposal | null;
  onConfirmReplan?: (proposalId: string) => void | Promise<void>;
  onRejectReplan?: (proposalId: string, reason: string) => void | Promise<void>;
  pending?: boolean;
};

type DiffItem = {
  kind: "added" | "removed" | "modified" | "unchanged";
  task: Task;
  beforeTask?: Task;
  changes: string[];
};

function buildDiff(before: Task[], after: Task[]): DiffItem[] {
  const beforeMap = new Map(before.map((t) => [t.id, t]));
  const afterMap = new Map(after.map((t) => [t.id, t]));
  const allIds = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const items: DiffItem[] = [];

  for (const id of allIds) {
    const b = beforeMap.get(id);
    const a = afterMap.get(id);

    if (!b && a) {
      items.push({ kind: "added", task: a, changes: ["新增任务"] });
    } else if (b && !a) {
      items.push({ kind: "removed", task: b, changes: ["移除任务"] });
    } else if (b && a) {
      const changes: string[] = [];
      if (b.status !== a.status) changes.push(`状态：${translateStatus(b.status)} → ${translateStatus(a.status)}`);
      if (b.owner_user_id !== a.owner_user_id) changes.push("负责人已调整");
      if (b.due_date !== a.due_date) changes.push(`截止：${b.due_date} → ${a.due_date}`);
      if (b.priority !== a.priority) changes.push(`优先级：${b.priority} → ${a.priority}`);
      if (changes.length > 0) {
        items.push({ kind: "modified", task: a, beforeTask: b, changes });
      } else {
        items.push({ kind: "unchanged", task: a, changes: [] });
      }
    }
  }

  return items;
}

function kindClass(kind: DiffItem["kind"]) {
  switch (kind) {
    case "added":
      return "border-moss/30 bg-moss/5";
    case "removed":
      return "border-coral/30 bg-coral/5";
    case "modified":
      return "border-citron/50 bg-citron/10";
    default:
      return "border-ink/10 bg-paper/40";
  }
}

function kindBadgeClass(kind: DiffItem["kind"]) {
  switch (kind) {
    case "added":
      return "bg-moss/15 text-moss";
    case "removed":
      return "bg-coral/15 text-coral";
    case "modified":
      return "bg-citron/40 text-ink";
    default:
      return "bg-ink/8 text-ink/55";
  }
}

function kindLabel(kind: DiffItem["kind"]) {
  switch (kind) {
    case "added":
      return "新增";
    case "removed":
      return "移除";
    case "modified":
      return "调整";
    default:
      return "未变化";
  }
}

function kindIcon(kind: DiffItem["kind"]) {
  switch (kind) {
    case "added":
      return <Plus className="h-4 w-4 text-moss" />;
    case "removed":
      return <Minus className="h-4 w-4 text-coral" />;
    case "modified":
      return <RefreshCw className="h-4 w-4 text-harbor" />;
    default:
      return <GitBranch className="h-4 w-4 text-ink/40" />;
  }
}

const PROPOSAL_LABELS: Record<string, string> = {
  summary: "摘要",
  task: "任务",
  title: "标题",
  status: "状态",
  task_status: "任务状态",
  due_date: "截止日期",
  end_date: "结束日期",
  start_date: "开始日期",
  deadline: "截止日期",
  blocker: "阻塞",
  new_start_date: "新开始日期",
  new_end_date: "新结束日期",
  can_cut: "可砍",
  reason: "原因",
  type: "类型",
  content: "内容",
  goal: "目标",
  start_suggestion: "如何开始",
  completion_standard: "完成标准",
  estimated_hours: "预估工时",
  priority: "优先级",
  name: "名称",
  description: "描述",
  deliverable: "交付物",
  blocker_reason: "阻塞原因",
  progress_note: "进展说明",
  proposed_status: "建议状态",
  current_status: "当前状态",
  task_title: "任务",
  member_name: "成员",
  acceptance_criteria: "验收标准",
  stages: "阶段",
  risks: "风险",
  risks_mitigated: "已缓解风险",
  issues: "问题点",
  actions: "应对措施",
  mitigation: "缓解方案",
  // suppressed
  evidence_refs: "",
  stage_id: "",
  task_id: "",
  owner_user_id: "",
  user_id: "",
  backup_owner_user_id: "",
  current_stage_id: "",
  project_id: "",
  workspace_id: "",
};

function proposalLabel(key: string) {
  const label = PROPOSAL_LABELS[key];
  if (label === "") return "";
  if (label !== undefined) return label;
  return key.replace(/_/g, " ");
}

function proposalValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "object" && item !== null) {
        return Object.entries(item as Record<string, unknown>)
          .map(([k, v]) => { const l = proposalLabel(k); return l ? `${l}: ${proposalValue(v)}` : ""; })
          .filter(Boolean).join("、");
      }
      return String(item);
    }).join("；");
  }
  if (typeof value === "object" && value !== null) return "结构化调整";
  return translateStatus(String(value));
}

function renderSummary(value: Record<string, unknown> | unknown[]) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-ink/40 text-[10px]">无变更</span>;
    return (
      <ul className="space-y-1">
        {value.map((item, i) => (
          <li key={i} className="text-[11px] leading-relaxed">
            {typeof item === "object" && item !== null
              ? Object.entries(item as Record<string, unknown>).map(([k, v]) => {
                  const label = proposalLabel(k);
                  if (!label) return null;
                  return (
                    <div key={k} className="flex gap-1.5 py-0.5 text-[11px] leading-relaxed">
                      <span className="font-medium text-ink/50 shrink-0">{label}：</span>
                      <MultilineText text={proposalValue(v)} />
                    </div>
                  );
                }).filter(Boolean)
              : <MultilineText text={String(item)} />}
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return <span className="text-ink/40 text-[10px]">无变更</span>;
    return (
      <div>
        {entries.map(([key, val]) => {
          const label = proposalLabel(key);
          if (!label) return null;
          return (
            <div key={key} className="flex gap-1.5 py-0.5 text-[11px] leading-relaxed">
              <span className="font-medium text-ink/50 shrink-0">{label}：</span>
              <MultilineText text={proposalValue(val)} />
            </div>
          );
        })}
      </div>
    );
  }
  return <MultilineText text={String(value)} />;
}

function ProposalDetailSection({ label, items }: { label: string; items: unknown[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-xs font-semibold tracking-wider text-ink/45">{label}</p>
      <ul className="mt-1 space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="rounded bg-white/70 px-2.5 py-1.5 text-[11px] leading-relaxed text-ink/60">
            {typeof item === "object" && item !== null
              ? Object.entries(item as Record<string, unknown>)
                  .filter(([, v]) => v !== null && v !== undefined && v !== "")
                  .map(([k, v]) => {
                    const label2 = proposalLabel(k);
                    if (!label2) return null;
                    return (
                      <div key={k} className="flex gap-1.5 py-0.5 text-[11px] leading-relaxed">
                        <span className="font-medium text-ink/55 shrink-0">{label2}：</span>
                        <MultilineText text={proposalValue(v)} />
                      </div>
                    );
                  })
                  .filter(Boolean)
              : <MultilineText text={String(item)} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReplanDiff({
  before,
  after,
  proposal,
  pendingProposal,
  onConfirmReplan,
  onRejectReplan,
  pending,
}: ReplanDiffProps) {
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");

  const diff = buildDiff(before, after);
  const added = diff.filter((d) => d.kind === "added");
  const removed = diff.filter((d) => d.kind === "removed");
  const modified = diff.filter((d) => d.kind === "modified");

  // Extract proposal data from pendingProposal payload if available
  const proposalPayload = pendingProposal?.payload as Record<string, unknown> | undefined;
  const effectiveProposal = proposal ?? (proposalPayload ? {
    before: (proposalPayload.before as Record<string, unknown>) ?? {},
    after: (proposalPayload.after as Record<string, unknown>) ?? {},
    impact: (proposalPayload.impact as string) ?? "",
    reason: (proposalPayload.reason as string) ?? "",
    requires_confirmation: (proposalPayload.requires_confirmation as boolean) ?? true,
  } : null);

  const stageAdjustments = (proposalPayload?.stage_adjustments as unknown[]) ?? [];
  const taskChanges = (proposalPayload?.task_changes as unknown[]) ?? [];
  const actionCards = (proposalPayload?.action_cards as unknown[]) ?? [];
  const displayedAddedCount = added.length + actionCards.length;
  const displayedRemovedCount = removed.length;
  const displayedModifiedCount = modified.length + stageAdjustments.length + taskChanges.length;

  if (diff.length === 0 && !effectiveProposal && !pendingProposal) {
    return (
      <div className="rounded-lg border border-dashed border-ink/15 bg-paper/70 p-6 text-sm text-ink/55">
        暂无可展示的调整。运行「调整计划」后会显示重排建议。
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-ink/10 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">计划调整</h2>
          <p className="mt-1 text-sm text-ink/60">展示最近一次重排后的任务变化。</p>
        </div>
        <div className="flex gap-2">
          {displayedAddedCount > 0 && (
            <Badge className="bg-moss/15 text-moss">
              <Plus className="mr-1 h-3 w-3" />
              {displayedAddedCount}
            </Badge>
          )}
          {displayedRemovedCount > 0 && (
            <Badge className="bg-coral/15 text-coral">
              <Minus className="mr-1 h-3 w-3" />
              {displayedRemovedCount}
            </Badge>
          )}
          {displayedModifiedCount > 0 && (
            <Badge className="bg-citron/40 text-ink">
              <RefreshCw className="mr-1 h-3 w-3" />
              {displayedModifiedCount}
            </Badge>
          )}
        </div>
      </div>

      {/* Replan proposal metadata */}
      {effectiveProposal && (
        <div className="mt-4 rounded-lg border border-citron/30 bg-citron/5 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-citron" />
            <span className="font-semibold text-ink">重排建议</span>
            {effectiveProposal.requires_confirmation && pendingProposal?.status === "pending" && (
              <Badge className="bg-citron/40 text-ink">待确认</Badge>
            )}
          </div>

          {effectiveProposal.impact && (
            <div className="mt-2 text-sm text-ink/70">
              <span className="font-semibold text-ink/80">影响：</span>
              <MultilineText text={effectiveProposal.impact} className="mt-0.5" />
            </div>
          )}
          {effectiveProposal.reason && (
            <div className="mt-1 text-sm text-ink/70">
              <span className="font-semibold text-ink/80">原因：</span>
              <MultilineText text={effectiveProposal.reason} className="mt-0.5" />
            </div>
          )}

          <div className="mt-3 grid gap-3 md:grid-cols-2 text-[11px] leading-relaxed">
            <div className="rounded-md bg-white px-3 py-2">
              <p className="text-[10px] font-semibold tracking-wider text-ink/35">调整前</p>
              <div className="mt-1">{renderSummary(effectiveProposal.before)}</div>
            </div>
            <div className="rounded-md bg-white px-3 py-2">
              <p className="text-[10px] font-semibold tracking-wider text-ink/35">调整后</p>
              <div className="mt-1">{renderSummary(effectiveProposal.after)}</div>
            </div>
          </div>

          {/* Show stage adjustments, task changes, action cards from proposal */}
          <ProposalDetailSection label="阶段调整" items={stageAdjustments} />
          <ProposalDetailSection label="任务变更" items={taskChanges} />
          <ProposalDetailSection label="新行动卡" items={actionCards} />

          {/* Confirm / Reject buttons for pending proposals */}
          {pendingProposal?.status === "pending" && (
            <div className="mt-4 space-y-2">
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => onConfirmReplan?.(pendingProposal.id)}
                  className="bg-moss text-white hover:bg-moss/85"
                >
                  <ShieldCheck className="mr-1 h-4 w-4" />
                  确认调整
                </Button>
                {!showRejectForm && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => setShowRejectForm(true)}
                  >
                    <XCircle className="mr-1 h-4 w-4" />
                    拒绝调整
                  </Button>
                )}
              </div>
              {showRejectForm && (
                <div className="space-y-2">
                  <p className="text-sm text-ink/70">请输入拒绝理由（拒绝理由将作为项目记忆保存）：</p>
                  <Textarea
                    value={rejectionReason}
                    onChange={(e) => setRejectionReason(e.target.value)}
                    placeholder="例如：调整方案未解决核心风险"
                    rows={2}
                    className="text-sm"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || !rejectionReason.trim()}
                      onClick={() => {
                        onRejectReplan?.(pendingProposal.id, rejectionReason.trim());
                        setShowRejectForm(false);
                        setRejectionReason("");
                      }}
                      className="border-coral/40 text-coral hover:bg-coral/10"
                    >
                      <XCircle className="mr-1 h-4 w-4" />
                      确认拒绝
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => { setShowRejectForm(false); setRejectionReason(""); }}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-5 grid gap-3">
        {diff
          .filter((d) => d.kind !== "unchanged")
          .map((item) => (
            <article
              key={item.task.id}
              className={`rounded-lg border p-4 ${kindClass(item.kind)}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                {kindIcon(item.kind)}
                <h3 className="font-semibold text-ink">{item.task.title}</h3>
                <Badge className={kindBadgeClass(item.kind)}>{kindLabel(item.kind)}</Badge>
              </div>

              {item.changes.length > 0 && (
                <div className="mt-3 space-y-1">
                  {item.changes.map((change, index) => (
                    <div key={index} className="flex items-center gap-2 text-sm text-ink/70">
                      <ArrowRight className="h-3 w-3 text-ink/40" />
                      {change}
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
      </div>
    </section>
  );
}
