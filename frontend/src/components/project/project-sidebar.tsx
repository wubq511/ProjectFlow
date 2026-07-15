"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  Compass,
  GitBranch,
  ListTodo,
  Users,
  ClipboardCheck,
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Home,
  Briefcase,
  Building2,
  ChevronDown,
  FolderOpen,
  Plus,
  Settings,
  Crown,
  BookOpen,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProjectState, Workspace } from "@/lib/types";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { MemberManagementDialog } from "@/components/member/member-management-dialog";
import { NewWorkspaceDialog } from "@/components/workspace/new-workspace-dialog";
import { setCurrentUserId, clearLastWorkspaceId } from "@/components/app-shell";
import { listWorkspaces } from "@/lib/api";

export type ProjectView =
  | "agent"
  | "overview"
  | "direction"
  | "stages"
  | "my-tasks"
  | "team-tasks"
  | "checkin"
  | "risks"
  | "memory"
  | "retro";

const MENU_ITEMS: {
  id: ProjectView;
  label: string;
  icon: React.ElementType;
  badge?: (state: ProjectState, currentUserId?: string) => number;
}[] = [
  { id: "agent", label: "Agent 对话", icon: Bot },
  { id: "overview", label: "项目总览", icon: LayoutDashboard },
  { id: "direction", label: "方向卡", icon: Compass },
  { id: "stages", label: "阶段计划", icon: GitBranch },
  {
    id: "my-tasks",
    label: "我的任务",
    icon: ListTodo,
    badge: (state, currentUserId) =>
      (state.tasks ?? []).filter(
        (t) =>
          t.owner_user_id === currentUserId && t.status !== "done"
      ).length,
  },
  {
    id: "team-tasks",
    label: "团队任务",
    icon: Users,
    badge: (state) => (state.tasks ?? []).filter((t) => t.status !== "done").length,
  },
  { id: "checkin", label: "签到与状态", icon: ClipboardCheck },
  {
    id: "risks",
    label: "风险预警",
    icon: AlertTriangle,
    badge: (state) => (state.risks ?? []).filter((r) => r.status === "open").length,
  },
  { id: "memory", label: "项目记忆", icon: BookOpen },
  { id: "retro", label: "项目复盘", icon: BarChart3 },
];

const OVERVIEW_GROUP: ProjectView[] = ["agent", "overview", "direction", "stages"];
const EXECUTION_GROUP: ProjectView[] = [
  "my-tasks",
  "team-tasks",
  "checkin",
  "risks",
  "memory",
];

interface ProjectSidebarProps {
  projectId: string;
  state: ProjectState;
  currentUserId?: string;
  collapsed: boolean;
  onToggle: () => void;
  showWorkspace: boolean;
  onShowWorkspace: (show: boolean) => void;
  onSelectProject?: (projectId: string) => void;
  onNavigateView?: (view: ProjectView) => void;
  workspaceState?: import("@/lib/types").WorkspaceState;
  onRefresh?: () => void;
}

