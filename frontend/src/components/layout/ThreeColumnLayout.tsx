"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PanelLeft, PanelRight } from "lucide-react";

// Sidebar collapse state keys
const LEFT_SIDEBAR_KEY = "projectflow:left-sidebar-collapsed";
const RIGHT_SIDEBAR_KEY = "projectflow:right-sidebar-collapsed";

function subscribeToStorage(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

function getLeftSnapshot() {
  if (typeof window === "undefined") return "false";
  return localStorage.getItem(LEFT_SIDEBAR_KEY) ?? "false";
}

function getRightSnapshot() {
  if (typeof window === "undefined") return "false";
  return localStorage.getItem(RIGHT_SIDEBAR_KEY) ?? "false";
}

function getServerSnapshot() {
  return "false";
}

interface ThreeColumnLayoutProps {
  leftSidebar: React.ReactNode;
  rightPanel: React.ReactNode;
  children: React.ReactNode;
}

export function ThreeColumnLayout({
  leftSidebar,
  rightPanel,
  children,
}: ThreeColumnLayoutProps) {
  const leftCollapsedRaw = React.useSyncExternalStore(
    subscribeToStorage,
    getLeftSnapshot,
    getServerSnapshot,
  );
  const rightCollapsedRaw = React.useSyncExternalStore(
    subscribeToStorage,
    getRightSnapshot,
    getServerSnapshot,
  );

  const [leftCollapsed, setLeftCollapsed] = React.useState(leftCollapsedRaw === "true");
  const [rightCollapsed, setRightCollapsed] = React.useState(rightCollapsedRaw === "true");
  const [leftHovered, setLeftHovered] = React.useState(false);
  const [rightHovered, setRightHovered] = React.useState(false);

  React.useEffect(() => {
    setLeftCollapsed(leftCollapsedRaw === "true");
  }, [leftCollapsedRaw]);

  React.useEffect(() => {
    setRightCollapsed(rightCollapsedRaw === "true");
  }, [rightCollapsedRaw]);

  // Keyboard shortcuts
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === "b") {
        e.preventDefault();
        toggleLeft();
      }
      if (e.ctrlKey && e.key === "j") {
        e.preventDefault();
        toggleRight();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function toggleLeft() {
    const next = !leftCollapsed;
    setLeftCollapsed(next);
    localStorage.setItem(LEFT_SIDEBAR_KEY, String(next));
    window.dispatchEvent(new StorageEvent("storage", { key: LEFT_SIDEBAR_KEY }));
  }

  function toggleRight() {
    const next = !rightCollapsed;
    setRightCollapsed(next);
    localStorage.setItem(RIGHT_SIDEBAR_KEY, String(next));
    window.dispatchEvent(new StorageEvent("storage", { key: RIGHT_SIDEBAR_KEY }));
  }

  const leftWidth = leftCollapsed ? 48 : 240;
  const rightWidth = rightCollapsed ? 48 : 320;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[var(--color-bg-primary)]">
      {/* Left Sidebar */}
      <motion.aside
        initial={false}
        animate={{ width: leftWidth }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="relative flex-shrink-0 border-r border-dashed border-[var(--border)] bg-[var(--color-bg-secondary)]"
        onMouseEnter={() => leftCollapsed && setLeftHovered(true)}
        onMouseLeave={() => setLeftHovered(false)}
      >
        <AnimatePresence>
          {leftCollapsed && leftHovered && (
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-y-0 left-0 z-50 w-[240px] bg-[var(--color-bg-secondary)] border-r border-dashed border-[var(--border)] shadow-lg"
            >
              {leftSidebar}
            </motion.div>
          )}
        </AnimatePresence>

        {!leftCollapsed || leftHovered ? (
          <div className={`h-full overflow-y-auto ${leftCollapsed ? "opacity-0 pointer-events-none" : "opacity-100"}`}>
            {!leftCollapsed && leftSidebar}
          </div>
        ) : null}

        {/* Collapse toggle button */}
        <button
          onClick={toggleLeft}
          className="absolute top-3 -right-3 z-40 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-bg-secondary)] border border-[var(--border)] text-[var(--color-text-tertiary)] hover:text-[var(--color-primary)] hover:border-[var(--color-primary)] transition-colors shadow-sm"
          title={leftCollapsed ? "展开左侧栏 (Ctrl+B)" : "收起左侧栏 (Ctrl+B)"}
        >
          <PanelLeft className="h-3 w-3" />
        </button>
      </motion.aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto min-w-0">
        {children}
      </main>

      {/* Right Agent Panel */}
      <motion.aside
        initial={false}
        animate={{ width: rightWidth }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="relative flex-shrink-0 border-l border-dashed border-[var(--border)] bg-[var(--color-bg-secondary)]"
        onMouseEnter={() => rightCollapsed && setRightHovered(true)}
        onMouseLeave={() => setRightHovered(false)}
      >
        <AnimatePresence>
          {rightCollapsed && rightHovered && (
            <motion.div
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-y-0 right-0 z-50 w-[320px] bg-[var(--color-bg-secondary)] border-l border-dashed border-[var(--border)] shadow-lg"
            >
              {rightPanel}
            </motion.div>
          )}
        </AnimatePresence>

        {!rightCollapsed || rightHovered ? (
          <div className={`h-full overflow-y-auto ${rightCollapsed ? "opacity-0 pointer-events-none" : "opacity-100"}`}>
            {!rightCollapsed && rightPanel}
          </div>
        ) : null}

        {/* Collapse toggle button */}
        <button
          onClick={toggleRight}
          className="absolute top-3 -left-3 z-40 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-bg-secondary)] border border-[var(--border)] text-[var(--color-text-tertiary)] hover:text-[var(--color-primary)] hover:border-[var(--color-primary)] transition-colors shadow-sm"
          title={rightCollapsed ? "展开右侧栏 (Ctrl+J)" : "收起右侧栏 (Ctrl+J)"}
        >
          <PanelRight className="h-3 w-3" />
        </button>
      </motion.aside>
    </div>
  );
}
