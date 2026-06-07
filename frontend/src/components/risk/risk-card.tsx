"use client";

import { AlertTriangle, CheckCircle2, EyeOff, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useInlineConfirm } from "@/lib/use-inline-confirm";
import type { Risk } from "@/lib/types";

type RiskCardProps = {
  risk: Risk;
  onAccept?: (riskId: string) => void | Promise<void>;
  onIgnore?: (riskId: string) => void | Promise<void>;
  onResolve?: (riskId: string) => void | Promise<void>;
  pending?: boolean;
};

function severityClass(severity: Risk["severity"]) {
  if (severity === "high") return "bg-coral/15 text-coral";
  if (severity === "medium") return "bg-citron/40 text-ink";
  return "bg-ink/8 text-ink/55";
}

function severityLabel(severity: Risk["severity"]) {
  const labels: Record<Risk["severity"], string> = {
    high: "高",
    medium: "中",
    low: "低",
  };
  return labels[severity];
}

function typeLabel(type: Risk["type"]) {
  const labels: Record<Risk["type"], string> = {
    deadline: "截止风险",
    dependency: "依赖风险",
    workload: "工作量风险",
    scope: "范围风险",
    review: "评审风险",
    assignment: "分工风险",
    checkin: "签到风险",
  };
  return labels[type];
}

function statusLabel(status: Risk["status"]) {
  const labels: Record<Risk["status"], string> = {
    open: "待处理",
    accepted: "已接受",
    ignored: "已忽略",
    resolved: "已解决",
  };
  return labels[status];
}

function typeClass(type: Risk["type"]) {
  switch (type) {
    case "deadline":
      return "bg-coral/15 text-coral";
    case "dependency":
      return "bg-harbor/15 text-harbor";
    case "workload":
      return "bg-citron/40 text-ink";
    case "scope":
      return "bg-ink/8 text-ink/55";
    default:
      return "bg-ink/8 text-ink/55";
  }
}

const EVIDENCE_LABELS: Record<string, string> = {
  source: "来源",
  detail: "事实",
  text: "事实",
  task_title: "任务",
  task_status: "任务状态",
  stage_name: "阶段",
  member_name: "成员",
  blocker: "阻塞",
  due_date: "截止日期",
  deadline: "截止日期",
  status: "状态",
  severity: "严重度",
  type: "类型",
  available_hours_next_cycle: "下周期可用时间",
  available_hours: "可用时间",
  recommendation: "建议",
};

function evidenceLabel(key: string) {
  return EVIDENCE_LABELS[key] ?? key;
}

function evidenceValue(value: unknown) {
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "object" && value !== null) return "结构化项目证据";
  return String(value);
}

/** Render a single evidence item — handles both string and dict formats */
function renderEvidenceItem(item: string | Record<string, unknown>, index: number) {
  if (typeof item === "string") {
    return (
      <li key={index} className="text-xs text-ink/60">
        • {item}
      </li>
    );
  }
  // Structured evidence dict
  const entries = Object.entries(item).filter(([key, value]) => {
    if (value === null || value === undefined || value === "") return false;
    return !key.endsWith("_id") && key !== "id";
  });
  const detail = item.detail as string | undefined;
  const dataEntries = detail !== undefined ? entries.filter(([k]) => k !== "detail") : entries;

  return (
    <li key={index} className="text-xs text-ink/60">
      {dataEntries.map(([key, value], i) => (
        <span key={i}>
          {i > 0 && ", "}
          <span className="font-medium text-ink/70">{evidenceLabel(key)}</span>: {evidenceValue(value)}
        </span>
      ))}
      {detail && <span className="ml-1 text-ink/50">— {detail}</span>}
    </li>
  );
}

export function RiskCard({ risk, onAccept, onIgnore, onResolve, pending }: RiskCardProps) {
  const isOpen = risk.status === "open";
  const isAccepted = risk.status === "accepted";
  const isHighRisk = risk.severity === "high";
  const confirmResolve = useInlineConfirm();
  const confirmIgnore = useInlineConfirm();

  return (
    <article className={`rounded-lg border bg-paper/60 p-4 ${isHighRisk ? "border-coral/30" : "border-ink/10"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <AlertTriangle className={`h-4 w-4 ${isHighRisk ? "text-coral" : "text-ink/40"}`} />
            <h3 className="font-semibold text-ink">{risk.title}</h3>
            <Badge className={severityClass(risk.severity)}>{severityLabel(risk.severity)}</Badge>
            {isHighRisk && (
              <Badge className="bg-coral/20 text-coral font-semibold">高危</Badge>
            )}
            <Badge className={typeClass(risk.type)}>{typeLabel(risk.type)}</Badge>
            <Badge
              className={
                risk.status === "open"
                  ? "bg-coral/15 text-coral"
                  : risk.status === "resolved"
                    ? "bg-moss/15 text-moss"
                    : risk.status === "accepted"
                      ? "bg-citron/40 text-ink"
                      : "bg-ink/8 text-ink/55"
              }
            >
              {statusLabel(risk.status)}
            </Badge>
          </div>
          <p className="mt-2 text-sm text-ink/70">{risk.description}</p>

          {risk.evidence.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold text-ink/45">证据</p>
              <ul className="mt-1 space-y-1">
                {risk.evidence.map((item, index) => renderEvidenceItem(item, index))}
              </ul>
            </div>
          )}

          {risk.recommendation && (
            <div className="mt-3 rounded-md bg-white px-3 py-2 text-sm text-ink/75">
              <span className="font-semibold text-ink/70">建议：</span> {risk.recommendation}
            </div>
          )}

          {isHighRisk && isOpen && (
            <div className="mt-2 rounded-md bg-coral/5 px-3 py-2 text-xs text-coral">
              高危风险需人工确认后才会触发计划调整。接受风险仅记录认知，不会自动执行建议。
            </div>
          )}
        </div>

        {(isOpen || isAccepted) && (
          <div className="flex gap-2">
            {confirmResolve.confirming ? (
              <>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={confirmResolve.handleConfirm(() => onResolve?.(risk.id))}
                  className="bg-coral text-white hover:bg-coral/85"
                >
                  <ShieldCheck className="h-4 w-4" />
                  确认解决？
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={confirmResolve.cancel}
                >
                  取消
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={pending}
                onClick={confirmResolve.handleConfirm(() => onResolve?.(risk.id))}
                className="bg-moss text-white hover:bg-moss/85"
              >
                <ShieldCheck className="h-4 w-4" />
                解决
              </Button>
            )}
            {isOpen && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => onAccept?.(risk.id)}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  接受
                </Button>
                {confirmIgnore.confirming ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={confirmIgnore.handleConfirm(() => onIgnore?.(risk.id))}
                      className="text-coral hover:bg-coral/10 hover:text-coral"
                    >
                      <EyeOff className="h-4 w-4" />
                      确认忽略？
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={confirmIgnore.cancel}
                    >
                      取消
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={confirmIgnore.handleConfirm(() => onIgnore?.(risk.id))}
                  >
                    <EyeOff className="h-4 w-4" />
                    忽略
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
