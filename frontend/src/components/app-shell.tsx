"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { motion } from "framer-motion";
import { Home, LayoutDashboard, Plus, Menu } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from "@/components/ui/sheet";

const WORKSPACE_STORAGE_KEY = "projectflow:last-workspace-id";

function subscribeToStorage(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

function getStorageSnapshot() {
  return localStorage.getItem(WORKSPACE_STORAGE_KEY);
}

function getServerSnapshot() {
  return null;
}

const baseNavItems = [
  { label: "首页", href: "/", icon: Home },
  { label: "新建项目", href: "/projects/new", icon: Plus },
] as const;

function useWorkspaceNav() {
  const pathname = usePathname();
  const workspaceMatch = pathname.match(/\/workspaces\/([^/]+)/);
  const urlWorkspaceId = workspaceMatch?.[1] ?? null;

  const cachedId = useSyncExternalStore(
    subscribeToStorage,
    getStorageSnapshot,
    getServerSnapshot,
  );

  useEffect(() => {
    if (urlWorkspaceId) {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, urlWorkspaceId);
      window.dispatchEvent(new StorageEvent("storage", { key: WORKSPACE_STORAGE_KEY }));
    }
  }, [urlWorkspaceId]);

  return urlWorkspaceId || cachedId;
}

export function setLastWorkspaceId(id: string) {
  if (typeof window !== "undefined") {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, id);
  }
}

function NavLink({
  label,
  href,
  icon: Icon,
  active,
}: {
  label: string;
  href: string;
  icon: React.ElementType;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-moss/10 text-moss"
          : "text-ink/65 hover:bg-ink/5 hover:text-ink"
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {label}
    </Link>
  );
}

function MobileNav({ pathname, workspaceId }: { pathname: string; workspaceId: string | null }) {
  const navItems = workspaceId
    ? [
        { label: "首页", href: "/", icon: Home },
        { label: "工作台", href: `/workspaces/${workspaceId}`, icon: LayoutDashboard },
        { label: "新建项目", href: "/projects/new", icon: Plus },
      ]
    : baseNavItems;

  return (
    <Sheet>
      <SheetTrigger render={<Button variant="ghost" size="icon" />}>
        <Menu />
        <span className="sr-only">打开导航</span>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 bg-paper p-0">
        <SheetHeader className="border-b border-ink/10 px-5 py-4">
          <SheetTitle className="font-display text-lg font-black text-ink">
            ProjectFlow
          </SheetTitle>
          <SheetDescription className="text-xs text-ink/55">
            主动推进型项目 Agent
          </SheetDescription>
        </SheetHeader>
        <nav className="flex flex-col gap-1 p-4">
          {navItems.map((item) => {
            const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
            return (
              <SheetClose
                key={item.href}
                render={
                  <Link
                    href={item.href}
                    className={cn(
                      "inline-flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                      active
                        ? "bg-moss/10 text-moss"
                        : "text-ink/65 hover:bg-ink/5 hover:text-ink"
                    )}
                  />
                }
              >
                <item.icon className="h-4 w-4" aria-hidden />
                {item.label}
              </SheetClose>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const workspaceId = useWorkspaceNav();

  const navItems = workspaceId
    ? [
        { label: "首页", href: "/", icon: Home },
        { label: "工作台", href: `/workspaces/${workspaceId}`, icon: LayoutDashboard },
        { label: "新建项目", href: "/projects/new", icon: Plus },
      ]
    : baseNavItems;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <motion.header
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="sticky top-0 z-40 border-b border-ink/8 bg-paper/90 backdrop-blur-md"
      >
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-5 lg:px-8">
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2">
              <span className="font-display text-lg font-black text-ink">
                ProjectFlow
              </span>
            </Link>

            <nav className="hidden items-center gap-1 md:flex">
              {navItems.map((item) => (
                <NavLink
                  key={item.href}
                  label={item.label}
                  href={item.href}
                  icon={item.icon}
                  active={pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href))}
                />
              ))}
            </nav>
          </div>

          <div className="hidden md:block" />

          <div className="md:hidden">
            <MobileNav pathname={pathname} workspaceId={workspaceId} />
          </div>
        </div>
      </motion.header>

      <Separator className="opacity-40" />

      <motion.main
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        {children}
      </motion.main>
    </div>
  );
}
