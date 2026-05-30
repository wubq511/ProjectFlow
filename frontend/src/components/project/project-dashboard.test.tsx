import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { ProjectDashboard } from "./project-dashboard";
import type { ProjectState } from "@/lib/types";

const projectState: ProjectState = {
  workspace: {
    workspace_id: "workspace-1",
    name: "Demo Workspace",
    owner_user_id: "user-lead",
    description: "Demo team",
    created_at: "2026-05-29T00:00:00Z",
    updated_at: "2026-05-29T00:00:00Z",
  },
  project: {
    id: "project-1",
    workspace_id: "workspace-1",
    name: "AI Study Planner",
    idea: "Help students coordinate a course project demo.",
    deadline: "2026-06-07",
    deliverables: "Demo, README, review deck",
    status: "active",
    current_stage_id: "stage-1",
    direction_card: {
      problem: "Students lose time deciding what to do next.",
      users: "College project teams",
      value: "Turn project state into the next concrete action.",
      deliverables: ["Working demo", "Review summary"],
      boundaries: ["One week", "Local demo"],
      risks: ["Scope drift"],
      suggested_questions: ["Who is the first demo user?"],
    },
    created_by: "user-lead",
    created_at: "2026-05-29T00:00:00Z",
    updated_at: "2026-05-29T00:00:00Z",
  },
  resources: [],
  members: [
    {
      user_id: "user-lead",
      display_name: "Lin",
      email: null,
      avatar_url: null,
      created_at: "2026-05-29T00:00:00Z",
    },
    {
      user_id: "user-mia",
      display_name: "Mia",
      email: null,
      avatar_url: null,
      created_at: "2026-05-29T00:00:00Z",
    },
    {
      user_id: "user-chen",
      display_name: "Chen",
      email: null,
      avatar_url: null,
      created_at: "2026-05-29T00:00:00Z",
    },
  ],
  member_profiles: [],
  stages: [
    {
      id: "stage-1",
      project_id: "project-1",
      name: "Prototype",
      goal: "Show a working assignment flow.",
      start_date: "2026-05-29",
      end_date: "2026-06-01",
      deliverable: "Clickable dashboard",
      done_criteria: ["Direction confirmed", "Assignments visible"],
      status: "active",
      order_index: 0,
    },
    {
      id: "stage-2",
      project_id: "project-1",
      name: "Review Prep",
      goal: "Prepare final demo materials.",
      start_date: "2026-06-02",
      end_date: "2026-06-07",
      deliverable: "Review package",
      done_criteria: ["Deck ready"],
      status: "pending",
      order_index: 1,
    },
  ],
  tasks: [
    {
      id: "task-1",
      project_id: "project-1",
      stage_id: "stage-1",
      title: "Build assignment board",
      description: "Render owner, backup owner, and rationale.",
      priority: "P0",
      status: "in_progress",
      owner_user_id: "user-mia",
      backup_owner_user_id: "user-chen",
      due_date: "2026-06-01",
      estimated_hours: 5,
      dependency_ids: ["task-2"],
      acceptance_criteria: ["Owner visible", "Backup visible"],
      can_cut: false,
      assignment_reason: "Mia has frontend UI experience.",
      created_by_agent: true,
      updated_at: "2026-05-29T00:00:00Z",
    },
    {
      id: "task-2",
      project_id: "project-1",
      stage_id: "stage-1",
      title: "Research task",
      description: "Collect demo constraints.",
      priority: "P1",
      status: "done",
      owner_user_id: "user-lead",
      backup_owner_user_id: null,
      due_date: "2026-05-30",
      estimated_hours: 2,
      dependency_ids: [],
      acceptance_criteria: ["Constraints listed"],
      can_cut: true,
      assignment_reason: null,
      created_by_agent: true,
      updated_at: "2026-05-29T00:00:00Z",
    },
  ],
  agent_proposals: [],
  assignment_proposals: [
    {
      id: "proposal-1",
      project_id: "project-1",
      stage_id: "stage-1",
      task_id: "task-1",
      recommended_owner_user_id: "user-mia",
      backup_owner_user_id: "user-chen",
      reason: "Mia can ship the UI fastest, Chen can cover API wiring.",
      risk_note: "Mia has limited hours before deadline.",
      status: "proposed",
      created_by_agent: true,
      created_at: "2026-05-29T00:00:00Z",
    },
  ],
  assignment_responses: [],
  assignment_negotiations: [
    {
      id: "negotiation-1",
      project_id: "project-1",
      stage_id: "stage-1",
      from_user_id: "user-mia",
      desired_task_id: "task-2",
      current_owner_user_id: "user-lead",
      status: "pending",
      agent_message: "Swap proposal: Mia takes research follow-up, Lin keeps final confirmation.",
      created_at: "2026-05-29T00:00:00Z",
    },
  ],
  checkins: [],
  risks: [],
  action_cards: [
    {
      id: "action-1",
      project_id: "project-1",
      stage_id: "stage-1",
      user_id: "user-lead",
      task_id: null,
      type: "team_next_step",
      title: "Confirm direction card",
      content: "Lock the project boundary before assignment finalization.",
      reason: "Task breakdown depends on a stable direction.",
      due_date: "2026-05-29",
      status: "active",
      created_by_agent: true,
      created_at: "2026-05-29T00:00:00Z",
    },
  ],
  timeline: [
    {
      id: "event-1",
      project_id: "project-1",
      workspace_id: "workspace-1",
      event_type: "clarify",
      input_snapshot: {},
      output_snapshot: {
        suggested_questions: ["Who is the first demo user?"],
        summary: "Clarify the demo boundary.",
        target_outcome: "Confirm the smallest useful dashboard.",
        reason: "The team needs a stable scope.",
      },
      reasoning_summary: "Asked one scope question before planning.",
      user_confirmed: false,
      created_at: "2026-05-29T00:00:00Z",
    },
  ],
};

