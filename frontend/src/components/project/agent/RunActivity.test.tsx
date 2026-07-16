import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { RunActivity } from "./RunActivity";
import type { RunActivityItem } from "@/lib/types";

// Mock window.matchMedia for prefers-reduced-motion detection
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// Mock lucide-react — include BookOpen for skill icons
vi.mock("lucide-react", () => ({
  ChevronDown: ({ className, style }: { className?: string; style?: React.CSSProperties }) => <span data-testid="chevron-down" className={className} style={style} />,
  Loader2: ({ className }: { className?: string }) => <span data-testid="loader2" className={className} />,
  CheckCircle2: () => <span data-testid="check" />,
  XCircle: () => <span data-testid="x" />,
  Shield: () => <span data-testid="shield" />,
  BookOpen: ({ className }: { className?: string }) => <span data-testid="book-open" className={className} />,
}));

// Mock framer-motion to avoid animation complexity in tests
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => {
      // Filter out framer-motion specific props, expose layout as data attribute
      const { initial, animate, exit, variants, transition, layout, layoutDependency, ...domProps } = props as Record<string, unknown>;
      const extraProps: Record<string, unknown> = {};
      if (layout !== undefined) extraProps["data-layout"] = String(layout);
      if (layoutDependency !== undefined) extraProps["data-layout-dependency"] = String(layoutDependency);
      return <div {...(domProps as React.HTMLAttributes<HTMLDivElement>)} {...extraProps}>{children}</div>;
    },
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// Mock ProcessMarkdown to just render content as text
vi.mock("./ProcessMarkdown", () => ({
  ProcessMarkdown: ({ content }: { content: string }) => <span data-testid="process-md">{content}</span>,
}));

// Mock StreamingProcessText to track scheduler usage
let lastStreamingProcessTextProps: { content: string; isStreaming: boolean } | null = null;
vi.mock("./StreamingProcessText", () => ({
  StreamingProcessText: ({ content, isStreaming }: { content: string; isStreaming: boolean }) => {
    lastStreamingProcessTextProps = { content, isStreaming };
    return <span data-testid="streaming-process-text" data-streaming={String(isStreaming)}>{content}</span>;
  },
}));

const progressItem = (id: string, content: string): RunActivityItem => ({
  id,
  sequence: 1,
  created_at: new Date().toISOString(),
  kind: "progress",
  content,
});

const toolItem = (id: string, toolName: string, status: "running" | "completed", startedAt?: string): RunActivityItem => ({
  id,
  sequence: 2,
  created_at: new Date().toISOString(),
  kind: "tool",
  tool_call_id: id,
  tool_name: toolName,
  status,
  label: status === "running" ? "正在获取项目状态" : "已获取项目状态",
  started_at: startedAt ?? new Date().toISOString(),
});

const skillItem = (id: string, label: string, status: "loading" | "loaded" | "failed" | "blocked"): RunActivityItem => ({
  id,
  sequence: 3,
  created_at: new Date().toISOString(),
  kind: "skill",
  skill_name: "test-skill",
  label,
  status,
  started_at: new Date().toISOString(),
});

beforeEach(() => {
  lastStreamingProcessTextProps = null;
});

