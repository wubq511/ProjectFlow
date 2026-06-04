import { Suspense } from "react";
import { Loader2 } from "lucide-react";

import { AccountSetupForm } from "@/components/onboarding/account-setup-form";
import { StepIndicator } from "@/components/ui/step-indicator";

function LoadingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-moss" />
        <p className="text-sm text-ink/60">正在加载引导流程...</p>
      </div>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <main className="min-h-screen bg-paper text-ink">
      <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-5 py-12">
        <StepIndicator
          steps={[
            { label: "选择身份", description: "创建新账号或选择现有用户" },
            { label: "创建工作区", description: "设置团队空间" },
            { label: "完善资料", description: "补充个人信息" },
            { label: "新建项目", description: "开始第一个项目" },
          ]}
          currentStep={0}
          className="mb-8"
        />
        <Suspense fallback={<LoadingFallback />}>
          <AccountSetupForm />
        </Suspense>
      </div>
    </main>
  );
}
