"use client";

import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Target, Package, ShieldAlert, Lightbulb, Crosshair, HelpCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { MultilineText } from "@/components/ui/multiline-text";

export type DirectionDecisionContent = {
  problem?: string;
  users?: string;
  value?: string;
  deliverables?: string[];
  boundaries?: string[];
  risks?: string[];
  suggested_questions?: string[];
  source_summary?: string;
  assumptions?: string[];
  unknowns?: string[];
  mvp_boundary?: {
    must_have?: string[];
    defer?: string[];
    out_of_scope?: string[];
  };
  decision_points?: string[];
  reason?: string;
};

type DirectionDecisionViewProps = {
  content: DirectionDecisionContent;
  compact?: boolean;
};

function safeStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function SectionHeader({ icon: Icon, children, color }: { icon: React.ElementType; children: ReactNode; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn("flex h-6 w-6 items-center justify-center rounded-md", color)}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <p className="text-sm font-semibold text-ink">{children}</p>
    </div>
  );
}

export function DirectionDecisionView({ content, compact }: DirectionDecisionViewProps) {
  const deliverables = safeStringList(content.deliverables);
  const boundaries = safeStringList(content.boundaries);
  const risks = safeStringList(content.risks);
  const questions = safeStringList(content.suggested_questions);
  const assumptions = safeStringList(content.assumptions);
  const unknowns = safeStringList(content.unknowns);
  const decisionPoints = safeStringList(content.decision_points);
  const mustHave = safeStringList(content.mvp_boundary?.must_have);
  const defer = safeStringList(content.mvp_boundary?.defer);
  const outOfScope = safeStringList(content.mvp_boundary?.out_of_scope);
  const hasAudienceOrValue = Boolean(content.users || content.value);
  const hasConstraints = boundaries.length > 0 || risks.length > 0;
  const hasMvpBoundary = mustHave.length > 0 || defer.length > 0 || outOfScope.length > 0;

  return (
    <article className={cn("space-y-5", compact && "space-y-4")}>
      {/* Reason */}
      {content.reason && (
        <div className="rounded-lg bg-primary/5 px-4 py-3 text-sm leading-6 text-ink/70 border border-primary/10">
          <MultilineText text={content.reason} />
        </div>
      )}

      {/* Source Summary */}
      {content.source_summary && (
        <div className="rounded-lg bg-paper px-4 py-3 border border-ink/8">
          <p className="text-xs font-bold text-ink/60 tracking-wider">依据摘要</p>
          <div className="mt-1 text-sm leading-6 text-ink/80">
            <MultilineText text={content.source_summary} />
          </div>
        </div>
      )}

      {/* Section 1: 核心定义 */}
      {(content.problem || hasAudienceOrValue) && (
        <section className="rounded-lg bg-primary/5 px-4 py-4 space-y-4 border border-primary/10">
          <SectionHeader icon={Target} color="bg-primary/15 text-primary">核心定义</SectionHeader>
          {content.problem && (
            <div>
              <p className="text-xs font-bold text-ink/60 tracking-wider">核心问题</p>
              <div className="mt-1 text-base font-semibold leading-7 text-ink">
                <MultilineText text={content.problem} />
              </div>
            </div>
          )}
          {hasAudienceOrValue && (
            <div className="grid gap-4 sm:grid-cols-2">
              {content.users && (
                <div>
                  <p className="text-xs font-bold text-ink/60 tracking-wider">目标用户</p>
                  <div className="mt-1 text-sm leading-6 text-ink/80">
                    <MultilineText text={content.users} />
                  </div>
                </div>
              )}
              {content.value && (
                <div>
                  <p className="text-xs font-bold text-ink/60 tracking-wider">核心价值</p>
                  <div className="mt-1 text-sm leading-6 text-ink/80">
                    <MultilineText text={content.value} />
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Section 2: 交付与边界 */}
      {(deliverables.length > 0 || boundaries.length > 0) && (
        <section className="rounded-lg bg-paper px-4 py-4 space-y-4 border border-ink/8">
          <SectionHeader icon={Package} color="bg-ink/10 text-ink/60">交付与边界</SectionHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            {deliverables.length > 0 && (
              <div>
                <p className="text-xs font-bold text-ink/60 tracking-wider">交付物</p>
                <ul className="mt-2 grid gap-2 text-sm leading-6 text-ink/80">
                  {deliverables.map((deliverable) => (
                    <li key={deliverable} className="flex gap-2">
                      <CheckCircle2 className="mt-1 h-3.5 w-3.5 shrink-0 text-moss" />
                      <span>{deliverable}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {boundaries.length > 0 && (
              <div>
                <p className="text-xs font-bold text-ink/60 tracking-wider">边界</p>
                <ul className="mt-2 grid gap-2 text-sm leading-6 text-ink/80">
                  {boundaries.map((boundary) => (
                    <li key={boundary}>{boundary}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Section 3: 风险与问题 */}
      {(risks.length > 0 || questions.length > 0) && (
        <section className="rounded-lg bg-coral/5 px-4 py-4 space-y-4 border border-coral/10">
          <SectionHeader icon={ShieldAlert} color="bg-coral/15 text-coral">风险与问题</SectionHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            {risks.length > 0 && (
              <div>
                <p className="text-xs font-bold text-ink/60 tracking-wider">风险</p>
                <ul className="mt-2 grid gap-2 text-sm leading-6 text-coral/85">
                  {risks.map((risk) => (
                    <li key={risk} className="flex gap-2">
                      <AlertTriangle className="mt-1 h-3.5 w-3.5 shrink-0" />
                      <span>{risk}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {questions.length > 0 && (
              <div>
                <p className="text-xs font-bold text-ink/60 tracking-wider">澄清问题</p>
                <ul className="mt-2 grid gap-2 text-sm leading-6 text-ink/80">
                  {questions.map((question) => (
                    <li key={question} className="flex gap-2">
                      <HelpCircle className="mt-1 h-3.5 w-3.5 shrink-0 text-ink/40" />
                      <span>{question}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Section 4: 假设与缺口 */}
      {(assumptions.length > 0 || unknowns.length > 0) && (
        <section className="rounded-lg bg-citron/5 px-4 py-4 space-y-4 border border-citron/15">
          <SectionHeader icon={Lightbulb} color="bg-citron/20 text-amber-700">假设与缺口</SectionHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            {assumptions.length > 0 && (
              <div>
                <p className="text-xs font-bold text-ink/60 tracking-wider">当前假设</p>
                <ul className="mt-2 grid gap-2 text-sm leading-6 text-ink/80">
                  {assumptions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            {unknowns.length > 0 && (
              <div>
                <p className="text-xs font-bold text-ink/60 tracking-wider">关键信息缺口</p>
                <ul className="mt-2 grid gap-2 text-sm leading-6 text-coral/85">
                  {unknowns.map((item) => (
                    <li key={item} className="flex gap-2">
                      <AlertTriangle className="mt-1 h-3.5 w-3.5 shrink-0" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Section 5: MVP 边界与决策 */}
      {(hasMvpBoundary || decisionPoints.length > 0) && (
        <section className="rounded-lg bg-moss/5 px-4 py-4 space-y-4 border border-moss/15">
          <SectionHeader icon={Crosshair} color="bg-moss/15 text-moss">MVP 边界与决策</SectionHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            {hasMvpBoundary && (
              <div>
                <p className="text-xs font-bold text-ink/60 tracking-wider">MVP 边界</p>
                <div className="mt-2 grid gap-3 text-sm leading-6 text-ink/80">
                  {mustHave.length > 0 && (
                    <BoundaryGroup label="必须完成" items={mustHave} tone="moss" />
                  )}
                  {defer.length > 0 && (
                    <BoundaryGroup label="可推迟" items={defer} tone="ink" />
                  )}
                  {outOfScope.length > 0 && (
                    <BoundaryGroup label="不做" items={outOfScope} tone="coral" />
                  )}
                </div>
              </div>
            )}
            {decisionPoints.length > 0 && (
              <div>
                <p className="text-xs font-bold text-ink/60 tracking-wider">待决策点</p>
                <ul className="mt-2 grid gap-2 text-sm leading-6 text-ink/80">
                  {decisionPoints.map((item) => (
                    <li key={item} className="flex gap-2">
                      <HelpCircle className="mt-1 h-3.5 w-3.5 shrink-0 text-moss/60" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}
    </article>
  );
}

function BoundaryGroup({
  label,
  items,
  tone,
}: {
  label: string;
  items: string[];
  tone: "moss" | "ink" | "coral";
}) {
  const toneClass = {
    moss: "border-moss/20 bg-moss/10 text-moss",
    ink: "border-ink/10 bg-ink/5 text-ink/65",
    coral: "border-coral/20 bg-coral/10 text-coral",
  }[tone];

  return (
    <div>
      <Badge variant="outline" className={cn("mb-1 border px-2 py-0.5", toneClass)}>
        {label}
      </Badge>
      <ul className="grid gap-1">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