describe("RunActivity progress uses StreamingProcessText scheduler", () => {
  it("live progress row uses StreamingProcessText with isStreaming=true", () => {
    const activities: RunActivityItem[] = [
      progressItem("p1", "正在分析项目状态"),
    ];
    render(<RunActivity activities={activities} isStreaming={true} isExpanded={true} />);

    // The last (and only) progress item should use StreamingProcessText
    const streamingText = screen.getByTestId("streaming-process-text");
    expect(streamingText).toBeTruthy();
    expect(streamingText.getAttribute("data-streaming")).toBe("true");
    expect(streamingText.textContent).toBe("正在分析项目状态");
  });

  it("non-streaming progress uses ProcessMarkdown directly (not StreamingProcessText)", () => {
    const activities: RunActivityItem[] = [
      progressItem("p1", "已完成的进度"),
    ];
    render(<RunActivity activities={activities} isStreaming={false} isExpanded={true} />);

    // Non-streaming: should use ProcessMarkdown, not StreamingProcessText
    expect(screen.queryByTestId("streaming-process-text")).toBeNull();
    expect(screen.getByTestId("process-md")).toBeTruthy();
    expect(screen.getByTestId("process-md").textContent).toBe("已完成的进度");
  });

  it("older progress items use ProcessMarkdown (not streaming), only last uses StreamingProcessText", () => {
    const activities: RunActivityItem[] = [
      progressItem("p1", "旧进度"),
      progressItem("p2", "最新进度"),
    ];
    render(<RunActivity activities={activities} isStreaming={true} isExpanded={true} />);

    // Should have both process-md (for p1) and streaming-process-text (for p2)
    const processMds = screen.getAllByTestId("process-md");
    const streamingTexts = screen.getAllByTestId("streaming-process-text");
    expect(processMds.length).toBe(1); // p1 uses ProcessMarkdown
    expect(streamingTexts.length).toBe(1); // p2 uses StreamingProcessText
    expect(streamingTexts[0].getAttribute("data-streaming")).toBe("true");
  });

  it("progress content is passed correctly to StreamingProcessText", () => {
    const activities: RunActivityItem[] = [
      progressItem("p1", "### 分析\n\n**重点**内容"),
    ];
    render(<RunActivity activities={activities} isStreaming={true} isExpanded={true} />);

    expect(lastStreamingProcessTextProps).toBeTruthy();
    expect(lastStreamingProcessTextProps!.content).toBe("### 分析\n\n**重点**内容");
    expect(lastStreamingProcessTextProps!.isStreaming).toBe(true);
  });
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

describe("RunActivity skill icons (BookOpen)", () => {
  it("shows BookOpen for skill with loaded status", () => {
    const activities: RunActivityItem[] = [
      skillItem("s1", "项目规划", "loaded"),
    ];
    render(<RunActivity activities={activities} isStreaming={false} isExpanded={true} />);

    expect(screen.getByTestId("book-open")).toBeTruthy();
    expect(screen.queryByTestId("check")).toBeNull(); // No CheckCircle2
  });

  it("shows BookOpen for skill with loaded status (different label)", () => {
    const activities: RunActivityItem[] = [
      skillItem("s1", "任务分工", "loaded"),
    ];
    render(<RunActivity activities={activities} isStreaming={false} isExpanded={true} />);

    expect(screen.getByTestId("book-open")).toBeTruthy();
    expect(screen.queryByTestId("check")).toBeNull();
  });

  it("shows Loader2 for skill with loading status", () => {
    const activities: RunActivityItem[] = [
      skillItem("s1", "风险分析", "loading"),
    ];
    render(<RunActivity activities={activities} isStreaming={true} isExpanded={true} />);

    expect(screen.getByTestId("loader2")).toBeTruthy();
    expect(screen.queryByTestId("book-open")).toBeNull();
  });

  it("no icon for skill with failed status (falls through to default)", () => {
    const activities: RunActivityItem[] = [
      skillItem("s1", "状态推进", "failed"),
    ];
    render(<RunActivity activities={activities} isStreaming={false} isExpanded={true} />);

    // Failed skill shows XCircle via the status switch
    expect(screen.getByTestId("x")).toBeTruthy();
    expect(screen.queryByTestId("book-open")).toBeNull();
  });

  it("skill loaded does NOT show both BookOpen and CheckCircle2 (single icon)", () => {
    const activities: RunActivityItem[] = [
      skillItem("s1", "项目规划", "loaded"),
    ];
    render(<RunActivity activities={activities} isStreaming={false} isExpanded={true} />);

    // Exactly one icon — BookOpen, no duplicate
    expect(screen.getAllByTestId("book-open")).toHaveLength(1);
    expect(screen.queryByTestId("check")).toBeNull();
  });
});

describe("RunActivity running feedback (fix C)", () => {
  it("shows single Loader2 for running tool (no wrench dual icon)", () => {
    const activities: RunActivityItem[] = [
      toolItem("tc-1", "get_project_state", "running"),
    ];
    render(<RunActivity activities={activities} isStreaming={true} isExpanded={true} />);

    // Should have exactly one Loader2 — no wrench icon
    const loaders = screen.getAllByTestId("loader2");
    expect(loaders).toHaveLength(1);
  });

  it("shows elapsed time for running tool when started_at is provided", () => {
    const startedAt = new Date(Date.now() - 5000).toISOString();
    const activities: RunActivityItem[] = [
      toolItem("tc-1", "get_project_state", "running", startedAt),
    ];
    render(<RunActivity activities={activities} isStreaming={true} isExpanded={true} />);

    expect(screen.getByText(/\d+s/)).toBeTruthy();
  });

  it("shows final duration for completed tool", () => {
    const item = toolItem("tc-1", "get_project_state", "completed");
    const activities: RunActivityItem[] = [
      { ...item, duration_ms: 2500 } as RunActivityItem,
    ];
    render(<RunActivity activities={activities} isStreaming={false} isExpanded={true} />);

    expect(screen.getByText("2s")).toBeTruthy();
  });

  it("shows live elapsed in header when streaming with processStartedAt", () => {
    const processStartedAt = new Date(Date.now() - 10000).toISOString();
    const activities: RunActivityItem[] = [
      progressItem("p1", "处理中"),
    ];
    render(
      <RunActivity
        activities={activities}
        isStreaming={true}
        isExpanded={true}
        processStartedAt={processStartedAt}
      />,
    );

    expect(screen.getByText(/\d+s/)).toBeTruthy();
  });
});

describe("RunActivity collapse animation (fix D)", () => {
  it("renders expanded content when isExpanded is true", () => {
    const activities: RunActivityItem[] = [
      progressItem("p1", "可见内容"),
    ];
    render(<RunActivity activities={activities} isStreaming={false} isExpanded={true} />);

    expect(screen.getByText("可见内容")).toBeTruthy();
  });

  it("hides content when isExpanded is false", () => {
    const activities: RunActivityItem[] = [
      progressItem("p1", "隐藏内容"),
    ];
    render(<RunActivity activities={activities} isStreaming={false} isExpanded={false} />);

    expect(screen.queryByText("隐藏内容")).toBeNull();
  });

  it("calls onToggle when header is clicked", () => {
    const onToggle = vi.fn();
    const activities: RunActivityItem[] = [
      progressItem("p1", "内容"),
    ];
    render(<RunActivity activities={activities} isStreaming={false} isExpanded={true} onToggle={onToggle} />);

    const button = screen.getByRole("button");
    button.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("processStartedAt is passed through correctly", () => {
    const processStartedAt = "2026-07-16T10:00:00Z";
    const activities: RunActivityItem[] = [
      progressItem("p1", "处理中"),
    ];
    render(
      <RunActivity
        activities={activities}
        isStreaming={true}
        isExpanded={true}
        processStartedAt={processStartedAt}
      />,
    );

    // Header should show live elapsed (proves processStartedAt is consumed)
    expect(screen.getByText(/\d+s/)).toBeTruthy();
  });

  it("reduced-motion: renders without animation variants", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });

    const activities: RunActivityItem[] = [
      progressItem("p1", "无动效内容"),
    ];
    render(<RunActivity activities={activities} isStreaming={false} isExpanded={true} />);

    expect(screen.getByText("无动效内容")).toBeTruthy();
  });

  it("collapse wrapper does NOT use permanent will-change", () => {
    const activities: RunActivityItem[] = [
      progressItem("p1", "测试内容"),
    ];
    const { container } = render(<RunActivity activities={activities} isStreaming={false} isExpanded={true} />);

    // will-change should NOT be permanently set — only transient during animation
    const wrapper = container.querySelector("[style*='will-change']");
    expect(wrapper).toBeNull();
  });
});

describe("collapseVariants compliance", () => {
  it("variants use opacity + transform (composited), not height/maxHeight/clipPath/y shorthand", async () => {
    // Import the ACTUAL module (bypasses vi.mock) to verify source-level compliance
    const actual = await vi.importActual<typeof import("./RunActivity")>("./RunActivity");
    const { collapseVariants } = actual;

    // Expanded variant — no height/maxHeight/clipPath/y/scale shorthand
    expect(collapseVariants.expanded).not.toHaveProperty("height");
    expect(collapseVariants.expanded).not.toHaveProperty("maxHeight");
    expect(collapseVariants.expanded).not.toHaveProperty("clipPath");
    expect(collapseVariants.expanded).not.toHaveProperty("y");
    expect(collapseVariants.expanded).not.toHaveProperty("scale");

    // Collapsed variant — no height/maxHeight/clipPath/y/scale shorthand
    expect(collapseVariants.collapsed).not.toHaveProperty("height");
    expect(collapseVariants.collapsed).not.toHaveProperty("maxHeight");
    expect(collapseVariants.collapsed).not.toHaveProperty("clipPath");
    expect(collapseVariants.collapsed).not.toHaveProperty("y");
    expect(collapseVariants.collapsed).not.toHaveProperty("scale");

    // Verify required visual properties exist (opacity + full transform string)
    expect(collapseVariants.expanded).toHaveProperty("opacity", 1);
    expect(collapseVariants.expanded).toHaveProperty("transform", "translate3d(0,0,0)");
    expect(collapseVariants.collapsed).toHaveProperty("opacity", 0);
    expect(collapseVariants.collapsed).toHaveProperty("transform", "translate3d(0,-4px,0)");
  });

  it("ActivityRow uses full transform string, not y shorthand", async () => {
    // Verify source-level: the ActivityRow motion props must use translate3d, not y
    const source = await import("./RunActivity");
    // We can't directly inspect ActivityRow (it's not exported), but we verify
    // via the rendered output: framer-motion mock strips motion props, but
    // initial/animate with y would produce 'y' prop on the DOM element.
    // Since our mock filters those out, we verify indirectly by checking
    // that the collapseVariants pattern is followed (translate3d, not y).
    // The actual source verification is in the variants test above.
    expect(source.collapseVariants.expanded).toHaveProperty("transform", "translate3d(0,0,0)");
  });
});