export function ProjectSidebar({
  projectId,
  state,
  currentUserId,
  collapsed,
  onToggle,
  showWorkspace,
  onShowWorkspace,
  onSelectProject,
  onNavigateView,
  workspaceState,
  onRefresh,
}: ProjectSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentView = (searchParams.get("view") as ProjectView) || "overview";
  const [hovered, setHovered] = useState(false);
  const [memberMgmtOpen, setMemberMgmtOpen] = useState(false);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(true);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [allWorkspaces, setAllWorkspaces] = useState<Workspace[]>(() =>
    state.workspace ? [state.workspace] : []
  );

  const handleNavigate = useCallback(
    (view: ProjectView) => {
      onShowWorkspace(false);
      if (onNavigateView) {
        onNavigateView(view);
      }
    },
    [onShowWorkspace, onNavigateView]
  );

  // Keyboard shortcut: Ctrl+B to toggle sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "b") {
        e.preventDefault();
        onToggle();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onToggle]);

  const isExpanded = !collapsed || hovered;

  const workspace = state.workspace ?? { workspace_id: "", name: "工作区", owner_user_id: "" };
  const otherProjects = state.projects?.filter((p) => p.id !== projectId) ?? [];
  const currentMembership = state.memberships?.find((m) => m.user_id === currentUserId);
  const isOwner = currentMembership?.role === "owner";

  // Fetch all workspaces for the switcher
  useEffect(() => {
    let ignore = false;
    listWorkspaces()
      .then((workspaces) => {
        if (!ignore) setAllWorkspaces(workspaces);
      })
      .catch((err) => {
        console.error("Failed to load workspace list:", err);
      });
    return () => { ignore = true; };
  }, [workspace.workspace_id]);

  const badgeCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of MENU_ITEMS) {
      if (item.badge) {
        map.set(item.id, item.badge(state, currentUserId));
      }
    }
    return map;
  }, [state, currentUserId]);

  return (
    <motion.aside
      className={cn(
        "relative flex h-screen flex-col border-r border-neutral-200/70 bg-bg-sidebar transition-all duration-200 ease-out",
        isExpanded ? "w-60" : "w-12"
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      initial={false}
    >
      {/* Toggle button */}
      <button
        type="button"
        onClick={onToggle}
        className="absolute -right-3 top-4 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-400 shadow-sm transition hover:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-moss/30"
        aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
      >
        {collapsed ? (
          <ChevronRight className="h-3 w-3" />
        ) : (
          <ChevronLeft className="h-3 w-3" />
        )}
      </button>

      {/* Header: Workspace selector / Home */}
      <div className="flex h-14 items-center gap-2 border-b border-neutral-100 px-3">
        <button
          type="button"
          onClick={() => {
            clearLastWorkspaceId();
            router.push("/");
          }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-moss text-white"
        >
          <Home className="h-4 w-4" />
        </button>
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden whitespace-nowrap"
            >
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-sm font-semibold text-neutral-900 transition hover:bg-neutral-50 focus:outline-none"
                >
                  <Building2 className="h-3.5 w-3.5 text-neutral-400" />
                  <span className="max-w-[140px] truncate">{workspace.name}</span>
                  <ChevronDown className="h-3 w-3 text-neutral-400" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-52">
                  <DropdownMenuItem
                    onClick={() => onShowWorkspace(true)}
                    className="cursor-pointer gap-2"
                  >
                    <LayoutDashboard className="h-4 w-4" />
                    工作台首页
                  </DropdownMenuItem>

                  {/* Workspace switcher */}
                  {allWorkspaces.filter((ws) => ws.workspace_id !== workspace.workspace_id).length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <span className="block px-2 py-1 text-xs font-medium text-neutral-400">
                        切换工作区
                      </span>
                      {allWorkspaces
                        .filter((ws) => ws.workspace_id !== workspace.workspace_id)
                        .map((ws) => (
                          <DropdownMenuItem
                            key={ws.workspace_id}
                            onClick={() => router.push(`/workspaces/${ws.workspace_id}`)}
                            className="cursor-pointer gap-2"
                          >
                            <Building2 className="h-4 w-4 text-neutral-400" />
                            <span className="truncate">{ws.name}</span>
                          </DropdownMenuItem>
                        ))}
                    </>
                  )}

                  <DropdownMenuItem
                    onClick={() => setMemberMgmtOpen(true)}
                    className="cursor-pointer gap-2"
                  >
                    <Settings className="h-4 w-4" />
                    成员管理
                    {isOwner && (
                      <span className="ml-auto rounded-full bg-moss/10 px-1.5 py-0.5 text-[10px] font-medium text-moss">
                        负责人
                      </span>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <span className="block px-2 py-1 text-xs font-medium text-neutral-400">
                    项目
                  </span>
                  {otherProjects.length === 0 ? (
                    <span className="block px-2 py-1.5 text-xs text-neutral-400">
                      暂无其他项目
                    </span>
                  ) : (
                    otherProjects.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        onClick={() => {
                          onShowWorkspace(false);
                          onSelectProject?.(p.id);
                        }}
                        className="cursor-pointer gap-2"
                      >
                        <FolderOpen className="h-4 w-4 text-neutral-400" />
                        <span className="truncate">{p.name}</span>
                      </DropdownMenuItem>
                    ))
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      // In unified layout, open workspace view where new project dialog is available
                      onShowWorkspace(true);
                    }}
                    className="cursor-pointer gap-2 text-moss"
                  >
                    <Plus className="h-4 w-4" />
                    新建项目
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto custom-scrollbar py-3">
        {/* Workspace section (expandable) */}
        <div className="px-1.5">
          <button
            type="button"
            onClick={() => setWorkspaceExpanded(!workspaceExpanded)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-moss/30",
              showWorkspace
                ? "bg-moss/10 text-moss"
                : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800",
              !isExpanded && "justify-center px-0"
            )}
          >
            <Building2 className="h-4 w-4 shrink-0" aria-hidden />
            <AnimatePresence>
              {isExpanded && (
                <motion.span
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: "auto" }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex-1 overflow-hidden whitespace-nowrap text-left"
                >
                  工作区
                </motion.span>
              )}
            </AnimatePresence>
            {isExpanded && (
              <motion.div
                initial={false}
                animate={{ rotate: workspaceExpanded ? 180 : 0 }}
                transition={{ duration: 0.15 }}
                className="ml-auto"
              >
                <ChevronDown className="h-3 w-3" />
              </motion.div>
            )}
          </button>

          {/* Expanded workspace list */}
          <AnimatePresence>
            {workspaceExpanded && isExpanded && (
              <motion.div
                initial={{ maxHeight: 0, opacity: 0 }}
                animate={{ maxHeight: 300, opacity: 1 }}
                exit={{ maxHeight: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="ml-4 space-y-0.5 py-1">
                  {/* All workspaces — switch by clicking */}
                  {allWorkspaces.map((ws) => (
                    <button
                      key={ws.workspace_id}
                      type="button"
                      onClick={() => {
                        if (ws.workspace_id !== workspace.workspace_id) {
                          router.push(`/workspaces/${ws.workspace_id}`);
                        } else {
                          onShowWorkspace(true);
                        }
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                        ws.workspace_id === workspace.workspace_id && showWorkspace
                          ? "bg-moss/10 text-moss font-medium"
                          : ws.workspace_id === workspace.workspace_id
                            ? "text-neutral-700 font-medium"
                            : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800"
                      )}
                    >
                      <Building2 className="h-3 w-3 shrink-0" />
                      <span className="truncate">{ws.name}</span>
                    </button>
                  ))}

                  {/* New workspace button */}
                  <button
                    type="button"
                    onClick={() => setNewWorkspaceOpen(true)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-moss transition-colors hover:bg-moss/5"
                  >
                    <Plus className="h-3 w-3 shrink-0" />
                    <span>新建工作区</span>
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Divider */}
        {isExpanded && (
          <div className="mx-4 my-2 border-t border-dashed border-neutral-200" />
        )}
        {!isExpanded && <div className="my-2 h-px bg-neutral-100 mx-2" />}

        {/* Overview group */}
        <ul className="space-y-0.5 px-1.5">
          {MENU_ITEMS.filter((item) => OVERVIEW_GROUP.includes(item.id)).map(
            (item) => (
              <MenuItem
                key={item.id}
                item={item}
                isActive={currentView === item.id && !showWorkspace}
                isExpanded={isExpanded}
                onClick={() => handleNavigate(item.id)}
                badgeCount={badgeCounts.get(item.id)}
                disabled={showWorkspace}
              />
            )
          )}
        </ul>

        {/* Divider */}
        {isExpanded && (
          <div className="mx-4 my-2 border-t border-dashed border-neutral-200" />
        )}
        {!isExpanded && <div className="my-2 h-px bg-neutral-100 mx-2" />}

        {/* Execution group */}
        <ul className="space-y-0.5 px-1.5">
          {MENU_ITEMS.filter((item) => EXECUTION_GROUP.includes(item.id)).map(
            (item) => (
              <MenuItem
                key={item.id}
                item={item}
                isActive={currentView === item.id && !showWorkspace}
                isExpanded={isExpanded}
                onClick={() => handleNavigate(item.id)}
                badgeCount={badgeCounts.get(item.id)}
                disabled={showWorkspace}
              />
            )
          )}
        </ul>

        {/* Divider */}
        {isExpanded && (
          <div className="mx-4 my-2 border-t border-dashed border-neutral-200" />
        )}
        {!isExpanded && <div className="my-2 h-px bg-neutral-100 mx-2" />}

        {/* Retro group */}
        <ul className="space-y-0.5 px-1.5">
          {MENU_ITEMS.filter((item) => item.id === "retro").map((item) => (
            <MenuItem
              key={item.id}
              item={item}
              isActive={currentView === item.id && !showWorkspace}
              isExpanded={isExpanded}
              onClick={() => handleNavigate(item.id)}
              badgeCount={item.badge?.(state, currentUserId)}
              disabled={showWorkspace}
            />
          ))}
        </ul>
      </nav>

      {/* Footer: User switcher + Settings */}
      <div className="border-t border-neutral-100 p-2 space-y-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs text-neutral-500 transition hover:bg-neutral-50 focus:outline-none",
              !isExpanded && "justify-center"
            )}
          >
            <Briefcase className="h-4 w-4 shrink-0" />
            <AnimatePresence>
              {isExpanded && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="overflow-hidden whitespace-nowrap"
                >
                  {(state.members ?? []).find((m) => m.user_id === currentUserId)
                    ?.display_name ?? "选择身份"}
                </motion.span>
              )}
            </AnimatePresence>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            {(state.members ?? []).map((member) => (
              <DropdownMenuItem
                key={member.user_id}
                onClick={() => setCurrentUserId(member.user_id)}
                className={cn(
                  "cursor-pointer text-sm",
                  member.user_id === currentUserId && "font-semibold text-moss",
                )}
              >
                {member.display_name}
                {member.user_id === currentUserId && " ✓"}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("projectflow:open-settings"))}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs text-neutral-500 transition hover:bg-neutral-50 focus:outline-none",
            !isExpanded && "justify-center"
          )}
          title="设置"
          aria-label="设置"
        >
          <Settings className="h-4 w-4 shrink-0" aria-hidden />
          <AnimatePresence>
            {isExpanded && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="overflow-hidden whitespace-nowrap"
              >
                设置
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      </div>

      {/* Member Management Dialog */}
      <MemberManagementDialog
        workspaceId={workspace.workspace_id}
        open={memberMgmtOpen}
        onOpenChange={setMemberMgmtOpen}
        members={state.members ?? []}
        memberships={state.memberships ?? []}
        profiles={state.member_profiles ?? []}
        onMembersChanged={onRefresh ?? (() => window.location.reload())}
      />

      {/* New Workspace Dialog */}
      <NewWorkspaceDialog
        open={newWorkspaceOpen}
        onOpenChange={setNewWorkspaceOpen}
        onCreated={(ws) => {
          if (router) {
            router.push(`/workspaces/${ws.workspace_id}`);
          } else if (typeof window !== "undefined") {
            window.location.href = `/workspaces/${ws.workspace_id}`;
          }
        }}
      />
    </motion.aside>
  );
}

