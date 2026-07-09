"use client";

import { useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  GitMerge,
  Lightbulb,
  ListChecks,
  MessageSquareWarning,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MultilineText } from "@/components/ui/multiline-text";
import type { AgentEvent } from "@/lib/types";

type AgentTimelineProps = {
  events: AgentEvent[];
};

function eventIcon(type: AgentEvent["event_type"]) {
  switch (type) {
    case "clarify":
      return <Lightbulb className="h-4 w-4" />;
    case "plan":
      return <ClipboardList className="h-4 w-4" />;
    case "breakdown":
      return <ListChecks className="h-4 w-4" />;
    case "assign":
      return <Users className="h-4 w-4" />;
    case "negotiate":
      return <GitMerge className="h-4 w-4" />;
    case "push":
      return <Sparkles className="h-4 w-4" />;
    case "checkin":
      return <MessageSquareWarning className="h-4 w-4" />;
    case "risk":
      return <ShieldAlert className="h-4 w-4" />;
    case "replan":
      return <RefreshCw className="h-4 w-4" />;
    case "export":
      return <Bot className="h-4 w-4" />;
    default:
      return <Bot className="h-4 w-4" />;
  }
}

function eventLabel(type: AgentEvent["event_type"]) {
  const labels: Record<AgentEvent["event_type"], string> = {
    clarify: "方向澄清",
    plan: "阶段计划",
    breakdown: "任务拆解",
    assign: "分工推荐",
    negotiate: "分工协调",
    push: "主动推进",
    checkin: "签到分析",
    risk: "风险分析",
    replan: "计划调整",
    export: "导出",
  };
  return labels[type];
}

function statusLabel(status: AgentEvent["status"]) {
  const labels: Record<AgentEvent["status"], string> = {
    success: "成功",
    repaired: "已修复",
    fallback: "基础建议",
    failed: "失败",
  };
  return labels[status];
}

function statusClass(status: AgentEvent["status"]) {
  switch (status) {
    case "success":
      return "bg-moss/15 text-moss";
    case "repaired":
      return "bg-citron/40 text-ink";
    case "fallback":
      return "bg-harbor/15 text-harbor";
    case "failed":
      return "bg-coral/15 text-coral";
    default:
      return "bg-ink/8 text-ink/55";
  }
}

function eventClass(type: AgentEvent["event_type"]) {
  switch (type) {
    case "clarify":
      return "bg-harbor/15 text-harbor";
    case "plan":
      return "bg-moss/15 text-moss";
    case "breakdown":
      return "bg-citron/40 text-ink";
    case "assign":
      return "bg-ink/8 text-ink/55";
    case "negotiate":
      return "bg-harbor/15 text-harbor";
    case "push":
      return "bg-moss/15 text-moss";
    case "checkin":
      return "bg-citron/40 text-ink";
    case "risk":
      return "bg-coral/15 text-coral";
    case "replan":
      return "bg-coral/15 text-coral";
    case "export":
      return "bg-ink/8 text-ink/55";
    default:
      return "bg-ink/8 text-ink/55";
  }
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function groupByDate(events: AgentEvent[]) {
  const groups = new Map<string, AgentEvent[]>();
  for (const event of events) {
    const date = new Date(event.created_at).toLocaleDateString("zh-CN");
    const existing = groups.get(date) ?? [];
    existing.push(event);
    groups.set(date, existing);
  }
  return groups;
}

function SnapshotPreview({ snapshot }: { snapshot: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);

  const preview = JSON.stringify(snapshot, null, 2);
  const lines = preview.split("\n");
  const truncated = lines.slice(0, 6).join("\n");

  if (lines.length <= 6) {
    return (
      <pre className="mt-2 rounded-md bg-ink/5 p-3 text-xs text-ink/70 overflow-auto">
        {preview}
      </pre>
    );
  }

  return (
    <div className="mt-2">
      <pre className="rounded-md bg-ink/5 p-3 text-xs text-ink/70 overflow-auto">
        {expanded ? preview : truncated + "\n..."}
      </pre>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded((v) => !v)}
        className="mt-1 h-7 text-xs"
      >
        {expanded ? (
          <>
            <ChevronUp className="mr-1 h-3 w-3" />
            收起
          </>
        ) : (
          <>
            <ChevronDown className="mr-1 h-3 w-3" />
            展开更多
          </>
        )}
      </Button>
    </div>
  );
}

export function AgentTimeline({ events }: AgentTimelineProps) {
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-ink/15 bg-paper/70 p-6 text-sm text-ink/55">
        暂无时间线事件。运行 Agent 操作后会显示决策记录。
      </div>
    );
  }

  const groups = groupByDate(events);
  const sortedDates = Array.from(groups.keys()).sort(
    (a, b) => new Date(b).getTime() - new Date(a).getTime()
  );

  return (
    <section className="rounded-lg border border-ink/10 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-lg font-bold text-ink">Agent 时间线</h2>
        <p className="mt-1 text-sm text-ink/60">
          记录 Agent 的证据、行动和降级事件。
        </p>
      </div>

      <div className="mt-5 space-y-6">
        {sortedDates.map((date) => (
          <div key={date}>
            <p className="text-xs font-semibold text-ink/45">
              {date}
            </p>
            <div className="mt-3 space-y-3">
              {(groups.get(date) ?? []).map((event) => {
                const isExpanded = expandedEventId === event.id;
                return (
                  <article
                    key={event.id}
                    className="rounded-lg border border-ink/10 bg-paper/50 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className={eventClass(event.event_type)}>
                          {eventIcon(event.event_type)}
                        </span>
                        <Badge className={eventClass(event.event_type)}>
                          {eventLabel(event.event_type)}
                        </Badge>
                        <Badge className={statusClass(event.status)}>
                          {statusLabel(event.status)}
                        </Badge>
                        <span className="text-xs text-ink/50">
                          {formatDate(event.created_at)}
                        </span>
                      </div>
                      {event.user_confirmed && (
                        <Badge className="bg-moss/15 text-moss">已确认</Badge>
                      )}
                    </div>

                    <MultilineText text={event.reasoning_summary} className="mt-2 text-sm text-ink/75" />

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setExpandedEventId(isExpanded ? null : event.id)
                      }
                      className="mt-2 h-7 text-xs"
                    >
                      {isExpanded ? (
                        <>
                          <ChevronUp className="mr-1 h-3 w-3" />
                          隐藏详情
                        </>
                      ) : (
                        <>
                          <ChevronDown className="mr-1 h-3 w-3" />
                          查看详情
                        </>
                      )}
                    </Button>

                    {isExpanded && (
                      <div className="mt-2 space-y-3">
                        <div>
                          <p className="text-xs font-semibold text-ink/45">
                            输入
                          </p>
                          <SnapshotPreview snapshot={event.input_snapshot} />
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-ink/45">
                            输出
                          </p>
                          <SnapshotPreview snapshot={event.output_snapshot} />
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
