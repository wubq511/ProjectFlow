import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TaskStatusUpdate, TaskStatusUpdateList } from "./task-status-update";
import type { Task } from "@/lib/types";

const task: Task = {
  id: "task-1",
  project_id: "project-1",
  stage_id: "stage-1",
  title: "前端联调",
  description: "验证任务状态更新。",
  priority: "P0",
  status: "in_progress",
  owner_user_id: "user-1",
  backup_owner_user_id: null,
  due_date: "2026-06-01",
  estimated_hours: 4,
  dependency_ids: [],
  acceptance_criteria: [],
  can_cut: false,
  assignment_reason: null,
  order_index: 0,
  created_by_agent: true,
  updated_at: "2026-05-30T00:00:00Z",
};

describe("TaskStatusUpdate", () => {
  it("renders task update controls with Chinese copy", () => {
    render(<TaskStatusUpdate task={task} userId="user-1" onUpdate={vi.fn()} />);

    expect(screen.getByText("状态")).toBeTruthy();
    expect(screen.getAllByText("进行中").length).toBeGreaterThan(0);
    expect(screen.getByText("进展说明")).toBeTruthy();
    expect(screen.getByPlaceholderText("本次有哪些进展？（可选）")).toBeTruthy();
    expect(screen.getByRole("button", { name: /更新状态/ })).toBeTruthy();
    expect(screen.queryByText("Status")).toBeNull();
    expect(screen.queryByText("Update status")).toBeNull();
  });

  it("renders the empty state in Chinese", () => {
    render(<TaskStatusUpdateList tasks={[]} userId="user-1" onUpdate={vi.fn()} />);

    expect(screen.getByText("暂无可更新的任务。")).toBeTruthy();
  });
});
