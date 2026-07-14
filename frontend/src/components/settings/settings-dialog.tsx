"use client";

import { useState } from "react";
import { Brain, Database } from "lucide-react";
import { usePathname } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ModelConfigTab } from "./model-config-tab";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const tabs = [
  { id: "model-config", label: "模型配置", icon: Brain },
  { id: "system", label: "系统", icon: Database },
] as const;

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<string>("model-config");
  const pathname = usePathname();
  const isWorkspace = pathname.startsWith("/workspaces/");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-hidden p-0">
        <div className="flex h-[85vh]">
          {/* Sidebar navigation */}
          <div className="w-48 border-r bg-neutral-50/70 p-4">
            <DialogHeader className="mb-4">
              <DialogTitle className="text-base">设置</DialogTitle>
            </DialogHeader>
            <nav className="space-y-1" aria-label="设置标签">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition",
                    activeTab === tab.id
                      ? "bg-white text-neutral-900 shadow-sm"
                      : "text-neutral-500 hover:bg-white/60 hover:text-neutral-700",
                  )}
                  aria-current={activeTab === tab.id ? "page" : undefined}
                >
                  <tab.icon className="h-4 w-4" aria-hidden />
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === "model-config" && <ModelConfigTab />}
            {activeTab === "system" && <SystemTab isWorkspace={isWorkspace} />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SystemTab({ isWorkspace }: { isWorkspace: boolean }) {
  const [resetting, setResetting] = useState(false);

  const handleReset = () => {
    if (
      !window.confirm(
        "确定要重置演示数据吗？所有项目、任务和阶段数据将恢复为初始演示状态。",
      )
    ) {
      return;
    }
    setResetting(true);
    window.dispatchEvent(new CustomEvent("projectflow:reset-demo"));
    // The actual reset is handled by the workspace page listener.
    // Keep the spinner briefly so the click feels acknowledged.
    window.setTimeout(() => setResetting(false), 800);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-neutral-900">系统</h3>
        <p className="mt-1 text-xs text-neutral-500">
          管理演示数据和其他全局设置。
        </p>
      </div>

      <div className="rounded-xl border border-coral/20 bg-coral/5 p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h4 className="text-sm font-medium text-coral">重置演示数据</h4>
            <p className="mt-1 text-xs leading-5 text-neutral-600">
              将项目、阶段、任务和成员数据恢复为初始演示状态。此操作会重新生成示例内容，当前未确认的提案和对话将丢失。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 self-start border-coral/30 text-coral hover:bg-coral/10 hover:text-coral"
            disabled={!isWorkspace || resetting}
            onClick={handleReset}
          >
            {resetting ? "重置中…" : "重置数据"}
          </Button>
        </div>
        {!isWorkspace && (
          <p className="mt-3 text-xs text-neutral-500">
            请进入工作台后使用此功能。
          </p>
        )}
      </div>
    </div>
  );
}
