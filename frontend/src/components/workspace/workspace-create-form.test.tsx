import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceCreateForm } from "./workspace-create-form";

const apiMocks = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
}));

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("@/lib/api", () => apiMocks);
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

describe("WorkspaceCreateForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.createWorkspace.mockResolvedValue({
      workspace_id: "workspace-1",
      name: "创新小队",
    });
  });

  it("shows the canonical five project types and submits the selected type", async () => {
    render(<WorkspaceCreateForm ownerUserId="user-1" />);

    fireEvent.change(screen.getByPlaceholderText("例如：2024 春季开发小队"), {
      target: { value: "创新小队" },
    });
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));

    for (const label of ["通用项目", "课程作业", "比赛", "创业", "研究"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "其他" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "3-5 人" }));
    fireEvent.click(screen.getByRole("button", { name: "研究" }));
    fireEvent.click(screen.getByRole("button", { name: "创建工作区" }));

    await waitFor(() => {
      expect(apiMocks.createWorkspace).toHaveBeenCalledWith({
        name: "创新小队",
        owner_user_id: "user-1",
        description: null,
        team_size: 3,
        project_template: "research",
      });
    });
  });
});
