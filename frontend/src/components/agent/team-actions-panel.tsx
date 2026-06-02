"use client";

import { Lightbulb } from "lucide-react";

import { ActionCardsList } from "@/components/agent/action-card";
import type { ActionCard } from "@/lib/types";

type TeamActionsPanelProps = {
  cards: ActionCard[];
  onDismiss?: (cardId: string) => void | Promise<void>;
  onComplete?: (cardId: string) => void | Promise<void>;
  pending?: boolean;
  canOperate?: boolean;
};

export function TeamActionsPanel({ cards, onDismiss, onComplete, pending, canOperate = true }: TeamActionsPanelProps) {
  const teamCards = cards.filter(
    (card) => !card.user_id
  );

  return (
    <section className="rounded-lg border border-ink/10 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">团队下一步</h2>
          <p className="mt-1 text-sm text-ink/60">
            Agent 推送的团队共同行动和提醒。
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-citron/35 px-3 py-1 text-xs font-medium text-ink">
          <Lightbulb className="h-3.5 w-3.5" />
          {teamCards.filter((c) => c.status === "active").length} 进行中
        </div>
      </div>

      <div className="mt-5">
        <ActionCardsList
          cards={teamCards}
          emptyText="暂无团队行动卡。分工确认后运行主动推进。"
          onDismiss={onDismiss}
          onComplete={onComplete}
          pending={pending}
          canOperate={canOperate}
        />
      </div>
    </section>
  );
}
