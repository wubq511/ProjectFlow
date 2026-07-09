"use client";

import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Users,
  FolderOpen,
  Plus,
  Crown,
  Settings,
  Archive,
  TriangleAlert,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { MemberManagementDialog } from "@/components/member/member-management-dialog";
import { NewProjectDialog } from "./new-project-dialog";
import { deleteProject } from "@/lib/api";
import type { ProjectState, WorkspaceState, Project } from "@/lib/types";
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

const statusLabelMap: Record<string, string> = {
  draft: "草稿",
  active: "进行中",
  at_risk: "有风险",
  completed: "已完成",
};

function StatCard({
  value,
  label,
  icon,
  accent = "primary",
  prominent = false,
  action,
}: {
  value: number | string;
  label: string;
  icon: React.ReactNode;
  accent?: "primary" | "emerald" | "citron";
  prominent?: boolean;
  action?: { label: string; onClick: () => void };
}) {
  const accentStyles = {
    primary: "bg-primary/10 text-primary",
    emerald: "bg-emerald-100 text-emerald-600",
    citron: "bg-citron/20 text-yellow-700",
  };

  return (
    <div
      className="flex items-center gap-4 rounded-2xl border border-neutral-200 bg-white p-5"
    >
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${accentStyles[accent]}`}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={`font-bold text-neutral-900 ${
            prominent ? "text-3xl" : "text-2xl"
          }`}
        >
          {value}
        </p>
        <p className="text-sm text-neutral-500">{label}</p>
        {action && (
          <button
            onClick={action.onClick}
            className="mt-1 text-xs font-medium text-primary hover:underline"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

interface WorkspaceContentProps {
  state: ProjectState | WorkspaceState;
  currentUserId?: string;
  onNavigateToProject?: (projectId: string) => void;
  onRefresh?: () => void;
}

export function WorkspaceContent({ state, currentUserId, onNavigateToProject, onRefresh }: WorkspaceContentProps) {
  const workspace = state.workspace;
  const memberships = state.memberships ?? [];
  const projects = state.projects ?? [];
  const members = state.members;
  const profiles = state.member_profiles;

  const [memberMgmtOpen, setMemberMgmtOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [deletedProjectIds, setDeletedProjectIds] = useState<string[]>([]);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 监听 Agent 侧边栏发出的创建项目事件
  useEffect(() => {
    const handler = () => setNewProjectOpen(true);
    window.addEventListener("projectflow:create-project", handler);
    return () => window.removeEventListener("projectflow:create-project", handler);
  }, []);

  const localProjects = React.useMemo(() => {
    if (deletedProjectIds.length === 0) return projects;
    const hiddenIds = new Set(deletedProjectIds);
    return projects.filter((project) => !hiddenIds.has(project.id));
  }, [deletedProjectIds, projects]);

  const activeProjects = localProjects.filter((p) => p.status === "active");
  const completedProjects = localProjects.filter((p) => p.status === "completed");

  const currentMembership = memberships.find((m) => m.user_id === currentUserId);
  const isOwner = currentMembership?.role === "owner";

  const handleDeleteProject = async (projectId: string) => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteProject(projectId);
      setDeletedProjectIds((prev) => [...prev, projectId]);
      setDeleteConfirmId(null);
    } catch {
      setDeleteError("删除失败，请检查网络后重试。");
    } finally {
      setDeleting(false);
    }
  };

  const filteredMemberships = memberships.filter((m) => {
    const user = members.find((u) => u.user_id === m.user_id);
    const profile = profiles.find((p) => p.user_id === m.user_id);
    const query = memberSearch.trim().toLowerCase();
    if (!query) return true;
    return (
      user?.display_name.toLowerCase().includes(query) ||
      profile?.role_preference.toLowerCase().includes(query) ||
      false
    );
  });

  const filteredProjects = localProjects.filter((p) => {
    const query = projectSearch.trim().toLowerCase();
    if (!query) return true;
    return p.name.toLowerCase().includes(query);
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="h-full overflow-y-auto custom-scrollbar p-6"
    >
      {/* Header */}
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-neutral-400 mb-1">
            <Users className="h-4 w-4" />
            <span className="text-xs font-medium">
              工作区
            </span>
          </div>
          <h1 className="font-display text-3xl font-normal leading-tight text-neutral-900 md:text-4xl">
            {workspace.name}
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {workspace.description || "团队项目、成员能力和推进状态集中在这里。"}
          </p>
        </div>

      </header>

      {/* Stats */}
      <section className="mb-8 grid gap-3 sm:grid-cols-3">
        <StatCard
          value={memberships.length}
          label="团队成员"
          icon={<Users className="h-5 w-5" />}
          accent="primary"
          prominent
        />
        <StatCard
          value={activeProjects.length}
          label="活跃项目"
          icon={<FolderOpen className="h-5 w-5" />}
          accent="emerald"
          action={
            activeProjects.length > 0 && onNavigateToProject
              ? { label: "查看项目", onClick: () => onNavigateToProject(activeProjects[0].id) }
              : undefined
          }
        />
        <StatCard
          value={completedProjects.length}
          label="已完成"
          icon={<Archive className="h-5 w-5" />}
          accent="citron"
          action={
            completedProjects.length > 0 && onNavigateToProject
              ? { label: "查看归档", onClick: () => onNavigateToProject(completedProjects[0].id) }
              : undefined
          }
        />
      </section>

      {/* Main content */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Members */}
        <Card className="border-neutral-200 bg-white">
          <CardHeader className="flex flex-row items-center justify-between border-b border-neutral-100 pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Users className="h-5 w-5 text-primary" />
              成员 ({filteredMemberships.length})
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setMemberMgmtOpen(true)}
            >
              <Settings className="h-4 w-4" />
              成员管理
            </Button>
          </CardHeader>
          <CardContent className="pt-4 space-y-3">
            {memberships.length > 0 && (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                <Input
                  placeholder="搜索成员姓名或角色..."
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  className="pl-9 h-9"
                />
              </div>
            )}
            {memberships.length === 0 ? (
              <EmptyState
                icon={
                  <Users className="h-10 w-10 text-muted-foreground/60" />
                }
                title="还没有成员"
                description="邀请团队成员加入，分配角色和任务"
                action={{
                  label: "邀请成员",
                  onClick: () => setMemberMgmtOpen(true),
                }}
              />
            ) : filteredMemberships.length === 0 ? (
              <div className="py-8 text-center text-sm text-neutral-400">
                未找到匹配的成员
              </div>
            ) : (
              <ul className="space-y-1">
                {filteredMemberships.map((m) => {
                  const user = members.find((u) => u.user_id === m.user_id);
                  const profile = profiles.find(
                    (p) => p.user_id === m.user_id
                  );
                  const initials = (user?.display_name ?? "?").slice(0, 2);

                  return (
                    <li
                      key={m.id}
                      className="flex items-center justify-between rounded-xl px-3 py-3 transition-colors hover:bg-neutral-50 cursor-pointer"
                      onClick={() => setMemberMgmtOpen(true)}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                          {initials}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-neutral-900">
                            {user?.display_name ?? "未知"}
                          </p>
                          {profile && (
                            <p className="text-xs text-muted-foreground">
                              {profile.role_preference} · {profile.available_hours_per_week} 小时/周
                            </p>
                          )}
                        </div>
                      </div>
                      <Badge
                        variant={m.role === "owner" ? "default" : "secondary"}
                        className="shrink-0 ml-2"
                      >
                        {m.role === "owner" ? (
                          <span className="flex items-center gap-1">
                            <Crown className="h-3 w-3" />
                            负责人
                          </span>
                        ) : (
                          "成员"
                        )}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Projects */}
        <Card className="border-neutral-200 bg-white">
          <CardHeader className="border-b border-neutral-100 pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <FolderOpen className="h-5 w-5 text-emerald-500" />
              项目 ({filteredProjects.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-4">
            {localProjects.length > 0 && (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                <Input
                  placeholder="搜索项目名称..."
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                  className="pl-9 h-9"
                />
              </div>
            )}
            {localProjects.length === 0 ? (
              <EmptyState
                icon={
                  <FolderOpen className="h-10 w-10 text-muted-foreground/60" />
                }
                title="还没有项目"
                description="创建第一个项目，开始你的团队协作之旅"
              >
                <Button
                  variant="outline"
                  className="mt-4 gap-2"
                  onClick={() => setNewProjectOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  创建项目
                </Button>
              </EmptyState>
            ) : filteredProjects.length === 0 ? (
              <div className="py-8 text-center text-sm text-neutral-400">
                未找到匹配的项目
              </div>
            ) : (
              <>
                {filteredProjects.map((p) => {
                  const showDeleteConfirm = deleteConfirmId === p.id
                  return (
                    <div
                      key={p.id}
                      className="group flex w-full items-center justify-between rounded-xl border border-neutral-100 bg-white"
                    >
                      <button
                        onClick={() => {
                          onNavigateToProject?.(p.id);
                        }}
                        className="flex flex-1 min-w-0 items-center justify-between px-3 py-3 text-left transition-colors hover:bg-primary/5 rounded-l-xl"
                        aria-label={`打开项目 ${p.name}`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span
                            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                              p.status === "at_risk"
                                ? "bg-coral/10 text-coral"
                                : p.status === "completed"
                                  ? "bg-neutral-100 text-neutral-500"
                                  : "bg-emerald-100 text-emerald-600"
                            }`}
                          >
                            {p.status === "at_risk" ? (
                              <TriangleAlert className="h-5 w-5" />
                            ) : p.status === "completed" ? (
                              <Archive className="h-5 w-5" />
                            ) : (
                              <FolderOpen className="h-5 w-5" />
                            )}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-neutral-800">
                              {p.name}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {statusLabelMap[p.status] ?? p.status}
                            </p>
                          </div>
                        </div>
                      </button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleteConfirmId(p.id)
                        }}
                        className="h-8 w-8 p-0 mr-1 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label="删除项目"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      <AlertDialog open={showDeleteConfirm} onOpenChange={(open) => {
                        if (!open) {
                          setDeleteConfirmId(null);
                          setDeleteError(null);
                        }
                      }}>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>确认删除项目 &quot;{p.name}&quot;？</AlertDialogTitle>
                            <AlertDialogDescription>
                              删除后项目将无法恢复。所有相关的阶段、任务、Agent 提案等数据都将被永久删除。
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          {deleteError && (
                            <p className="text-sm text-destructive px-1">{deleteError}</p>
                          )}
                          <AlertDialogFooter>
                            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDeleteProject(p.id)}
                              disabled={deleting}
                              className="bg-destructive hover:bg-destructive/90"
                            >
                              {deleting ? "删除中..." : "确认删除"}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )
                })}
                <Separator className="my-2" />
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => setNewProjectOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  新建项目
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <MemberManagementDialog
        workspaceId={workspace.workspace_id}
        open={memberMgmtOpen}
        onOpenChange={setMemberMgmtOpen}
        members={members}
        memberships={memberships}
        profiles={profiles}
        onMembersChanged={onRefresh ?? (() => window.location.reload())}
      />

      <NewProjectDialog
        workspaceId={workspace.workspace_id}
        createdBy={workspace.owner_user_id}
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
        onCreated={(project) => {
          onNavigateToProject?.(project.id);
        }}
      />
    </motion.div>
  );
}
