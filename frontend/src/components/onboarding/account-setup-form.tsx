"use client"

import * as React from "react"
import { motion } from "framer-motion"
import {
  Loader2,
  UserPlus,
  CheckCircle2,
  AlertCircle,
  Mail,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { FormField } from "@/components/ui/form-field"
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"
import { createUser, listUsers } from "@/lib/api"
import type { User } from "@/lib/types"

export function AccountSetupForm() {
  const router = useRouter()
  const [displayName, setDisplayName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [users, setUsers] = React.useState<User[]>([])
  const [loading, setLoading] = React.useState(true)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [createdUser, setCreatedUser] = React.useState<User | null>(null)
  const [errors, setErrors] = React.useState<Record<string, string>>({})

  React.useEffect(() => {
    listUsers()
      .then(setUsers)
      .catch(() => setError("加载用户列表失败"))
      .finally(() => setLoading(false))
  }, [])

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}
    if (!displayName.trim()) {
      newErrors.displayName = "请输入显示名称"
    } else if (displayName.trim().length < 2) {
      newErrors.displayName = "至少 2 个字符"
    } else if (displayName.trim().length > 30) {
      newErrors.displayName = "最多 30 个字符"
    }

    if (
      email.trim() &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    ) {
      newErrors.email = "邮箱格式不正确"
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return
    setSubmitting(true)
    setError(null)
    try {
      const user = await createUser({
        display_name: displayName.trim(),
        email: email.trim() || null,
      })
      setCreatedUser(user)
      setUsers((prev) => [...prev, user])
    } catch {
      setError("创建账号失败，请重试")
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  if (createdUser) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto max-w-lg p-4"
      >
        <Card className="border-green-200 bg-green-50/50 dark:bg-green-950/20">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <CheckCircle2 className="h-10 w-10 text-green-600" />
            <p className="text-lg font-bold">账号创建成功</p>
            <p className="text-sm text-muted-foreground">
              {createdUser.display_name}
            </p>
            <Button
              className="mt-2"
              onClick={() =>
                router.push(`/workspaces/new?ownerId=${createdUser.user_id}`)
              }
            >
              创建工作区
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
          <UserPlus className="h-6 w-6 text-primary" />
          创建账号
        </h1>
        <p className="text-sm text-muted-foreground">
          创建你的 ProjectFlow 账号，开始团队协作
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <FormField
              label="显示名称"
              required
              error={errors.displayName}
            >
              <Input
                id="displayName"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value)
                  if (errors.displayName)
                    setErrors((prev) => ({ ...prev, displayName: "" }))
                }}
                placeholder="你的姓名"
                className={cn(
                  "h-10",
                  errors.displayName && "border-destructive"
                )}
              />
            </FormField>
            <FormField label="邮箱" error={errors.email} hint="可选">
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    if (errors.email)
                      setErrors((prev) => ({ ...prev, email: "" }))
                  }}
                  placeholder="you@example.com"
                  className={cn(
                    "h-10 pl-9",
                    errors.email && "border-destructive"
                  )}
                />
              </div>
            </FormField>
            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}
            <Button
              type="submit"
              disabled={submitting || !displayName.trim()}
              className="w-full"
            >
              {submitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="mr-2 h-4 w-4" />
              )}
              创建账号
            </Button>
          </form>
        </CardContent>
      </Card>

      {users.length > 0 && (
        <>
          <Separator />
          <div>
            <p className="mb-3 text-sm font-semibold text-muted-foreground">
              或选择现有演示用户：
            </p>
            <div className="space-y-2">
              {users.map((user) => (
                <a
                  key={user.user_id}
                  href={`/workspaces/new?ownerId=${user.user_id}`}
                  className="flex items-center justify-between rounded-lg border bg-card p-3 transition hover:border-primary/40 hover:bg-primary/5"
                >
                  <span className="font-medium">{user.display_name}</span>
                  <Badge variant="secondary" className="text-xs">
                    选择
                  </Badge>
                </a>
              ))}
            </div>
          </div>
        </>
      )}
    </motion.div>
  )
}
