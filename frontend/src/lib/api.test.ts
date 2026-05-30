import { afterEach, describe, expect, it, vi } from "vitest";

import { getProjectState, runAssignment } from "./api";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("frontend API layer", () => {
  it("runs agent flows through the implemented workspace-scoped backend route", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/projects/project-1")) {
        return jsonResponse({
          id: "project-1",
          workspace_id: "workspace-1",
          name: "Demo",
          idea: "Demo",
          deadline: "2026-06-07",
          deliverables: "Demo",
          status: "active",
          current_stage_id: null,
          direction_card: null,
          created_by: "user-1",
          created_at: "2026-05-29T00:00:00Z",
          updated_at: "2026-05-29T00:00:00Z",
        });
      }
      if (url.endsWith("/agent/assign")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ workspace_id: "workspace-1" });
        return jsonResponse({
          event_type: "assign",
          status: "fallback",
          attempts: 2,
          used_fallback: true,
          output: {},
          created_ids: ["proposal-1"],
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await runAssignment("project-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("composes dashboard state from execution-loop endpoints", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/projects/project-1")) {
        return jsonResponse({
          id: "project-1",
          workspace_id: "workspace-1",
          name: "Demo",
          idea: "Demo",
          deadline: "2026-06-07",
          deliverables: "Demo",
          status: "active",
          current_stage_id: "stage-1",
          direction_card: null,
          created_by: "user-1",
          created_at: "2026-05-29T00:00:00Z",
          updated_at: "2026-05-29T00:00:00Z",
        });
      }
      if (url.endsWith("/workspaces/workspace-1")) {
        return jsonResponse({
          id: "workspace-1",
          name: "Workspace",
          owner_user_id: "user-1",
          description: null,
          created_at: "2026-05-29T00:00:00Z",
          updated_at: "2026-05-29T00:00:00Z",
        });
      }
      if (url.endsWith("/projects/project-1/resources")) return jsonResponse([]);
      if (url.endsWith("/projects/project-1/stages")) {
        return jsonResponse([
          {
            id: "stage-1",
            project_id: "project-1",
            name: "Build",
            goal: "Build demo",
            start_date: "2026-05-29",
            end_date: "2026-06-01",
            deliverable: "Demo",
            done_criteria: [],
            status: "active",
            order_index: 0,
          },
        ]);
      }
      if (url.endsWith("/projects/project-1/tasks")) return jsonResponse([]);
      if (url.endsWith("/users")) {
        return jsonResponse([
          {
            id: "user-1",
            display_name: "Lin",
            email: null,
            avatar_url: null,
            created_at: "2026-05-29T00:00:00Z",
          },
        ]);
      }
      if (url.endsWith("/workspaces/workspace-1/profiles")) return jsonResponse([]);
      if (url.includes("/agent-proposals?project_id=project-1")) return jsonResponse([]);
      if (url.endsWith("/projects/project-1/assignment-proposals")) return jsonResponse([]);
      if (url.endsWith("/projects/project-1/assignment-responses")) return jsonResponse([]);
      if (url.endsWith("/projects/project-1/assignment-negotiations")) return jsonResponse([]);
      if (url.endsWith("/projects/project-1/checkin-cycles")) return jsonResponse([]);
      if (url.endsWith("/projects/project-1/risks")) return jsonResponse([]);
      if (url.endsWith("/projects/project-1/action-cards")) {
        return jsonResponse([
          {
            id: "card-1",
            project_id: "project-1",
            stage_id: "stage-1",
            user_id: null,
            task_id: null,
            type: "team_next_step",
            title: "Confirm demo",
            content: "Walk the flow.",
            reason: "Demo needs a stable path.",
            due_date: null,
            status: "active",
            created_by_agent: true,
            created_at: "2026-05-29T00:00:00Z",
          },
        ]);
      }
      if (url.endsWith("/projects/project-1/timeline")) return jsonResponse([]);
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await getProjectState("project-1");

    expect(state.action_cards).toHaveLength(1);
    expect(state.action_cards[0].title).toBe("Confirm demo");
  });
});
