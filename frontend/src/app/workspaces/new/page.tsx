"use client";

import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { WorkspaceCreateForm } from "@/components/workspace/workspace-create-form";
import { InviteMemberPanel } from "@/components/workspace/invite-member-panel";
import { Separator } from "@/components/ui/separator";
import { StepIndicator } from "@/components/ui/step-indicator";
import { useState } from "react";
import type { Workspace } from "@/lib/types";

function WorkspaceNewContent() {
  const searchParams = useSearchParams();
  const ownerId = searchParams.get("ownerId") ?? undefined;
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-lg px-5 py-12">
      <StepIndicator
        steps={[
          { label: "选择身份", description: "创建新账号或选择现有用户" },
          { label: "创建工作区", description: "设置团队空间" },
          { label: "完善资料", description: "补充个人信息" },
          { label: "新建项目", description: "开始第一个项目" },
        ]}
        currentStep={1}
        className="mb-8"
      />

      <div className="space-y-6">
        <WorkspaceCreateForm
          ownerUserId={ownerId}
          onCreated={(ws: Workspace) => setWorkspaceId(ws.workspace_id)}
        />

        {workspaceId && (
          <>
            <Separator />
            <InviteMemberPanel workspaceId={workspaceId} />
          </>
        )}
      </div>
    </div>
  );
}

function LoadingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-moss" />
        <p className="text-sm text-ink/60">正在加载...</p>
      </div>
    </div>
  );
}

export default function NewWorkspacePage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <WorkspaceNewContent />
    </Suspense>
  );
}
