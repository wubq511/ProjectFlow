"use client";

import * as React from "react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CalendarCheck,
  CheckCircle2,
  ClipboardCheck,
  Compass,
  Clock3,
  GitBranch,
  HelpCircle,
  Loader2,
  MessageCircle,
  Radar,
  Route,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";

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

const heroMetrics = [
  { value: "Phase 35", label: "演示闭环" },
  { value: "4 阶段", label: "规划到监控" },
  { value: "人工确认", label: "高影响先确认" },
] as const;

const productNavItems = ["项目空间", "方向卡", "阶段计划", "团队行动", "风险审查"] as const;

const actionRows = [
  { title: "把社交动态移出 MVP", owner: "负责人确认", due: "09:40", accent: "bg-coral" },
  { title: "拆出后端 API 与数据模型", owner: "陈沐", due: "今天", accent: "bg-moss" },
  { title: "安排演示脚本彩排", owner: "林舟", due: "明天", accent: "bg-citron" },
] as const;

const agentSignals = [
  { label: "方向", value: "先锁定二手交易 MVP，不进入社区功能。" },
  { label: "分工", value: "陈沐适合后端 API；林舟负责演示链路。" },
  { label: "风险", value: "支付与实时聊天会拖慢交付，建议放入二期。" },
] as const;

const timelineEvents = [
  { time: "09:12", title: "收到新想法", text: "校园二手交易平台，目标是一周内完成可演示版本。" },
  { time: "09:18", title: "生成方向卡", text: "保留发布、搜索、联系卖家；排除支付、评价和社交动态。" },
  { time: "09:31", title: "推荐分工", text: "按技能和可用时间拆出 owner，等待负责人确认。" },
] as const;

const workflowItems = [
  {
    icon: Compass,
    title: "方向澄清",
    eyebrow: "先把方向说清楚",
    text: "项目想法、假设、未知问题和 MVP 边界被整理成可以确认的方向卡。",
  },
  {
    icon: Users,
    title: "分工推荐",
    eyebrow: "分工有依据",
    text: "推荐 owner 时引用技能、时间、意向和限制，不再靠群聊里谁先回复。",
  },
  {
    icon: ClipboardCheck,
    title: "执行追踪",
    eyebrow: "下一步很具体",
    text: "阶段目标被拆成行动卡、检查点和签到反馈，团队知道今天该推进什么。",
  },
  {
    icon: Radar,
    title: "风险监控",
    eyebrow: "风险会被推到眼前",
    text: "范围、依赖、deadline 和 workload 的异常会被记录证据，再给出重排建议。",
  },
] as const;

const comparisonRows = [
  { label: "传统任务列表", value: "记录任务是否完成，但不判断计划是否仍然合理。" },
  { label: "ProjectFlow", value: "持续读取项目状态，给出方向、分工、行动和风险的下一步建议。" },
  { label: "关键差异", value: "建议不会直接生效，高影响操作始终等待负责人确认。" },
] as const;

const kineticEase = [0.32, 0.72, 0, 1] as const;

const heroGroupVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.08,
      delayChildren: 0.12,
    },
  },
};

const heroItemVariants = {
  hidden: { opacity: 0, y: 30, scale: 0.98 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.75, ease: kineticEase },
  },
};

