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
        className="fixed z-50 rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        style={{
          left: anchorRect.left,
          bottom: window.innerHeight - anchorRect.top + 4,
          width: anchorRect.width,
        }}
      >
        <div className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">没有匹配的命令</div>
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label="斜杠命令"
      aria-activedescendant={activeId}
      className="fixed z-50 max-h-64 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
      style={{
        left: anchorRect.left,
        bottom: window.innerHeight - anchorRect.top + 4,
        width: anchorRect.width,
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
            className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
              isActive
                ? "bg-moss/10 text-moss dark:bg-moss/10 dark:text-moss"
                : "hover:bg-neutral-50 dark:hover:bg-neutral-800"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400" />
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="shrink-0 font-mono text-xs font-medium text-neutral-700 dark:text-neutral-300">
                /{cmd.command}
              </span>
              <span className="shrink-0 text-xs text-neutral-900 dark:text-neutral-100">{cmd.label}</span>
              <span className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">{cmd.description}</span>
            </div>
            <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
              {cmd.category}
            </span>
          </button>
        );
      })}
    </div>
  );
}
