"use client";

import { useState } from "react";
import { ShieldAlert } from "lucide-react";

import { RiskCard } from "@/components/risk/risk-card";
import { Badge } from "@/components/ui/badge";
import type { Risk } from "@/lib/types";

type RiskPanelProps = {
  risks: Risk[];
  onAccept?: (riskId: string) => void | Promise<void>;
  onIgnore?: (riskId: string) => void | Promise<void>;
  onResolve?: (riskId: string) => void | Promise<void>;
  pending?: boolean;
};

type RiskFilter = "all" | "open" | "accepted" | "ignored" | "resolved";

const FILTER_LABELS: Record<RiskFilter, string> = {
  all: "全部",
  open: "待处理",
  accepted: "已接受",
  ignored: "已忽略",
  resolved: "已解决",
};

export function RiskPanel({ risks, onAccept, onIgnore, onResolve, pending }: RiskPanelProps) {
  const [filter, setFilter] = useState<RiskFilter>("all");

  const openRisks = risks.filter((risk) => risk.status === "open");
  const highSeverityCount = openRisks.filter((risk) => risk.severity === "high").length;

  const filteredRisks = filter === "all" ? risks : risks.filter((risk) => risk.status === filter);

  const filters: RiskFilter[] = ["all", "open", "accepted", "ignored", "resolved"];

  return (
    <section className="rounded-lg border border-ink/10 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">风险</h2>
          <p className="mt-1 text-sm text-ink/60">
            Agent 识别的风险，附带证据和建议
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-coral/15 px-3 py-1 text-xs font-medium text-coral">
          <ShieldAlert className="h-3.5 w-3.5" />
          {openRisks.length} 待处理{highSeverityCount > 0 && `，${highSeverityCount} 高危`}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {filters.map((f) => {
          const count = f === "all" ? risks.length : risks.filter((r) => r.status === f).length;
          if (f !== "all" && count === 0) return null;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                filter === f
                  ? "bg-ink text-white"
                  : "bg-ink/5 text-ink/65 hover:bg-ink/10"
              }`}
            >
              {FILTER_LABELS[f]}
              <span className="opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {risks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ink/15 bg-paper/70 p-6 text-sm text-ink/55">
            暂无识别到的风险。请在签到提交后运行风险分析。
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredRisks.length === 0 && (
              <div className="rounded-lg border border-dashed border-ink/15 bg-paper/70 p-6 text-sm text-ink/55">
                该筛选条件下没有风险记录。
              </div>
            )}
            {filteredRisks.map((risk) => (
              <RiskCard
                key={risk.id}
                risk={risk}
                onAccept={onAccept}
                onIgnore={onIgnore}
                onResolve={onResolve}
                pending={pending}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
