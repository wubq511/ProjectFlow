"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useSearchParams, usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  Home,
  LayoutDashboard,
  Compass,
  Layers,
  CheckSquare,
  Users,
  ClipboardCheck,
  AlertTriangle,
  BarChart3,
  ChevronDown,
  Crown,
  Settings,
  LogOut,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Project, User, Workspace } from "@/lib/types";

interface LeftSidebarProps {
  workspace: Workspace;
  projects: Project[];
  currentProject: Project;
  currentUser: User;
  members: User[];
  badgeCounts?: {
    myTasks?: number;
    teamTasks?: number;
    risks?: number;
  };
}

const menuItems = [
  { id: "overview", label: "项目总览", icon: LayoutDashboard, href: "?view=overview" },
  { id: "direction", label: "方向卡", icon: Compass, href: "?view=direction" },
  { id: "stages", label: "阶段计划", icon: Layers, href: "?view=stages" },
  { id: "my-tasks", label: "我的任务", icon: CheckSquare, href: "?view=my-tasks" },
  { id: "team-tasks", label: "团队任务", icon: Users, href: "?view=team-tasks" },
  { id: "checkin", label: "签到与状态", icon: ClipboardCheck, href: "?view=checkin" },
  { id: "risks", label: "风险预警", icon: AlertTriangle, href: "?view=risks" },
  { id: "retro", label: "项目复盘", icon: BarChart3, href: "?view=retro" },
];

export function LeftSidebar({
  workspace,
  projects,
  currentProject,
  currentUser,
  members,
  badgeCounts = {},
}: LeftSidebarProps) {
  const params = useParams();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const projectId = params.projectId as string;
  const currentView = searchParams.get("view") ?? "overview";

  const [projectOpen, setProjectOpen] = React.useState(false);
  const [userOpen, setUserOpen] = React.useState(false);

  return (
    <div className="flex h-full flex-col py-4">
      {/* Logo / Home */}
      <div className="px-4 mb-4">
        <Link
          href="/"
          className="flex items-center gap-2 text-lg font-black text-[var(--color-text-primary)] hover:opacity-80 transition-opacity"
        >
          <Home className="h-5 w-5" />
          ProjectFlow
        </Link>
      </div>

      {/* Project Switcher */}
      <div className="px-4 mb-3">
        <button
          onClick={() => setProjectOpen(!projectOpen)}
          className="flex w-full items-center justify-between rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-primary)] transition-colors"
        >
          <span className="flex items-center gap-2 truncate">
            <LayoutDashboard className="h-4 w-4 text-[var(--color-primary)]" />
            <span className="truncate">{currentProject.name}</span>
          </span>
          <ChevronDown className={cn("h-4 w-4 transition-transform", projectOpen && "rotate-180")} />
        </button>

        {projectOpen && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-1 rounded-lg border border-dashed border-[var(--border)] bg-[var(--color-bg-primary)] py-1"
          >
            {projects.map((p) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 text-sm transition-colors",
                  p.id === currentProject.id
                    ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                    : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                )}
              >
                <LayoutDashboard className="h-3.5 w-3.5" />
                <span className="truncate">{p.name}</span>
              </Link>
            ))}
          </motion.div>
        )}
      </div>

      {/* Divider */}
      <div className="mx-4 border-t border-dashed border-[var(--border)]" />

      {/* Menu Items */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5">
        {menuItems.map((item) => {
          const isActive = currentView === item.id;
          const badge =
            item.id === "my-tasks"
              ? badgeCounts.myTasks
              : item.id === "team-tasks"
                ? badgeCounts.teamTasks
                : item.id === "risks"
                  ? badgeCounts.risks
                  : undefined;

          return (
            <Link
              key={item.id}
              href={`/projects/${projectId}${item.href}`}
              className={cn(
                "flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150",
                isActive
                  ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)] hover:text-[var(--color-text-primary)]"
              )}
            >
              <span className="flex items-center gap-2.5">
                <item.icon className="h-4 w-4" />
                {item.label}
              </span>
              {badge !== undefined && badge > 0 && (
                <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[var(--color-accent)] px-1.5 text-xs font-bold text-[var(--color-text-secondary)]">
                  {badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Divider */}
      <div className="mx-4 border-t border-dashed border-[var(--border)]" />

      {/* User Panel */}
      <div className="px-4 pt-3">
        <button
          onClick={() => setUserOpen(!userOpen)}
          className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-sm hover:bg-[var(--color-bg-primary)] transition-colors"
        >
          <span className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-[var(--color-primary)] text-xs font-bold">
              {currentUser.display_name.charAt(0)}
            </div>
            <span className="truncate">
              {currentUser.display_name}
              {workspace.owner_user_id === currentUser.user_id && (
                <span className="ml-1 inline-flex items-center text-[var(--color-accent)]">
                  <Crown className="h-3 w-3" />
                </span>
              )}
            </span>
          </span>
          <ChevronDown className={cn("h-4 w-4 transition-transform", userOpen && "rotate-180")} />
        </button>

        {userOpen && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-1 rounded-lg border border-dashed border-[var(--border)] bg-[var(--color-bg-primary)] py-1"
          >
            <div className="px-3 py-2 text-xs text-[var(--color-text-tertiary)]">
              切换成员视角
            </div>
            {members.map((member) => (
              <button
                key={member.user_id}
                onClick={() => {
                  localStorage.setItem("projectflow:current-user-id", member.user_id);
                  window.dispatchEvent(new StorageEvent("storage", { key: "projectflow:current-user-id" }));
                  setUserOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors",
                  member.user_id === currentUser.user_id
                    ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                    : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                )}
              >
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-[var(--color-primary)] text-xs font-bold">
                  {member.display_name.charAt(0)}
                </div>
                <span className="truncate">{member.display_name}</span>
                {workspace.owner_user_id === member.user_id && (
                  <Crown className="h-3 w-3 text-[var(--color-accent)]" />
                )}
              </button>
            ))}
            <div className="border-t border-dashed border-[var(--border)] my-1" />
            <Link
              href={`/workspaces/${workspace.workspace_id}`}
              className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
            >
              <Settings className="h-4 w-4" />
              工作台设置
            </Link>
            <Link
              href="/"
              className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
            >
              <LogOut className="h-4 w-4" />
              返回首页
            </Link>
          </motion.div>
        )}
      </div>
    </div>
  );
}
