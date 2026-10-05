import { Database } from "lucide-react";

import type { EvidenceRef } from "@/lib/types";
import { translateStatus } from "@/lib/utils";

const FIELD_LABELS: Record<string, string> = {
  skills: "技能",
  hours: "可用时间",
  available_hours: "可用时间",
  available_hours_per_week: "每周可用时间",
  status: "状态",
  deadline: "截止日期",
  due_date: "截止日期",
  blocker: "阻塞",
  priority: "优先级",
  constraints: "成员限制",
};

function fieldLabel(field: string) {
  return FIELD_LABELS[field] ?? field.replaceAll("_", " ");
}

export function EvidenceRefList({ refs }: { refs?: EvidenceRef[] }) {
  if (!refs?.length) return null;

  return (
    <div className="mt-3 rounded-md bg-primary/5 px-3 py-2" aria-label="结构化依据">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
        <Database className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        结构化依据
      </p>
      <ul className="mt-1.5 space-y-1">
        {refs.map((ref, index) => (
          <li key={`${ref.entity_type}-${ref.field}-${index}`} className="break-words text-xs text-ink/65">
            <span className="font-medium text-ink/75">{fieldLabel(ref.field)}：</span>
            {translateStatus(ref.value)}
          </li>
        ))}
      </ul>
    </div>
  );
}
