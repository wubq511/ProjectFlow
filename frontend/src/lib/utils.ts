import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Parse inline markdown-level formatting (**bold**) and return an array of
 * { text, bold } segments suitable for rendering.
 */
export type TextSegment = { text: string; bold: boolean };

const RE_BOLD = /\*\*(.+?)\*\*/g;

export function parseInlineMarkdown(text: string): TextSegment[] {
  if (!text) return [];
  const segments: TextSegment[] = [];
  let lastIndex = 0;
  // Reset lastIndex in case this global regex was used elsewhere
  RE_BOLD.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RE_BOLD.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), bold: false });
    }
    segments.push({ text: match[1], bold: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), bold: false });
  }
  return segments.length > 0 ? segments : [{ text, bold: false }];
}

export function cleanJsonString(text: string) {
  if (!text) return text;
  return text.replace(/\{['"]name['"]:\s*['"]([^'"]+)['"][^}]*\}/g, '$1');
}

/**
 * Smart line-break for prose text that may contain numbered points like (1)(2) or
 * literal \n. Always split on \n first, then split on parenthesized numbers (1)/(2)
 * when they appear mid-text.
 */
const RE_NUMBERED_POINT = /(?:\s*)(?=\(\d+\))/g;

export function splitProseLines(text: string): string[] {
  if (!text) return [];
  // First: normalize all line separators to \n
  let normalized = text;
  if (text.includes("\\n")) {
    normalized = text.replace(/\\n/g, "\n");
  }
  // Second: split on explicit newlines
  const rawLines = normalized.includes("\n")
    ? normalized.split("\n").map((s) => s.trim()).filter(Boolean)
    : [normalized];
  // Third: within each raw line, also split on (N) markers
  const result: string[] = [];
  for (const line of rawLines) {
    const subParts = line.split(RE_NUMBERED_POINT).filter((s) => s.trim());
    if (subParts.length > 1) {
      for (const part of subParts) {
        result.push(part.trim());
      }
    } else {
      result.push(line);
    }
  }
  // Post-split: break long lines on Chinese semicolons
  const final: string[] = [];
  for (const line of result) {
    if (line.includes("；") && line.length > 20) {
      final.push(...line.split(/；\s*/).map(s => s.trim()).filter(Boolean));
    } else {
      final.push(line);
    }
  }
  if (final.length > 1) return final;

  // Fallback: split on bullet points
  const bulletedParts = normalized.split(/(?=(?:^|\s)[-•]\s+)/).filter((s) => s.trim());
  if (bulletedParts.length > 1) {
    return bulletedParts.map((s) => s.trim()).filter(Boolean);
  }
  // Fallback: split on "1. " / "2. " numbered lists
  const dotNumberedParts = normalized.split(/(?=\d+\.\s+)/).filter((s) => s.trim());
  if (dotNumberedParts.length > 1) {
    return dotNumberedParts.map((s) => s.trim()).filter(Boolean);
  }
  // Fallback: split on Chinese semicolons in long text
  if (normalized.includes("；") && normalized.length > 30) {
    return normalized.split(/；\s*/).map((s) => s.trim()).filter(Boolean);
  }
  return [normalized];
}

/* ------------------------------------------------------------------ */
/*  Shared Status Translation                                          */
/* ------------------------------------------------------------------ */

/** All known English status/enum/type values and their Chinese equivalents.
 *  Imported by frontend components to avoid inline translation tables. */
const STATUS_TRANSLATIONS: Record<string, string> = {
  // Task status
  not_started: "未开始", in_progress: "进行中", done: "已完成", blocked: "受阻", cancelled: "已取消",
  // Stage / Project status
  active: "进行中", pending: "待开始", completed: "已完成", at_risk: "有风险", draft: "草稿",
  // Severity / Mood
  high: "高", medium: "中", low: "低",
  // Risk status
  open: "待处理", accepted: "已接受", ignored: "已忽略", resolved: "已解决",
  // Assignment proposal status
  proposed: "待确认", owner_confirmed: "已确认", owner_rejected: "已拒绝",
  negotiating: "协商中", finalized: "已定稿",
  // Checkin
  paused: "已暂停",
  // Resource type
  text_note: "文本笔记", file_stub: "文件", link: "链接",
  // Risk type
  deadline: "截止风险", dependency: "依赖风险", workload: "工作量风险",
  scope: "范围风险", review: "评审风险", assignment: "分工风险", checkin: "签到风险",
  // Response
  accept: "接受", reject: "拒绝",
  // ActionCard type
  personal_task: "个人任务", team_next_step: "下一步", reminder: "提醒",
  risk_action: "风险应对", kickoff_tip: "启动提示", checkin_prompt: "签到提醒",
  assignment_request: "分工请求", suggestion: "建议",
  // ActionCard status
  dismissed: "已忽略",
};

/**
 * Translate a known English status/enum/type value to Chinese.
 * Returns the original value if no translation exists.
 */
export function translateStatus(value: string | null | undefined): string {
  if (!value) return "";
  return STATUS_TRANSLATIONS[value] ?? value;
}
