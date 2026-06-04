"use client"

import * as React from "react"
import { motion } from "framer-motion"
import {
  Loader2,
  UserPlus,
  AlertCircle,
  Mail,
  ChevronDown,
  ChevronUp,
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
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [showAllUsers, setShowAllUsers] = React.useState(false)



  React.useEffect(() => {
    let ignore = false;
    listUsers()
      .then((data) => { if (!ignore) setUsers(data); })
      .catch(() => { if (!ignore) setError("加载用户列表失败"); })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [])

  const validate = React.useCallback((): boolean => {
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
  }, [displayName, email])

  const handleDisplayNameChange = (value: string) => {
    setDisplayName(value)
    if (value.trim() || email.trim()) {
      const newErrors: Record<string, string> = {}
      if (!value.trim()) {
        newErrors.displayName = "请输入显示名称"
      } else if (value.trim().length < 2) {
        newErrors.displayName = "至少 2 个字符"
      } else if (value.trim().length > 30) {
        newErrors.displayName = "最多 30 个字符"
      }
      if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        newErrors.email = "邮箱格式不正确"
      }
      setErrors(newErrors)
    }
  }

  const handleEmailChange = (value: string) => {
    setEmail(value)
    if (displayName.trim() || value.trim()) {
      const newErrors: Record<string, string> = {}
      if (!displayName.trim()) {
        newErrors.displayName = "请输入显示名称"
      } else if (displayName.trim().length < 2) {
        newErrors.displayName = "至少 2 个字符"
      } else if (displayName.trim().length > 30) {
        newErrors.displayName = "最多 30 个字符"
      }
      if (value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
        newErrors.email = "邮箱格式不正确"
      }
      setErrors(newErrors)
    }
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
      setUsers((prev) => [...prev, user])
      router.push(`/workspaces/new?ownerId=${user.user_id}`)
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

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto max-w-lg space-y-6 p-4"
    >
      <div className="mb-6">
        <h2 className="flex items-center gap-2 text-2xl font-bold">
          <UserPlus className="h-6 w-6 text-primary" />
          创建账号
        </h2>
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
                onChange={(e) => handleDisplayNameChange(e.target.value)}
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
                  onChange={(e) => handleEmailChange(e.target.value)}
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
            <p className="mb-3 text-sm font-medium text-muted-foreground">
              或选择现有演示用户：
            </p>
            <div className="space-y-2">
              {(showAllUsers ? users : users.slice(0, 4)).map((user) => (
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
              {users.length > 4 && (
                <button
                  type="button"
                  onClick={() => setShowAllUsers(!showAllUsers)}
                  className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed p-2 text-sm text-muted-foreground transition hover:bg-muted"
                >
                  {showAllUsers ? (
                    <>
                      <ChevronUp className="h-4 w-4" />
                      收起
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-4 w-4" />
                      查看全部 {users.length} 个用户
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </motion.div>
  )
}
