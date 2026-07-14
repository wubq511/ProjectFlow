"use client";

// Trigger HMR refresh to clear stale Turbopack cache.
import { useCallback, useRef, useState, useEffect, useMemo, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ChangeEvent } from "react";
import { Loader2, Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { SLASH_COMMANDS, parseSlashCommand, getLeadingSlashCommand, type SlashCommandDef } from "@/components/project/project-actions";
import { SlashCommandMenu } from "@/components/project/agent/SlashCommandMenu";
import { SlashCommandChip } from "@/components/project/agent/SlashCommandChip";
import type { ThinkingLevel, ModelConfigEntry } from "@/lib/types";

interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (content: string) => void;
  onSlashSubmit?: (content: string, skill: string, slashCommand: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  isRunning?: boolean;
  onSendSteering?: (content: string) => void | Promise<void>;
  onCancelRun?: () => void | Promise<void>;
  maxLength?: number;
  // Model selector props (relocated from advanced operations panel)
  modelConfigs?: ModelConfigEntry[];
  selectedModelId?: string | null;
  onModelChange?: (modelId: string) => void;
  thinkingLevel?: ThinkingLevel | null;
  onThinkingLevelChange?: (level: ThinkingLevel | null) => void;
}

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onSlashSubmit,
  onStop,
  disabled,
  isStreaming,
  isRunning,
  onSendSteering,
  onCancelRun,
  maxLength = 4000,
  modelConfigs,
  selectedModelId,
  onModelChange,
  thinkingLevel,
  onThinkingLevelChange,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [slashActive, setSlashActive] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashHint, setSlashHint] = useState<string | null>(null);

  const leadingCommand = useMemo(() => getLeadingSlashCommand(value), [value]);

  // Split the full value into a non-editable command chip and an editable body.
  // The textarea only renders the body; the chip is a separate flex item. This
  // avoids the fragile text-indent/overlay measurement needed when trying to
  // hide the underlying "/command " token inside a single textarea.
  const { commandPrefix, bodyValue } = useMemo(() => {
    if (!leadingCommand) return { commandPrefix: "", bodyValue: value };
    const prefix = `/${leadingCommand.command} `;
    return { commandPrefix: prefix, bodyValue: value.slice(prefix.length) };
  }, [value, leadingCommand]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = 20;
    const maxLines = 6;
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * maxLines)}px`;
  }, [bodyValue]);

  // Slash command detection — only when no command is already active and not during a run.
  const handleInputChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const newBody = e.target.value;
      if (leadingCommand) {
        onChange(`${commandPrefix}${newBody}`);
        return;
      }

      onChange(newBody);

      if (isRunning) {
        // During a run, `/` is treated as normal text; no slash menu.
        setSlashActive(false);
        setSlashHint(null);
        return;
      }

      const match = newBody.match(/^\/([a-z]*)$/i);
      if (match) {
        setSlashActive(true);
        setSlashQuery(match[1]);
        setSlashIndex(0);
        setSlashHint(null);
      } else {
        setSlashActive(false);
        setSlashHint(null);
      }
    },
    [leadingCommand, commandPrefix, onChange, isRunning],
  );

  const filteredCommands = useMemo(
    () =>
      slashActive
        ? SLASH_COMMANDS.filter(
            (c) =>
              c.command.startsWith(slashQuery.toLowerCase()) ||
              c.label.includes(slashQuery),
          )
        : [],
    [slashActive, slashQuery],
  );

  const handleSlashSelect = useCallback(
    (cmd: SlashCommandDef) => {
      onChange(`/${cmd.command} `);
      setSlashActive(false);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          const len = el.value.length;
          el.setSelectionRange(len, len);
        }
      });
    },
    [onChange],
  );

  const handleRemoveCommand = useCallback(() => {
    if (!leadingCommand) return;
    onChange(bodyValue);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.focus();
    });
  }, [leadingCommand, bodyValue, onChange]);

  const handleSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const trimmed = value.trim();
      if (!trimmed || (disabled && !isRunning)) return;

      if (isRunning) {
        if (onSendSteering) {
          await onSendSteering(trimmed);
          onChange("");
        }
        return;
      }

      // Check if it's a slash command
      if (onSlashSubmit) {
        const parsed = parseSlashCommand(trimmed);
        if (parsed) {
          onSlashSubmit(parsed.content, parsed.skill, parsed.command);
          setSlashHint(null);
          setSlashActive(false);
          onChange("");
          return;
        }
        // 以 / 开头但不是有效命令 → 提示而非发送
        if (trimmed.startsWith("/")) {
          setSlashHint(`未知命令：${trimmed.split(/\s/)[0]}，输入 / 查看可用命令`);
          return;
        }
      }

      setSlashHint(null);
      setSlashActive(false);
      onSubmit(trimmed);
    },
    [value, disabled, isRunning, onSendSteering, onSubmit, onSlashSubmit, onChange],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // Escape always closes the slash menu, even when no commands match
      if (slashActive && e.key === "Escape") {
        e.preventDefault();
        setSlashActive(false);
        return;
      }

      // Backspace at the very start of the body removes the leading command chip.
      // This mirrors the common "delete the prefix" gesture while keeping the
      // command and body as separate layout elements.
      if (e.key === "Backspace" && leadingCommand && textareaRef.current) {
        const start = textareaRef.current.selectionStart;
        const end = textareaRef.current.selectionEnd;
        if (start === end && start !== null && start === 0) {
          e.preventDefault();
          onChange(bodyValue);
          return;
        }
      }

      // Slash menu navigation (only when results exist)
      if (slashActive && filteredCommands.length > 0) {
        switch (e.key) {
          case "ArrowDown":
            e.preventDefault();
            setSlashIndex((i) => (i + 1) % filteredCommands.length);
            return;
          case "ArrowUp":
            e.preventDefault();
            setSlashIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
            return;
          case "Enter":
            e.preventDefault();
            handleSlashSelect(filteredCommands[slashIndex]);
            return;
          case "Tab":
            e.preventDefault();
            handleSlashSelect(filteredCommands[slashIndex]);
            return;
        }
      }

      // Normal submit
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === "Escape" && value.length > 0 && !slashActive) {
        e.preventDefault();
        onChange("");
      }
    },
    [slashActive, filteredCommands, slashIndex, handleSlashSelect, handleSubmit, value, onChange, leadingCommand, bodyValue],
  );

  // Get anchor rect for menu positioning — recompute on scroll/resize so the
  // menu tracks the textarea even inside overflow-y-auto containers.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!slashActive) return;
    const updateRect = () => {
      if (textareaRef.current) {
        setAnchorRect(textareaRef.current.getBoundingClientRect());
      }
    };
    updateRect();
    // capture: true so we catch scroll events from overflow containers
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [slashActive]);

  const nearLimit = value.length > maxLength * 0.9;
  const selectedModel = selectedModelId ? modelConfigs?.find((c) => c.id === selectedModelId) : undefined;
  const supportsThinking = selectedModel?.capabilities?.thinking ?? false;
  const supportedLevels = selectedModel?.capabilities?.supportedThinkingLevels;
  const thinkingLevels: ThinkingLevel[] = supportedLevels?.length
    ? (supportedLevels as ThinkingLevel[])
    : ["low", "medium", "high", "xhigh", "max"];

  return (
    <form onSubmit={handleSubmit}>
      {slashActive && anchorRect && (
        <SlashCommandMenu
          commands={filteredCommands}
          selectedIndex={slashIndex}
          onSelect={handleSlashSelect}
          onClose={() => setSlashActive(false)}
          anchorRect={anchorRect}
        />
      )}
      <div className="rounded-md border border-neutral-200 bg-white p-2.5 transition-all duration-200 focus-within:border-neutral-400">
        <div className="flex items-start gap-2">
          {leadingCommand && (
            <div className="shrink-0">
              <SlashCommandChip command={leadingCommand} onRemove={handleRemoveCommand} />
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={bodyValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder={
              isRunning
                ? "追加约束或纠正当前运行..."
                : leadingCommand
                  ? "补充上下文..."
                  : "告诉 Agent 你想推进什么...  (输入 / 使用斜杠命令)"
            }
            className="min-h-12 flex-1 resize-none bg-transparent py-0.5 text-sm text-neutral-800 outline-none placeholder:text-neutral-500"
            disabled={disabled && !isRunning}
            maxLength={maxLength}
            aria-label="输入消息"
          />
        </div>
        {slashHint && (
          <div className="mt-1 text-[11px] text-coral">{slashHint}</div>
        )}
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {modelConfigs && selectedModelId !== undefined && onModelChange && (
              <Select value={selectedModelId ?? ""} onValueChange={(v) => { if (v) onModelChange?.(v); }}>
                <SelectTrigger size="sm" className="h-6 w-auto min-w-28 text-[11px]">
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {modelConfigs.filter((c) => c.valid).map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {supportsThinking && thinkingLevel !== undefined && onThinkingLevelChange && (
              <Select
                value={thinkingLevel ?? "auto"}
                onValueChange={(v) => onThinkingLevelChange(v === "auto" ? null : (v as ThinkingLevel))}
              >
                <SelectTrigger size="sm" className="h-6 w-auto text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">auto</SelectItem>
                  {thinkingLevels.map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <span className={cn("text-[10px] transition-colors", nearLimit ? "text-coral" : "text-neutral-300")}>
              {nearLimit
                ? `${value.length}/${maxLength}`
                : value.length === 0
                  ? "Enter 发送 · Shift+Enter 换行"
                  : ""}
            </span>
          </div>
          <div className="flex gap-1.5">
            {isRunning && !value.trim() ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 border-coral/30 px-3 text-xs text-coral hover:bg-coral/10"
                onClick={onCancelRun}
                disabled={!onCancelRun}
                aria-label="停止运行"
              >
                <Square className="h-3 w-3" />
                停止
              </Button>
            ) : (
              <Button
                type="submit"
                size="sm"
                className="h-8 gap-1.5 bg-moss px-3 text-xs text-white shadow-sm shadow-moss/20 hover:bg-moss/90 active:shadow-none"
                disabled={!value.trim() || (disabled && !isRunning)}
              >
                {disabled && !isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                发送
              </Button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
