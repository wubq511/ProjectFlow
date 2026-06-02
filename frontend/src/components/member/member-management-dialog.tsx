"use client"

import * as React from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Users,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  X,
  UserPlus,
  Pencil,
  Trash2,
  ChevronLeft,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { createUser, upsertMemberProfile, removeMember, addWorkspaceMember } from "@/lib/api"
import type { Skill, User, MemberProfile, WorkspaceMembership } from "@/lib/types"

interface MemberManagementDialogProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  members: User[]
  memberships: WorkspaceMembership[]
  profiles: MemberProfile[]
  onMembersChanged: () => void
}

type ViewState = "list" | "add" | "edit" | "delete-confirm"

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
  "SQL",
  "Docker",
  "Figma",
]

function MemberForm({
  initialData,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  initialData?: {
    name: string
    email: string
    rolePreference: string
    availableHours: number
    skills: Skill[]
    interests: string
    constraints: string
  }
  onSubmit: (data: {
    name: string
    email: string
    rolePreference: string
    availableHours: number
    skills: Skill[]
    interests: string
    constraints: string
  }) => void
  onCancel: () => void
  submitLabel: string
}) {
  const [name, setName] = React.useState(initialData?.name ?? "")
  const [email, setEmail] = React.useState(initialData?.email ?? "")
  const [rolePreference, setRolePreference] = React.useState(initialData?.rolePreference ?? "")
  const [availableHours, setAvailableHours] = React.useState<number>(initialData?.availableHours ?? 10)
  const [skills, setSkills] = React.useState<Skill[]>(initialData?.skills ?? [])
  const [newSkillName, setNewSkillName] = React.useState("")
  const [newSkillLevel, setNewSkillLevel] = React.useState("3")
  const [interests, setInterests] = React.useState(initialData?.interests ?? "")
  const [constraints, setConstraints] = React.useState(initialData?.constraints ?? "")
  const [errors, setErrors] = React.useState<Record<string, string>>({})

  const addSkill = () => {
    const skillName = newSkillName.trim()
    if (!skillName) return
    if (skills.some((s) => s.name.toLowerCase() === skillName.toLowerCase())) return
    setSkills([...skills, { name: skillName, level: Number(newSkillLevel) }])
    setNewSkillName("")
    setNewSkillLevel("3")
  }

  const removeSkill = (skillName: string) => {
    setSkills(skills.filter((s) => s.name !== skillName))
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}
    if (!name.trim()) newErrors.name = "请输入成员姓名"
    if (!rolePreference.trim()) newErrors.role = "请输入角色偏好"
    if (availableHours <= 0) newErrors.hours = "可用时间必须大于 0"
    if (skills.length === 0) newErrors.skills = "请至少添加一项技能"
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = () => {
    if (!validate()) return
    onSubmit({
      name: name.trim(),
      email: email.trim(),
      rolePreference: rolePreference.trim(),
      availableHours,
      skills,
      interests: interests.trim(),
      constraints: constraints.trim(),
    })
  }

  return (
    <div className="space-y-4 py-2">
      <div className="space-y-2">
        <label className="text-sm font-medium">
          姓名 <span className="text-destructive">*</span>
        </label>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            if (errors.name) setErrors((prev) => ({ ...prev, name: "" }))
          }}
          placeholder="成员姓名"
          className="h-10"
        />
        {errors.name && <p className="text-sm text-destructive">{errors.name}</p>}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">邮箱</label>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="选填"
          className="h-10"
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">
          角色偏好 <span className="text-destructive">*</span>
        </label>
        <Input
          value={rolePreference}
          onChange={(e) => {
            setRolePreference(e.target.value)
            if (errors.role) setErrors((prev) => ({ ...prev, role: "" }))
          }}
          placeholder="例如：前端开发、产品经理"
          className="h-10"
        />
        {errors.role && <p className="text-sm text-destructive">{errors.role}</p>}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">
          每周可用时间 <span className="text-destructive">*</span>
        </label>
        <Input
          type="number"
          min={1}
          max={80}
          value={availableHours}
          onChange={(e) => setAvailableHours(Math.max(1, Number(e.target.value) || 1))}
          className="h-10"
        />
        <p className="text-xs text-muted-foreground">通常学生项目投入 5-20 小时</p>
        {errors.hours && <p className="text-sm text-destructive">{errors.hours}</p>}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">
          技能 <span className="text-destructive">*</span>
        </label>
        {errors.skills && <p className="text-sm text-destructive">{errors.skills}</p>}
        {skills.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {skills.map((skill) => (
              <Badge key={skill.name} variant="secondary" className="gap-1.5 py-1 pl-2.5 pr-1.5">
                {skill.name}
                <span className="text-muted-foreground">Lv.{skill.level}</span>
                <button
                  onClick={() => removeSkill(skill.name)}
                  className="ml-0.5 rounded-full p-0.5 transition hover:bg-destructive/20 hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Input
              placeholder="技能名称"
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
          <select
            value={newSkillLevel}
            onChange={(e) => setNewSkillLevel(e.target.value)}
            className="h-10 rounded-md border bg-background px-2 text-sm"
          >
            <option value="1">Lv.1</option>
            <option value="2">Lv.2</option>
            <option value="3">Lv.3</option>
            <option value="4">Lv.4</option>
            <option value="5">Lv.5</option>
          </select>
          <Button type="button" variant="outline" onClick={addSkill} disabled={!newSkillName.trim()} className="h-10">
            添加
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {POPULAR_SKILLS.filter((s) => !skills.some((sk) => sk.name.toLowerCase() === s.toLowerCase()))
            .slice(0, 8)
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

      <div className="space-y-2">
        <label className="text-sm font-medium">兴趣方向</label>
        <Input
          value={interests}
          onChange={(e) => setInterests(e.target.value)}
          placeholder="例如：UI 设计、数据可视化"
          className="h-10"
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">限制条件</label>
        <Input
          value={constraints}
          onChange={(e) => setConstraints(e.target.value)}
          placeholder="例如：周末不可用"
          className="h-10"
        />
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button onClick={handleSubmit}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </div>
  )
}

export function MemberManagementDialog({
  workspaceId,
  open,
  onOpenChange,
  members,
  memberships,
  profiles,
  onMembersChanged,
}: MemberManagementDialogProps) {
  const [view, setView] = React.useState<ViewState>("list")
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [success, setSuccess] = React.useState("")
  const [selectedUserId, setSelectedUserId] = React.useState<string | null>(null)

  const resetState = () => {
    setView("list")
    setLoading(false)
    setError("")
    setSuccess("")
    setSelectedUserId(null)
  }

  const handleOpenChange = (value: boolean) => {
    if (!value) {
      resetState()
    }
    onOpenChange(value)
  }

  const getSelectedMember = () => {
    if (!selectedUserId) return null
    const user = members.find((m) => m.user_id === selectedUserId)
    const profile = profiles.find((p) => p.user_id === selectedUserId)
    const membership = memberships.find((m) => m.user_id === selectedUserId)
    if (!user) return null
    return { user, profile, membership }
  }

  const handleAdd = async (data: {
    name: string
    email: string
    rolePreference: string
    availableHours: number
    skills: Skill[]
    interests: string
    constraints: string
  }) => {
    setLoading(true)
    setError("")
    try {
      const user = await createUser({
        display_name: data.name,
        email: data.email || null,
      })
      await addWorkspaceMember(workspaceId, user.user_id, "member")
      await upsertMemberProfile(workspaceId, user.user_id, {
        skills: data.skills,
        available_hours_per_week: data.availableHours,
        role_preference: data.rolePreference,
        interests: data.interests,
        constraints: data.constraints,
        collaboration_preference: null,
      })
      setSuccess(`成员 ${data.name} 添加成功`)
      onMembersChanged()
      setView("list")
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加成员失败")
    } finally {
      setLoading(false)
    }
  }

  const handleEdit = async (data: {
    name: string
    email: string
    rolePreference: string
    availableHours: number
    skills: Skill[]
    interests: string
    constraints: string
  }) => {
    if (!selectedUserId) return
    setLoading(true)
    setError("")
    try {
      await upsertMemberProfile(workspaceId, selectedUserId, {
        skills: data.skills,
        available_hours_per_week: data.availableHours,
        role_preference: data.rolePreference,
        interests: data.interests,
        constraints: data.constraints,
        collaboration_preference: null,
      })
      setSuccess("成员信息更新成功")
      onMembersChanged()
      setView("list")
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新成员失败")
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!selectedUserId) return
    setLoading(true)
    setError("")
    try {
      await removeMember(workspaceId, selectedUserId)
      setSuccess("成员已删除")
      onMembersChanged()
      setView("list")
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除成员失败")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {view !== "list" && (
              <Button variant="ghost" size="icon-sm" className="-ml-2 h-8 w-8" onClick={() => setView("list")}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
            )}
            <Users className="h-5 w-5 text-primary" />
            {view === "list" && "成员管理"}
            {view === "add" && "添加成员"}
            {view === "edit" && "编辑成员"}
            {view === "delete-confirm" && "确认删除"}
          </DialogTitle>
          <DialogDescription>
            {view === "list" && `共 ${members.length} 位成员`}
            {view === "add" && "为新成员创建账号并填写基本资料"}
            {view === "edit" && "修改成员的基本资料"}
            {view === "delete-confirm" && "删除后无法恢复，请确认"}
          </DialogDescription>
        </DialogHeader>

        {success && (
          <div className="flex items-center gap-2 rounded-lg bg-green-50 p-3 text-sm text-green-700">
            <CheckCircle2 className="h-4 w-4" />
            {success}
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        )}

        <AnimatePresence mode="wait">
          {view === "list" && (
            <motion.div
              key="list"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-3 py-2"
            >
              {members.map((member) => {
                const profile = profiles.find((p) => p.user_id === member.user_id)
                const membership = memberships.find((m) => m.user_id === member.user_id)
                const isOwner = membership?.role === "owner"
                return (
                  <div
                    key={member.user_id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div>
                      <p className="font-medium">{member.display_name}</p>
                      {profile && (
                        <p className="text-xs text-muted-foreground">
                          {profile.role_preference} / {profile.available_hours_per_week}h/周
                        </p>
                      )}
                      {profile?.skills?.length ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {profile.skills.slice(0, 4).map((skill) => (
                            <Badge key={skill.name} variant="secondary" className="text-[10px]">
                              {skill.name} Lv.{skill.level}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1">
                      {isOwner && (
                        <Badge variant="default" className="mr-1">
                          负责人
                        </Badge>
                      )}
                      {!isOwner && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="h-8 w-8"
                            onClick={() => {
                              setSelectedUserId(member.user_id)
                              setView("edit")
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => {
                              setSelectedUserId(member.user_id)
                              setView("delete-confirm")
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}

              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => {
                  setError("")
                  setSuccess("")
                  setView("add")
                }}
              >
                <UserPlus className="h-4 w-4" />
                添加成员
              </Button>
            </motion.div>
          )}

          {view === "add" && (
            <motion.div key="add" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <MemberForm
                onSubmit={handleAdd}
                onCancel={() => setView("list")}
                submitLabel={loading ? "添加中..." : "添加成员"}
              />
            </motion.div>
          )}

          {view === "edit" && (
            <motion.div key="edit" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              {(() => {
                const selected = getSelectedMember()
                if (!selected) return null
                return (
                  <MemberForm
                    initialData={{
                      name: selected.user.display_name,
                      email: selected.user.email ?? "",
                      rolePreference: selected.profile?.role_preference ?? "",
                      availableHours: selected.profile?.available_hours_per_week ?? 10,
                      skills: selected.profile?.skills ?? [],
                      interests: selected.profile?.interests ?? "",
                      constraints: selected.profile?.constraints ?? "",
                    }}
                    onSubmit={handleEdit}
                    onCancel={() => setView("list")}
                    submitLabel={loading ? "保存中..." : "保存修改"}
                  />
                )
              })()}
            </motion.div>
          )}

          {view === "delete-confirm" && (
            <motion.div
              key="delete"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="space-y-4 py-4"
            >
              <div className="flex flex-col items-center gap-3 py-4">
                <AlertTriangle className="h-12 w-12 text-destructive" />
                <p className="text-lg font-semibold text-destructive">确认删除成员？</p>
                <p className="text-sm text-muted-foreground">
                  {(() => {
                    const selected = getSelectedMember()
                    return selected ? `将删除成员：${selected.user.display_name}` : ""
                  })()}
                </p>
                <p className="text-xs text-muted-foreground">此操作不可恢复</p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setView("list")}>
                  取消
                </Button>
                <Button variant="destructive" className="flex-1" onClick={handleDelete} disabled={loading}>
                  {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  确认删除
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  )
}
