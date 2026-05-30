"use client";

import { CheckCircle2, HelpCircle, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AgentEvent, DirectionCard } from "@/lib/types";

type DirectionCardPanelProps = {
  directionCard?: DirectionCard | null;
  timeline: AgentEvent[];
  pending?: boolean;
  onRunClarification?: () => void;
};

function safeStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function latestClarification(timeline: AgentEvent[]) {
  return [...timeline].reverse().find((event) => event.event_type === "clarify");
}

export function DirectionCardPanel({
  directionCard,
  timeline,
  pending,
  onRunClarification,
}: DirectionCardPanelProps) {
  const clarification = latestClarification(timeline);
  const questions = safeStringList(directionCard?.suggested_questions ?? clarification?.output_snapshot?.suggested_questions);
  const confirmed = Boolean(directionCard);

  const deliverables = safeStringList(directionCard?.deliverables);
  const boundaries = safeStringList(directionCard?.boundaries);
  const risks = safeStringList(directionCard?.risks);

  return (
    <section className="rounded-lg border border-ink/10 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">方向卡</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink/60">
            确认项目方向后再规划任务和分工，避免后续建议偏离目标
          </p>
        </div>
        <Badge className={confirmed ? "bg-moss/15 text-moss" : "bg-citron/35 text-ink"}>
          {confirmed ? "已确认" : "待确认"}
        </Badge>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-lg border border-ink/10 bg-paper/70 p-4">
          {directionCard ? (
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink/45">核心问题</p>
                <p className="mt-1 text-sm font-semibold text-ink">{directionCard.problem}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink/45">目标用户</p>
                  <p className="mt-1 text-sm text-ink/75">{directionCard.users}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink/45">核心价值</p>
                  <p className="mt-1 text-sm text-ink/75">{directionCard.value}</p>
                </div>
              </div>
              {deliverables.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink/45">交付物</p>
                  <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-ink/75">
                    {deliverables.map((d) => <li key={d}>{d}</li>)}
                  </ul>
                </div>
              )}
              {boundaries.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink/45">边界</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {boundaries.map((b) => (
                      <Badge key={b} variant="outline" className="border-ink/15 bg-white text-ink/70">
                        {b}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {risks.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink/45">风险</p>
                  <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-coral/80">
                    {risks.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="flex min-h-40 flex-col items-start justify-center gap-3">
              <HelpCircle className="h-6 w-6 text-harbor" />
              <div>
                <p className="font-semibold text-ink">尚未生成方向卡</p>
                <p className="mt-1 text-sm text-ink/60">完成项目录入后运行澄清方向，生成项目方向建议</p>
              </div>
              <Button onClick={onRunClarification} disabled={pending} className="bg-ink text-white hover:bg-ink/85">
                <Sparkles className="h-4 w-4" />
                运行澄清方向
              </Button>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-ink/10 bg-white p-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-moss" />
            <p className="font-semibold text-ink">Agent 提问</p>
          </div>
          {questions.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {questions.map((question) => (
                <li key={question} className="rounded-md bg-paper px-3 py-2 text-sm text-ink/75">
                  {question}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-ink/50">澄清方向运行后将显示提问</p>
          )}
        </div>
      </div>
    </section>
  );
}
