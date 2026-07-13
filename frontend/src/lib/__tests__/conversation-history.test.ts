import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useConversationHistory } from "../use-conversation-history";
import {
  listConversations,
  getConversationDetail,
  getConversationMessages,
} from "../api";

// Mock the API module
vi.mock("../api", () => ({
  listConversations: vi.fn(),
  getConversationDetail: vi.fn(),
  getConversationMessages: vi.fn(),
}));

const mockListConversations = vi.mocked(listConversations);
const mockGetConversationDetail = vi.mocked(getConversationDetail);
const mockGetConversationMessages = vi.mocked(getConversationMessages);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const conversationSummaries = [
  {
    id: "conv-2",
    project_id: "proj-1",
    title: "最新会话",
    visibility: "private" as const,
    creator_user_id: "user-1",
    message_count: 5,
    last_message_preview: "这是最后一条消息",
    created_at: "2026-07-12T10:00:00Z",
    updated_at: "2026-07-12T12:00:00Z",
  },
  {
    id: "conv-1",
    project_id: "proj-1",
    title: "旧会话",
    visibility: "team" as const,
    creator_user_id: "user-1",
    message_count: 10,
    last_message_preview: "旧消息",
    created_at: "2026-07-11T10:00:00Z",
    updated_at: "2026-07-11T12:00:00Z",
  },
];

const conversationDetail = {
  id: "conv-2",
  workspace_id: "ws-1",
  project_id: "proj-1",
  status: "active",
  visibility: "private" as const,
  creator_user_id: "user-1",
  title: "最新会话",
  summary: "",
  current_focus: "执行推进",
  messages: [
    {
      id: "msg-3",
      conversation_id: "conv-2",
      role: "assistant",
      content: "回答内容",
      structured_payload: {},
      created_at: "2026-07-12T12:00:00Z",
    },
    {
      id: "msg-2",
      conversation_id: "conv-2",
      role: "user",
      content: "用户问题",
      structured_payload: {},
      created_at: "2026-07-12T11:00:00Z",
    },
  ],
  created_at: "2026-07-12T10:00:00Z",
  updated_at: "2026-07-12T12:00:00Z",
};

