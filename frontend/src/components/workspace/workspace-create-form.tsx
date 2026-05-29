"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { motion } from "framer-motion"
import {
  Loader2,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
  Users,
  Briefcase,
  GraduationCap,
  Lightbulb,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent } from "@/components/ui/card"
import { createWorkspace } from "@/lib/api"
import type { Workspace } from "@/lib/types"
import { StepIndicator } from "@/components/ui/step-indicator"
import { FormField } from "@/components/ui/form-field"
import { cn } from "@/lib/utils"

const USE_CASES = [
  { id: "course", label: "课程", icon: GraduationCap },
  { id: "competition", label: "比赛", icon: Briefcase },
  { id: "startup", label: "创业", icon: Lightbulb },
  { id: "other", label: "其他", icon: Users },
] as const

const TEAM_SIZES = [
  { id: "1-2", label: "1-2 人" },
  { id: "3-5", label: "3-5 人" },
  { id: "6-10", label: "6-10 人" },
  { id: "10+", label: "10+ 人" },
] as const

interface WorkspaceCreateFormProps {
  ownerUserId?: string
  onCreated?: (workspace: Workspace) => void
}

export function WorkspaceCreateForm({
  ownerUserId,
  onCreated,
}: WorkspaceCreateFormProps) {
  const router = useRouter()
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [ownerId, setOwnerId] = React.useState(ownerUserId ?? "")
  const [step, setStep] = React.useState(0)
  const [teamSize, setTeamSize] = React.useState("")
  const [useCase, setUseCase] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [created, setCreated] = React.useState<Workspace | null>(null)
  const [errors, setErrors] = React.useState<Record<string, string>>({})

  const steps = [
    { label: "基本信息", description: "工作区名称和描述" },
    { label: "团队上下文", description: "规模和场景" },
  ]

  const validateStep = (s: number): boolean => {
    const newErrors: Record<string, string> = {}
    if (s === 0) {
      if (!name.trim()) newErrors.name = "请输入工作区名称"
      else if (name.trim().length < 2) newErrors.name = "至少 2 个字符"
      if (!ownerId.trim()) newErrors.ownerId = "请输入所有者 ID"
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validateStep(1)) return
    setSubmitting(true)
    setError(null)
    try {
      const ws = await createWorkspace({
        name: name.trim(),
        owner_user_id: ownerId.trim(),
        description: description.trim() || null,
      })
      setCreated(ws)
      onCreated?.(ws)
    } catch {
      setError("创建工作区失败，请重试")
    } finally {
      setSubmitting(false)
    }
  }

  if (created) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto max-w-lg p-4"
      >
        <Card className="border-green-200 bg-green-50/50 dark:bg-green-950/20">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <CheckCircle2 className="h-10 w-10 text-green-600" />
            <p className="text-lg font-bold">工作区创建成功</p>
            <p className="text-sm text-muted-foreground">{created.name}</p>
            <p className="text-xs font-mono text-muted-foreground/60">
              {created.workspace_id}
            </p>
            <Button
              className="mt-2"
              onClick={() =>
                router.push(
                  `/onboarding/profile?userId=${ownerId}&workspaceId=${created.workspace_id}`
                )
              }
            >
              完善成员资料
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
      className="mx-auto max-w-lg space-y-6 p-4"
    >
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <FolderOpen className="h-6 w-6 text-emerald-500" />
          创建工作区
        </h1>
        <p className="text-sm text-muted-foreground">
          为你的团队创建一个协作空间
        </p>
      </div>

      <StepIndicator steps={steps} currentStep={step} />

      <form onSubmit={handleSubmit} className="space-y-4">
        {step === 0 && (
          <div className="space-y-4">
            <FormField label="工作区名称" required error={errors.name}>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (errors.name)
                    setErrors((prev) => ({ ...prev, name: "" }))
                }}
                placeholder="例如：2024 春季开发小队"
                className="h-10"
              />
            </FormField>
            <FormField label="工作区描述" hint="简单描述团队或项目方向">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="我们是一个专注于..."
                rows={3}
                className="resize-none"
              />
            </FormField>
            <FormField label="所有者 ID" required error={errors.ownerId}>
              <Input
                value={ownerId}
                onChange={(e) => {
                  setOwnerId(e.target.value)
                  if (errors.ownerId)
                    setErrors((prev) => ({ ...prev, ownerId: "" }))
                }}
                placeholder="UUID of the team lead"
                disabled={!!ownerUserId}
                className="h-10"
              />
            </FormField>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <FormField label="团队规模" hint="预计参与人数">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {TEAM_SIZES.map((size) => (
                  <button
                    key={size.id}
                    type="button"
                    onClick={() => setTeamSize(size.id)}
                    className={cn(
                      "rounded-lg border-2 px-3 py-2 text-sm font-medium transition-colors",
                      teamSize === size.id
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-muted hover:border-muted-foreground/30"
                    )}
                  >
                    {size.label}
                  </button>
                ))}
              </div>
            </FormField>

            <FormField label="主要场景" hint="你们主要做什么类型的项目">
              <div className="grid grid-cols-2 gap-3">
                {USE_CASES.map((uc) => {
                  const Icon = uc.icon
                  return (
                    <button
                      key={uc.id}
                      type="button"
                      onClick={() => setUseCase(uc.id)}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border-2 px-3 py-2 text-sm font-medium transition-colors",
                        useCase === uc.id
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-muted hover:border-muted-foreground/30"
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {uc.label}
                    </button>
                  )
                })}
              </div>
            </FormField>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setStep(Math.max(0, step - 1))}
            disabled={step === 0}
          >
            上一步
          </Button>
          {step < steps.length - 1 ? (
            <Button
              type="button"
              onClick={() => {
                if (validateStep(step)) setStep(step + 1)
              }}
            >
              下一步 &rarr;
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={submitting || !name.trim() || !ownerId.trim()}
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  创建中...
                </>
              ) : (
                "创建工作区"
              )}
            </Button>
          )}
        </div>
      </form>
    </motion.div>
  )
}
