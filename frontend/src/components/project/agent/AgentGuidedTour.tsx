"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronRight, ChevronLeft, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const TOUR_KEY = "projectflow-agent-tour-seen";

interface TourStep {
  target: string;
  title: string;
  description: string;
  position: "right" | "below" | "above";
}

const TOUR_STEPS: TourStep[] = [
  {
    target: "[data-tour='header']",
    title: "Agent 助手",
    description: "通过对话帮你推进项目。所有建议你确认后才会生效。",
    position: "right",
  },
  {
    target: "[data-tour='context']",
    title: "当前阶段",
    description: "显示项目所处阶段和待确认事项。Agent 会根据阶段推荐下一步。",
    position: "right",
  },
  {
    target: "[data-tour='prompts']",
    title: "快速开始",
    description: "点击即可让 Agent 执行特定操作，也可以自由输入消息。",
    position: "right",
  },
  {
    target: "[data-tour='composer']",
    title: "输入消息",
    description: "Enter 发送，Shift+Enter 换行。试试点击上面的快速开始。",
    position: "above",
  },
];

function isTourSeen(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(TOUR_KEY) === "true";
}

function markTourSeen() {
  try {
    localStorage.setItem(TOUR_KEY, "true");
  } catch {
    // localStorage unavailable
  }
}

interface AgentGuidedTourProps {
  active: boolean;
  onComplete: () => void;
}

export function AgentGuidedTour({ active, onComplete }: AgentGuidedTourProps) {
  const [step, setStep] = useState(0);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const handleNext = useCallback(() => {
    if (step < TOUR_STEPS.length - 1) {
      setStep((s) => s + 1);
    } else {
      markTourSeen();
      onComplete();
    }
  }, [step, onComplete]);

  const handlePrev = useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
  }, [step]);

  const handleSkip = useCallback(() => {
    markTourSeen();
    onComplete();
  }, [onComplete]);

  // Position tooltip via useLayoutEffect to avoid render-time DOM reads
  useLayoutEffect(() => {
    if (!active) return;
    const el = tooltipRef.current;
    if (!el) return;
    const current = TOUR_STEPS[step];
    const targetEl = document.querySelector(current.target);
    if (!targetEl) return;

    const rect = targetEl.getBoundingClientRect();
    const sidebarRect = targetEl.closest("[data-tour-sidebar]")?.getBoundingClientRect();

    if (sidebarRect) {
      el.style.position = "absolute";
      el.style.left = "8px";
      el.style.right = "8px";
      el.style.zIndex = "50";
      if (current.position === "below") {
        el.style.top = `${rect.bottom - sidebarRect.top + 8}px`;
        el.style.bottom = "";
      } else if (current.position === "above") {
        el.style.bottom = `${sidebarRect.bottom - rect.top + 8}px`;
        el.style.top = "";
      }
    }
  }, [active, step]);

  // Keyboard navigation
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); handleSkip(); }
      if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); handleNext(); }
      if (e.key === "ArrowLeft") { e.preventDefault(); handlePrev(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, handleSkip, handleNext, handlePrev]);

  if (!active) return null;

  const current = TOUR_STEPS[step];

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={step}
        ref={tooltipRef}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.15 }}
        className="rounded-md border border-neutral-200 bg-white p-3 shadow-lg"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-moss" />
            <p className="text-xs font-semibold text-neutral-800">{current.title}</p>
          </div>
          <button
            type="button"
            onClick={handleSkip}
            className="text-neutral-500 hover:text-neutral-700"
            aria-label="跳过引导"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-neutral-500">{current.description}</p>
        <div className="mt-2.5 flex items-center justify-between">
          <div className="flex gap-1">
            {TOUR_STEPS.map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1 w-1 rounded-full",
                  i === step ? "bg-moss" : "bg-neutral-200",
                )}
              />
            ))}
          </div>
          <div className="flex gap-1.5">
            {step > 0 && (
              <button
                type="button"
                onClick={handlePrev}
                className="flex h-6 items-center gap-0.5 rounded px-2 text-[10px] text-neutral-500 hover:bg-neutral-50"
              >
                <ChevronLeft className="h-3 w-3" />
                上一步
              </button>
            )}
            <button
              type="button"
              onClick={handleNext}
              className="flex h-6 items-center gap-0.5 rounded bg-moss px-2 text-[10px] text-white hover:bg-moss/90"
            >
              {step < TOUR_STEPS.length - 1 ? "下一步" : "开始使用"}
              {step < TOUR_STEPS.length - 1 && <ChevronRight className="h-3 w-3" />}
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

export function useGuidedTour() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    // Delay to let sidebar render
    const timer = setTimeout(() => {
      if (!isTourSeen()) {
        setActive(true);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  const complete = useCallback(() => setActive(false), []);

  return { active, complete };
}
