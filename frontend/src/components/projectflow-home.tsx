"use client";

import * as React from "react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  BrainCircuit,
  CalendarCheck,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Compass,
  FileCheck2,
  GitBranch,
  HelpCircle,
  Layers3,
  Loader2,
  MessageCircle,
  MessageSquareText,
  MousePointer2,
  Radar,
  Route,
  ScanLine,
  ShieldCheck,
  Sparkles,
  TimerReset,
  Users,
  WandSparkles,
  Zap,
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

const kineticEase = [0.32, 0.72, 0, 1] as const;

const heroGroupVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.075,
      delayChildren: 0.12,
    },
  },
};

const heroItemVariants = {
  hidden: { opacity: 0, y: 28, scale: 0.985 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.76, ease: kineticEase },
  },
};

const heroStats = [
  { value: "4", label: "核心推进模块" },
  { value: "3-8", label: "人项目小队" },
  { value: "先解释", label: "再等待确认" },
] as const;

const projectTabs = ["方向卡", "阶段计划", "分工建议", "风险重排"] as const;

const signalChips = [
  { text: "小林本周可投入时间降到 4h", tone: "border-coral/20 bg-coral/10 text-coral" },
  { text: "支付功能建议后延到二期", tone: "border-citron/40 bg-citron/20 text-[#7b6500]" },
  { text: "陈沐适合负责后端 API", tone: "border-moss/20 bg-moss/10 text-moss" },
  { text: "演示闭环还缺一次彩排", tone: "border-[#8b7cf6]/20 bg-[#8b7cf6]/10 text-[#6252c7]" },
  { text: "当前阶段目标仍可完成", tone: "border-[#18a874]/20 bg-[#18a874]/10 text-[#17795c]" },
] as const;

const timelineEvents = [
  {
    time: "09:12",
    title: "方向收敛",
    text: "校园二手交易先保留发布、搜索、联系卖家；支付和评价推迟。",
    icon: Compass,
  },
  {
    time: "09:24",
    title: "阶段计划",
    text: "先做可演示闭环，再补充数据质量和展示脚本。",
    icon: Route,
  },
  {
    time: "09:37",
    title: "分工建议",
    text: "按技能、可用时间和意向推荐 owner，等待负责人确认。",
    icon: Users,
  },
] as const;

const signalSummary = [
  { label: "输入", value: "讨论、签到、任务状态", icon: MessageSquareText },
  { label: "判断", value: "范围、优先级、owner", icon: BrainCircuit },
  { label: "输出", value: "可确认的下一步", icon: FileCheck2 },
] as const;

const productMetrics = [
  { value: "68%", label: "阶段完成度", tone: "text-neutral-950" },
  { value: "1 个高风险", label: "范围风险", tone: "text-coral" },
  { value: "3", label: "待确认行动", tone: "text-moss" },
] as const;

const actionRows = [
  { title: "确认 MVP 边界", owner: "负责人", meta: "需确认", tone: "bg-citron" },
  { title: "后端 API 与数据模型", owner: "陈沐", meta: "今天", tone: "bg-moss" },
  { title: "演示脚本彩排", owner: "林舟", meta: "明天", tone: "bg-[#8b7cf6]" },
] as const;

const scenarioRows = [
  { label: "科创项目", value: "从题目方向到 demo 链路，持续收敛范围。", icon: Compass },
  { label: "课程小组", value: "把零散讨论变成可确认的阶段计划和任务。", icon: ClipboardCheck },
  { label: "竞赛团队", value: "临近评审前暴露风险，及时砍掉低优先级功能。", icon: Radar },
  { label: "训练营项目", value: "成员时间变化后，分工和下一步自动重新排布。", icon: Activity },
] as const;

