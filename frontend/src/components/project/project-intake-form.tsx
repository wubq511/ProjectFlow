"use client"

import * as React from "react"
import { motion } from "framer-motion"
import {
  Loader2,
  Lightbulb,
  AlertCircle,
  BookOpen,
  Trophy,
  Rocket,
  FlaskConical,
  CalendarIcon,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { createProject, addResource } from "@/lib/api"
import type { Project, AddResourceRequest } from "@/lib/types"
import { ResourceInputPanel } from "./resource-input-panel"
import { FormSection } from "@/components/ui/form-section"
import { FormField } from "@/components/ui/form-field"
import { TagInput } from "@/components/ui/tag-input"
import { cn } from "@/lib/utils"

const PROJECT_TYPES = [
  { id: "coursework", label: "课程作业", icon: BookOpen },
  { id: "competition", label: "比赛", icon: Trophy },
  { id: "startup", label: "创业", icon: Rocket },
  { id: "research", label: "研究", icon: FlaskConical },
] as const

type ProjectType = (typeof PROJECT_TYPES)[number]["id"]

interface DraftData {
  name: string
  idea: string
  deadline: string
  projectType: ProjectType | ""
  teamSize: string
  deliverables: string[]
  createdBy: string
}

const DRAFT_KEY = "project-intake-draft"

interface ProjectIntakeFormProps {
  workspaceId: string
  defaultCreatedBy?: string
  onCreated?: (project: Project) => void
}

export function ProjectIntakeForm({
  workspaceId,
  defaultCreatedBy,
  onCreated,
}: ProjectIntakeFormProps) {
  const [resources, setResources] = React.useState<AddResourceRequest[]>([])
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [touched, setTouched] = React.useState<Record<string, boolean>>({})

  // Load draft from localStorage on mount
  const [name, setName] = React.useState(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY)
      if (draft) {
        const data: DraftData = JSON.parse(draft)
        return data.name || ""
      }
    } catch { /* ignore */ }
    return ""
  })
  const [idea, setIdea] = React.useState(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY)
      if (draft) {
        const data: DraftData = JSON.parse(draft)
        return data.idea || ""
      }
    } catch { /* ignore */ }
    return ""
  })
  const [deadline, setDeadline] = React.useState(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY)
      if (draft) {
        const data: DraftData = JSON.parse(draft)
        return data.deadline || ""
      }
    } catch { /* ignore */ }
    return ""
  })
  const [projectType, setProjectType] = React.useState<ProjectType | "">(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY)
      if (draft) {
        const data: DraftData = JSON.parse(draft)
        return data.projectType || ""
      }
    } catch { /* ignore */ }
    return ""
  })
  const [teamSize, setTeamSize] = React.useState(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY)
      if (draft) {
        const data: DraftData = JSON.parse(draft)
        return data.teamSize || ""
      }
    } catch { /* ignore */ }
    return ""
  })
  const [deliverableTags, setDeliverableTags] = React.useState<string[]>(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY)
      if (draft) {
        const data: DraftData = JSON.parse(draft)
        return data.deliverables || []
      }
    } catch { /* ignore */ }
    return []
  })
  const [createdBy, setCreatedBy] = React.useState(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY)
      if (draft) {
        const data: DraftData = JSON.parse(draft)
        return data.createdBy || defaultCreatedBy || ""
      }
    } catch { /* ignore */ }
    return defaultCreatedBy || ""
  })

  // Auto-save draft
  React.useEffect(() => {
    const draft: DraftData = {
      name,
      idea,
      deadline,
      projectType,
      teamSize,
      deliverables: deliverableTags,
      createdBy,
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  }, [name, idea, deadline, projectType, teamSize, deliverableTags, createdBy])

  const validate = React.useCallback((): boolean => {
    const newErrors: Record<string, string> = {}
    if (!name.trim()) {
      newErrors.name = "请输入项目名称"
    } else if (name.trim().length < 2) {
      newErrors.name = "项目名称至少 2 个字符"
    } else if (name.trim().length > 50) {
      newErrors.name = "项目名称最多 50 个字符"
    }

    if (!idea.trim()) {
      newErrors.idea = "请输入项目想法"
    } else if (idea.trim().length < 10) {
      newErrors.idea = "项目想法至少 10 个字符"
    } else if (idea.trim().length > 500) {
      newErrors.idea = "项目想法最多 500 个字符"
    }

    if (!deadline) {
      newErrors.deadline = "请选择截止日期"
    } else {
      const deadlineDate = new Date(deadline)
      const now = new Date()
      now.setHours(0, 0, 0, 0)
      if (deadlineDate < now) {
        newErrors.deadline = "截止日期必须在今天之后"
      }
    }

    if (!createdBy.trim()) {
      newErrors.createdBy = "请输入创建者 ID"
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }, [name, idea, deadline, createdBy])

  const validateField = React.useCallback((field: string, value: string) => {
    const newErrors: Record<string, string> = {}
    if (field === "name") {
      if (!value.trim()) {
        newErrors.name = "请输入项目名称"
      } else if (value.trim().length < 2) {
        newErrors.name = "项目名称至少 2 个字符"
      } else if (value.trim().length > 50) {
        newErrors.name = "项目名称最多 50 个字符"
      }
    }
    if (field === "idea") {
      if (!value.trim()) {
        newErrors.idea = "请输入项目想法"
      } else if (value.trim().length < 10) {
        newErrors.idea = "项目想法至少 10 个字符"
      } else if (value.trim().length > 500) {
        newErrors.idea = "项目想法最多 500 个字符"
      }
    }
    if (field === "deadline") {
      if (!value) {
        newErrors.deadline = "请选择截止日期"
      } else {
        const deadlineDate = new Date(value)
        const now = new Date()
        now.setHours(0, 0, 0, 0)
        if (deadlineDate < now) {
          newErrors.deadline = "截止日期必须在今天之后"
        }
      }
    }
    if (field === "createdBy" && !value.trim()) {
      newErrors.createdBy = "请输入创建者 ID"
    }
    setErrors((prev) => ({ ...prev, ...newErrors }))
  }, [])

  const clearDraft = () => {
    localStorage.removeItem(DRAFT_KEY);
  };

  const [showClearConfirm, setShowClearConfirm] = React.useState(false);



  const handleClear = () => {
    setShowClearConfirm(true);
  };

  const confirmClear = () => {
    clearDraft();
    setName("");
    setIdea("");
    setDeadline("");
    setProjectType("");
    setTeamSize("");
    setDeliverableTags([]);
    setCreatedBy(defaultCreatedBy || "");
    setErrors({});
    setError(null);
    setResources([]); // 确保资源也被清空
    setShowClearConfirm(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) {
      setTimeout(() => {
        const firstErrorElement = document.querySelector('.border-destructive');
        if (firstErrorElement) {
          firstErrorElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          (firstErrorElement as HTMLElement).focus?.();
        }
      }, 0);
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const deliverablesStr =
        deliverableTags.length > 0
          ? deliverableTags.join(", ")
          : "待补充"
      const project = await createProject(workspaceId, {
        name: name.trim(),
        idea: idea.trim(),
        deadline,
        deliverables: deliverablesStr,
        created_by: createdBy.trim(),
      })
      // Add resources if any
      const failedResources: string[] = []
      for (const res of resources) {
        try {
          await addResource(project.id, res)
        } catch (err) {
          console.error(`资源"${res.title || 'untitled'}"保存失败:`, err)
          failedResources.push(res.title || "untitled")
        }
      }
      if (failedResources.length > 0) {
        setError(
          `项目已创建，但 ${failedResources.length} 个资源保存失败: ${failedResources.join(", ")}`
        )
      }
      clearDraft()
      onCreated?.(project)
    } catch {
      setError("创建项目失败，请重试")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto max-w-2xl space-y-6 p-4"
    >
      <div>
        <h2 className="flex items-center gap-2 text-2xl font-bold">
          <Lightbulb className="h-6 w-6 text-amber-500" />
          新建项目
        </h2>
        <p className="text-sm text-muted-foreground">
          填写项目信息，AI 将为你生成阶段规划和任务分解
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <FormSection title="项目基本信息">
          <div className="grid gap-4">
            <FormField label="项目名称" required error={errors.name}>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (touched.name) validateField("name", e.target.value)
                }}
                onBlur={() => {
                  setTouched((prev) => ({ ...prev, name: true }))
                  validateField("name", name)
                }}
                placeholder="例如：校园二手交易平台"
                className={cn("h-10", errors.name && "border-destructive")}
              />
            </FormField>
            <FormField label="截止日期" required error={errors.deadline}>
              <div className="relative">
                <Input
                  type="date"
                  value={deadline}
                  onChange={(e) => {
                    setDeadline(e.target.value)
                    if (touched.deadline) validateField("deadline", e.target.value)
                  }}
                  onBlur={() => {
                    setTouched((prev) => ({ ...prev, deadline: true }))
                    validateField("deadline", deadline)
                  }}
                  className={cn("h-10 pr-10", errors.deadline && "border-destructive")}
                />
                <CalendarIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </FormField>
          </div>
          <FormField
            label="项目想法"
            required
            error={errors.idea}
            hint="描述项目背景、目标和预期成果"
          >
            <Textarea
              value={idea}
              onChange={(e) => {
                setIdea(e.target.value)
                if (touched.idea) validateField("idea", e.target.value)
              }}
              onBlur={() => {
                setTouched((prev) => ({ ...prev, idea: true }))
                validateField("idea", idea)
              }}
              placeholder="我们想做一款帮助大学生..."
              rows={4}
              className={cn("resize-none", errors.idea && "border-destructive")}
            />
          </FormField>
          {!defaultCreatedBy && (
            <FormField label="创建者 ID" required error={errors.createdBy}>
              <Input
                value={createdBy}
                onChange={(e) => {
                  setCreatedBy(e.target.value)
                  if (touched.createdBy) validateField("createdBy", e.target.value)
                }}
                onBlur={() => {
                  setTouched((prev) => ({ ...prev, createdBy: true }))
                  validateField("createdBy", createdBy)
                }}
                placeholder="选填，默认使用当前用户"
                className={cn("h-10", errors.createdBy && "border-destructive")}
              />
            </FormField>
          )}
        </FormSection>

        <FormSection title="项目详情">
          <FormField label="项目类型">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {PROJECT_TYPES.map((type) => {
                const Icon = type.icon
                const isSelected = projectType === type.id
                return (
                  <button
                    key={type.id}
                    type="button"
                    onClick={() => setProjectType(type.id)}
                    className={cn(
                      "flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-colors",
                      isSelected
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-muted bg-background hover:border-muted-foreground/30"
                    )}
                  >
                    <Icon className="h-6 w-6" />
                    <span className="text-sm font-medium">{type.label}</span>
                  </button>
                )
              })}
            </div>
          </FormField>

          <div className="grid gap-4">
            <FormField label="团队规模" hint="预计参与人数">
              <Input
                type="number"
                min={1}
                max={50}
                value={teamSize}
                onChange={(e) => setTeamSize(e.target.value)}
                placeholder="例如：5"
                className="h-10"
              />
            </FormField>
            <FormField label="预期交付物" hint="项目最终要产出什么">
              <TagInput
                tags={deliverableTags}
                onTagsChange={setDeliverableTags}
                placeholder="输入后按回车添加"
                maxTags={8}
              />
            </FormField>
          </div>
        </FormSection>

        <FormSection title="资源与约束" collapsible defaultOpen={false}>
          <ResourceInputPanel onChange={setResources} />
        </FormSection>

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleClear}
          >
            清空
          </Button>
          <Button
            type="submit"
            disabled={
              submitting ||
              !name.trim() ||
              !idea.trim() ||
              !deadline ||
              !createdBy.trim()
            }
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                创建中...
              </>
            ) : (
              <>开始规划 &rarr;</>
            )}
          </Button>
        </div>
      </form>

      <AlertDialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认清空表单？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作将清空所有已填写的信息，且不可撤销。您确定要继续吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={confirmClear}>清空</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  )
}
