import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunControls } from "./AgentRunControls";

const getRunSnapshot = vi.fn();
const resumeRun = vi.fn();
const sendSteering = vi.fn();

vi.mock("@/lib/api", () => ({
  getRunSnapshot: (...args: unknown[]) => getRunSnapshot(...args),
  resumeRun: (...args: unknown[]) => resumeRun(...args),
  sendSteering: (...args: unknown[]) => sendSteering(...args),
}));

const snapshot = (status: string, workState: string) => ({
  run_id: "run-1", conversation_id: "conv-1", workspace_id: "ws-1", project_id: "proj-1",
  status, current_turn: 1, current_step: 1, last_event_seq: 5, state_version: 5,
  created_at: "2026-07-12T00:00:00Z", updated_at: "2026-07-12T00:00:01Z", completed_at: null,
  side_effects: [], latest_checkpoint: { workState: { status: workState } }, recent_events: [],
});

describe("AgentRunControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRunSnapshot.mockResolvedValue(snapshot("model_streaming", "executing"));
    resumeRun.mockResolvedValue({ run_id: "run-1", status: "resumed", message: "运行已恢复" });
    sendSteering.mockResolvedValue({ run_id: "run-1", steering_seq: 6, accepted: true, message: "已接收" });
  });

  it("adds constraints to the current run", async () => {
    render(<AgentRunControls runId="run-1" connectionStatus="executing" />);
    await screen.findByText("执行中");
    fireEvent.change(screen.getByLabelText("追加运行约束"), { target: { value: "不要修改截止日期" } });
    fireEvent.click(screen.getByRole("button", { name: "追加约束" }));
    await waitFor(() => expect(sendSteering).toHaveBeenCalledWith(
      "run-1", "constraint", "不要修改截止日期", expect.any(String),
    ));
  });

  it("offers checkpoint resume after disconnection", async () => {
    getRunSnapshot.mockResolvedValue(snapshot("failed", "recovering"));
    render(<AgentRunControls runId="run-1" connectionStatus="disconnected" />);
    const button = await screen.findByRole("button", { name: "恢复运行" });
    fireEvent.click(button);
    await waitFor(() => expect(resumeRun).toHaveBeenCalledWith("run-1"));
  });

  it("renders an approval decision without exposing internal identifiers", async () => {
    getRunSnapshot.mockResolvedValue(snapshot("persisting_tool_result", "awaiting_approval"));
    render(<AgentRunControls runId="run-1" connectionStatus="executing" />);
    const approve = await screen.findByRole("button", { name: "批准操作" });
    expect(screen.queryByText("run-1")).toBeNull();
    fireEvent.click(approve);
    await waitFor(() => expect(sendSteering).toHaveBeenCalledWith(
      "run-1", "approval_response", "approved", expect.any(String), { approved: true },
    ));
  });
});