const comparisonRows = [
  { label: "收集信号", text: "成员时间、任务进度、资源变化和风险反馈会被整理成统一上下文。", icon: ScanLine },
  { label: "形成判断", text: "系统先说明为什么要调整，再给出方向、计划、分工或重排建议。", icon: BrainCircuit },
  { label: "确认执行", text: "高影响调整等待负责人确认，低风险动作直接变成可跟进任务。", icon: MousePointer2 },
] as const;

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
      initial={{ opacity: 0, y: 34 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.72, delay, ease: kineticEase }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function SignalRail() {
  const chips = [...signalChips, ...signalChips];

  return (
    <div className="relative mx-auto mt-9 max-w-5xl overflow-hidden py-2">
      <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-[#f7f7f1] to-transparent" />
      <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-[#f7f7f1] to-transparent" />
      <motion.div
        className="flex w-max gap-2.5"
        animate={{ x: ["0%", "-50%"] }}
        transition={{ duration: 24, repeat: Infinity, ease: "linear" }}
      >
        {chips.map((chip, index) => (
          <span
            key={`${chip.text}-${index}`}
            className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm shadow-[0_14px_32px_rgba(25,34,47,0.07),inset_0_1px_0_rgba(255,255,255,0.92)] backdrop-blur-xl ${chip.tone}`}
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
            {chip.text}
          </span>
        ))}
      </motion.div>
    </div>
  );
}

function ProductPreview() {
  return (
    <motion.div
      variants={heroItemVariants}
      className="relative mx-auto mt-14 w-full max-w-6xl px-0 sm:px-6"
      aria-label="ProjectFlow 产品界面预览"
    >
      <motion.div
        aria-hidden
        className="absolute -inset-x-8 -top-12 bottom-20 overflow-hidden rounded-[44px] border border-white/80 bg-[url('/images/projectflow-signal-mist.png')] bg-cover bg-center shadow-[0_54px_140px_rgba(45,109,195,0.18),inset_0_1px_0_rgba(255,255,255,0.92)] sm:-inset-x-4"
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        whileInView={{ opacity: 1, y: 0, scale: 1 }}
        viewport={{ once: true, amount: 0.25 }}
        animate={{ backgroundPosition: ["48% 48%", "54% 50%", "48% 48%"] }}
        transition={{ duration: 18, repeat: Infinity, ease: kineticEase }}
      />
      <div
        aria-hidden
        className="absolute -inset-x-8 -top-12 bottom-20 rounded-[44px] bg-[linear-gradient(180deg,rgba(255,255,255,0.12),rgba(247,247,241,0.24)_70%,rgba(247,247,241,0.88))] sm:-inset-x-4"
      />
      <motion.div
        animate={{ y: [0, -8, 0] }}
        transition={{ duration: 8.5, repeat: Infinity, ease: kineticEase }}
        className="relative overflow-hidden rounded-[34px] border border-neutral-950/10 bg-white/75 p-2 shadow-[0_46px_120px_rgba(45,109,195,0.18),0_20px_70px_rgba(25,34,47,0.12),inset_0_1px_0_rgba(255,255,255,0.95)] backdrop-blur-xl"
      >
        <motion.div
          aria-hidden
          className="absolute -inset-y-10 -left-1/2 w-1/2 rotate-12 bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.72),transparent)]"
          animate={{ x: ["0%", "330%"] }}
          transition={{ duration: 5.6, repeat: Infinity, repeatDelay: 4, ease: kineticEase }}
        />
        <div className="relative overflow-hidden rounded-[27px] border border-neutral-950/10 bg-[#fbfaf6] shadow-[0_1px_0_rgba(255,255,255,0.98)_inset]">
          <div
            aria-hidden
            className="absolute inset-0 opacity-[0.34] [background-image:linear-gradient(rgba(16,22,31,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(16,22,31,0.035)_1px,transparent_1px)] [background-size:54px_54px]"
          />
          <div className="relative flex flex-col gap-4 border-b border-neutral-950/10 bg-white/75 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-[13px] bg-neutral-950 text-white shadow-[0_12px_30px_rgba(16,22,31,0.16)]">
                <Layers3 className="h-4 w-4" aria-hidden />
              </span>
              <div>
                <p className="font-grotesk text-sm font-semibold text-neutral-950">Campus Demo Workspace</p>
                <p className="mt-0.5 text-xs text-neutral-500">AI Agent 正在整理下一步</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {heroStats.map((item) => (
                <span
                  key={item.label}
                  className="rounded-full border border-neutral-950/10 bg-white/80 px-3 py-1.5 text-neutral-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.96)]"
                >
                  <span className="font-semibold text-neutral-950">{item.value}</span> {item.label}
                </span>
              ))}
            </div>
          </div>

          <div className="relative grid min-h-[560px] lg:grid-cols-[216px_minmax(0,1fr)_316px]">
            <aside className="border-b border-neutral-950/10 bg-[#f4f6f2]/80 p-5 lg:border-b-0 lg:border-r">
              <p className="font-display text-2xl leading-none text-neutral-950">ProjectFlow</p>
              <p className="mt-2 text-xs leading-5 text-neutral-500">主动推进型项目工作区</p>
              <nav className="mt-7 space-y-1.5" aria-label="产品预览导航">
                {projectTabs.map((item, index) => (
                  <div
                    key={item}
                    className={`flex items-center justify-between rounded-[13px] px-3 py-2.5 text-sm transition ${
                      index === 0
                        ? "bg-neutral-950 text-white shadow-[0_14px_28px_rgba(16,22,31,0.18)]"
                        : "text-neutral-500 hover:bg-white/70 hover:text-neutral-950"
                    }`}
                  >
                    {item}
                    {index === 0 && <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                  </div>
                ))}
              </nav>
              <div className="mt-8 rounded-[20px] border border-neutral-950/10 bg-white/70 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                <p className="text-xs font-semibold uppercase text-neutral-400">Current stage</p>
                <p className="mt-2 text-sm font-semibold text-neutral-950">可演示闭环</p>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-neutral-950/8">
                  <motion.div
                    className="h-full rounded-full bg-moss"
                    initial={{ width: "22%" }}
                    whileInView={{ width: "68%" }}
                    viewport={{ once: true }}
                    transition={{ duration: 1.2, ease: kineticEase }}
                  />
                </div>
              </div>
              <div className="mt-5 space-y-2">
                {signalSummary.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.label} className="rounded-[16px] border border-neutral-950/8 bg-white/66 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.86)]">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase text-neutral-400">
                        <Icon className="h-3.5 w-3.5 text-moss" aria-hidden />
                        {item.label}
                      </div>
                      <p className="mt-1.5 text-xs leading-5 text-neutral-600">{item.value}</p>
                    </div>
                  );
                })}
              </div>
            </aside>

            <section className="min-w-0 bg-[linear-gradient(180deg,#fffdfa,#f7f8f3)] p-5 sm:p-6">
              <div className="flex flex-col gap-4 border-b border-neutral-950/10 pb-6 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-moss/10 bg-white/80 px-3 py-1.5 text-xs font-semibold text-moss shadow-[0_8px_22px_rgba(45,109,195,0.08),inset_0_1px_0_rgba(255,255,255,0.94)]">
                    <WandSparkles className="h-3.5 w-3.5" aria-hidden />
                    方向卡
                  </div>
                  <h2 className="mt-4 max-w-2xl text-2xl font-semibold leading-tight text-neutral-950 md:text-[2rem]">
                    校园二手交易，先推进到发布、搜索、联系卖家的演示闭环。
                  </h2>
                </div>
                <div className="grid w-full max-w-sm grid-cols-3 divide-x divide-neutral-950/10 rounded-[18px] border border-neutral-950/10 bg-white/80 text-sm shadow-[0_16px_36px_rgba(28,40,54,0.07),inset_0_1px_0_rgba(255,255,255,0.95)] md:w-[22rem]">
                  {productMetrics.map((metric) => (
                    <div key={metric.label} className="p-3">
                      <p className={`font-grotesk text-lg font-semibold ${metric.tone}`}>{metric.value}</p>
                      <p className="mt-1 text-xs text-neutral-500">{metric.label}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 pt-6 xl:grid-cols-[minmax(0,1fr)_260px]">
                <div>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-950">
                      <TimerReset className="h-4 w-4 text-moss" aria-hidden />
                      推进时间线
                    </h3>
                    <span className="text-xs text-neutral-500">today</span>
                  </div>
                  <div className="overflow-hidden rounded-[21px] border border-neutral-950/10 bg-white/90 shadow-[0_18px_42px_rgba(28,40,54,0.07),inset_0_1px_0_rgba(255,255,255,0.95)]">
                    {timelineEvents.map((event, index) => {
                      const Icon = event.icon;
                      return (
                        <motion.div
                          key={event.title}
                          initial={{ opacity: 0.55, x: 12 }}
                          whileInView={{ opacity: 1, x: 0 }}
                          viewport={{ once: true }}
                          transition={{ duration: 0.55, delay: index * 0.08, ease: kineticEase }}
                          className="grid gap-3 border-b border-neutral-950/8 p-4 last:border-b-0 sm:grid-cols-[64px_minmax(0,1fr)]"
                        >
                          <p className="font-grotesk text-xs font-semibold text-neutral-400">{event.time}</p>
                          <div className="flex gap-3">
                            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-moss/10 bg-moss/10 text-moss shadow-[0_8px_22px_rgba(45,109,195,0.10)]">
                              <Icon className="h-4 w-4" aria-hidden />
                            </span>
                            <div>
                              <p className="text-sm font-semibold text-neutral-950">{event.title}</p>
                              <p className="mt-1 text-sm leading-6 text-neutral-600">{event.text}</p>
                            </div>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>

                <div className="relative overflow-hidden rounded-[21px] border border-neutral-950/10 bg-white/80 p-4 shadow-[0_18px_42px_rgba(28,40,54,0.07),inset_0_1px_0_rgba(255,255,255,0.95)]">
                  <motion.div
                    aria-hidden
                    className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(45,109,195,0.55),transparent)]"
                    animate={{ x: ["-100%", "100%"] }}
                    transition={{ duration: 2.8, repeat: Infinity, repeatDelay: 1.4, ease: kineticEase }}
                  />
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-950">
                    <Sparkles className="h-4 w-4 text-moss" aria-hidden />
                    Agent 建议
                  </h3>
                  <div className="mt-4 space-y-4">
                    {[
                      ["原因", "支付和实时聊天会拖慢核心演示链路。"],
                      ["建议", "先交付发布、搜索、联系卖家。"],
                      ["确认", "负责人确认后再重排计划。"],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <p className="text-xs font-medium text-neutral-400">{label}</p>
                        <p className="mt-1 text-sm leading-6 text-neutral-700">{value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <aside className="border-t border-neutral-950/10 bg-[#fffefa] p-5 lg:border-l lg:border-t-0">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-neutral-950">下一步行动</h3>
                <span className="rounded-full border border-neutral-950/10 bg-white px-2.5 py-1 text-xs text-neutral-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                  3 项待处理
                </span>
              </div>
              <div className="mt-4 space-y-2.5">
                {actionRows.map((row, index) => (
                  <motion.div
                    key={row.title}
                    initial={{ opacity: 0, y: 12 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: index * 0.08, ease: kineticEase }}
                    className="rounded-[18px] border border-neutral-950/10 bg-white/90 p-3 shadow-[0_10px_26px_rgba(28,40,54,0.06),inset_0_1px_0_rgba(255,255,255,0.94)]"
                  >
                    <div className="flex items-start gap-2">
                      <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${row.tone} shadow-[0_0_0_4px_rgba(45,109,195,0.08)]`} />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold leading-5 text-neutral-950">{row.title}</p>
                        <p className="mt-2 text-xs text-neutral-500">
                          {row.owner} · {row.meta}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
              <motion.div
                className="mt-4 rounded-[18px] border border-coral/20 bg-[linear-gradient(180deg,rgba(220,79,95,0.10),rgba(220,79,95,0.045))] p-3 text-sm text-coral shadow-[inset_0_1px_0_rgba(255,255,255,0.76)]"
                animate={{ boxShadow: ["0 0 0 rgba(220,79,95,0)", "0 0 34px rgba(220,79,95,0.12)", "0 0 0 rgba(220,79,95,0)"] }}
                transition={{ duration: 3.6, repeat: Infinity, ease: kineticEase }}
              >
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4" aria-hidden />
                  计划可能超范围
                </div>
                <p className="mt-2 leading-6 text-coral/90">保留核心交易流程，支付与聊天推迟到下一阶段。</p>
              </motion.div>
            </aside>
          </div>
        </div>
      </motion.div>
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

  async function loadDemoWorkspace() {
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
  }

  if (storedId && !isLoadingDemo && isValidating) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-moss" />
      </div>
    );
  }

  return (
    <main className="overflow-hidden bg-[#f7f7f1] text-neutral-950">
      <section className="relative overflow-hidden border-b border-neutral-950/10 pb-16 pt-28 md:pb-20 md:pt-32">
        <motion.div
          aria-hidden
          className="absolute inset-x-0 top-0 h-[620px] bg-[url('/images/projectflow-signal-mist.png')] bg-cover bg-center opacity-80"
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: 0.82, scale: [1.01, 1.035, 1.01], x: [-8, 8, -8] }}
          transition={{ duration: 20, repeat: Infinity, ease: kineticEase }}
        />
        <div aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgba(247,247,241,0.40),#f7f7f1_86%)]" />
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-36 bg-[linear-gradient(180deg,rgba(255,255,255,0.78),transparent)]"
        />
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.30] [background-image:linear-gradient(rgba(16,22,31,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(16,22,31,0.032)_1px,transparent_1px)] [background-size:92px_92px]"
        />

        <div className="site-container relative">
          <motion.div
            variants={heroGroupVariants}
            initial="hidden"
            animate="visible"
            className="mx-auto max-w-5xl text-center"
          >
            <motion.a
              variants={heroItemVariants}
              href="#operating-loop"
              className="inline-flex items-center gap-2 rounded-full border border-neutral-950/10 bg-white/80 px-2 py-1.5 text-xs font-medium text-neutral-600 shadow-[0_18px_46px_rgba(25,34,47,0.08),inset_0_1px_0_rgba(255,255,255,0.95)] backdrop-blur-xl transition hover:border-neutral-950/20 hover:text-neutral-950 sm:text-sm"
            >
              <span className="rounded-full bg-neutral-950 px-2.5 py-1 font-grotesk text-[11px] uppercase tracking-normal text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]">
                New
              </span>
              <span className="whitespace-nowrap">
                主动推进型项目 Agent<span className="hidden sm:inline">，为学生小队持续判断下一步</span>
              </span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            </motion.a>

            <motion.h1
              variants={heroItemVariants}
              className="mx-auto mt-7 max-w-6xl text-balance text-[2.85rem] font-semibold leading-[0.96] text-neutral-950 sm:text-6xl md:text-7xl lg:text-[5.8rem]"
            >
              <span className="block">把小队项目，</span>
              <span className="block sm:whitespace-nowrap">
                <span className="relative inline-block px-2">
                  <span className="relative z-10 font-display text-[1.08em] font-normal italic tracking-normal text-moss [font-family:'Songti_SC','STSong','Noto_Serif_SC',serif]">
                    推进
                  </span>
                  <span aria-hidden className="absolute bottom-2 left-1 right-1 h-3 rounded-full bg-citron/50 shadow-[0_8px_22px_rgba(250,209,59,0.24)] md:bottom-4 md:h-4" />
                </span>
                到下一步。
              </span>
            </motion.h1>

            <motion.p
              variants={heroItemVariants}
              className="mx-auto mt-7 max-w-2xl text-pretty text-base leading-8 text-neutral-600 md:text-lg"
            >
              ProjectFlow 读取目标、任务、成员时间和风险信号，把零散讨论变成可确认的方向、计划、分工和重排建议。
            </motion.p>

            <motion.div variants={heroItemVariants} className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
              <Button
                onClick={() => router.push("/onboarding")}
                className="group h-12 rounded-full bg-neutral-950 pl-6 pr-2 text-white shadow-[0_24px_60px_rgba(16,22,31,0.22),inset_0_1px_0_rgba(255,255,255,0.16)] transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5 hover:bg-neutral-900 active:scale-[0.98]"
                size="lg"
              >
                开始推进
                <span className="ml-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-neutral-950 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-1 group-hover:-translate-y-px">
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </span>
              </Button>
              <button
                type="button"
                disabled={isLoadingDemo}
                aria-busy={isLoadingDemo}
                onClick={loadDemoWorkspace}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-neutral-950/10 bg-white/70 px-5 text-sm font-semibold text-neutral-900 shadow-[0_18px_44px_rgba(25,34,47,0.08),inset_0_1px_0_rgba(255,255,255,0.96)] backdrop-blur-md transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5 hover:border-neutral-950/20 hover:bg-white disabled:opacity-50"
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

            <motion.div
              variants={heroItemVariants}
              className="mx-auto mt-6 flex max-w-3xl flex-col overflow-hidden rounded-[22px] border border-neutral-950/10 bg-white/75 text-left shadow-[0_24px_70px_rgba(25,34,47,0.09),inset_0_1px_0_rgba(255,255,255,0.96)] backdrop-blur-xl sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-moss/10 text-moss">
                  <Zap className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase text-neutral-400">Try the operating prompt</p>
                  <p className="truncate text-sm text-neutral-700">校园二手交易项目，怎样先做出能演示的闭环？</p>
                </div>
              </div>
              <div className="border-t border-neutral-950/10 px-4 py-3 sm:border-l sm:border-t-0">
                <p className="whitespace-nowrap text-sm font-semibold text-neutral-950">生成方向卡</p>
              </div>
            </motion.div>

            {demoError && (
              <motion.div
                variants={heroItemVariants}
                className="mx-auto mt-5 max-w-md rounded-[18px] border border-coral/25 bg-white/80 px-4 py-3 text-left text-sm text-coral shadow-[0_20px_54px_rgba(220,79,95,0.10),inset_0_1px_0_rgba(255,255,255,0.9)]"
              >
                <p className="font-medium">演示数据加载失败</p>
                <p className="mt-1 text-coral/80">{demoError}</p>
                <div className="mt-2 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setDemoError(null)}
                    className="text-xs font-medium underline underline-offset-2 hover:text-neutral-950"
                  >
                    清除提示
                  </button>
                  <a
                    href="https://github.com/Robert-Flow/ProjectFlow/issues"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2 hover:text-neutral-950"
                  >
                    <MessageCircle className="h-3 w-3" aria-hidden />
                    反馈问题
                  </a>
                </div>
              </motion.div>
            )}
          </motion.div>

          <SignalRail />
          <ProductPreview />
        </div>
      </section>

      <section id="scenarios" className="relative border-b border-neutral-950/10 bg-[#fffefa]">
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.22] [background-image:linear-gradient(rgba(16,22,31,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(16,22,31,0.04)_1px,transparent_1px)] [background-size:96px_96px]"
        />
        <div className="site-container relative grid gap-12 py-28 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
          <Reveal>
            <p className="font-grotesk text-sm font-semibold uppercase text-neutral-400">Built for projects that keep changing</p>
            <h2 className="mt-5 max-w-xl text-balance text-4xl font-semibold leading-tight text-neutral-950 md:text-5xl">
              不要等到评审前，才发现计划已经跑偏。
            </h2>
            <p className="mt-5 max-w-md text-base leading-8 text-neutral-600">
              ProjectFlow 不要求团队先变得很专业。它先接住混乱，再把混乱翻译成负责人可以确认的推进动作。
            </p>
          </Reveal>

          <div className="grid overflow-hidden rounded-[30px] border border-neutral-950/10 bg-white/70 shadow-[0_28px_80px_rgba(25,34,47,0.08),inset_0_1px_0_rgba(255,255,255,0.94)] md:grid-cols-2">
            {scenarioRows.map((row, index) => {
              const Icon = row.icon;
              return (
                <Reveal
                  key={row.label}
                  delay={index * 0.04}
                  className={`group border-b border-neutral-950/10 p-7 transition-colors hover:bg-[#f8fbff] md:border-r ${
                    index % 2 === 1 ? "md:border-r-0" : ""
                  } ${index > 1 ? "md:border-b-0" : ""}`}
                >
                  <div className="flex h-11 w-11 items-center justify-center rounded-[16px] border border-neutral-950/10 bg-white text-moss shadow-[0_12px_28px_rgba(45,109,195,0.10),inset_0_1px_0_rgba(255,255,255,0.9)] transition-transform duration-500 group-hover:-translate-y-0.5">
                    <Icon className="h-5 w-5" aria-hidden />
                  </div>
                  <p className="mt-7 text-lg font-semibold text-neutral-950">{row.label}</p>
                  <p className="mt-3 text-sm leading-7 text-neutral-600">{row.value}</p>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      <section id="operating-loop" className="relative overflow-hidden border-b border-neutral-950/10 bg-[#f7f7f1]">
        <div className="site-container relative grid gap-12 py-28 lg:grid-cols-[0.82fr_1.18fr] lg:items-start">
          <Reveal>
            <div className="inline-flex items-center gap-2 rounded-full border border-neutral-950/10 bg-white/70 px-3 py-1.5 text-sm font-medium text-neutral-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.92)]">
              <GitBranch className="h-4 w-4 text-moss" aria-hidden />
              项目推进回路
            </div>
            <h2 className="mt-6 max-w-xl text-balance text-4xl font-semibold leading-tight text-neutral-950 md:text-5xl">
              成熟的团队工具，应该能解释为什么现在要做这件事。
            </h2>
            <p className="mt-5 max-w-md text-base leading-8 text-neutral-600">
              它不是再多塞一个任务列表，而是把项目里的信号、判断和行动串成一个可追踪的推进回路。
            </p>
          </Reveal>

          <Reveal delay={0.08} className="relative overflow-hidden rounded-[32px] border border-neutral-950/10 bg-white/75 p-3 shadow-[0_30px_88px_rgba(25,34,47,0.09),inset_0_1px_0_rgba(255,255,255,0.96)]">
            <div
              aria-hidden
              className="absolute inset-0 bg-[url('/images/projectflow-signal-mist.png')] bg-cover bg-center opacity-55"
            />
            <div className="relative overflow-hidden rounded-[25px] border border-neutral-950/10 bg-[#fbfcf8]/90 backdrop-blur-xl">
              <div className="grid border-b border-neutral-950/10 bg-white/70 px-5 py-4 md:grid-cols-[1fr_auto] md:items-center">
                <div>
                  <p className="font-grotesk text-xs font-semibold uppercase text-neutral-400">Live reasoning pipeline</p>
                  <p className="mt-1 text-lg font-semibold text-neutral-950">从混乱信号到可确认行动</p>
                </div>
                <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-moss/10 bg-white px-3 py-1.5 text-xs font-semibold text-moss shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] md:mt-0">
                  <span className="h-1.5 w-1.5 rounded-full bg-moss" />
                  Agent online
                </div>
              </div>
              <div className="grid divide-y divide-neutral-950/10 md:grid-cols-3 md:divide-x md:divide-y-0">
                {comparisonRows.map((row, index) => {
                  const Icon = row.icon;
                  return (
                    <motion.div
                      key={row.label}
                      initial={{ opacity: 0, y: 20 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true, amount: 0.35 }}
                      transition={{ duration: 0.62, delay: index * 0.08, ease: kineticEase }}
                      className="relative min-h-64 p-6"
                    >
                      <div className="flex h-12 w-12 items-center justify-center rounded-[17px] border border-neutral-950/10 bg-white text-moss shadow-[0_14px_34px_rgba(45,109,195,0.11),inset_0_1px_0_rgba(255,255,255,0.92)]">
                        <Icon className="h-5 w-5" aria-hidden />
                      </div>
                      <p className="mt-8 font-grotesk text-xs font-semibold uppercase text-neutral-400">0{index + 1}</p>
                      <h3 className="mt-2 text-xl font-semibold text-neutral-950">{row.label}</h3>
                      <p className="mt-3 text-sm leading-7 text-neutral-600">{row.text}</p>
                      {index < comparisonRows.length - 1 && (
                        <ArrowRight className="absolute right-5 top-8 hidden h-5 w-5 text-neutral-300 md:block" aria-hidden />
                      )}
                    </motion.div>
                  );
                })}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <section id="capabilities" className="relative overflow-hidden border-b border-neutral-950/10 bg-[#fffefa]">
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-72 bg-[url('/images/projectflow-signal-mist.png')] bg-cover bg-center opacity-45"
        />
        <div className="site-container relative py-28">
          <Reveal className="mx-auto max-w-3xl text-center">
            <p className="font-grotesk text-sm font-semibold uppercase text-neutral-400">ProjectFlow in motion</p>
            <h2 className="mt-5 text-balance text-4xl font-semibold leading-tight text-neutral-950 md:text-5xl">
              不展示功能清单，展示项目真的被推进了什么。
            </h2>
            <p className="mx-auto mt-5 max-w-2xl text-base leading-8 text-neutral-600">
              参考真实小队会遇到的变化：范围漂移、成员时间变少、任务没人接、评审前风险暴露。ProjectFlow 把这些变化变成可确认的推进结果。
            </p>
          </Reveal>

          <div className="mt-14 grid auto-rows-[220px] gap-5 md:grid-cols-2 xl:grid-cols-4">
            <Reveal className="h-full">
              <article className="flex h-full flex-col justify-between rounded-[24px] border border-[#e9cf50] bg-[#fff1a8] p-6 text-neutral-950 shadow-[0_22px_54px_rgba(118,96,12,0.10)]">
                <div>
                  <p className="font-grotesk text-[3.25rem] font-medium leading-none tracking-normal">68%</p>
                  <p className="mt-2 text-sm font-medium text-neutral-700">演示闭环完成度</p>
                </div>
                <p className="text-sm leading-6 text-neutral-700">发布、搜索、联系卖家先跑通，支付和评价进入二期。</p>
              </article>
            </Reveal>

            <Reveal delay={0.04} className="h-full">
              <article className="flex h-full flex-col justify-between rounded-[24px] border border-[#8edf93] bg-[#b9f3b7] p-6 text-neutral-950 shadow-[0_22px_54px_rgba(38,123,63,0.10)]">
                <div>
                  <p className="font-grotesk text-[3.25rem] font-medium leading-none tracking-normal">3</p>
                  <p className="mt-2 text-sm font-medium text-neutral-700">待确认行动</p>
                </div>
                <p className="text-sm leading-6 text-neutral-700">每条都带 owner、时间和触发原因，不再只是一句“尽快”。</p>
              </article>
            </Reveal>

            <Reveal delay={0.08} className="h-full md:col-span-2">
              <article className="flex h-full flex-col justify-between rounded-[24px] border border-neutral-950/10 bg-white p-6 shadow-[0_22px_54px_rgba(25,34,47,0.08),inset_0_1px_0_rgba(255,255,255,0.96)]">
                <p className="max-w-xl text-xl font-semibold leading-8 text-neutral-950">
                  “支付和实时聊天会拖慢核心演示链路。先交付发布、搜索、联系卖家，负责人确认后再重排计划。”
                </p>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-950 text-sm font-semibold text-white">PF</span>
                    <div>
                      <p className="text-sm font-semibold text-neutral-950">Agent 建议</p>
                      <p className="text-xs text-neutral-500">范围调整 · 等待确认</p>
                    </div>
                  </div>
                  <p className="font-display text-2xl text-neutral-950">ProjectFlow</p>
                </div>
              </article>
            </Reveal>

            <Reveal delay={0.12} className="h-full md:col-span-2">
              <article className="flex h-full flex-col justify-between rounded-[24px] border border-neutral-950/10 bg-white p-6 shadow-[0_22px_54px_rgba(25,34,47,0.08),inset_0_1px_0_rgba(255,255,255,0.96)]">
                <p className="max-w-2xl text-xl font-semibold leading-8 text-neutral-950">
                  “小林本周可投入时间降到 4h 后，后端 API 推荐给陈沐，演示脚本彩排交给林舟，计划仍能按时形成闭环。”
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {["时间信号", "分工建议", "阶段重排"].map((item) => (
                    <span key={item} className="rounded-full border border-neutral-950/10 bg-[#f7f7f1] px-3 py-1.5 text-xs font-semibold text-neutral-600">
                      {item}
                    </span>
                  ))}
                </div>
              </article>
            </Reveal>

            <Reveal delay={0.16} className="h-full">
              <article className="flex h-full flex-col justify-between rounded-[24px] border border-[#e9cf50] bg-[#fff1a8] p-6 text-neutral-950 shadow-[0_22px_54px_rgba(118,96,12,0.10)]">
                <div>
                  <p className="font-grotesk text-[3.25rem] font-medium leading-none tracking-normal">4h</p>
                  <p className="mt-2 text-sm font-medium text-neutral-700">成员时间变化</p>
                </div>
                <p className="text-sm leading-6 text-neutral-700">不是备注在群里，而是进入计划影响计算。</p>
              </article>
            </Reveal>

            <Reveal delay={0.2} className="h-full">
              <article className="flex h-full flex-col justify-between rounded-[24px] border border-[#f0bad5] bg-[#ffd7eb] p-6 text-neutral-950 shadow-[0_22px_54px_rgba(152,60,104,0.10)]">
                <div>
                  <p className="font-grotesk text-[3.25rem] font-medium leading-none tracking-normal">1</p>
                  <p className="mt-2 text-sm font-medium text-neutral-700">高影响风险</p>
                </div>
                <p className="text-sm leading-6 text-neutral-700">范围风险被提前推到负责人面前，而不是评审前才暴露。</p>
              </article>
            </Reveal>
          </div>

          <Reveal delay={0.12} className="mt-5 grid gap-3 md:grid-cols-4">
            {[
              ["方向澄清", "方向有边界"],
              ["阶段计划", "计划可执行"],
              ["分工推荐", "分工有依据"],
              ["风险重排", "风险可重排"],
            ].map(([label, text]) => (
              <div key={label} className="rounded-[18px] border border-neutral-950/10 bg-white/72 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.95)]">
                <p className="font-grotesk text-xs font-semibold uppercase text-neutral-400">{label}</p>
                <p className="mt-1 text-sm font-semibold text-neutral-950">{text}</p>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      <section className="bg-[#fffefa]">
        <div className="site-container py-20">
          <div className="relative overflow-hidden rounded-[34px] border border-neutral-950/10 bg-white/75 p-6 shadow-[0_28px_86px_rgba(25,34,47,0.08),inset_0_1px_0_rgba(255,255,255,0.96)] md:p-10">
            <div
              aria-hidden
              className="absolute inset-0 bg-[url('/images/projectflow-signal-mist.png')] bg-cover bg-center opacity-50"
            />
            <div className="relative grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <div>
                <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-neutral-950/10 bg-white/70 px-3 py-1.5 text-sm text-neutral-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl">
                  <ShieldCheck className="h-4 w-4 text-moss" aria-hidden />
                  MVP 演示已就绪，高影响调整仍由人确认
                </div>
                <h2 className="max-w-2xl text-balance text-4xl font-semibold leading-tight text-neutral-950">
                  让团队今天就知道下一步。
                </h2>
                <div className="mt-6 flex flex-wrap gap-2">
                  {["方向可解释", "任务可执行", "风险可重排"].map((item) => (
                    <span
                      key={item}
                      className="inline-flex items-center gap-2 rounded-full border border-neutral-950/10 bg-white/75 px-3 py-1.5 text-sm text-neutral-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.92)] backdrop-blur-xl"
                    >
                      <CheckCircle2 className="h-4 w-4 text-moss" aria-hidden />
                      {item}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  onClick={() => router.push("/onboarding")}
                  className="group h-12 rounded-full bg-neutral-950 pl-6 pr-2 text-white shadow-[0_18px_42px_rgba(16,22,31,0.16),inset_0_1px_0_rgba(255,255,255,0.14)] transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5 hover:bg-neutral-900 active:scale-[0.98]"
                  size="lg"
                >
                  开始推进
                  <span className="ml-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-neutral-950 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-0.5 group-hover:-translate-y-px">
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </span>
                </Button>
                <button
                  type="button"
                  onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-neutral-950/10 bg-white/75 px-5 text-sm font-semibold text-neutral-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.92)] backdrop-blur-xl transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5 hover:border-neutral-950/20 hover:bg-white"
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  回到产品预览
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer className="site-container flex flex-col gap-4 border-t border-neutral-950/10 py-10 sm:flex-row sm:items-center sm:justify-between">
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
