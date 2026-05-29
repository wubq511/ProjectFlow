"use client"

import * as React from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Loader2,
  UserPlus,
  Copy,
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
import { createInvitation } from "@/lib/api"
import type { Invitation } from "@/lib/types"

interface InviteMemberPanelProps {
  workspaceId: string
}

export function InviteMemberPanel({ workspaceId }: InviteMemberPanelProps) {
  const [invitedName, setInvitedName] = React.useState("")
  const [invitedEmail, setInvitedEmail] = React.useState("")
  const [invitations, setInvitations] = React.useState<Invitation[]>([])
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [copiedToken, setCopiedToken] = React.useState<string | null>(null)
  const [errors, setErrors] = React.useState<Record<string, string>>({})

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}
    if (!invitedName.trim()) newErrors.name = "请输入成员姓名"
    if (
      invitedEmail.trim() &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invitedEmail.trim())
    ) {
      newErrors.email = "邮箱格式不正确"
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return
    setSubmitting(true)
    setError(null)
    try {
      const inv = await createInvitation(workspaceId, {
        invited_name: invitedName.trim(),
        invited_email: invitedEmail.trim() || null,
      })
      setInvitations((prev) => [...prev, inv])
      setInvitedName("")
      setInvitedEmail("")
      setErrors({})
    } catch {
      setError("发送邀请失败，请重试")
    } finally {
      setSubmitting(false)
    }
  }

  const copyLink = (token: string) => {
    const link = `${window.location.origin}/invite/${token}`
    navigator.clipboard.writeText(link).then(() => {
      setCopiedToken(token)
      setTimeout(() => setCopiedToken(null), 2000)
    })
  }

  const statusVariant = (status: string) => {
    switch (status) {
      case "pending":
        return "secondary"
      case "accepted":
        return "default"
      case "expired":
        return "outline"
      default:
        return "secondary"
    }
  }

  const statusLabel = (status: string) => {
    switch (status) {
      case "pending":
        return "待接受"
      case "accepted":
        return "已接受"
      case "expired":
        return "已过期"
      default:
        return status
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto max-w-lg space-y-4 p-4"
    >
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <UserPlus className="h-6 w-6 text-blue-500" />
          邀请成员
        </h1>
        <p className="text-sm text-muted-foreground">
          发送邀请链接给团队成员加入工作区
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleInvite} className="space-y-4">
            <FormField label="姓名" required error={errors.name}>
              <Input
                value={invitedName}
                onChange={(e) => {
                  setInvitedName(e.target.value)
                  if (errors.name)
                    setErrors((prev) => ({ ...prev, name: "" }))
                }}
                placeholder="成员姓名"
                className="h-10"
              />
            </FormField>
            <FormField
              label="邮箱"
              error={errors.email}
              hint="可选，用于发送邮件邀请"
            >
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="email"
                  value={invitedEmail}
                  onChange={(e) => {
                    setInvitedEmail(e.target.value)
                    if (errors.email)
                      setErrors((prev) => ({ ...prev, email: "" }))
                  }}
                  placeholder="member@example.com"
                  className="h-10 pl-9"
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
              disabled={submitting || !invitedName.trim()}
              className="w-full"
            >
              {submitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="mr-2 h-4 w-4" />
              )}
              发送邀请
            </Button>
          </form>
        </CardContent>
      </Card>

      {invitations.length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <p className="text-sm font-semibold text-muted-foreground">
              已发送的邀请
            </p>
            <AnimatePresence>
              {invitations.map((inv) => (
                <motion.div
                  key={inv.invitation_id}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{inv.invited_name}</p>
                    {inv.invited_email && (
                      <p className="truncate text-xs text-muted-foreground">
                        {inv.invited_email}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={statusVariant(inv.status)}>
                      {statusLabel(inv.status)}
                    </Badge>
                    {inv.status === "pending" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyLink(inv.token)}
                        className={cn(
                          "h-7 gap-1 text-xs",
                          copiedToken === inv.token &&
                            "text-green-600 hover:text-green-700"
                        )}
                      >
                        {copiedToken === inv.token ? (
                          <>
                            <CheckCircle2 className="h-3 w-3" />
                            已复制
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" />
                            复制链接
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </>
      )}
    </motion.div>
  )
}
