"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import remarkGfm from "remark-gfm";

const ReactMarkdown = dynamic(() => import("react-markdown"), { ssr: false });

/**
 * Compact markdown renderer for the process/activity area.
 * Headings degrade to compact body text (no large titles), preserving
 * semantic formatting (lists, bold, inline code, tables) without
 * visual weight competing with the answer area.
 */
interface ProcessMarkdownProps {
  content: string;
  className?: string;
}

export function ProcessMarkdown({ content, className }: ProcessMarkdownProps) {
  const normalized = useMemo(() => normalizeNumberedProse(content), [content]);

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Headings degrade to compact body — no large titles in process area
          h1: ({ children, ...props }) => (
            <p className="text-[13px] leading-relaxed font-medium text-neutral-700 dark:text-neutral-300 mt-1 mb-0.5" {...props}>{children}</p>
          ),
          h2: ({ children, ...props }) => (
            <p className="text-[13px] leading-relaxed font-medium text-neutral-700 dark:text-neutral-300 mt-1 mb-0.5" {...props}>{children}</p>
          ),
          h3: ({ children, ...props }) => (
            <p className="text-[13px] leading-relaxed font-medium text-neutral-600 dark:text-neutral-400 mt-0.5 mb-0.5" {...props}>{children}</p>
          ),
          h4: ({ children, ...props }) => (
            <p className="text-[13px] leading-relaxed font-medium text-neutral-600 dark:text-neutral-400 mt-0.5 mb-0.5" {...props}>{children}</p>
          ),
          h5: ({ children, ...props }) => (
            <p className="text-[13px] leading-relaxed font-medium text-neutral-600 dark:text-neutral-400 mt-0.5 mb-0.5" {...props}>{children}</p>
          ),
          h6: ({ children, ...props }) => (
            <p className="text-[13px] leading-relaxed font-medium text-neutral-600 dark:text-neutral-400 mt-0.5 mb-0.5" {...props}>{children}</p>
          ),
          p: ({ children, ...props }) => (
            <p className="text-[13px] leading-relaxed text-neutral-600 dark:text-neutral-400" {...props}>{children}</p>
          ),
          ol: ({ children, ...props }) => (
            <ol className="list-decimal pl-4 space-y-0.5" {...props}>{children}</ol>
          ),
          ul: ({ children, ...props }) => (
            <ul className="list-disc pl-4 space-y-0.5" {...props}>{children}</ul>
          ),
          li: ({ children, ...props }) => (
            <li className="text-[13px] leading-relaxed text-neutral-600 dark:text-neutral-400" {...props}>{children}</li>
          ),
          strong: ({ children, ...props }) => (
            <strong className="font-semibold text-neutral-700 dark:text-neutral-300" {...props}>{children}</strong>
          ),
          em: ({ children, ...props }) => (
            <em className="italic" {...props}>{children}</em>
          ),
          code: ({ children, className: codeClassName, ...props }) => {
            const isInline = !codeClassName;
            if (isInline) {
              return (
                <code
                  className="rounded bg-neutral-200/60 dark:bg-neutral-700/50 px-1 py-0.5 text-[11px] font-mono"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <pre className="my-1 overflow-x-auto rounded-md bg-neutral-200/60 dark:bg-neutral-700/50 p-2">
                <code className="text-[11px] font-mono" {...props}>{children}</code>
              </pre>
            );
          },
          hr: () => (
            <hr className="my-2 border-neutral-200 dark:border-neutral-700" />
          ),
          table: ({ children, ...props }) => (
            <div className="my-1 overflow-x-auto">
              <table className="text-[11px] border-collapse" {...props}>{children}</table>
            </div>
          ),
          th: ({ children, ...props }) => (
            <th className="border-b border-neutral-200 dark:border-neutral-700 px-2 py-1 text-left font-semibold text-neutral-600 dark:text-neutral-400" {...props}>{children}</th>
          ),
          td: ({ children, ...props }) => (
            <td className="border-b border-neutral-100 dark:border-neutral-800 px-2 py-1 text-neutral-600 dark:text-neutral-400" {...props}>{children}</td>
          ),
          blockquote: ({ children, ...props }) => (
            <blockquote
              className="border-l-2 border-neutral-300 dark:border-neutral-600 pl-3 my-1 text-neutral-500 dark:text-neutral-500"
              {...props}
            >
              {children}
            </blockquote>
          ),
          a: ({ children, ...props }) => (
            <a className="text-moss underline underline-offset-2" {...props}>{children}</a>
          ),
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Convert (1)...(2)...(3) inline-numbered prose into a markdown ordered list.
 */
function normalizeNumberedProse(text: string): string {
  if (/^\d+\.\s/m.test(text)) return text;
  const numbered = /\(\d+\)/g;
  if (!numbered.test(text)) return text;
  numbered.lastIndex = 0;
  const parts = text.split(/(?=\(\d+\))/g);
  if (parts.length <= 1) return text;
  const cleaned = parts
    .map((s) => s.replace(/^\(\d+\)\s*/, "").trim())
    .filter(Boolean);
  if (cleaned.length <= 1) return text;
  const prefixMatch = text.match(/^([^(]+)\(\d+\)/);
  const prefix = prefixMatch ? prefixMatch[1].trim() : "";
  const body = cleaned.map((line, i) => `${i + 1}. ${line}`).join("\n");
  return prefix ? `${prefix}\n\n${body}` : body;
}
