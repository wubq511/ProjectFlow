"use client"

import * as React from "react"
import { useParams, useRouter } from "next/navigation"
import { motion } from "framer-motion"
import {
  Loader2,
  AlertCircle,
  Users,
  FolderOpen,
  Plus,
  Crown,
  Settings,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { getWorkspaceState } from "@/lib/api"
import { setLastWorkspaceId } from "@/components/app-shell"
import { EmptyState } from "@/components/ui/empty-state"
import { MemberManagementDialog } from "@/components/member/member-management-dialog"
import type { WorkspaceState } from "@/lib/types"

function WorkspaceContent({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const [state, setState] = React.useState<WorkspaceState | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [memberMgmtOpen, setMemberMgmtOpen] = React.useState(false)
  const [refreshKey, setRefreshKey] = React.useState(0)

  React.useEffect(() => {
    setLastWorkspaceId(workspaceId)
  }, [workspaceId])

  React.useEffect(() => {
    let cancelled = false
    getWorkspaceState(workspaceId)
      .then((data) => {
        if (!cancelled) setState(data)
      })
      .catch(() => {
        if (!cancelled) setError("加载工作台失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [workspaceId, refreshKey])

  const loadWorkspace = React.useCallback(() => {
    setLoading(true)
    setError(null)
    setRefreshKey((k) => k + 1)
  }, [])

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (error || !state) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-destructive">{error ?? "工作台未找到"}</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => window.location.reload()}>
            重试
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              localStorage.removeItem("projectflow:last-workspace-id");
              window.location.href = "/";
            }}
          >
            返回首页
          </Button>
        </div>
      </div>
    )
  }

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto max-w-3xl px-5 py-8"
      >
        <header className="mb-8">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">
            工作台
          </p>
          <h1 className="mt-2 text-3xl font-black">{state.workspace.name}</h1>
          {state.workspace.description && (
            <p className="mt-2 text-sm text-muted-foreground">
              {state.workspace.description}
            </p>
          )}
        </header>

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Users className="h-5 w-5 text-blue-500" />
                成员 ({state.memberships.length})
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setMemberMgmtOpen(true)}
              >
                <Settings className="h-4 w-4" />
                管理
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {state.memberships.length === 0 ? (
                <EmptyState
                  icon={
                    <Users className="h-10 w-10 text-muted-foreground/60" />
                  }
                  title="还没有成员"
                  description="邀请团队成员加入协作"
                  action={{
                    label: "管理成员",
                    onClick: () => setMemberMgmtOpen(true),
                  }}
                />
              ) : (
                <>
                  {state.memberships.map((m) => {
                    const user = state.users.find((u) => u.user_id === m.user_id)
                    const profile = state.member_profiles.find(
                      (p) => p.user_id === m.user_id
                    )
                    return (
                      <div
                        key={m.id}
                        className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-accent/50"
                      >
                        <div>
                          <p className="font-medium">
                            {user?.display_name ?? "未知"}
                          </p>
                          {profile && (
                            <p className="text-xs text-muted-foreground">
                              {profile.role_preference} /{" "}
                              {profile.available_hours_per_week}h/周
                            </p>
                          )}
                          {profile?.skills?.length ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {profile.skills.slice(0, 3).map((skill) => (
                                <Badge key={skill.name} variant="secondary" className="text-[10px]">
                                  {skill.name} Lv.{skill.level}
                                </Badge>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        <Badge variant={m.role === "owner" ? "default" : "secondary"}>
                          {m.role === "owner" ? (
                            <span className="flex items-center gap-1">
                              <Crown className="h-3 w-3" />
                              负责人
                            </span>
                          ) : (
                            "已加入"
                          )}
                        </Badge>
                      </div>
                    )
                  })}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <FolderOpen className="h-5 w-5 text-emerald-500" />
                项目 ({state.projects.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {state.projects.length === 0 ? (
                <EmptyState
                  icon={
                    <FolderOpen className="h-10 w-10 text-muted-foreground/60" />
                  }
                  title="还没有项目"
                  description="创建第一个项目，开始你的团队协作之旅"
                  action={{
                    label: "新建项目",
                    onClick: () =>
                      router.push(
                        `/projects/new?workspaceId=${workspaceId}&createdBy=${state.workspace.owner_user_id}`
                      ),
                  }}
                />
              ) : (
                <>
                  {state.projects.map((p) => (
                    <a
                      key={p.id}
                      href={`/projects/${p.id}`}
                      className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:border-primary/40 hover:bg-primary/5"
                    >
                      <div>
                        <p className="font-medium">{p.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {p.status}
                        </p>
                      </div>
                      <Badge
                        variant={
                          p.status === "active"
                            ? "default"
                            : p.status === "at_risk"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {p.status === "active"
                          ? "进行中"
                          : p.status === "at_risk"
                            ? "有风险"
                            : p.status === "completed"
                              ? "已完成"
                              : p.status}
                      </Badge>
                    </a>
                  ))}
                  <Separator className="my-2" />
                  <Button
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() =>
                      router.push(
                        `/projects/new?workspaceId=${workspaceId}&createdBy=${state.workspace.owner_user_id}`
                      )
                    }
                  >
                    <Plus className="h-4 w-4" />
                    新建项目
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </motion.div>

      <MemberManagementDialog
        workspaceId={workspaceId}
        open={memberMgmtOpen}
        onOpenChange={setMemberMgmtOpen}
        members={state.users}
        memberships={state.memberships}
        profiles={state.member_profiles}
        onMembersChanged={loadWorkspace}
      />
    </>
  )
}

export default function WorkspaceDashboardPage() {
  const params = useParams()
  const workspaceId = params.workspaceId as string
  return <WorkspaceContent workspaceId={workspaceId} />
}
