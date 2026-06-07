"use client";

import { HelpCircle } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Tone = "coral" | "primary" | "moss" | "ink";

interface CompactStatProps {
  label: string;
  value: string | number;
  trend: string;
  tone: Tone;
  helpText?: string;
}

const toneClasses: Record<Tone, string> = {
  coral: "text-coral",
  primary: "text-primary",
  moss: "text-moss",
  ink: "text-ink/55",
};

export function CompactStat({ label, value, trend, tone, helpText }: CompactStatProps) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
     <div className="flex items-center gap-1.5">
        <p className="text-xs font-semibold tracking-normal text-neutral-500">{label}</p>
        {helpText && (
          <TooltipProvider delay={200}>
            <Tooltip>
              <TooltipTrigger>
                <HelpCircle className="h-3.5 w-3.5 text-neutral-400 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs text-xs">
                {helpText}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <p className="text-2xl font-bold text-neutral-900">{value}</p>
        <span className={`text-xs ${toneClasses[tone]}`}>{trend}</span>
      </div>
    </div>
  );
}