const latestMessagesPage = {
  messages: conversationDetail.messages,
  has_older: false,
  older_cursor: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useConversationHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("initial state", () => {
    it("starts with empty summaries and null active conversation", () => {
      const { result } = renderHook(() => useConversationHistory());

      expect(result.current.summaries).toEqual([]);
      expect(result.current.activeConversation).toBeNull();
      expect(result.current.isDraft).toBe(false);
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.isLoadingHistory).toBe(false);
      expect(result.current.isLoadingDetail).toBe(false);
      expect(result.current.isLoadingOlder).toBe(false);
      expect(result.current.historyError).toBeNull();
      expect(result.current.detailError).toBeNull();
      expect(result.current.hasOlderMessages).toBe(false);
    });
  });

  describe("loadHistory", () => {
    it("loads conversation summaries", async () => {
      mockListConversations.mockResolvedValueOnce(conversationSummaries);

      const { result } = renderHook(() => useConversationHistory());

      await act(async () => {
        await result.current.loadHistory("proj-1", "user-1");
      });

      expect(result.current.summaries).toEqual(conversationSummaries);
      expect(result.current.isLoadingHistory).toBe(false);
      expect(result.current.historyError).toBeNull();
      expect(mockListConversations).toHaveBeenCalledWith("proj-1", "user-1");
    });

    it("sets error on failure while preserving existing summaries", async () => {
      const { result } = renderHook(() => useConversationHistory());

      // First load some summaries
      mockListConversations.mockResolvedValueOnce(conversationSummaries);
      await act(async () => {
        await result.current.loadHistory("proj-1", "user-1");
      });

      expect(result.current.summaries).toEqual(conversationSummaries);

      // Then fail on the next load
      mockListConversations.mockRejectedValueOnce(new Error("Network error"));
      await act(async () => {
        await result.current.loadHistory("proj-1", "user-1");
      });

      expect(result.current.historyError).toBe("加载会话列表失败，请重试");
      // Previous summaries should be preserved
      expect(result.current.summaries).toEqual(conversationSummaries);
    });
  });

  describe("switchToConversation", () => {
    it("loads conversation detail and updates active conversation", async () => {
      mockGetConversationDetail.mockResolvedValueOnce(conversationDetail);
      mockGetConversationMessages.mockResolvedValueOnce(latestMessagesPage);

      const { result } = renderHook(() => useConversationHistory());

      await act(async () => {
        await result.current.switchToConversation("conv-2", "proj-1", "user-1");
      });

      expect(result.current.activeConversation?.id).toBe("conv-2");
      expect(result.current.isDraft).toBe(false);
      expect(result.current.isLoadingDetail).toBe(false);
      expect(result.current.detailError).toBeNull();
    });

    it("uses the latest message page instead of the compatibility detail payload", async () => {
      mockGetConversationDetail.mockResolvedValueOnce(conversationDetail);
      mockGetConversationMessages.mockResolvedValueOnce(latestMessagesPage);

      const { result } = renderHook(() => useConversationHistory());

      await act(async () => {
        await result.current.switchToConversation("conv-2", "proj-1", "user-1");
      });

      expect(result.current.activeConversation?.messages).toHaveLength(2);
      expect(result.current.activeConversation?.messages[0].id).toBe("msg-3");
      expect(result.current.hasOlderMessages).toBe(false);
    });

    it("sets error on failure while preserving current conversation", async () => {
      mockGetConversationDetail.mockRejectedValueOnce(new Error("Not found"));

      const { result } = renderHook(() => useConversationHistory());

      await act(async () => {
        await result.current.switchToConversation("conv-2", "proj-1", "user-1");
      });

      expect(result.current.detailError).toBe("加载对话失败，请重试");
      expect(result.current.activeConversation).toBeNull();
    });
  });

  describe("startNewDraft", () => {
    it("enters draft mode with no active conversation", () => {
      const { result } = renderHook(() => useConversationHistory());

      act(() => {
        result.current.startNewDraft();
      });

      expect(result.current.isDraft).toBe(true);
      expect(result.current.activeConversation).toBeNull();
      expect(result.current.hasOlderMessages).toBe(false);
    });

    it("does not start draft while streaming", () => {
      const { result } = renderHook(() => useConversationHistory());

      act(() => {
        result.current.setStreaming(true);
      });

      act(() => {
        result.current.startNewDraft();
      });

      expect(result.current.isDraft).toBe(false);
    });
  });

  describe("loadOlderMessages", () => {
    it("loads and merges older messages without duplicates", async () => {
      mockGetConversationDetail.mockResolvedValueOnce(conversationDetail);
      mockGetConversationMessages.mockResolvedValueOnce({
        messages: conversationDetail.messages,
        has_older: true,
        older_cursor: { created_at: "2026-07-12T11:00:00Z", id: "msg-2" },
      });

      const { result } = renderHook(() => useConversationHistory());

      // First switch to conversation (loads conv-2 with msg-3, msg-2)
      await act(async () => {
        await result.current.switchToConversation("conv-2", "proj-1", "user-1");
      });

      // Mock the older messages call (returns msg-1 and msg-0)
      mockGetConversationMessages.mockResolvedValueOnce({
        messages: [
          {
            id: "msg-1",
            conversation_id: "conv-2",
            role: "user",
            content: "更早的问题",
            structured_payload: {},
            created_at: "2026-07-12T10:00:00Z",
          },
          {
            id: "msg-0",
            conversation_id: "conv-2",
            role: "user",
            content: "最早的问题",
            structured_payload: {},
            created_at: "2026-07-12T09:00:00Z",
          },
        ],
        has_older: false,
        older_cursor: null,
      });

      await act(async () => {
        await result.current.loadOlderMessages("user-1");
      });

      // Should have merged without duplicates
      const messages = result.current.activeConversation?.messages ?? [];
      const ids = messages.map((m) => m.id);
      expect(ids).toContain("msg-0");
      expect(ids).toContain("msg-1");
      expect(ids).toContain("msg-2");
      expect(ids).toContain("msg-3");
      expect(result.current.hasOlderMessages).toBe(false);
    });
  });

  describe("onConversationCreated", () => {
    it("sets active conversation and exits draft mode", () => {
      const { result } = renderHook(() => useConversationHistory());

      act(() => {
        result.current.startNewDraft();
      });
      expect(result.current.isDraft).toBe(true);

      const newConversation = {
        id: "conv-new",
        workspace_id: "ws-1",
        project_id: "proj-1",
        status: "active",
        summary: "",
        current_focus: "",
        messages: [],
        created_at: "2026-07-13T00:00:00Z",
        updated_at: "2026-07-13T00:00:00Z",
      };

      act(() => {
        result.current.onConversationCreated(newConversation);
      });

      expect(result.current.activeConversation?.id).toBe("conv-new");
      expect(result.current.isDraft).toBe(false);
    });
  });

  describe("onPersistedTurn", () => {
    it("merges new messages into active conversation", () => {
      const { result } = renderHook(() => useConversationHistory());

      // Set initial conversation
      act(() => {
        result.current.onConversationCreated({
          id: "conv-1",
          workspace_id: "ws-1",
          project_id: "proj-1",
          status: "active",
          summary: "",
          current_focus: "",
          messages: [
            {
              id: "msg-1",
              conversation_id: "conv-1",
              role: "user",
              content: "问题",
              structured_payload: {},
              created_at: "2026-07-13T00:00:00Z",
            },
          ],
          created_at: "2026-07-13T00:00:00Z",
          updated_at: "2026-07-13T00:00:00Z",
        });
      });

      // Simulate persisted turn
      act(() => {
        result.current.onPersistedTurn({
          id: "conv-1",
          workspace_id: "ws-1",
          project_id: "proj-1",
          status: "active",
          summary: "",
          current_focus: "",
          messages: [
            {
              id: "msg-1",
              conversation_id: "conv-1",
              role: "user",
              content: "问题",
              structured_payload: {},
              created_at: "2026-07-13T00:00:00Z",
            },
            {
              id: "msg-2",
              conversation_id: "conv-1",
              role: "assistant",
              content: "回答",
              structured_payload: {},
              created_at: "2026-07-13T00:01:00Z",
            },
          ],
          created_at: "2026-07-13T00:00:00Z",
          updated_at: "2026-07-13T00:01:00Z",
        });
      });

      expect(result.current.activeConversation?.messages).toHaveLength(2);
      expect(result.current.activeConversation?.messages[1].id).toBe("msg-2");
    });

    it("ignores turns for different conversations", () => {
      const { result } = renderHook(() => useConversationHistory());

      act(() => {
        result.current.onConversationCreated({
          id: "conv-1",
          workspace_id: "ws-1",
          project_id: "proj-1",
          status: "active",
          summary: "",
          current_focus: "",
          messages: [],
          created_at: "2026-07-13T00:00:00Z",
          updated_at: "2026-07-13T00:00:00Z",
        });
      });

      act(() => {
        result.current.onPersistedTurn({
          id: "conv-other",
          workspace_id: "ws-1",
          project_id: "proj-1",
          status: "active",
          summary: "",
          current_focus: "",
          messages: [
            {
              id: "msg-other",
              conversation_id: "conv-other",
              role: "assistant",
              content: "其他会话",
              structured_payload: {},
              created_at: "2026-07-13T00:01:00Z",
            },
          ],
          created_at: "2026-07-13T00:00:00Z",
          updated_at: "2026-07-13T00:01:00Z",
        });
      });

      // Should not have merged the other conversation's messages
      expect(result.current.activeConversation?.messages).toHaveLength(0);
    });
  });

  describe("setStreaming", () => {
    it("updates streaming state", () => {
      const { result } = renderHook(() => useConversationHistory());

      act(() => {
        result.current.setStreaming(true);
      });

      expect(result.current.isStreaming).toBe(true);

      act(() => {
        result.current.setStreaming(false);
      });

      expect(result.current.isStreaming).toBe(false);
    });
  });

  describe("reset", () => {
    it("clears all state", async () => {
      mockListConversations.mockResolvedValueOnce(conversationSummaries);
      mockGetConversationDetail.mockResolvedValueOnce(conversationDetail);
      mockGetConversationMessages.mockResolvedValueOnce(latestMessagesPage);

      const { result } = renderHook(() => useConversationHistory());

      // Load some data
      await act(async () => {
        await result.current.loadHistory("proj-1", "user-1");
      });
      await act(async () => {
        await result.current.switchToConversation("conv-2", "proj-1", "user-1");
      });

      // Reset
      act(() => {
        result.current.reset();
      });

      expect(result.current.summaries).toEqual([]);
      expect(result.current.activeConversation).toBeNull();
      expect(result.current.isDraft).toBe(false);
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.hasOlderMessages).toBe(false);
      expect(result.current.historyError).toBeNull();
      expect(result.current.detailError).toBeNull();
    });
  });

  describe("duplicate prevention", () => {
    it("deduplicates messages when merging older pages", async () => {
      // Setup conversation with messages msg-2, msg-3
      mockGetConversationDetail.mockResolvedValueOnce({
        ...conversationDetail,
        messages: [
          {
            id: "msg-2",
            conversation_id: "conv-2",
            role: "user",
            content: "问题",
            structured_payload: {},
            created_at: "2026-07-12T11:00:00Z",
          },
          {
            id: "msg-3",
            conversation_id: "conv-2",
            role: "assistant",
            content: "回答",
            structured_payload: {},
            created_at: "2026-07-12T12:00:00Z",
          },
        ],
      });
      mockGetConversationMessages.mockResolvedValueOnce({
        messages: conversationDetail.messages,
        has_older: true,
        older_cursor: { created_at: "2026-07-12T11:00:00Z", id: "msg-2" },
      });

      const { result } = renderHook(() => useConversationHistory());

      await act(async () => {
        await result.current.switchToConversation("conv-2", "proj-1", "user-1");
      });

      // Mock older page that includes a duplicate
      mockGetConversationMessages.mockResolvedValueOnce({
        messages: [
          {
            id: "msg-2", // Duplicate from the latest page.
            conversation_id: "conv-2",
            role: "user",
            content: "用户问题",
            structured_payload: {},
            created_at: "2026-07-12T11:00:00Z",
          },
          {
            id: "msg-1",
            conversation_id: "conv-2",
            role: "user",
            content: "更早",
            structured_payload: {},
            created_at: "2026-07-12T10:00:00Z",
          },
        ],
        has_older: false,
        older_cursor: null,
      });

      await act(async () => {
        await result.current.loadOlderMessages("user-1");
      });

      // Should not have duplicate msg-2
      const messages = result.current.activeConversation?.messages ?? [];
      const msg2Count = messages.filter((m) => m.id === "msg-2").length;
      expect(msg2Count).toBe(1);
    });
  });
});
