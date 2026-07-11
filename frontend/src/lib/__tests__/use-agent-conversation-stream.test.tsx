import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversationTurn } from "../types";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, sendAgentConversationMessageStream: vi.fn() };
});

import { sendAgentConversationMessageStream, type AgentStreamCallbacks } from "../api";
import { useAgentConversationStream, useAgentStreamNavigationReset } from "../useAgentConversationStream";

const mockedSend = vi.mocked(sendAgentConversationMessageStream);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function persistedTurn(content = "完成回答"): AgentConversationTurn {
  return {
    conversation: {
      id: "c1", workspace_id: "w1", project_id: "p1", status: "active",
      summary: "", current_focus: "", messages: [],
      created_at: "2026-07-12T00:00:00Z", updated_at: "2026-07-12T00:00:01Z",
    },
    user_message: {
      id: "u-server", conversation_id: "c1", role: "user", content: "问题",
      structured_payload: {}, created_at: "2026-07-12T00:00:00Z",
    },
    assistant_message: {
      id: "a-server", conversation_id: "c1", role: "assistant", content,
      structured_payload: {}, created_at: "2026-07-12T00:00:01Z",
    },
    next_suggestions: [], suggestions: [], artifacts: [],
  };
}

describe("useAgentConversationStream production hook", () => {
  beforeEach(() => mockedSend.mockReset());

  it("ignores callbacks queued after stop and preserves the cancelled turn", async () => {
    const request = deferred<void>();
    let callbacks!: AgentStreamCallbacks;
    mockedSend.mockImplementation(async (_conversationId, _content, _viewer, nextCallbacks) => {
      callbacks = nextCallbacks;
      return request.promise;
    });
    const { result } = renderHook(() => useAgentConversationStream({
      onPersistedTurn: vi.fn(), onError: vi.fn(), onDisconnect: vi.fn(),
    }));

    let sendPromise!: Promise<void>;
    act(() => { sendPromise = result.current.send("c1", "问题", "u1"); });
    await waitFor(() => expect(result.current.streamTurn.status).toBe("connecting"));
    act(() => callbacks.onContent({ kind: "text", phase: "delta", content_index: 0, message_seq: 1, content: "部分回答" }));
    act(() => result.current.stop());
    act(() => callbacks.onDone(persistedTurn("迟到回答")));

    expect(result.current.streamTurn.status).toBe("cancelled");
    expect(result.current.streamAnswerContent).toBe("部分回答");
    request.resolve();
    await act(async () => { await sendPromise; });
  });

  it("archives a failed turn when the next turn starts", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const callbackList: AgentStreamCallbacks[] = [];
    mockedSend
      .mockImplementationOnce(async (_conversationId, _content, _viewer, callbacks) => {
        callbackList.push(callbacks);
        return first.promise;
      })
      .mockImplementationOnce(async (_conversationId, _content, _viewer, callbacks) => {
        callbackList.push(callbacks);
        return second.promise;
      });
    const { result } = renderHook(() => useAgentConversationStream({
      onPersistedTurn: vi.fn(), onError: vi.fn(), onDisconnect: vi.fn(),
    }));

    let firstPromise!: Promise<void>;
    act(() => { firstPromise = result.current.send("c1", "第一次问题", "u1"); });
    await waitFor(() => expect(callbackList).toHaveLength(1));
    act(() => callbackList[0].onContent({ kind: "text", phase: "delta", content_index: 0, message_seq: 1, content: "部分" }));
    act(() => callbackList[0].onError("失败"));
    first.resolve();
    await act(async () => { await firstPromise; });

    let secondPromise!: Promise<void>;
    act(() => { secondPromise = result.current.send("c1", "第二次问题", "u1"); });
    await waitFor(() => expect(result.current.archivedStreamTurns).toHaveLength(1));
    expect(result.current.archivedStreamTurns[0].turn.status).toBe("failed");
    expect(result.current.archivedStreamTurns[0].turn.finalContent).toBeNull();

    await waitFor(() => expect(callbackList).toHaveLength(2));
    act(() => callbackList[1].onDone(persistedTurn()));
    expect(result.current.archivedStreamTurns[0].turn.userMessage?.content).toBe("第一次问题");
    second.resolve();
    await act(async () => { await secondPromise; });
  });
});

describe("useAgentStreamNavigationReset", () => {
  it("resets once when URL identity changes and deduplicates click plus effect", () => {
    const reset = vi.fn();
    const { result, rerender } = renderHook(
      ({ identity }) => useAgentStreamNavigationReset(identity, reset),
      { initialProps: { identity: "workspace-1:project-1" } },
    );

    act(() => result.current("workspace-1:project-2"));
    expect(reset).toHaveBeenCalledTimes(1);
    rerender({ identity: "workspace-1:project-2" });
    expect(reset).toHaveBeenCalledTimes(1);

    rerender({ identity: "workspace-1:project-3" });
    expect(reset).toHaveBeenCalledTimes(2);
  });
});
