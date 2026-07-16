"use client";

import { useEffect, useRef } from "react";
import type { SlashCommandDef } from "@/components/project/project-actions";

interface SlashCommandMenuProps {
  commands: SlashCommandDef[];
  selectedIndex: number;
  onSelect: (command: SlashCommandDef) => void;
  onClose: () => void;
  anchorRect: DOMRect;
}

export function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
  onClose,
  anchorRect,
}: SlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const activeId = commands.length > 0 ? `slash-cmd-${commands[selectedIndex]?.command}` : undefined;

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Scroll selected item into view
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const item = menu.children[selectedIndex] as HTMLElement;
    if (item && typeof item.scrollIntoView === "function") {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (commands.length === 0) {
    return (
      <div
        ref={menuRef}
        role="listbox"
        aria-label="斜杠命令"
        className="fixed z-50 rounded-xl border border-neutral-100 bg-white/95 p-3 shadow-md backdrop-blur-md dark:border-neutral-800 dark:bg-neutral-950/95"
        style={{
          left: anchorRect.left,
          bottom: window.innerHeight - anchorRect.top + 4,
          width: Math.min(480, anchorRect.width),
        }}
      >
        <div className="text-xs text-neutral-500 dark:text-neutral-400">没有匹配的命令</div>
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label="斜杠命令"
      aria-activedescendant={activeId}
      className="fixed z-50 max-h-64 overflow-y-auto rounded-xl border border-neutral-100 bg-white/95 p-1 shadow-md backdrop-blur-md dark:border-neutral-800 dark:bg-neutral-950/95 custom-scrollbar"
      style={{
        left: anchorRect.left,
        bottom: window.innerHeight - anchorRect.top + 4,
        width: Math.min(480, anchorRect.width),
      }}
    >
      {commands.map((cmd, index) => {
        const Icon = cmd.icon;
        const isActive = index === selectedIndex;
        const itemId = `slash-cmd-${cmd.command}`;
        return (
          <button
            key={cmd.command}
            id={itemId}
            type="button"
            role="option"
            aria-selected={isActive}
            onClick={() => onSelect(cmd)}
            className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors rounded-lg ${
              isActive
                ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50/50 dark:hover:bg-neutral-900/30"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500" />
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="shrink-0 text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
                {cmd.label}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
                /{cmd.command}
              </span>
              <span className="truncate text-xs text-neutral-400 dark:text-neutral-500 font-normal">
                {cmd.description}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
