"use client";

import { X } from "lucide-react";
import type { SlashCommandDef } from "@/components/project/project-actions";

interface SlashCommandChipProps {
  command: SlashCommandDef;
  onRemove?: () => void;
}

export function SlashCommandChip({ command, onRemove }: SlashCommandChipProps) {
  const Icon = command.icon;
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-moss/10 px-1.5 py-0.5 text-sm font-medium text-moss">
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{command.label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="pointer-events-auto ml-0.5 shrink-0 rounded-sm p-0.5 hover:bg-moss/20 focus:outline-none focus-visible:ring-1 focus-visible:ring-moss"
          aria-label="移除命令"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
