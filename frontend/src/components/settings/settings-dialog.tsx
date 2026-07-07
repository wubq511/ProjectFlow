"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ModelConfigTab } from "./model-config-tab";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<string>("model-config");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
        </DialogHeader>

        {/* Tab bar */}
        <div className="flex gap-1 border-b pb-2 mb-4">
          <button
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              activeTab === "model-config"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
            onClick={() => setActiveTab("model-config")}
          >
            模型配置
          </button>
        </div>

        {/* Tab content */}
        {activeTab === "model-config" && <ModelConfigTab />}
      </DialogContent>
    </Dialog>
  );
}