describe("ProjectDashboard", () => {
  it("shows planning and assignment surfaces from project state", () => {
    render(
      <ProjectDashboard
        state={projectState}
        onRunAgent={vi.fn()}
        onRespondToAssignment={vi.fn()}
        onStartNegotiation={vi.fn()}
        onFinalizeAssignments={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "AI Study Planner" })).toBeTruthy();
    expect(screen.getByText("当前阶段")).toBeTruthy();
    expect(screen.getAllByText("Prototype").length).toBeGreaterThan(0);
    expect(screen.getByText("推荐下一步")).toBeTruthy();
    expect(screen.getAllByText("Confirm direction card").length).toBeGreaterThan(0);

    expect(screen.getByText("Who is the first demo user?")).toBeTruthy();
    expect(screen.getByText("Students lose time deciding what to do next.")).toBeTruthy();
    expect(screen.getByText("P0")).toBeTruthy();
    expect(screen.getByText("Depends on: Research task")).toBeTruthy();
    expect(screen.getByText("Can cut")).toBeTruthy();

    expect(screen.getByText("Mia can ship the UI fastest, Chen can cover API wiring.")).toBeTruthy();
    expect(screen.getByText("负责人: Mia")).toBeTruthy();
    expect(screen.getByText("备选: Chen")).toBeTruthy();
    expect(screen.getByText("待确认")).toBeTruthy();
    expect(screen.getByText("Swap proposal: Mia takes research follow-up, Lin keeps final confirmation.")).toBeTruthy();
    expect(screen.getByText("负责人仅在最终确认后生效。")).toBeTruthy();
  });

  it("opens rejection controls with preferred task and reason fields", () => {
    render(
      <ProjectDashboard
        state={projectState}
        onRunAgent={vi.fn()}
        onRespondToAssignment={vi.fn()}
        onStartNegotiation={vi.fn()}
        onFinalizeAssignments={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "拒绝分工" }));

    expect(screen.getByText("偏好任务")).toBeTruthy();
    expect(screen.getByText("原因")).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交拒绝" })).toBeTruthy();
  });
});
