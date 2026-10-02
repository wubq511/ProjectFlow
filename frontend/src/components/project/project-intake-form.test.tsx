import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectIntakeForm } from "./project-intake-form";

const apiMocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  addResource: vi.fn(),
}));

vi.mock("@/lib/api", () => apiMocks);
vi.mock("./resource-input-panel", () => ({ ResourceInputPanel: () => null }));

function fillRequiredFields(container: HTMLElement) {
  fireEvent.change(screen.getByPlaceholderText("例如：校园二手交易平台"), {
    target: { value: "校园项目助手" },
  });
  fireEvent.change(screen.getByPlaceholderText("我们想做一款帮助大学生..."), {
    target: { value: "这是一个帮助大学生团队推进项目的工具" },
  });
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 30);
  fireEvent.change(container.querySelector('input[type="date"]')!, {
    target: { value: deadline.toISOString().slice(0, 10) },
  });
}

describe("ProjectIntakeForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.createProject.mockResolvedValue({ id: "project-1" });
  });

  it("submits the selected project type and omits the duplicate team-size field", async () => {
    const { container } = render(
      <ProjectIntakeForm workspaceId="workspace-1" defaultCreatedBy="user-1" />,
    );
    expect(screen.queryByText("团队规模")).toBeNull();

    fillRequiredFields(container);
    fireEvent.click(screen.getByRole("button", { name: "比赛" }));
    fireEvent.click(screen.getByRole("button", { name: /开始规划/ }));

    await waitFor(() => {
      expect(apiMocks.createProject).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
        project_template: "competition",
        created_by: "user-1",
      }));
    });
    expect(JSON.parse(localStorage.getItem("project-intake-draft") ?? "{}"))
      .not.toHaveProperty("teamSize");
  });

  it("uses general for a project without a selected type", async () => {
    const { container } = render(
      <ProjectIntakeForm workspaceId="workspace-1" defaultCreatedBy="user-1" />,
    );
    fillRequiredFields(container);
    fireEvent.click(screen.getByRole("button", { name: /开始规划/ }));

    await waitFor(() => {
      expect(apiMocks.createProject).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
        project_template: "general",
      }));
    });
  });
});