function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 42 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.22 }}
      transition={{ duration: 0.78, delay, ease: kineticEase }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function ProjectFlowHome() {
  const router = useRouter();
  const storedId = useSyncExternalStore(subscribeToStorage, getStorageSnapshot, getServerSnapshot);
  const [isLoadingDemo, setIsLoadingDemo] = React.useState(false);
  const [isValidating, setIsValidating] = React.useState(false);
  const [demoError, setDemoError] = React.useState<string | null>(null);
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
    <main className="bg-[#050608] text-white">
      <section className="relative overflow-hidden border-b border-white/10 bg-[#050608]">
        <motion.div
          aria-hidden
          className="absolute inset-0 bg-[url('/images/projectflow-cinematic-hero.png')] bg-cover bg-center opacity-80"
          initial={{ opacity: 0, scale: 1.06, x: -18 }}
          animate={{ opacity: 0.84, scale: [1.04, 1.08, 1.04], x: [-18, 12, -18], y: [0, -10, 0] }}
          transition={{ duration: 18, repeat: Infinity, ease: kineticEase }}
        />
        <div
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(180deg,rgba(5,6,8,0.1)_0%,rgba(5,6,8,0.42)_42%,#050608_100%)]"
        />
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.18] [background-image:linear-gradient(rgba(255,255,255,0.14)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.12)_1px,transparent_1px)] [background-size:72px_72px]"
        />
        <motion.div
          aria-hidden
          className="absolute left-[-12%] top-[18%] h-[22rem] w-[80rem] rotate-[-14deg] bg-[linear-gradient(90deg,transparent,rgba(255,54,77,0.24),rgba(61,127,255,0.16),transparent)] opacity-70"
          animate={{ x: ["-8%", "8%", "-8%"], opacity: [0.42, 0.76, 0.42] }}
          transition={{ duration: 10, repeat: Infinity, ease: kineticEase }}
        />

        <div className="site-container relative flex min-h-[100dvh] flex-col justify-end pb-12 pt-32 md:pb-16 md:pt-40">
          <motion.div
            variants={heroGroupVariants}
            initial="hidden"
            animate="visible"
            className="mx-auto max-w-5xl text-center"
          >
            <motion.div
              variants={heroItemVariants}
              className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.08] px-3.5 py-2 text-sm font-medium text-white/72 shadow-[0_18px_60px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)]"
            >
              <GitBranch className="h-4 w-4 text-[#ff4055]" aria-hidden />
              ProjectFlow / 项目操作系统
            </motion.div>

            <motion.h1
              variants={heroItemVariants}
              className="mx-auto mt-7 max-w-6xl text-balance text-5xl font-semibold leading-[0.94] text-white sm:text-6xl md:text-7xl lg:text-8xl xl:text-[7.4rem]"
            >
              学生项目的主动推进工作台
            </motion.h1>

            <motion.p
              variants={heroItemVariants}
              className="mx-auto mt-7 max-w-2xl text-pretty text-base leading-8 text-white/68 md:text-lg"
            >
              它不只是保存任务，而是持续读取项目状态，把方向澄清、阶段计划、分工建议和风险重排串成一条可以执行的节奏。
            </motion.p>

            <motion.div variants={heroItemVariants} className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
              <Button
                onClick={() => router.push("/onboarding")}
                className="group h-12 rounded-full bg-white pl-6 pr-2 text-neutral-950 shadow-[0_22px_70px_rgba(255,54,77,0.24),inset_0_1px_0_rgba(255,255,255,0.95)] transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#f4f4f1] active:scale-[0.98]"
                size="lg"
              >
                开始使用
                <span className="ml-3 flex h-8 w-8 items-center justify-center rounded-full bg-neutral-950 text-white transition-transform duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-1 group-hover:-translate-y-px group-hover:scale-105">
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </span>
              </Button>
              <button
                type="button"
                disabled={isLoadingDemo}
                aria-busy={isLoadingDemo}
                onClick={async () => {
                  setIsLoadingDemo(true);
                  setDemoError(null);
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
                    setDemoError(`加载演示数据失败: ${err instanceof Error ? err.message : "未知错误"}`);
                  } finally {
                    setIsLoadingDemo(false);
                  }
                }}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-white/12 bg-white/[0.08] px-5 text-sm font-semibold text-white/82 shadow-[0_18px_50px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.13)] transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5 hover:border-white/28 hover:bg-white/[0.14] hover:text-white disabled:opacity-50"
              >
                {isLoadingDemo ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    正在加载...
                  </>
                ) : (
                  <>
                    <CalendarCheck className="h-4 w-4" aria-hidden />
                    加载演示数据
                  </>
                )}
              </button>
            </motion.div>

            {demoError && (
              <motion.div
                variants={heroItemVariants}
                className="mx-auto mt-5 max-w-md rounded-[18px] border border-[#ff4055]/30 bg-[#12080b]/78 px-4 py-3 text-left text-sm text-[#ff8794] shadow-[0_20px_70px_rgba(255,54,77,0.16),inset_0_1px_0_rgba(255,255,255,0.08)]"
              >
                <p className="font-medium">演示数据加载失败</p>
                <p className="mt-1 text-[#ff9aa5]">请检查网络连接，或稍后再试。</p>
                <div className="mt-2 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setDemoError(null)}
                    className="text-xs font-medium underline underline-offset-2 hover:text-white"
                  >
                    清除提示
                  </button>
                  <a
                    href="https://github.com/Robert-Flow/ProjectFlow/issues"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2 hover:text-white"
                  >
                    <MessageCircle className="h-3 w-3" aria-hidden />
                    反馈问题
                  </a>
                </div>
              </motion.div>
            )}
          </motion.div>

          <motion.div
            variants={heroItemVariants}
            initial="hidden"
            animate="visible"
            className="relative mx-auto mt-14 w-full max-w-6xl"
            aria-label="ProjectFlow 产品界面预览"
          >
            <motion.div
              animate={{ y: [0, -10, 0] }}
              transition={{ duration: 9, repeat: Infinity, ease: kineticEase }}
              className="relative rounded-[38px] border border-white/12 bg-white/[0.08] p-2 shadow-[0_46px_130px_rgba(0,0,0,0.52),0_0_70px_rgba(255,54,77,0.16),inset_0_1px_0_rgba(255,255,255,0.16)]"
            >
              <motion.div
                aria-hidden
                className="absolute -inset-y-10 -left-1/2 w-1/2 rotate-12 bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent)]"
                animate={{ x: ["0%", "330%"] }}
                transition={{ duration: 5.8, repeat: Infinity, repeatDelay: 3.5, ease: kineticEase }}
              />
              <div className="relative overflow-hidden rounded-[30px] border border-white/10 bg-[#0a1018] shadow-[0_1px_0_rgba(255,255,255,0.14)_inset,0_0_0_1px_rgba(255,255,255,0.05)_inset]">
                <div className="flex flex-col gap-3 border-b border-white/10 bg-[linear-gradient(180deg,#111925,#0a1018)] px-5 py-4 text-white sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#ff6b75] shadow-[0_0_0_3px_rgba(255,107,117,0.12)]" />
                    <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#ffd45a] shadow-[0_0_0_3px_rgba(255,212,90,0.12)]" />
                    <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#39d799] shadow-[0_0_0_3px_rgba(57,215,153,0.12)]" />
                    <span className="ml-2 text-sm font-medium text-white/78">Campus Demo Workspace</span>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-white/64">
                    {heroMetrics.map((item) => (
                      <span
                        key={item.label}
                        className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                      >
                        <span className="font-semibold text-white">{item.value}</span> {item.label}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="grid bg-[#f8faf7] lg:grid-cols-[224px_minmax(0,1fr)_320px]">
                  <aside className="border-b border-neutral-200/10 bg-[linear-gradient(180deg,#111925,#090f17)] p-5 text-white lg:border-b-0 lg:border-r lg:border-white/10">
                    <p className="text-sm font-semibold">ProjectFlow</p>
                    <p className="mt-1 text-xs leading-5 text-white/45">主动推进型项目工作区</p>
                    <nav className="mt-7 space-y-1.5" aria-label="产品预览导航">
                      {productNavItems.map((item, index) => (
                        <div
                          key={item}
                          className={`rounded-[14px] px-3.5 py-2.5 text-sm transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${
                            index === 1
                              ? "bg-white text-neutral-950 shadow-[0_10px_24px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.9)]"
                              : "text-white/50 hover:bg-white/[0.04] hover:text-white/80"
                          }`}
                        >
                          {item}
                        </div>
                      ))}
                    </nav>
                  </aside>

                  <section className="min-w-0 bg-[linear-gradient(180deg,#fbfcfa,#f2f6f3)] p-4 sm:p-6">
                    <div className="flex flex-col gap-4 border-b border-neutral-200/80 pb-6 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="inline-flex items-center gap-2 rounded-full border border-moss/15 bg-white/80 px-3 py-1.5 text-xs font-semibold text-moss shadow-[0_8px_20px_rgba(45,109,195,0.08),inset_0_1px_0_rgba(255,255,255,0.9)]">
                        <Route className="h-3.5 w-3.5" aria-hidden />
                        方向卡
                      </div>
                      <h2 className="mt-4 max-w-2xl text-2xl font-semibold leading-tight text-neutral-950 md:text-3xl">
                        校园二手交易平台，先交付可演示的发布与搜索闭环。
                      </h2>
                    </div>
                    <div className="grid w-full max-w-xs grid-cols-2 divide-x divide-neutral-200/80 rounded-[18px] border border-white bg-white/86 text-sm shadow-[0_16px_36px_rgba(28,40,54,0.08),inset_0_1px_0_rgba(255,255,255,0.95)] md:w-60">
                      <div className="p-3">
                        <p className="font-semibold text-neutral-950">72%</p>
                        <p className="mt-1 text-xs text-neutral-500">方向清晰度</p>
                      </div>
                      <div className="p-3">
                        <p className="font-semibold text-coral">1 个高风险</p>
                        <p className="mt-1 text-xs text-neutral-500">范围风险</p>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-4 pt-6 xl:grid-cols-[minmax(0,1fr)_260px]">
                    <div>
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-950">
                          <Clock3 className="h-4 w-4 text-moss" aria-hidden />
                          项目时间线
                        </h3>
                        <span className="text-xs text-neutral-500">今天</span>
                      </div>
                      <div className="overflow-hidden rounded-[20px] border border-white bg-white/90 shadow-[0_18px_42px_rgba(28,40,54,0.08),inset_0_1px_0_rgba(255,255,255,0.92)]">
                        {timelineEvents.map((event) => (
                          <div key={event.title} className="grid gap-3 border-b border-neutral-200/70 p-4 last:border-b-0 sm:grid-cols-[58px_minmax(0,1fr)]">
                            <p className="text-xs font-semibold text-neutral-400">{event.time}</p>
                            <div>
                              <p className="text-sm font-semibold text-neutral-950">{event.title}</p>
                              <p className="mt-1 text-sm leading-6 text-neutral-600">{event.text}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-[20px] border border-white bg-white/88 p-4 shadow-[0_18px_42px_rgba(28,40,54,0.08),inset_0_1px_0_rgba(255,255,255,0.92)]">
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-950">
                        <Sparkles className="h-4 w-4 text-moss" aria-hidden />
                        Agent 建议
                      </h3>
                      <div className="mt-4 space-y-4">
                        {agentSignals.map((signal) => (
                          <div key={signal.label}>
                            <p className="text-xs font-medium text-neutral-400">{signal.label}</p>
                            <p className="mt-1 text-sm leading-6 text-neutral-700">{signal.value}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>

                <aside className="border-t border-neutral-200/80 bg-[linear-gradient(180deg,#ffffff,#f8faf7)] p-5 lg:border-l lg:border-t-0">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-neutral-950">下一步行动</h3>
                    <span className="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">3 项待处理</span>
                  </div>
                  <div className="mt-4 space-y-2.5">
                    {actionRows.map((row) => (
                      <div
                        key={row.title}
                        className="rounded-[18px] border border-neutral-200/70 bg-white/88 p-3 shadow-[0_10px_26px_rgba(28,40,54,0.06),inset_0_1px_0_rgba(255,255,255,0.9)]"
                      >
                        <div className="flex items-start gap-2">
                          <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${row.accent} shadow-[0_0_0_4px_rgba(45,109,195,0.08)]`} />
                          <div className="min-w-0">
                            <p className="text-sm font-semibold leading-5 text-neutral-950">{row.title}</p>
                            <p className="mt-2 text-xs text-neutral-500">
                              {row.owner} · {row.due}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 rounded-[18px] border border-coral/20 bg-[linear-gradient(180deg,rgba(220,79,95,0.10),rgba(220,79,95,0.06))] p-3 text-sm text-coral shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]">
                    <div className="flex items-center gap-2 font-semibold">
                      <AlertTriangle className="h-4 w-4" aria-hidden />
                      计划可能超范围
                    </div>
                    <p className="mt-2 leading-6 text-coral/90">保留核心交易流程，支付与聊天推迟到下一阶段。</p>
                  </div>
                </aside>
                </div>
              </div>
            </motion.div>
          </motion.div>
        </div>
      </section>

      <section className="relative overflow-hidden border-b border-white/10 bg-[#050608]">
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.16] [background-image:linear-gradient(rgba(255,255,255,0.14)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.12)_1px,transparent_1px)] [background-size:96px_96px]"
        />
        <div className="site-container relative grid gap-12 py-28 lg:grid-cols-[0.82fr_1.18fr] lg:items-start">
          <Reveal>
            <p className="inline-flex rounded-full border border-white/12 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold uppercase text-white/62 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]">
              不是任务列表
            </p>
            <h2 className="mt-6 max-w-xl text-4xl font-semibold leading-tight text-white md:text-5xl">
              成熟的团队工具，应该能解释为什么现在要做这件事。
            </h2>
          </Reveal>

          <Reveal delay={0.08} className="rounded-[34px] border border-white/10 bg-white/[0.06] p-2 shadow-[0_34px_120px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.12)]">
            <div className="overflow-hidden rounded-[26px] border border-white/10 bg-[#0b1018]/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
              {comparisonRows.map((row, index) => (
                <motion.div
                  key={row.label}
                  initial={{ opacity: 0, x: 24 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true, amount: 0.35 }}
                  transition={{ duration: 0.72, delay: index * 0.07, ease: kineticEase }}
                  className="grid gap-4 border-b border-white/10 px-5 py-6 last:border-b-0 md:grid-cols-[160px_minmax(0,1fr)]"
                >
                  <p className="text-sm font-semibold text-white">{row.label}</p>
                  <p className="text-sm leading-7 text-white/60">{row.value}</p>
                </motion.div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      <section className="border-b border-neutral-200/70 bg-[#f4f5ef]">
        <div className="site-container py-28">
          <Reveal className="max-w-2xl">
            <p className="inline-flex rounded-full border border-neutral-950/10 bg-white/75 px-3 py-1.5 text-xs font-semibold uppercase text-neutral-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)]">
              项目推进回路
            </p>
            <h2 className="mt-5 text-4xl font-semibold leading-tight text-neutral-950 md:text-5xl">
              从想法到复盘，每一步都留下可执行的判断。
            </h2>
          </Reveal>

          <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {workflowItems.map((item, index) => {
              const Icon = item.icon;
              const featured = index === 0 || index === 3;
              return (
                <Reveal
                  key={item.title}
                  delay={index * 0.05}
                  className={`rounded-[30px] p-1.5 shadow-[0_22px_70px_rgba(28,40,54,0.1),inset_0_1px_0_rgba(255,255,255,0.95)] ring-1 ${
                    featured ? "bg-neutral-950 ring-neutral-950/8" : "bg-white/68 ring-white/80"
                  }`}
                >
                  <article
                    className={`h-full overflow-hidden rounded-[24px] border p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] ${
                      featured
                        ? "border-white/10 bg-[linear-gradient(180deg,#141a25,#080d14)] text-white"
                        : "border-white bg-white/90 text-neutral-950"
                    }`}
                  >
                    <div
                      className={`flex h-11 w-11 items-center justify-center rounded-[16px] border shadow-[0_10px_24px_rgba(28,40,54,0.08),inset_0_1px_0_rgba(255,255,255,0.9)] ${
                        featured
                          ? "border-white/10 bg-white/[0.08] text-[#ff4055]"
                          : "border-neutral-200/70 bg-[#f8faf7] text-moss"
                      }`}
                    >
                      <Icon className="h-5 w-5" aria-hidden />
                    </div>
                    <p className={`mt-7 text-sm font-semibold ${featured ? "text-white/38" : "text-neutral-400"}`}>
                      {item.title}
                    </p>
                    <h3 className="mt-2 text-xl font-semibold">{item.eyebrow}</h3>
                    <p className={`mt-3 text-sm leading-7 ${featured ? "text-white/58" : "text-neutral-600"}`}>
                      {item.text}
                    </p>
                  </article>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      <section className="bg-[#080d14] text-white">
        <div className="site-container grid gap-8 py-20 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-white/58 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
              <ShieldCheck className="h-4 w-4 text-citron" aria-hidden />
              MVP 演示已就绪，保留人工确认边界
            </div>
            <h2 className="max-w-2xl text-4xl font-semibold leading-tight">让团队今天就知道下一步。</h2>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              onClick={() => router.push("/onboarding")}
              className="group h-12 rounded-full bg-white pl-6 pr-2 text-neutral-950 shadow-[0_18px_42px_rgba(255,255,255,0.12),inset_0_1px_0_rgba(255,255,255,0.95)] transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-citron active:scale-[0.98]"
              size="lg"
            >
              开始使用
              <span className="ml-3 flex h-8 w-8 items-center justify-center rounded-full bg-neutral-950/8 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-0.5 group-hover:-translate-y-px">
                <ArrowRight className="h-4 w-4" aria-hidden />
              </span>
            </Button>
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-white/12 bg-white/[0.03] px-5 text-sm font-semibold text-white/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5 hover:border-white/28 hover:text-white"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              回到产品预览
            </button>
          </div>
        </div>
      </section>

      <footer className="site-container flex flex-col gap-4 py-10 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-neutral-500">ProjectFlow 是面向大学生项目小队的主动推进型 AI Agent。</p>
        <div className="flex flex-wrap items-center gap-4 text-sm text-neutral-500">
          <a
            href="https://github.com/Robert-Flow/ProjectFlow/blob/main/README.md"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 transition hover:text-moss"
          >
            <BookOpen className="h-4 w-4" aria-hidden />
            使用文档
          </a>
          <a
            href="https://github.com/Robert-Flow/ProjectFlow/issues"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 transition hover:text-moss"
          >
            <HelpCircle className="h-4 w-4" aria-hidden />
            常见问题与反馈
          </a>
        </div>
      </footer>
    </main>
  );
}
