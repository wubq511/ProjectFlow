"use client";

import { cleanJsonString } from "@/lib/utils";
import { MultilineText } from "@/components/ui/multiline-text";

/**
 * Display match text with label, stripping duplicate label prefix from the value.
 */
export function MatchText({ label, text }: { label: string; text: string }) {
  let cleanedText = cleanJsonString(text);

  const labelWithoutColon = label.replace(/[：:]$/, '');
  const prefixRegex = new RegExp(`^${labelWithoutColon}[：:]\\s*`);
  if (prefixRegex.test(cleanedText)) {
    cleanedText = cleanedText.replace(prefixRegex, '');
  }

  return (
    <div>
      <span className="font-semibold text-ink/70">{label}</span>
      <MultilineText text={cleanedText} />
    </div>
  );
}
