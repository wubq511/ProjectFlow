"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowRight, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";

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

export function ProjectFlowHome() {
  const router = useRouter();
  const storedId = useSyncExternalStore(subscribeToStorage, getStorageSnapshot, getServerSnapshot);

  useEffect(() => {
    if (storedId) {
      router.replace(`/workspaces/${storedId}`);
    }
  }, [storedId, router]);

  if (storedId) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-moss" />
      </div>
    );
  }

  return (
    <main className="mx-auto flex min-h-[80vh] max-w-2xl flex-col items-center justify-center px-5 text-center">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-moss/10 px-4 py-1.5 text-sm font-medium text-moss">
          <Sparkles className="h-4 w-4" />
          主动推进型项目 Agent
        </div>

        <h1 className="font-display text-4xl font-black leading-tight md:text-5xl">
          让项目自己告诉你
          <br />
          下一步做什么
        </h1>

        <p className="mx-auto mt-5 max-w-md text-base leading-7 text-ink/65">
          ProjectFlow 帮大学生项目小队持续回答：项目该往哪走？谁适合做什么？哪些有风险？计划是否需要调整？
        </p>

        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <Button
            onClick={() => router.push("/onboarding")}
            className="bg-ink text-white hover:bg-ink/85"
            size="lg"
          >
            开始使用
            <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                const { apiGet, loadDemoSeed } = await import("@/lib/api");
                await loadDemoSeed();
                const workspaces = await apiGet<{ workspace_id: string }[]>(`/workspaces`);
                if (workspaces.length > 0) {
                  const wsId = workspaces[0].workspace_id;
                  localStorage.setItem(WORKSPACE_STORAGE_KEY, wsId);
                  window.dispatchEvent(new StorageEvent("storage", { key: WORKSPACE_STORAGE_KEY }));
                  router.push(`/workspaces/${wsId}`);
                  return;
                }
              } catch {
                router.push("/onboarding");
              }
            }}
            size="lg"
          >
            加载演示数据
          </Button>
        </div>
      </motion.div>
    </main>
  );
}
