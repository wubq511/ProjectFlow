"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ProjectIntakeForm } from "./project-intake-form";
import type { Project, ProjectTemplate } from "@/lib/types";

interface NewProjectDialogProps {
  workspaceId: string;
  createdBy: string;
  defaultProjectTemplate?: ProjectTemplate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (project: Project) => void;
}

export function NewProjectDialog({
  workspaceId,
  createdBy,
  defaultProjectTemplate,
  open,
  onOpenChange,
  onCreated,
}: NewProjectDialogProps) {
  const [createdProject, setCreatedProject] = useState<Project | null>(null);

  const handleCreated = (project: Project) => {
    setCreatedProject(project);
    onCreated?.(project);
    // Close dialog after a short delay so user sees success
    setTimeout(() => {
      onOpenChange(false);
      setCreatedProject(null);
    }, 1500);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setCreatedProject(null);
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto custom-scrollbar p-6">
        <DialogHeader className="sr-only">
          <DialogTitle>新建项目</DialogTitle>
          <DialogDescription>
            填写项目信息，AI 将为你生成阶段规划和任务分解
          </DialogDescription>
        </DialogHeader>
        <ProjectIntakeForm
          workspaceId={workspaceId}
          defaultCreatedBy={createdBy}
          defaultProjectTemplate={defaultProjectTemplate}
          onCreated={handleCreated}
        />
      </DialogContent>
    </Dialog>
  );
}
