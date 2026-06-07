"use client";

import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Clock, History, Lightbulb, ShieldAlert, UserCheck, XCircle } from "lucide-react";
import { useInlineConfirm } from "@/lib/use-inline-confirm";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ActionCard } from "@/lib/types";

type ActionCardItemProps = {
  card: ActionCard;
  onDismiss?: (cardId: string) => void | Promise<void>;
  onComplete?: (cardId: string) => void | Promise<void>;
  pending?: boolean;
};

function typeIcon(type: ActionCard["type"]) {
  switch (type) {
    case "personal_task":
      return <UserCheck className="h-4 w-4" />;
    case "team_next_step":
      return <Lightbulb className="h-4 w-4" />;
    case "reminder":
      return <Clock className="h-4 w-4" />;
    case "risk_action":
      return <ShieldAlert className="h-4 w-4" />;
    default:
      return <Lightbulb className="h-4 w-4" />;
  }
}

function typeLabel(type: ActionCard["type"]) {
  const labels: Record<ActionCard["type"], string> = {
    personal_task: "个人任务",
    team_next_step: "团队下一步",
    reminder: "提醒",
    risk_action: "风险行动",
    kickoff_tip: "启动建议",
    checkin_prompt: "签到提醒",
    assignment_request: "分工确认",
  };
  return labels[type];
}

function statusLabel(status: ActionCard["status"]) {
  const labels: Record<ActionCard["status"], string> = {
    active: "进行中",
    done: "已完成",
    dismissed: "已忽略",
  };
  return labels[status];
}

function typeClass(type: ActionCard["type"]) {
  switch (type) {
    case "personal_task":
      return "bg-harbor/15 text-harbor";
    case "team_next_step":
      return "bg-moss/15 text-moss";
    case "reminder":
      return "bg-citron/40 text-ink";
    case "risk_action":
      return "bg-coral/15 text-coral";
    default:
      return "bg-ink/8 text-ink/55";
  }
}

export function ActionCardItem({ card, onDismiss, onComplete, pending, canOperate = true }: ActionCardItemProps & { canOperate?: boolean }) {
  const confirmComplete = useInlineConfirm();
  return (
    <article className="rounded-lg border border-ink/10 bg-paper/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={typeClass(card.type)}>{typeIcon(card.type)}</span>
            <h3 className="font-semibold text-ink">{card.title}</h3>
            <Badge className={typeClass(card.type)}>{typeLabel(card.type)}</Badge>
            <Badge
              className={
                card.status === "active"
                  ? "bg-moss/15 text-moss"
                  : card.status === "done"
                    ? "bg-ink/8 text-ink/55"
                    : "bg-ink/8 text-ink/55"
              }
            >
              {statusLabel(card.status)}
            </Badge>
          </div>
          <p className="mt-2 text-sm text-ink/70">{card.content}</p>

          {card.goal && (
            <p className="mt-2 text-sm text-ink/70">
              <span className="font-semibold text-ink/80">目标：</span> {card.goal}
            </p>
          )}
          {card.start_suggestion && (
            <p className="mt-1 text-sm text-ink/70">
              <span className="font-semibold text-ink/80">如何开始：</span> {card.start_suggestion}
            </p>
          )}
          {card.completion_standard && (
            <p className="mt-1 text-sm text-ink/70">
              <span className="font-semibold text-ink/80">完成标准：</span> {card.completion_standard}
            </p>
          )}

          {card.reason && (
            <p className="mt-2 flex items-center gap-1 text-xs text-ink/50">
              <Lightbulb className="h-3 w-3" />
              {card.reason}
            </p>
          )}
          {card.due_date && (
            <p className="mt-1 text-xs text-ink/50">
              截止：{new Date(card.due_date).toLocaleDateString("zh-CN")}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {card.status === "active" && (
            <>
              {confirmComplete.confirming ? (
                <>
                  <Button
                    size="sm"
                    disabled={pending || !canOperate}
                    onClick={confirmComplete.handleConfirm(() => onComplete?.(card.id))}
                    className="bg-coral text-white hover:bg-coral/85"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    确认完成？
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || !canOperate}
                    onClick={confirmComplete.cancel}
                  >
                    取消
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    disabled={pending || !canOperate}
                    onClick={confirmComplete.handleConfirm(() => onComplete?.(card.id))}
                    className="bg-moss text-white hover:bg-moss/85"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    完成
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || !canOperate}
                    onClick={() => onDismiss?.(card.id)}
                  >
                    <XCircle className="h-4 w-4" />
                    忽略
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

type ActionCardsListProps = {
  cards: ActionCard[];
  emptyText?: string;
  onDismiss?: (cardId: string) => void | Promise<void>;
  onComplete?: (cardId: string) => void | Promise<void>;
  pending?: boolean;
  canOperate?: boolean;
};

export function ActionCardsList({
  cards,
  emptyText = "暂无行动卡。",
  onDismiss,
  onComplete,
  pending,
  canOperate = true,
}: ActionCardsListProps) {
  const [showHistory, setShowHistory] = useState(false);
  const activeCards = cards.filter((card) => card.status === "active");
  const historyCards = cards.filter((card) => card.status !== "active");
  const doneCards = historyCards.filter((card) => card.status === "done");
  const dismissedCards = historyCards.filter((card) => card.status === "dismissed");

  if (cards.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-ink/15 bg-paper/70 p-6 text-sm text-ink/55">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {activeCards.length === 0 && historyCards.length === 0 && (
        <div className="rounded-lg border border-dashed border-ink/15 bg-paper/70 p-6 text-sm text-ink/55">
          暂无行动卡。
        </div>
      )}
      {activeCards.length === 0 && historyCards.length > 0 && (
        <div className="rounded-lg border border-dashed border-ink/15 bg-paper/70 p-6 text-sm text-ink/55">
          暂无进行中的行动卡。
        </div>
      )}
      {activeCards.map((card) => (
        <ActionCardItem
          key={card.id}
          card={card}
          onDismiss={onDismiss}
          onComplete={onComplete}
          pending={pending}
          canOperate={canOperate}
        />
      ))}

      {historyCards.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center gap-1.5 text-sm font-medium text-ink/55 transition hover:text-ink/80"
          >
            <History className="h-4 w-4" />
            {showHistory ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            历史记录（{historyCards.length}）
          </button>

          {showHistory && (
            <div className="mt-3 grid gap-3">
              {doneCards.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-moss/70">
                    已完成（{doneCards.length}）
                  </p>
                  {doneCards.map((card) => (
                    <div key={card.id} className="mb-2 opacity-70">
                      <ActionCardItem card={card} pending={pending} canOperate={false} />
                    </div>
                  ))}
                </div>
              )}
              {dismissedCards.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink/45">
                    已忽略（{dismissedCards.length}）
                  </p>
                  {dismissedCards.map((card) => (
                    <div key={card.id} className="mb-2 opacity-50">
                      <ActionCardItem card={card} pending={pending} canOperate={false} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
