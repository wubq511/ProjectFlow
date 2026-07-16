"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import remarkGfm from "remark-gfm";

const ReactMarkdown = dynamic(() => import("react-markdown"), { ssr: false });

/**
 * Convert (1)...(2)...(3) inline-numbered prose into a markdown ordered list
 * so that react-markdown renders each point on its own line.
 */
function normalizeNumberedProse(text: string): string {
  // Already has markdown list syntax — leave as-is
  if (/^\d+\.\s/m.test(text)) return text;
  // Convert (1)xxx(2)yyy(3)zzz → 1. xxx\n2. yyy\n3. zzz
  const numbered = /\(\d+\)/g;
  if (!numbered.test(text)) return text;
  numbered.lastIndex = 0;
  // Split on (N) markers
  const parts = text.split(/(?=\(\d+\))/g);
  if (parts.length <= 1) return text;
  const cleaned = parts
    .map((s) => s.replace(/^\(\d+\)\s*/, "").trim())
    .filter(Boolean);
  if (cleaned.length <= 1) return text;
  // Also handle the prefix before the first (1)
  const prefixMatch = text.match(/^([^(]+)\(\d+\)/);
  const prefix = prefixMatch ? prefixMatch[1].trim() : "";
  const body = cleaned.map((line, i) => `${i + 1}. ${line}`).join("\n");
  return prefix ? `${prefix}\n\n${body}` : body;
}

/** Stable components object — defined at module level to avoid re-creation on every render. */
const MARKDOWN_COMPONENTS = {
  ol: ({ children, ...props }: React.ComponentProps<"ol">) => (
    <ol className="list-decimal pl-4 space-y-0.5" {...props}>{children}</ol>
  ),
  ul: ({ children, ...props }: React.ComponentProps<"ul">) => (
    <ul className="list-disc pl-4 space-y-0.5" {...props}>{children}</ul>
  ),
  li: ({ children, ...props }: React.ComponentProps<"li">) => (
    <li className="text-xs leading-5" {...props}>{children}</li>
  ),
  p: ({ children, ...props }: React.ComponentProps<"p">) => (
    <p className="text-xs leading-5" {...props}>{children}</p>
  ),
  strong: ({ children, ...props }: React.ComponentProps<"strong">) => (
    <strong className="font-semibold" {...props}>{children}</strong>
  ),
  code: ({ children, className, ...props }: React.ComponentProps<"code"> & { className?: string }) => {
    const isInline = !className;
    if (isInline) {
      return <code className="rounded bg-neutral-200/60 px-1 py-0.5 text-[11px]" {...props}>{children}</code>;
    }
    return (
      <pre className="my-1 overflow-x-auto rounded-md bg-neutral-200/60 p-2">
        <code className="text-[11px]" {...props}>{children}</code>
      </pre>
    );
  },
  table: ({ children, ...props }: React.ComponentProps<"table">) => (
    <div className="my-1 overflow-x-auto">
      <table className="text-xs" {...props}>{children}</table>
    </div>
  ),
  th: ({ children, ...props }: React.ComponentProps<"th">) => (
    <th className="border-b border-neutral-200 px-2 py-1 text-left font-semibold" {...props}>{children}</th>
  ),
  td: ({ children, ...props }: React.ComponentProps<"td">) => (
    <td className="border-b border-neutral-100 px-2 py-1" {...props}>{children}</td>
  ),
} as const;

interface MarkdownContentProps {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className }: MarkdownContentProps) {
  const normalized = useMemo(() => normalizeNumberedProse(content), [content]);

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={MARKDOWN_COMPONENTS}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
