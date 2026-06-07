import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { AssignmentFlowPanel } from "./assignment-flow-panel";
import type { AssignmentNegotiation, AssignmentProposal, Stage, Task, User } from "@/lib/types";

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    article: ({ children, ...props }: React.ComponentProps<"article">) => (
      <article {...props}>{children}</article>
    ),
    div: ({ children, ...props }: React.ComponentProps<"div">) => (
      <div {...props}>{children}</div>
    ),
  },
}));

const SelectContext = React.createContext<{
  value: string;
  onValueChange: (value: string) => void;
} | null>(null);

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <SelectContext.Provider value={{ value, onValueChange }}>
      <div>{children}</div>
    </SelectContext.Provider>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
    const ctx = React.useContext(SelectContext);
    return (
      <button type="button" onClick={() => ctx?.onValueChange(value)}>
        {children}
      </button>
    );
  },
  SelectTrigger: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

const members: User[] = [
  {
    user_id: "user-lin",
    display_name: "林舟",
    email: null,
    avatar_url: null,
    created_at: "2026-06-03T00:00:00Z",
  },
  {
    user_id: "user-mia",
    display_name: "Mia",
    email: null,
    avatar_url: null,
    created_at: "2026-06-03T00:00:00Z",
  },
];

const stages: Stage[] = [
  {
    id: "stage-1",
    project_id: "project-1",
    name: "Prototype",
    goal: "Build assignment flow",
    start_date: "2026-06-03",
    end_date: "2026-06-04",
    deliverable: "Working flow",
    done_criteria: [],
    status: "active",
    order_index: 0,
  },
];

const tasks: Task[] = [
  {
    id: "task-api",
    project_id: "project-1",
    stage_id: "stage-1",
    title: "实现分工推荐 API",
    description: "Backend assignment endpoint",
    priority: "P0",
    status: "not_started",
    owner_user_id: null,
    backup_owner_user_id: null,
    due_date: "2026-06-04",
    estimated_hours: 4,
    dependency_ids: [],
    acceptance_criteria: [],
    can_cut: false,
    order_index: 0,
    created_by_agent: true,
    updated_at: "2026-06-03T00:00:00Z",
  },
  {
    id: "task-panel",
    project_id: "project-1",
    stage_id: "stage-1",
    title: "搭建分工流程面板",
    description: "Frontend assignment panel",
    priority: "P1",
    status: "not_started",
    owner_user_id: null,
    backup_owner_user_id: null,
    due_date: "2026-06-04",
    estimated_hours: 3,
    dependency_ids: [],
    acceptance_criteria: [],
    can_cut: false,
    order_index: 1,
    created_by_agent: true,
    updated_at: "2026-06-03T00:00:00Z",
  },
];

const proposedProposal: AssignmentProposal = {
  id: "proposal-1",
  project_id: "project-1",
  stage_id: "stage-1",
  task_id: "task-api",
  recommended_owner_user_id: "user-lin",
  backup_owner_user_id: "user-mia",
  reason: "林舟有后端经验，Mia 可协助联调。",
  skill_match: "后端技能匹配 API 任务",
  availability_match: "本周可投入时间覆盖预估工时",
  preference_match: "偏好后端和数据结构",
  constraint_respected: "避开周五晚不可用限制",
  risk_note: "注意 API 联调风险",
  status: "proposed",
  created_by_agent: true,
  created_at: "2026-06-03T00:00:00Z",
};

function renderPanel(overrides?: {
  proposals?: AssignmentProposal[];
  negotiations?: AssignmentNegotiation[];
}) {
  return render(
    <AssignmentFlowPanel
      proposals={overrides?.proposals ?? [proposedProposal]}
      negotiations={overrides?.negotiations ?? []}
      stages={stages}
      tasks={tasks}
      members={members}
      onRespondToAssignment={vi.fn()}
      onStartNegotiation={vi.fn()}
      onFinalizeAssignments={vi.fn()}
    />,
  );
}

describe("AssignmentFlowPanel", () => {
  it("renders Chinese match labels without English raw labels", () => {
    const { container } = renderPanel();

    expect(screen.getByText("技能匹配：")).toBeTruthy();
    expect(screen.getByText("时间匹配：")).toBeTruthy();
    expect(screen.getByText("偏好匹配：")).toBeTruthy();
    expect(screen.getByText("限制检查：")).toBeTruthy();
    expect(container.textContent).not.toContain("Skill:");
    expect(container.textContent).not.toContain("Availability:");
    expect(container.textContent).not.toContain("Preference:");
    expect(container.textContent).not.toContain("Constraint:");
  });

  it("hides response buttons for terminal assignment states", () => {
    renderPanel({
      proposals: [
        {
          ...proposedProposal,
          id: "proposal-finalized",
          status: "finalized",
        },
      ],
    });

    expect(screen.queryByRole("button", { name: "接受分工" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拒绝并协商" })).toBeNull();
    expect(screen.getByText("已定稿")).toBeTruthy();
  });

  it("shows selected preferred task title instead of raw task id", () => {
    const { container } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "拒绝并协商" }));
    fireEvent.click(screen.getByRole("button", { name: "搭建分工流程面板" }));

    expect(screen.getAllByText("搭建分工流程面板").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("task-panel");
  });

  it("renders all negotiation records with member and task names", () => {
    renderPanel({
      proposals: [
        {
          ...proposedProposal,
          id: "proposal-1",
          status: "owner_rejected",
        },
        {
          ...proposedProposal,
          id: "proposal-2",
          task_id: "task-panel",
          recommended_owner_user_id: "user-mia",
          status: "negotiating",
        }
      ],
      negotiations: [
        {
          id: "negotiation-1",
          project_id: "project-1",
          stage_id: "stage-1",
          from_user_id: "user-lin",
          desired_task_id: "task-panel",
          current_owner_user_id: null,
          status: "pending",
          agent_message: "林舟希望改做分工流程面板。",
          created_at: "2026-06-03T00:00:00Z",
        },
        {
          id: "negotiation-2",
          project_id: "project-1",
          stage_id: "stage-1",
          from_user_id: "user-mia",
          desired_task_id: "task-api",
          current_owner_user_id: "user-lin",
          status: "accepted",
          agent_message: "Mia 希望接手 API 任务。",
          created_at: "2026-06-03T00:00:00Z",
        },
      ],
    });

    expect(screen.getAllByText((content) => content.includes("林舟希望改做分工流程面板。")).length).toBeGreaterThan(0);
    expect(screen.getAllByText((content) => content.includes("Mia 希望接手 API 任务。")).length).toBeGreaterThan(0);
    expect(screen.getAllByText((content) => content.includes("来自 林舟")).length).toBeGreaterThan(0);
    expect(screen.getAllByText((content) => content.includes("偏好接手：搭建分工流程面板")).length).toBeGreaterThan(0);
  });
});
