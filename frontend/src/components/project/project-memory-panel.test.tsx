import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ProjectMemoryPanel } from "./project-memory-panel";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const baseMemory = {
  id: "memory-1",
  project_id: "project-1",
  workspace_id: "workspace-1",
  scope: "project",
  rationale: "rationale",
  source_type: "direction_card_confirmed",
  source_id: "proposal-1",
  valid_until: null,
  related_stage_id: null,
  related_task_id: null,
  related_risk_id: null,
  created_at: "2026-06-06T00:00:00Z",
  updated_at: "2026-06-06T00:00:00Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProjectMemoryPanel", () => {
  it("prompts for viewer identity when currentUserId is missing", () => {
    render(<ProjectMemoryPanel projectId="project-1" projectName="Demo" />);

    expect(screen.getByRole("heading", { name: "项目记忆" })).toBeTruthy();
    expect(screen.getByText("请在左侧选择当前成员身份后查看项目记忆。")).toBeTruthy();
  });

  it("shows loading state then renders grouped memories", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/projects/project-1/memories?viewer_user_id=user-1")) {
        return jsonResponse([
          {
            ...baseMemory,
            id: "memory-direction",
            memory_type: "direction",
            content: "方向记忆",
            status: "active",
            visibility: "team",
          },
          {
            ...baseMemory,
            id: "memory-rejection",
            memory_type: "rejection",
            source_type: "proposal_rejected",
            content: "拒绝记忆",
            status: "active",
            visibility: "team",
          },
        ]);
      }
      if (url.includes("/projects/project-1/memories.md?")) {
        return new Response("# Markdown", { status: 200 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectMemoryPanel projectId="project-1" projectName="Demo" currentUserId="user-1" />);

    expect(screen.getByText("加载项目记忆…")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("方向记忆")).toBeTruthy();
    });

    expect(screen.getByText("拒绝记忆")).toBeTruthy();
    expect(screen.getByText("方向与边界")).toBeTruthy();
    expect(screen.getByText("被拒绝方案")).toBeTruthy();
  });

  it("shows empty state when no memories are visible", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/projects/project-1/memories?viewer_user_id=user-1")) {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectMemoryPanel projectId="project-1" projectName="Demo" currentUserId="user-1" />);

    await waitFor(() => {
      expect(screen.getByText("暂无可见项目记忆")).toBeTruthy();
    });
  });

  it("shows error state when fetch fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/projects/project-1/memories?")) {
        return new Response(JSON.stringify({ detail: "项目不存在" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectMemoryPanel projectId="project-1" projectName="Demo" currentUserId="user-1" />);

    await waitFor(() => {
      expect(screen.getByText(/项目不存在/)).toBeTruthy();
    });
  });

  it("exports and previews Markdown when export button is clicked", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/projects/project-1/memories?viewer_user_id=user-1")) {
        return jsonResponse([]);
      }
      if (url.includes("/projects/project-1/memories.md?viewer_user_id=user-1")) {
        return new Response("# 项目记忆导出", { status: 200 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectMemoryPanel projectId="project-1" projectName="Demo" currentUserId="user-1" />);

    await waitFor(() => {
      expect(screen.getByText("暂无可见项目记忆")).toBeTruthy();
    });

    const exportButton = screen.getByRole("button", { name: "导出 Markdown" });
    fireEvent.click(exportButton);

    await waitFor(() => {
      expect(screen.getByText("Markdown 导出预览")).toBeTruthy();
    });

    expect(screen.getByText("# 项目记忆导出")).toBeTruthy();
  });

  it("renders member-only memories for the subject viewer", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/projects/project-1/memories?viewer_user_id=user-member")) {
        return jsonResponse([
          {
            ...baseMemory,
            id: "memory-private",
            memory_type: "member_constraint",
            content: "成员约束",
            status: "active",
            visibility: "subject_and_owner",
          },
        ]);
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ProjectMemoryPanel projectId="project-1" projectName="Demo" currentUserId="user-member" />,
    );

    await waitFor(() => {
      expect(screen.getByText("成员约束")).toBeTruthy();
    });

    expect(screen.getByText("相关成员和负责人可见")).toBeTruthy();
  });

  it("clears old memories and shows loading when the viewer changes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/projects/project-1/memories?viewer_user_id=user-owner")) {
        return jsonResponse([
          {
            ...baseMemory,
            id: "memory-private",
            memory_type: "member_constraint",
            content: "所有者私有约束",
            status: "active",
            visibility: "subject_and_owner",
          },
        ]);
      }
      if (url.includes("/projects/project-1/memories?viewer_user_id=user-member")) {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <ProjectMemoryPanel
        key="user-owner"
        projectId="project-1"
        projectName="Demo"
        currentUserId="user-owner"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("所有者私有约束")).toBeTruthy();
    });

    rerender(
      <ProjectMemoryPanel
        key="user-member"
        projectId="project-1"
        projectName="Demo"
        currentUserId="user-member"
      />,
    );

    expect(screen.queryByText("所有者私有约束")).toBeNull();
    expect(screen.getByText("加载项目记忆…")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("暂无可见项目记忆")).toBeTruthy();
    });
    expect(screen.queryByText("所有者私有约束")).toBeNull();
  });
});
