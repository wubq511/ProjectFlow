import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { RunActivity } from "./RunActivity";
import type { RunActivityItem } from "@/lib/types";

// Mock lucide-react to avoid SVG rendering issues
vi.mock("lucide-react", () => ({
  ChevronDown: () => <span data-testid="chevron-down" />,
  ChevronRight: () => <span data-testid="chevron-right" />,
  Loader2: ({ className }: { className?: string }) => <span data-testid="loader2" className={className} />,
  CheckCircle2: () => <span data-testid="check" />,
  XCircle: () => <span data-testid="x" />,
  Wrench: () => <span data-testid="wrench" />,
  BookOpen: () => <span data-testid="book" />,
  Shield: () => <span data-testid="shield" />,
}));

const progressItem = (id: string, content: string): RunActivityItem => ({
  id,
  sequence: 1,
  created_at: new Date().toISOString(),
  kind: "progress",
  content,
});

const toolItem = (id: string, toolName: string, status: "running" | "completed"): RunActivityItem => ({
  id,
  sequence: 2,
  created_at: new Date().toISOString(),
  kind: "tool",
  tool_call_id: id,
  tool_name: toolName,
  status,
  label: status === "running" ? "正在获取项目状态" : "已获取项目状态",
  started_at: new Date().toISOString(),
});

describe("RunActivity progress spinner (fix 5)", () => {
  it("shows spinner for the last progress item when streaming", () => {
    const activities: RunActivityItem[] = [
      progressItem("p1", "第一个进度"),
      progressItem("p2", "第二个进度"),
    ];
    render(<RunActivity activities={activities} isStreaming={true} isExpanded={true} />);

    // There should be exactly one Loader2 (spinner) — for the last progress
    const loaders = screen.getAllByTestId("loader2");
    expect(loaders).toHaveLength(1);
  });

  it("does NOT show spinner for progress items when not streaming", () => {
    const activities: RunActivityItem[] = [
      progressItem("p1", "进度说明"),
    ];
    render(<RunActivity activities={activities} isStreaming={false} isExpanded={true} />);

    // No spinner when not streaming
    const loaders = screen.queryAllByTestId("loader2");
    expect(loaders).toHaveLength(0);
  });

  it("does NOT show spinner for non-last progress items even when streaming", () => {
    const activities: RunActivityItem[] = [
      progressItem("p1", "旧进度"),
      progressItem("p2", "最新进度"),
    ];
    render(<RunActivity activities={activities} isStreaming={true} isExpanded={true} />);

    // Only one spinner (for p2, the last progress), not for p1
    const loaders = screen.getAllByTestId("loader2");
    expect(loaders).toHaveLength(1);
  });

  it("no progress spinner when last item is a tool", () => {
    const activities: RunActivityItem[] = [
      progressItem("p1", "进度说明"),
      toolItem("tc-1", "get_project_state", "running"),
    ];
    render(<RunActivity activities={activities} isStreaming={true} isExpanded={true} />);

    // The tool has its own spinner (Loader2 for running status)
    // but the progress item should NOT have a spinner
    const loaders = screen.getAllByTestId("loader2");
    // Only 1 loader — from the tool's running status, not from progress
    expect(loaders).toHaveLength(1);
  });

  it("renders progress text content correctly", () => {
    const activities: RunActivityItem[] = [
      progressItem("p1", "我先核对现有实现。"),
    ];
    render(<RunActivity activities={activities} isStreaming={true} isExpanded={true} />);

    expect(screen.getByText("我先核对现有实现。")).toBeTruthy();
  });

  it("returns null for empty activities", () => {
    const { container } = render(<RunActivity activities={[]} isStreaming={false} isExpanded={true} />);
    expect(container.firstChild).toBeNull();
  });
});
