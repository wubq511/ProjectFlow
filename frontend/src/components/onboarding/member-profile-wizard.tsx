"use client"

import * as React from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Loader2,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  UserCircle,
  Clock,
  Heart,
  X,
} from "lucide-react"
import Link from "next/link"
import { upsertMemberProfile } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { Skill } from "@/lib/types"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { StepIndicator } from "@/components/ui/step-indicator"
import { CompletionBar } from "@/components/ui/completion-bar"
import { FormField } from "@/components/ui/form-field"
import { TagInput } from "@/components/ui/tag-input"

interface MemberProfileWizardProps {
  userId: string
  workspaceId: string
}

type SubmitState = "idle" | "loading" | "error" | "success"

const POPULAR_SKILLS = [
  "Python",
  "JavaScript",
  "React",
  "Node.js",
  "UI/UX",
  "产品设计",
  "数据分析",
  "机器学习",
  "写作",
  "演讲",
  "项目管理",
  "市场调研",
  "视频剪辑",
  "平面设计",
  "Java",
  "Go",
  "Rust",
  "SQL",
  "Docker",
  "Figma",
]

const stepVariants = {
  enter: { opacity: 0, x: 40 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -40 },
}

export function MemberProfileWizard({
  userId,
  workspaceId,
}: MemberProfileWizardProps) {
  const [currentStep, setCurrentStep] = React.useState(0)

  // Step 1: Basic Info
  const [name, setName] = React.useState("")
  const [rolePreference, setRolePreference] = React.useState("")
  const [major, setMajor] = React.useState("")
  const [grade, setGrade] = React.useState("")

  // Step 2: Skills
  const [skills, setSkills] = React.useState<Skill[]>([])
  const [newSkillName, setNewSkillName] = React.useState("")
  const [newSkillLevel, setNewSkillLevel] = React.useState("3")
  const [pastProjects, setPastProjects] = React.useState("")

  // Step 3: Availability
  const [availableHours, setAvailableHours] = React.useState<number>(10)
  const [preferredTime, setPreferredTime] = React.useState("")
  const [interests, setInterests] = React.useState("")
  const [constraints, setConstraints] = React.useState("")

  // Submit state
  const [submitState, setSubmitState] = React.useState<SubmitState>("idle")
  const [errorMessage, setErrorMessage] = React.useState("")
  const [errors, setErrors] = React.useState<Record<string, string>>({})

  const steps = [
    { label: "基本信息", description: "姓名、角色、专业" },
    { label: "技能经验", description: "技能和过往项目" },
    { label: "可用时间", description: "每周投入时间" },
  ]

  // Completion calculation
  const completion = React.useMemo(() => {
    let score = 0
    if (name.trim()) score += 10
    if (rolePreference.trim()) score += 10
    if (major.trim()) score += 10
    if (grade.trim()) score += 10
    if (skills.length > 0) score += 20
    if (pastProjects.trim()) score += 10
    if (availableHours > 0) score += 10
    if (preferredTime.trim()) score += 10
    if (interests.trim()) score += 5
    if (constraints.trim()) score += 5
    return score
  }, [
    name,
    rolePreference,
    major,
    grade,
    skills,
    pastProjects,
    availableHours,
    preferredTime,
    interests,
    constraints,
  ])

  // --- Skill management ---
  const addSkill = () => {
    const skillName = newSkillName.trim()
    if (!skillName) return
    if (skills.some((s) => s.name.toLowerCase() === skillName.toLowerCase()))
      return
    setSkills([...skills, { name: skillName, level: Number(newSkillLevel) }])
    setNewSkillName("")
    setNewSkillLevel("3")
  }

  const removeSkill = (skillName: string) => {
    setSkills(skills.filter((s) => s.name !== skillName))
  }

  // --- Validation ---
  const validateStep = (step: number): boolean => {
    const newErrors: Record<string, string> = {}
    if (step === 0) {
      if (!name.trim()) newErrors.name = "请输入姓名"
      if (!rolePreference.trim()) newErrors.role = "请输入角色偏好"
    } else if (step === 1) {
      if (skills.length === 0) newErrors.skills = "请至少添加一项技能"
    } else if (step === 2) {
      if (availableHours <= 0) newErrors.hours = "可用时间必须大于 0"
      if (!preferredTime.trim()) newErrors.time = "请输入偏好工作时段"
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  // --- Navigation ---
  const goNext = () => {
    if (!validateStep(currentStep)) return
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1)
    }
  }

  const goBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1)
    }
  }

  // --- Submit ---
  const handleSubmit = async () => {
    if (!validateStep(currentStep)) return
    setSubmitState("loading")
    setErrorMessage("")

    try {
      await upsertMemberProfile(workspaceId, userId, {
        skills,
        available_hours_per_week: availableHours,
        role_preference: rolePreference.trim(),
        interests: interests.trim() || pastProjects.trim(),
        constraints: constraints.trim(),
        collaboration_preference: preferredTime.trim() || null,
      })
      setSubmitState("success")
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "保存资料失败，请重试"
      )
      setSubmitState("error")
    }
  }

  const handleRetry = () => {
    setSubmitState("idle")
    setErrorMessage("")
  }

  // --- Success state ---
  if (submitState === "success") {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.35 }}
        className="mx-auto max-w-lg p-4"
      >
        <Card className="border-green-200 bg-green-50/50 dark:bg-green-950/20">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              <CardTitle className="text-green-700">资料已保存</CardTitle>
            </div>
            <CardDescription>
              你的成员资料已保存，AI 将使用这些信息进行任务分配和建议。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border bg-card p-3 text-sm">
              <p className="text-muted-foreground">技能</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {skills.map((s) => (
                  <Badge key={s.name} variant="secondary">
                    {s.name} Lv.{s.level}
                  </Badge>
                ))}
              </div>
            </div>
            <Link
              href={`/workspaces/${workspaceId}`}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-bold text-primary-foreground transition hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              进入工作台
              <ArrowRight className="h-4 w-4" />
            </Link>
          </CardContent>
        </Card>
      </motion.div>
    )
  }

  // --- Error state ---
  if (submitState === "error") {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.35 }}
        className="mx-auto max-w-lg p-4"
      >
        <Card className="border-destructive/30 bg-destructive/5">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <CardTitle className="text-destructive">保存失败</CardTitle>
            </div>
            <CardDescription>{errorMessage}</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-3">
            <Button variant="outline" onClick={handleRetry} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              重试
            </Button>
            <Button variant="ghost" onClick={goBack} className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              返回表单
            </Button>
          </CardContent>
        </Card>
      </motion.div>
    )
  }

  // --- Step 1: Basic Info ---
  const renderStep1 = () => (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserCircle className="h-5 w-5 text-primary" />
          基本信息
        </CardTitle>
        <CardDescription>填写你的姓名、角色和专业信息</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField label="姓名" required error={errors.name}>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (errors.name) setErrors((prev) => ({ ...prev, name: "" }))
            }}
            placeholder="你的姓名"
            className="h-10"
          />
        </FormField>
        <FormField label="角色偏好" required error={errors.role}>
          <Input
            value={rolePreference}
            onChange={(e) => {
              setRolePreference(e.target.value)
              if (errors.role) setErrors((prev) => ({ ...prev, role: "" }))
            }}
            placeholder="例如：前端开发、产品经理"
            className="h-10"
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="专业">
            <Input
              value={major}
              onChange={(e) => setMajor(e.target.value)}
              placeholder="例如：计算机科学"
              className="h-10"
            />
          </FormField>
          <FormField label="年级">
            <Input
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
              placeholder="例如：大二"
              className="h-10"
            />
          </FormField>
        </div>
      </CardContent>
    </Card>
  )

  // --- Step 2: Skills ---
  const renderStep2 = () => (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Heart className="h-5 w-5 text-rose-500" />
          技能与经验
        </CardTitle>
        <CardDescription>
          添加你的技能并评分（1 = 初学者，5 = 专家）
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {errors.skills && (
          <p className="text-sm text-destructive">{errors.skills}</p>
        )}

        {/* Existing skills */}
        {skills.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {skills.map((skill) => (
              <Badge
                key={skill.name}
                variant="secondary"
                className="gap-1.5 py-1 pl-2.5 pr-1.5"
              >
                {skill.name}
                <span className="text-muted-foreground">Lv.{skill.level}</span>
                <button
                  onClick={() => removeSkill(skill.name)}
                  className="ml-0.5 rounded-full p-0.5 transition hover:bg-destructive/20 hover:text-destructive"
                  aria-label={`移除 ${skill.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        {skills.length === 0 && (
          <p className="py-3 text-center text-sm text-muted-foreground">
            还没有添加技能，请至少添加一项以继续
          </p>
        )}

        <Separator />

        {/* Add skill form */}
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <label className="text-xs text-muted-foreground">技能名称</label>
            <Input
              placeholder="例如：React、Python、设计"
              value={newSkillName}
              onChange={(e) => setNewSkillName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  addSkill()
                }
              }}
              className="h-10"
            />
          </div>
          <div className="w-24 space-y-1.5">
            <label className="text-xs text-muted-foreground">等级</label>
            <Select
              value={newSkillLevel}
              onValueChange={(v) => v && setNewSkillLevel(v)}
            >
              <SelectTrigger className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1</SelectItem>
                <SelectItem value="2">2</SelectItem>
                <SelectItem value="3">3</SelectItem>
                <SelectItem value="4">4</SelectItem>
                <SelectItem value="5">5</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={addSkill}
            disabled={!newSkillName.trim()}
            className="h-10"
          >
            添加
          </Button>
        </div>

        {/* Popular skills suggestions */}
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">热门技能：</p>
          <div className="flex flex-wrap gap-1.5">
            {POPULAR_SKILLS.filter(
              (s) => !skills.some((sk) => sk.name.toLowerCase() === s.toLowerCase())
            )
              .slice(0, 10)
              .map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setNewSkillName(s)
                    setNewSkillLevel("3")
                  }}
                  className="rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent"
                >
                  {s}
                </button>
              ))}
          </div>
        </div>

        <FormField label="过往项目" hint="简单描述你参与过的项目">
          <Textarea
            value={pastProjects}
            onChange={(e) => setPastProjects(e.target.value)}
            placeholder="例如：参与过校园二手交易平台开发，负责前端..."
            rows={3}
            className="resize-none"
          />
        </FormField>
      </CardContent>
    </Card>
  )

  // --- Step 3: Availability ---
  const renderStep3 = () => (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-amber-500" />
          可用时间
        </CardTitle>
        <CardDescription>告诉我们你每周能投入多少时间</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField
          label="每周可用时间"
          required
          error={errors.hours}
          hint="通常学生项目投入 5-20 小时"
        >
          <Input
            type="number"
            min={1}
            max={80}
            value={availableHours}
            onChange={(e) =>
              setAvailableHours(Math.max(1, Number(e.target.value) || 1))
            }
            className="h-10"
          />
        </FormField>
        <FormField
          label="偏好工作时段"
          required
          error={errors.time}
          hint="你习惯在什么时间工作"
        >
          <Input
            value={preferredTime}
            onChange={(e) => {
              setPreferredTime(e.target.value)
              if (errors.time) setErrors((prev) => ({ ...prev, time: "" }))
            }}
            placeholder="例如：晚上 8-11 点、周末下午"
            className="h-10"
          />
        </FormField>
        <FormField label="兴趣方向" hint="你喜欢做什么类型的工作">
          <Textarea
            value={interests}
            onChange={(e) => setInterests(e.target.value)}
            placeholder="例如：我喜欢做 UI 设计、数据可视化..."
            rows={3}
            className="resize-none"
          />
        </FormField>
        <FormField label="限制条件" hint="时间、能力或其他方面的限制">
          <Textarea
            value={constraints}
            onChange={(e) => setConstraints(e.target.value)}
            placeholder="例如：周末不可用，考试周直到 6 月 15 日..."
            rows={3}
            className="resize-none"
          />
        </FormField>
      </CardContent>
    </Card>
  )

  const renderCurrentStep = () => {
    switch (currentStep) {
      case 0:
        return renderStep1()
      case 1:
        return renderStep2()
      case 2:
        return renderStep3()
      default:
        return null
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold">完善成员资料</h1>
        <p className="text-sm text-muted-foreground">
          完善资料可获得更精准的分工建议
        </p>
      </div>

      <CompletionBar
        percentage={completion}
        label="资料完成度"
        showPercentage
      />
      {completion < 80 && (
        <p className="text-xs text-amber-600">
          完善资料可获得更精准的分工建议
        </p>
      )}

      <StepIndicator steps={steps} currentStep={currentStep} />

      <AnimatePresence mode="wait">
        <motion.div
          key={currentStep}
          variants={stepVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.25, ease: "easeInOut" }}
        >
          {renderCurrentStep()}
        </motion.div>
      </AnimatePresence>

      {/* Navigation buttons */}
      <div className="flex items-center justify-between gap-3 pt-2">
        <Button
          variant="outline"
          onClick={goBack}
          disabled={currentStep === 0}
          className="gap-2"
        >
          <ArrowLeft className="h-4 w-4" />
          上一步
        </Button>

        {currentStep < steps.length - 1 ? (
          <Button onClick={goNext} className="gap-2">
            下一步
            <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            onClick={handleSubmit}
            disabled={submitState === "loading"}
            className="gap-2"
          >
            {submitState === "loading" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                保存中...
              </>
            ) : (
              <>
                提交资料
                <CheckCircle2 className="h-4 w-4" />
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  )
}
