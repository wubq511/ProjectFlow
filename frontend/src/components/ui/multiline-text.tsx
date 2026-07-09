"use client";

import { Fragment } from "react";
import { splitProseLines, parseInlineMarkdown } from "@/lib/utils";

type MultilineTextProps = {
  text: string;
  className?: string;
  as?: "div" | "p";
};

function renderLine(line: string) {
  const segments = parseInlineMarkdown(line);
  return segments.map((seg, i) =>
    seg.bold ? <strong key={i}>{seg.text}</strong> : <Fragment key={i}>{seg.text}</Fragment>,
  );
}

export function MultilineText({ text, className, as = "p" }: MultilineTextProps) {
  if (!text || typeof text !== "string") return null;
  const lines = splitProseLines(text);
  if (lines.length <= 1) {
    const Tag = as;
    return <Tag className={className}>{renderLine(text)}</Tag>;
  }
  const Tag = as;
  return (
    <Tag className={className}>
      {lines.map((line, i) => (
        <span key={i} className={i > 0 ? "block mt-0.5" : "block"}>
          {renderLine(line)}
        </span>
      ))}
    </Tag>
  );
}
