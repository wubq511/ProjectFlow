import {
  BookOpen,
  FlaskConical,
  FolderKanban,
  Rocket,
  Trophy,
  type LucideIcon,
} from "lucide-react";

import type { ProjectTemplate } from "@/lib/types";

export type ProjectTemplateOption = {
  id: ProjectTemplate;
  label: string;
  icon: LucideIcon;
};

export const PROJECT_TEMPLATE_OPTIONS: readonly ProjectTemplateOption[] = [
  { id: "general", label: "通用项目", icon: FolderKanban },
  { id: "coursework", label: "课程作业", icon: BookOpen },
  { id: "competition", label: "比赛", icon: Trophy },
  { id: "startup", label: "创业", icon: Rocket },
  { id: "research", label: "研究", icon: FlaskConical },
];

export const PROJECT_TEMPLATE_LABELS = Object.fromEntries(
  PROJECT_TEMPLATE_OPTIONS.map(({ id, label }) => [id, label]),
) as Record<ProjectTemplate, string>;
