"use client";

import * as React from "react";
import { useEffect, useSyncExternalStore, useRef } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowRight, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";

const WORKSPACE_STORAGE_KEY = "projectflow:last-workspace-id";
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api";

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

async function checkWorkspaceExists(workspaceId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/workspaces/${workspaceId}`, { signal });
    return response.ok;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return false;
    return false;
  }
}

export function ProjectFlowHome() {
  const router = useRouter();
  const storedId = useSyncExternalStore(subscribeToStorage, getStorageSnapshot, getServerSnapshot);
  const [isLoadingDemo, setIsLoadingDemo] = React.useState(false);
  const [isValidating, setIsValidating] = React.useState(false);
  const validatedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!storedId || isLoadingDemo) return;
    if (validatedRef.current === storedId) return;

    validatedRef.current = storedId;
    setIsValidating(true);
    const controller = new AbortController();
    checkWorkspaceExists(storedId, controller.signal)
      .then((exists) => {
        if (controller.signal.aborted) return;
        if (exists) {
          router.replace(`/workspaces/${storedId}`);
        } else {
          localStorage.removeItem(WORKSPACE_STORAGE_KEY);
          window.dispatchEvent(new StorageEvent("storage", { key: WORKSPACE_STORAGE_KEY }));
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        localStorage.removeItem(WORKSPACE_STORAGE_KEY);
        window.dispatchEvent(new StorageEvent("storage", { key: WORKSPACE_STORAGE_KEY }));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsValidating(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [storedId, router, isLoadingDemo]);

  if (storedId && !isLoadingDemo && isValidating) {
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
            disabled={isLoadingDemo}
            onClick={async () => {
              setIsLoadingDemo(true);
              try {
                const { apiGet, loadDemoSeed } = await import("@/lib/api");
                await loadDemoSeed();
                const workspaces = await apiGet<{ id: string }[]>(`/workspaces`);
                if (workspaces.length > 0) {
                  const wsId = workspaces[0].id;
                  localStorage.setItem(WORKSPACE_STORAGE_KEY, wsId);
                  window.dispatchEvent(new StorageEvent("storage", { key: WORKSPACE_STORAGE_KEY }));
                  router.push(`/workspaces/${wsId}`);
                  return;
                }
              } catch (err) {
                console.error("加载演示数据失败:", err);
                alert(`加载演示数据失败: ${err instanceof Error ? err.message : "未知错误"}`);
              } finally {
                setIsLoadingDemo(false);
              }
            }}
            size="lg"
          >
            {isLoadingDemo ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                加载中...
              </>
            ) : (
              "加载演示数据"
            )}
          </Button>
        </div>
      </motion.div>
    </main>
  );
}
