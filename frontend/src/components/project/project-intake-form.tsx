"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { motion } from "framer-motion"
import {
  Loader2,
  Lightbulb,
  CheckCircle2,
  AlertCircle,
  BookOpen,
  Trophy,
  Rocket,
  FlaskConical,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent } from "@/components/ui/card"
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
  const router = useRouter()
  const [resources, setResources] = React.useState<AddResourceRequest[]>([])
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [created, setCreated] = React.useState<Project | null>(null)
  const [errors, setErrors] = React.useState<Record<string, string>>({})

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

  const validate = (): boolean => {
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
  }

  const clearDraft = () => {
    localStorage.removeItem(DRAFT_KEY)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return
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
        } catch {
          failedResources.push(res.title || "untitled")
        }
      }
      if (failedResources.length > 0) {
        setError(
          `项目已创建，但 ${failedResources.length} 个资源保存失败: ${failedResources.join(", ")}`
        )
      }
      setCreated(project)
      clearDraft()
      onCreated?.(project)
    } catch {
      setError("创建项目失败，请重试")
    } finally {
      setSubmitting(false)
    }
  }

  if (created) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto max-w-2xl p-4"
      >
        <Card className="border-green-200 bg-green-50/50 dark:bg-green-950/20">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <CheckCircle2 className="h-10 w-10 text-green-600" />
            <p className="text-lg font-bold">项目创建成功</p>
            <p className="text-sm text-muted-foreground">{created.name}</p>
            <p className="text-xs font-mono text-muted-foreground/60">
              {created.id}
            </p>
            <Button
              className="mt-2"
              onClick={() => router.push(`/projects/${created.id}`)}
            >
              进入项目
            </Button>
          </CardContent>
        </Card>
      </motion.div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto max-w-2xl space-y-6 p-4"
    >
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Lightbulb className="h-6 w-6 text-amber-500" />
          新建项目
        </h1>
        <p className="text-sm text-muted-foreground">
          填写项目信息，AI 将为你生成阶段规划和任务分解
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <FormSection title="项目基本信息">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="项目名称" required error={errors.name}>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (errors.name)
                    setErrors((prev) => ({ ...prev, name: "" }))
                }}
                placeholder="例如：校园二手交易平台"
                className="h-10"
              />
            </FormField>
            <FormField label="截止日期" required error={errors.deadline}>
              <Input
                type="date"
                value={deadline}
                onChange={(e) => {
                  setDeadline(e.target.value)
                  if (errors.deadline)
                    setErrors((prev) => ({ ...prev, deadline: "" }))
                }}
                className="h-10"
              />
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
                if (errors.idea)
                  setErrors((prev) => ({ ...prev, idea: "" }))
              }}
              placeholder="我们想做一款帮助大学生..."
              rows={4}
              className="resize-none"
            />
          </FormField>
          <FormField label="创建者 ID" required error={errors.createdBy}>
            <Input
              value={createdBy}
              onChange={(e) => {
                setCreatedBy(e.target.value)
                if (errors.createdBy)
                  setErrors((prev) => ({ ...prev, createdBy: "" }))
              }}
              placeholder="UUID of project creator"
              disabled={!!defaultCreatedBy}
              className="h-10"
            />
          </FormField>
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

          <div className="grid gap-4 sm:grid-cols-2">
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
            onClick={() => {
              clearDraft()
              setName("")
              setIdea("")
              setDeadline("")
              setProjectType("")
              setTeamSize("")
              setDeliverableTags([])
              setCreatedBy(defaultCreatedBy || "")
              setErrors({})
              setError(null)
            }}
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
    </motion.div>
  )
}