function MenuItem({
  item,
  isActive,
  isExpanded,
  onClick,
  badgeCount,
  disabled = false,
}: {
  item: (typeof MENU_ITEMS)[number];
  isActive: boolean;
  isExpanded: boolean;
  onClick: () => void;
  badgeCount?: number;
  disabled?: boolean;
}) {
  const Icon = item.icon;

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={disabled ? "请先选择一个项目" : undefined}
        className={cn(
          "relative flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-moss/30",
          isActive
            ? "text-moss"
            : disabled
              ? "cursor-not-allowed text-neutral-300 opacity-60"
              : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800",
          !isExpanded && "justify-center px-0"
        )}
        aria-current={isActive ? "page" : undefined}
      >
        {isActive && (
          <motion.div
            layoutId="activeNavBackground"
            className="absolute inset-0 rounded-lg bg-moss/10"
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          />
        )}
        <Icon className="h-4 w-4 shrink-0 z-10" aria-hidden />
        <AnimatePresence>
          {isExpanded && (
            <motion.span
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ duration: 0.15 }}
              className="flex-1 overflow-hidden whitespace-nowrap text-left z-10"
            >
              {item.label}
            </motion.span>
          )}
        </AnimatePresence>
        {isExpanded && badgeCount ? (
          <motion.span
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            className={cn(
              "ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold z-10",
              isActive
                ? "bg-moss/20 text-moss"
                : "bg-neutral-100 text-neutral-500"
            )}
          >
            {badgeCount}
          </motion.span>
        ) : null}
      </button>
    </li>
  );
}
