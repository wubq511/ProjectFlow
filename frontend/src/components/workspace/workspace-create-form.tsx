"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { motion } from "framer-motion"
import {
  Loader2,
  FolderOpen,
  AlertCircle,
  Users,
  Briefcase,
  GraduationCap,
  Lightbulb,
  ArrowLeft,
  ArrowRight,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { createWorkspace } from "@/lib/api"
import type { Workspace } from "@/lib/types"
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
  const [customUseCase, setCustomUseCase] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [touched, setTouched] = React.useState<Record<string, boolean>>({})

  const steps = [
    { label: "基本信息", description: "工作区名称和描述" },
    { label: "团队上下文", description: "规模和场景" },
  ]

  const validateStep = React.useCallback((s: number): boolean => {
    const newErrors: Record<string, string> = {}
    if (s === 0) {
      if (!name.trim()) newErrors.name = "请输入工作区名称"
      else if (name.trim().length < 2) newErrors.name = "至少 2 个字符"
    }
    if (s === 1) {
      if (!teamSize) newErrors.teamSize = "请选择团队规模"
      if (!useCase) newErrors.useCase = "请选择主要场景"
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }, [name, teamSize, useCase])

  const validateField = React.useCallback((field: string, value: string) => {
    const newErrors: Record<string, string> = {}
    if (field === "name") {
      if (!value.trim()) newErrors.name = "请输入工作区名称"
      else if (value.trim().length < 2) newErrors.name = "至少 2 个字符"
    }
    if (field === "ownerId" && !value.trim()) {
      newErrors.ownerId = "请输入所有者 ID"
    }
    if (field === "teamSize" && !value) {
      newErrors.teamSize = "请选择团队规模"
    }
    if (field === "useCase" && !value) {
      newErrors.useCase = "请选择主要场景"
    }
    setErrors((prev) => ({ ...prev, ...newErrors }))
  }, [])

  const goBack = () => {
    setStep((prev) => Math.max(0, prev - 1));
  };

  const goNext = () => {
    if (!validateStep(step)) return;
    setStep((prev) => Math.min(steps.length - 1, prev + 1));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validateStep(0) || !validateStep(1)) return
    setSubmitting(true)
    setError(null)
    try {
      const parsedTeamSize = teamSize === "10+" ? 10 : parseInt(teamSize.split("-")[0]);

      const ws = await createWorkspace({
        name: name.trim(),
        owner_user_id: ownerId.trim(),
        description: description.trim() || null,
        team_size: parsedTeamSize,
        use_case: useCase === "other" ? customUseCase.trim() : useCase,
      })
      onCreated?.(ws)
      router.push(`/onboarding/profile?userId=${ownerId.trim()}&workspaceId=${ws.workspace_id}`)
    } catch (err) {
      console.error("创建工作区失败:", err);
      setError(err instanceof Error ? err.message : "创建工作区失败，请重试");
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
      className="mx-auto max-w-lg space-y-6 p-4"
    >
      <div>
        <h2 className="flex items-center gap-2 text-2xl font-bold">
          <FolderOpen className="h-6 w-6 text-emerald-500" />
          创建工作区
        </h2>
        <p className="text-sm text-muted-foreground">
          为你的团队创建一个协作空间
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {step === 0 && (
          <div className="space-y-4">
            <FormField label="工作区名称" required error={errors.name}>
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
                placeholder="例如：2024 春季开发小队"
                className={cn("h-10", errors.name && "border-destructive")}
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
            {!ownerUserId && (
              <FormField label="所有者 ID" error={errors.ownerId}>
                <Input
                  value={ownerId}
                  onChange={(e) => {
                    setOwnerId(e.target.value)
                    if (touched.ownerId) validateField("ownerId", e.target.value)
                  }}
                  onBlur={() => {
                    setTouched((prev) => ({ ...prev, ownerId: true }))
                    validateField("ownerId", ownerId)
                  }}
                  placeholder="选填，默认使用当前用户"
                  className={cn("h-10", errors.ownerId && "border-destructive")}
                />
              </FormField>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <FormField label="团队规模" hint="预计参与人数" error={errors.teamSize}>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {TEAM_SIZES.map((size) => (
                  <button
                    key={size.id}
                    type="button"
                    onClick={() => {
                      setTeamSize(size.id)
                      setTouched((prev) => ({ ...prev, teamSize: true }))
                      validateField("teamSize", size.id)
                    }}
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

            <FormField label="主要场景" hint="你们主要做什么类型的项目" error={errors.useCase}>
              <div className="grid grid-cols-2 gap-3">
                {USE_CASES.map((uc) => {
                  const Icon = uc.icon
                  return (
                    <button
                      key={uc.id}
                      type="button"
                      onClick={() => {
                        setUseCase(uc.id)
                        validateField("useCase", uc.id)
                      }}
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
              {useCase === "other" && (
                <div className="mt-4">
                  <FormField label="具体场景" error={errors.customUseCase}>
                    <Input
                      value={customUseCase}
                      onChange={(e) => {
                        setCustomUseCase(e.target.value)
                        if (touched.customUseCase) validateField("customUseCase", e.target.value)
                      }}
                      onBlur={() => {
                        setTouched((prev) => ({ ...prev, customUseCase: true }))
                        validateField("customUseCase", customUseCase)
                      }}
                      placeholder="例如：毕业设计、社团活动"
                      className={cn("h-10", errors.customUseCase && "border-destructive")}
                    />
                  </FormField>
                </div>
              )}
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
              onClick={goBack}
              disabled={step === 0 || submitting}
              className="gap-2"
            >
              <ArrowLeft className="h-4 w-4" />
              上一步
            </Button>
          {step < steps.length - 1 ? (
              <Button onClick={goNext} className="gap-2">
                下一步
                <ArrowRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button type="submit" disabled={submitting} className="gap-2">
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                创建工作区
              </Button>
            )}
        </div>
      </form>
    </motion.div>
  )
}
