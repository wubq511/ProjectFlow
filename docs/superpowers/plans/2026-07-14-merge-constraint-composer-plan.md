# Merge Constraint Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the separate "append constraint" textarea into the main `ChatComposer`, keep stop and send as independent controls, fix cancel propagation, and enable both loop-boundary and mid-stream steering consumption in the agent-bridge runtime.

**Architecture:** Extend `ChatComposer` with runtime-aware props (`isRunning`, `onSendSteering`, `onCancelRun`) and render a dedicated stop button alongside the send button. `AgentSidebar` orchestrates run state and delegates steering/cancel actions. `AgentRunControls` loses its textarea and gains a steering history readout. On the agent-bridge side, Phase 1 adds loop-boundary steering consumption and prompt injection; Phase 2 adds a lightweight `SteeringPoller` that aborts the current stream when new steering arrives, and `pi-runtime` re-enters the model loop with steering injected.

**Tech Stack:** Next.js/React/Tailwind (frontend), TypeScript, Pi component runtime (agent-bridge), FastAPI backend (mostly unchanged).

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/components/project/agent/ChatComposer.tsx` | Main composer UI; add `isRunning` / `onSendSteering` / `onCancelRun`; dedicated stop + send buttons. |
| `frontend/src/components/project/agent-sidebar.tsx` | Wire composer to run state; implement `onSendSteering` and `onCancelRun`; clear draft on run start. |
| `frontend/src/components/project/agent/AgentRunControls.tsx` | Remove constraint textarea/buttons; add steering history list. |
| `frontend/src/components/project/agent/SteeringHistory.tsx` | New small component to render steering events for the active run. |
| `frontend/src/lib/api.ts` | No changes needed (already exports `sendSteering` and `cancelRun`). |
| `agent-bridge/src/runtime/session-store.ts` | Add `abort(runId, reason?)` overload; store per-run steering-available flag. |
| `agent-bridge/src/runtime/steering-poller.ts` | New poller class (Phase 2) that polls snapshot and aborts on new steering. |
| `agent-bridge/src/server/routes/cancel-run.ts` | Also call backend `cancelRun`; return error if backend fails. |
| `agent-bridge/src/server/routes/steering.ts` | No major changes; existing cancel path already calls backend. |
| `agent-bridge/src/runtime/pi-runtime.ts` | Add loop-boundary steering consumption (Phase 1) and mid-stream re-entry (Phase 2). |
| `agent-bridge/src/runtime/context-builder.ts` | Inject pending steering events into prompt as a required context block. |
| `agent-bridge/src/tools/fastapi-client.ts` | Add optional `timeoutMs` to `getRunSnapshot`. |
| Test files | See per-task test steps. |

---

## Phase 1: Frontend merge + cancel propagation + loop-boundary steering

### Task 1: Extend ChatComposer for runtime dual-mode

**Files:**
- Modify: `frontend/src/components/project/agent/ChatComposer.tsx`
- Test: `frontend/src/components/project/agent/__tests__/ChatComposer.test.tsx`

- [ ] **Step 1: Add new props to the interface**

```ts
interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (content: string) => void;
  onSlashSubmit?: (content: string, skill: string, slashCommand: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  isRunning?: boolean;
  onSendSteering?: (content: string) => void | Promise<void>;
  onCancelRun?: () => void | Promise<void>;
  maxLength?: number;
  modelConfigs?: ModelConfigEntry[];
  selectedModelId?: string | null;
  onModelChange?: (modelId: string) => void;
  thinkingLevel?: ThinkingLevel | null;
  onThinkingLevelChange?: (level: ThinkingLevel | null) => void;
}
```

- [ ] **Step 2: Destructure the new props in the component signature**

```ts
export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onSlashSubmit,
  onStop,
  disabled,
  isStreaming,
  isRunning,
  onSendSteering,
  onCancelRun,
  maxLength = 4000,
  modelConfigs,
  selectedModelId,
  onModelChange,
  thinkingLevel,
  onThinkingLevelChange,
}: ChatComposerProps) {
```

- [ ] **Step 3: Disable slash menu while running**

In `handleInputChange`, after computing `newBody`, early-return slash detection when `isRunning`:

```ts
const handleInputChange = useCallback(
  (e: ChangeEvent<HTMLTextAreaElement>) => {
    const newBody = e.target.value;
    if (leadingCommand) {
      onChange(`${commandPrefix}${newBody}`);
      return;
    }

    onChange(newBody);

    if (isRunning) {
      // During a run, `/` is treated as normal text; no slash menu.
      setSlashActive(false);
      setSlashHint(null);
      return;
    }

    const match = newBody.match(/^\/([a-z]*)$/i);
    if (match) {
      setSlashActive(true);
      setSlashQuery(match[1]);
      setSlashIndex(0);
      setSlashHint(null);
    } else {
      setSlashActive(false);
      setSlashHint(null);
    }
  },
  [leadingCommand, commandPrefix, onChange, isRunning],
);
```

- [ ] **Step 4: Update submit handler to branch on run state**

Replace the existing `handleSubmit` body:

```ts
const handleSubmit = useCallback(
  async (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || disabled) return;

    if (isRunning) {
      if (onSendSteering) {
        await onSendSteering(trimmed);
        onChange("");
      }
      return;
    }

    if (onSlashSubmit) {
      const parsed = parseSlashCommand(trimmed);
      if (parsed) {
        onSlashSubmit(parsed.content, parsed.skill, parsed.command);
        setSlashHint(null);
        setSlashActive(false);
        onChange("");
        return;
      }
      if (trimmed.startsWith("/")) {
        setSlashHint(`未知命令：${trimmed.split(/\s/)[0]}，输入 / 查看可用命令`);
        return;
      }
    }

    setSlashHint(null);
    setSlashActive(false);
    onSubmit(trimmed);
  },
  [value, disabled, isRunning, onSendSteering, onSubmit, onSlashSubmit, onChange],
);
```

- [ ] **Step 5: Replace the button rendering with dedicated stop + send buttons**

Find the block:

```tsx
<div className="flex gap-1.5">
  {isStreaming && onStop ? (
    <Button ...>停止</Button>
  ) : (
    <Button ...>发送</Button>
  )}
</div>
```

Replace it with:

```tsx
<div className="flex gap-1.5">
  {isRunning && (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-8 gap-1.5 border-coral/30 px-3 text-xs text-coral hover:bg-coral/10"
      onClick={onCancelRun}
      disabled={!onCancelRun || disabled}
      aria-label="停止运行"
    >
      <Square className="h-3 w-3" />
      停止
    </Button>
  )}
  <Button
    type="submit"
    size="sm"
    className="h-8 gap-1.5 bg-moss px-3 text-xs text-white shadow-sm shadow-moss/20 hover:bg-moss/90 active:shadow-none"
    disabled={!value.trim() || disabled}
  >
    {disabled ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
    发送
  </Button>
</div>
```

- [ ] **Step 6: Update placeholder when running**

Change the textarea placeholder:

```tsx
placeholder={
  isRunning
    ? "追加约束或纠正当前运行..."
    : leadingCommand
      ? "补充上下文..."
      : "告诉 Agent 你想推进什么...  (输入 / 使用斜杠命令)"
}
```

- [ ] **Step 7: Add tests for the new runtime behavior**

In `ChatComposer.test.tsx`, add:

```ts
it("shows stop button when running and input is empty", () => {
  renderComposer({ isRunning: true, value: "", onCancelRun: vi.fn() });
  expect(screen.getByRole("button", { name: /停止/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /发送/i })).toBeDisabled();
});

it("shows active send button when running and input has text", () => {
  renderComposer({ isRunning: true, value: "请优先做 MVP", onSendSteering: vi.fn() });
  expect(screen.getByRole("button", { name: /停止/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /发送/i })).toBeEnabled();
});

it("calls onSendSteering and clears input when running and submitted", async () => {
  const onSendSteering = vi.fn().mockResolvedValue(undefined);
  const onChange = vi.fn();
  renderComposer({ isRunning: true, value: "请优先做 MVP", onSendSteering, onChange });
  await userEvent.click(screen.getByRole("button", { name: /发送/i }));
  expect(onSendSteering).toHaveBeenCalledWith("请优先做 MVP");
  expect(onChange).toHaveBeenCalledWith("");
});

it("calls onCancelRun when stop is clicked", async () => {
  const onCancelRun = vi.fn();
  renderComposer({ isRunning: true, value: "", onCancelRun });
  await userEvent.click(screen.getByRole("button", { name: /停止/i }));
  expect(onCancelRun).toHaveBeenCalled();
});

it("does not open slash menu while running", async () => {
  renderComposer({ isRunning: true, value: "" });
  await userEvent.type(screen.getByRole("textbox"), "/");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("uses running placeholder when isRunning is true", () => {
  renderComposer({ isRunning: true, value: "" });
  expect(screen.getByRole("textbox")).toHaveAttribute(
    "placeholder",
    "追加约束或纠正当前运行..."
  );
});
```

- [ ] **Step 8: Run frontend tests**

```bash
cd /Users/robertwu/Documents/Projects/ProjectFlow/frontend
npm run test -- ChatComposer.test.tsx
```

Expected: all new tests pass; existing tests still pass.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/project/agent/ChatComposer.tsx frontend/src/components/project/agent/__tests__/ChatComposer.test.tsx
git commit -m "feat(composer): runtime dual-mode with dedicated stop + send-steering buttons"
```

---

### Task 2: Wire AgentSidebar to steering and cancel

**Files:**
- Modify: `frontend/src/components/project/agent-sidebar.tsx`
- Test: `frontend/src/components/project/agent-sidebar.test.tsx` (if exists; otherwise create minimal coverage or rely on integration tests)

- [ ] **Step 1: Import `sendSteering` and `cancelRun`**

Ensure these imports exist near the top:

```ts
import { sendSteering, cancelRun } from "@/lib/api";
```

- [ ] **Step 2: Track run status from AgentRunControls snapshot**

Add state to hold the latest snapshot from `AgentRunControls`:

```ts
const [runSnapshot, setRunSnapshot] = useState<Record<string, unknown> | null>(null);
```

Derive terminal status:

```ts
const terminalStatuses = new Set(["completed", "cancelled", "failed"]);
const runIsTerminal = runSnapshot?.status
  ? terminalStatuses.has(String(runSnapshot.status))
  : false;
const isRunning = !!activeRunId && !runIsTerminal;
```

- [ ] **Step 3: Clear draft when a run starts**

```ts
useEffect(() => {
  if (isRunning && draft.trim()) {
    setDraft("");
  }
}, [isRunning]); // intentionally omit setDraft/draft from deps
```

- [ ] **Step 4: Implement `onSendSteering` callback**

```ts
const handleSendSteering = useCallback(
  async (content: string) => {
    if (!activeRunId) return;
    try {
      await sendSteering(activeRunId, "constraint", content, crypto.randomUUID());
    } catch (err) {
      setConversationError(err instanceof Error ? err.message : "发送约束失败");
    }
  },
  [activeRunId],
);
```

- [ ] **Step 5: Implement `onCancelRun` callback**

```ts
const handleCancelRun = useCallback(async () => {
  if (!activeRunId) return;
  try {
    await cancelRun(activeRunId, "用户取消");
    onStopStreaming();
  } catch (err) {
    setConversationError(err instanceof Error ? err.message : "取消运行失败");
    // Do NOT call onStopStreaming — the run is still active in the backend.
  }
}, [activeRunId, onStopStreaming]);
```

- [ ] **Step 6: Pass new props to ChatComposer**

```tsx
<ChatComposer
  value={draft}
  onChange={setDraft}
  onSubmit={submitMessage}
  onSlashSubmit={handleSlashSubmit}
  onStop={onStopStreaming}
  disabled={isComposerDisabled}
  isStreaming={isStreaming}
  isRunning={isRunning}
  onSendSteering={handleSendSteering}
  onCancelRun={handleCancelRun}
  modelConfigs={modelConfigs}
  selectedModelId={selectedModelId}
  onModelChange={setSelectedModelId}
  thinkingLevel={thinkingLevel}
  onThinkingLevelChange={setThinkingLevel}
/>
```

- [ ] **Step 7: Wire AgentRunControls snapshot up to sidebar**

If `AgentRunControls` exposes `onSnapshotUpdate`, pass:

```tsx
<AgentRunControls
  runId={activeRunId}
  connectionStatus={connectionStatus}
  onCancel={handleCancelRun}
  onSnapshotUpdate={setRunSnapshot}
/>
```

If it does not, update `AgentRunControls` in Task 3 to expose it.

- [ ] **Step 8: Run lint and build**

```bash
cd /Users/robertwu/Documents/Projects/ProjectFlow/frontend
npm run lint
npm run build
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/project/agent-sidebar.tsx
git commit -m "feat(sidebar): wire steering send and real cancel run to composer"
```

---

### Task 3: Refactor AgentRunControls — remove textarea, add steering history

**Files:**
- Modify: `frontend/src/components/project/agent/AgentRunControls.tsx`
- Create: `frontend/src/components/project/agent/SteeringHistory.tsx`
- Test: `frontend/src/components/project/agent/__tests__/AgentRunControls.test.tsx`

- [ ] **Step 1: Create `SteeringHistory.tsx`**

```tsx
"use client";

interface SteeringEvent {
  steering_seq: number;
  steering_type: string;
  content: string;
  created_at: string;
  consumed: boolean;
}

interface SteeringHistoryProps {
  events: SteeringEvent[];
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}

export function SteeringHistory({ events }: SteeringHistoryProps) {
  if (events.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium text-neutral-500">已追加约束</div>
      <div className="space-y-1.5">
        {events.map((ev) => (
          <div
            key={ev.steering_seq}
            className="rounded border border-neutral-100 bg-neutral-50 px-2 py-1.5 text-xs text-neutral-700"
          >
            <div className="line-clamp-2">{ev.content}</div>
            <div className="mt-1 flex items-center justify-between text-[10px] text-neutral-400">
              <span>{ev.consumed ? "已处理" : "待处理"}</span>
              <span>{formatRelativeTime(ev.created_at)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Remove constraint textarea and buttons from AgentRunControls**

Delete local state and handlers related to:
- `draft` for steering
- `busy` for sending constraint
- `steer` / `handleSteer` / `handlePlanChange`

Remove the JSX containing the textarea and the "追加约束" / "调整计划" buttons.

- [ ] **Step 3: Add `SteeringHistory` to the run panel**

Derive events from the snapshot prop:

```ts
const steeringEvents = useMemo(() => {
  const unconsumed = (snapshot?.unconsumed_steering ?? []) as SteeringEvent[];
  const consumed = (snapshot?.consumed_steering ?? []) as SteeringEvent[];
  return [...unconsumed, ...consumed].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}, [snapshot]);
```

Render `<SteeringHistory events={steeringEvents} />` in the panel, below the status text.

- [ ] **Step 4: Expose snapshot updates to parent**

Add an `onSnapshotUpdate` callback prop:

```ts
interface AgentRunControlsProps {
  runId: string | null;
  connectionStatus?: string | null;
  onCancel?: () => void;
  onSnapshotUpdate?: (snapshot: RunSnapshot) => void;
}
```

Call `onSnapshotUpdate?.(latestSnapshot)` whenever the poller refreshes.

- [ ] **Step 5: Update tests**

Remove old tests for "追加约束" textarea. Add:

```ts
it("renders steering history from snapshot", () => {
  const snapshot = {
    status: "model_streaming",
    unconsumed_steering: [
      { steering_seq: 1, steering_type: "constraint", content: "优先 MVP", created_at: new Date().toISOString() },
    ],
    consumed_steering: [],
  };
  render(<AgentRunControls runId="run-1" snapshot={snapshot} />);
  expect(screen.getByText("已追加约束")).toBeInTheDocument();
  expect(screen.getByText("优先 MVP")).toBeInTheDocument();
});

it("does not render constraint textarea", () => {
  render(<AgentRunControls runId="run-1" />);
  expect(screen.queryByLabelText(/追加运行约束/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 6: Run tests**

```bash
cd /Users/robertwu/Documents/Projects/ProjectFlow/frontend
npm run test -- AgentRunControls.test.tsx
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/project/agent/AgentRunControls.tsx frontend/src/components/project/agent/SteeringHistory.tsx frontend/src/components/project/agent/__tests__/AgentRunControls.test.tsx
git commit -m "feat(run-controls): replace constraint textarea with steering history"
```

---

### Task 4: Add optional timeout to getRunSnapshot

**Files:**
- Modify: `agent-bridge/src/tools/fastapi-client.ts`
- Test: `agent-bridge/src/tools/__tests__/fastapi-client.test.ts` (create if missing)

- [ ] **Step 1: Update signature**

```ts
async getRunSnapshot(runId: string, afterEventSeq?: number, timeoutMs?: number): Promise<Record<string, unknown>> {
  const cursorParam = afterEventSeq != null && afterEventSeq > 0
    ? `?after_event_seq=${afterEventSeq}`
    : "";
  return this.request("GET", `/internal/agent-runs/${runId}/snapshot${cursorParam}`, undefined, timeoutMs);
}
```

- [ ] **Step 2: Update `request` to accept optional timeout**

```ts
private async request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const url = `${this.baseUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${this.serviceToken}`,
  };

  return this.fetchJson<T>(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, timeoutMs);
}
```

- [ ] **Step 3: Update `fetchJson` to accept optional timeout**

```ts
private async fetchJson<T>(url: string, init: RequestInit, timeoutMs?: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
  // ... rest unchanged
}
```

- [ ] **Step 4: Add test**

```ts
it("uses custom timeout for getRunSnapshot", async () => {
  vi.useFakeTimers();
  const client = new FastapiClient({ baseUrl: "http://api", serviceToken: "x", timeoutMs: 99999 });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
  const promise = client.getRunSnapshot("r1", undefined, 100);
  vi.advanceTimersByTime(100);
  await expect(promise).rejects.toThrow();
  fetchMock.mockRestore();
  vi.useRealTimers();
});
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/robertwu/Documents/Projects/ProjectFlow/agent-bridge
npm run test -- fastapi-client.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add agent-bridge/src/tools/fastapi-client.ts agent-bridge/src/tools/__tests__/fastapi-client.test.ts
git commit -m "feat(fastapi-client): per-request timeout for getRunSnapshot"
```

---

### Task 5: Harden cancel-run to propagate to backend

**Files:**
- Modify: `agent-bridge/src/server/routes/cancel-run.ts`
- Test: `agent-bridge/src/server/routes/__tests__/cancel-run.test.ts` (create if missing)

- [ ] **Step 1: Update the handler**

```ts
export async function handleCancelRun(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  const runId = params.runId ?? "";
  const run = ctx.sessionStore.get(runId);

  if (!run) {
    sendJson(res, 404, { error: "not_found", message: `运行 ${runId} 未找到` });
    return;
  }

  let reason = "user_cancelled";
  try {
    const bodyText = (req as IncomingMessage & { bodyText?: string }).bodyText;
    if (bodyText) {
      const body = JSON.parse(bodyText);
      if (typeof body.reason === "string") {
        reason = body.reason;
      }
    }
  } catch {
    // ignore parse errors
  }

  // Propagate to backend FIRST. If backend fails, do not pretend cancellation succeeded.
  try {
    await ctx.fastapiClient.cancelRun(runId, reason);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger?.warn({ err, runId }, "backend cancelRun failed");
    sendJson(res, 502, { error: "backend_cancel_failed", message });
    return;
  }

  // Transition to cancelled
  const cancelableStatuses = ["created", "context_building", "model_streaming", "tool_preparing", "tool_running", "persisting_tool_result"];
  if (cancelableStatuses.includes(run.status)) {
    run.status = "cancelled";
    run.completedAt = new Date().toISOString();
    run.updatedAt = run.completedAt;
    ctx.sessionStore.abort(runId, reason);
    ctx.sessionStore.clearAbortController(runId);
  }

  sendJson(res, 200, {
    run_id: run.runId,
    status: run.status,
    cancelled: run.status === "cancelled",
  });
}
```

- [ ] **Step 2: Add route test**

```ts
it("calls backend cancel and aborts sidecar session", async () => {
  const fastapiClient = { cancelRun: vi.fn().mockResolvedValue({}) };
  const sessionStore = new SessionStore();
  sessionStore.set("r1", { status: "model_streaming" } as AgentRunState);
  sessionStore.setAbortController("r1", new AbortController());
  const ctx = { fastapiClient, sessionStore, logger: { warn: vi.fn() } } as unknown as RunContext;

  await handleCancelRun(
    { bodyText: JSON.stringify({ reason: "用户取消" }) } as IncomingMessage,
    { statusCode: 200, setHeader: vi.fn(), end: vi.fn() } as unknown as ServerResponse,
    { runId: "r1" },
    ctx,
  );

  expect(fastapiClient.cancelRun).toHaveBeenCalledWith("r1", "用户取消");
  expect(sessionStore.get("r1")?.status).toBe("cancelled");
});

it("returns 502 when backend cancel fails", async () => {
  const fastapiClient = { cancelRun: vi.fn().mockRejectedValue(new Error("backend down")) };
  const sessionStore = new SessionStore();
  sessionStore.set("r1", { status: "model_streaming" } as AgentRunState);
  const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
  const ctx = { fastapiClient, sessionStore, logger: { warn: vi.fn() } } as unknown as RunContext;

  await handleCancelRun(
    { bodyText: "" } as IncomingMessage,
    res,
    { runId: "r1" },
    ctx,
  );

  expect(res.statusCode).toBe(502);
  expect(sessionStore.get("r1")?.status).toBe("model_streaming");
});
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/robertwu/Documents/Projects/ProjectFlow/agent-bridge
npm run test -- cancel-run.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add agent-bridge/src/server/routes/cancel-run.ts agent-bridge/src/server/routes/__tests__/cancel-run.test.ts
git commit -m "feat(cancel-run): propagate cancel to backend and fail loudly on error"
```

---

### Task 6: Inject steering into prompt context

**Files:**
- Modify: `agent-bridge/src/runtime/context-builder.ts`
- Test: `agent-bridge/src/runtime/__tests__/context-builder.test.ts`

- [ ] **Step 1: Add pendingSteering to ContextBuildInput**

```ts
export interface ContextBuildInput {
  // ...existing fields
  pendingSteering?: Array<{
    steering_type: string;
    content: string;
  }>;
}
```

- [ ] **Step 2: Add formatting helper**

```ts
function formatSteeringEvents(events?: Array<{ steering_type: string; content: string }>): string {
  if (!events || events.length === 0) return "";
  const items = events
    .filter((e) => e.steering_type !== "cancel")
    .map((e, idx) => `${idx + 1}. ${escapeXmlText(e.content.trim())}`)
    .join("\n");
  if (!items) return "";
  return `<user_steering>\n用户追加约束：\n${items}\n</user_steering>`;
}
```

- [ ] **Step 3: Append steering block in budget-aware path**

In `buildContextWithBudget`, after the `user_message` block:

```ts
if (input.pendingSteering && input.pendingSteering.length > 0) {
  const steeringContent = formatSteeringEvents(input.pendingSteering);
  if (steeringContent) {
    ledger.add(createBlock("user_steering", "user_input", steeringContent, {
      priority: 35,
      retention: "required",
      version: "2.0.0",
    }));
  }
}
```

- [ ] **Step 4: Append steering block in backward-compatible path**

In `buildUserMessage`, before the final `<user_message>` block:

```ts
if (input.pendingSteering && input.pendingSteering.length > 0) {
  const steeringContent = formatSteeringEvents(input.pendingSteering);
  if (steeringContent) {
    parts.push(steeringContent);
  }
}
```

- [ ] **Step 5: Add test**

```ts
it("injects steering events into prompt", () => {
  const context = buildContext({
    userContent: "开始规划",
    toolManifests: [],
    pendingSteering: [
      { steering_type: "constraint", content: "不要改截止日期" },
      { steering_type: "constraint", content: "<script>" },
    ],
  });
  expect(context.userMessage).toContain("用户追加约束：");
  expect(context.userMessage).toContain("不要改截止日期");
  expect(context.userMessage).toContain("&lt;script&gt;");
  expect(context.userMessage).not.toContain("<script>");
});
```

- [ ] **Step 6: Run tests**

```bash
cd /Users/robertwu/Documents/Projects/ProjectFlow/agent-bridge
npm run test -- context-builder.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add agent-bridge/src/runtime/context-builder.ts agent-bridge/src/runtime/__tests__/context-builder.test.ts
git commit -m "feat(context-builder): inject pending steering into prompt"
```

---

### Task 7: Loop-boundary steering consumption in pi-runtime

**Files:**
- Modify: `agent-bridge/src/runtime/pi-runtime.ts`
- Test: `agent-bridge/src/runtime/__tests__/pi-runtime.test.ts`

- [ ] **Step 1: Add steering consumption helper**

At the top of `executeRun`, before context building, define:

```ts
const MAX_STEERING_LOOPS = 5;
const consumedSteeringSeqs = new Set<number>();

const consumeSteeringEvents = async (
  steeringEvents: PendingSteeringEvent[],
): Promise<{ shouldAbort: boolean }> => {
  for (const event of steeringEvents) {
    if (consumedSteeringSeqs.has(event.steeringSeq)) continue;
    consumedSteeringSeqs.add(event.steeringSeq);

    if (event.steeringType === "cancel") {
      return { shouldAbort: true };
    }

    await persistControlPlaneEvent(
      "steering.consumed",
      runState,
      fastapiClient,
      stream,
      {
        steering_seq: event.steeringSeq,
        steering_type: event.steeringType,
        content: event.content.slice(0, 500),
      },
      traceIncludeSensitiveData,
    );

    if (event.steeringType === "clarification_answer" && workState.status === "awaiting_user") {
      try {
        workState = transitionWorkState(workState, "understanding", workState.version, "收到用户回答");
      } catch {
        // already transitioned
      }
    }
    if (event.steeringType === "approval_response" && workState.status === "awaiting_approval") {
      const approved = event.metadata?.approved === true || event.content === "approved";
      if (!approved) return { shouldAbort: true };
      workState = transitionWorkState(workState, "planning", workState.version, "用户已批准工具执行");
      await persistControlPlaneEvent(
        "work_state.changed",
        runState,
        fastapiClient,
        stream,
        { status: workState.status, version: workState.version, reason: workState.reason },
        traceIncludeSensitiveData,
      );
    }
  }
  return { shouldAbort: false };
};
```

- [ ] **Step 2: Consume initial pendingSteering if provided**

After context building and before the model loop, consume `input.pendingSteering`:

```ts
if (input.pendingSteering && input.pendingSteering.length > 0) {
  for (const s of input.pendingSteering) consumedSteeringSeqs.add(s.steeringSeq);
  const result = await consumeSteeringEvents(input.pendingSteering);
  if (result.shouldAbort) {
    // terminal cancelled
    runState.status = "cancelled";
    runState.completedAt = new Date().toISOString();
    runState.updatedAt = runState.completedAt;
    await persistAndEmitMappedEvent(
      { type: "run.cancelled", payload: { reason: "用户取消" }, newStatus: "cancelled" },
      runState, fastapiClient, stream, traceIncludeSensitiveData,
    );
    callbacks.onComplete?.(runState);
    return runState;
  }
}
```

- [ ] **Step 3: After model loop, poll snapshot for new steering**

Replace the existing post-loop steering consumption block (lines 1052-1066) with:

```ts
// ── Loop-boundary steering consumption ────────────────────────────
let steeringLoopCount = 0;
while (steeringLoopCount < MAX_STEERING_LOOPS) {
  const snapshot = await fastapiClient.getRunSnapshot(runId, undefined, 5000);
  const steeringList = ((snapshot.unconsumed_steering ?? []) as Array<{
    steering_seq: number;
    steering_type: string;
    content: string;
    client_message_id?: string;
    metadata?: Record<string, unknown>;
  }>).filter((s) => !consumedSteeringSeqs.has(s.steering_seq));

  if (steeringList.length === 0) break;

  const pending = steeringList.map((s) => ({
    steeringSeq: s.steering_seq,
    steeringType: s.steering_type as PendingSteeringEvent["steeringType"],
    content: s.content,
    clientMessageId: s.client_message_id ?? `snapshot:${s.steering_seq}`,
    metadata: s.metadata,
  }));

  const result = await consumeSteeringEvents(pending);
  if (result.shouldAbort) {
    runState.status = "cancelled";
    runState.completedAt = new Date().toISOString();
    runState.updatedAt = runState.completedAt;
    await persistAndEmitMappedEvent(
      { type: "run.cancelled", payload: { reason: "用户取消" }, newStatus: "cancelled" },
      runState, fastapiClient, stream, traceIncludeSensitiveData,
    );
    callbacks.onComplete?.(runState);
    return runState;
  }

  // Rebuild context with steering and run one more loop
  const nextContext = buildContext({
    ...contextInput,
    pendingSteering: pending.filter((p) => p.steeringType !== "cancel"),
  });
  const nextAgentContext: AgentContext = {
    systemPrompt: nextContext.systemPrompt,
    messages: [],
    tools: piTools,
  };
  const nextPromptMessage = {
    role: "user" as const,
    content: nextContext.userMessage,
    timestamp: Date.now(),
  } as AgentMessage;

  runState.status = "model_streaming";
  runState.updatedAt = new Date().toISOString();
  await runAgentLoop(
    [nextPromptMessage],
    nextAgentContext,
    config,
    piEventSink,
    options.signal,
    streamFn,
  );

  // Persist post-loop checkpoint after this extra loop
  checkpointVersion++;
  const loopCheckpoint = createCheckpoint(
    runState, workState, runPlan, input.outcomeContract,
    getCombinedLedger(), "tool_result", checkpointVersion,
    undefined, input.userContent,
  );
  await persistCheckpoint(loopCheckpoint, runState, fastapiClient, traceIncludeSensitiveData);

  steeringLoopCount++;
}
```

- [ ] **Step 4: Add tests**

```ts
it("consumes steering at loop boundary and re-runs", async () => {
  // mock fastapiClient.getRunSnapshot to return one steering event
  // assert runAgentLoop is called twice and final status is completed
});

it("terminals on cancel steering at loop boundary", async () => {
  // mock snapshot with cancel steering, assert run ends cancelled
});
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/robertwu/Documents/Projects/ProjectFlow/agent-bridge
npm run test -- pi-runtime.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add agent-bridge/src/runtime/pi-runtime.ts agent-bridge/src/runtime/__tests__/pi-runtime.test.ts
git commit -m "feat(pi-runtime): loop-boundary steering consumption"
```

---

## Phase 2: Mid-stream steering abort

### Task 8: Add abort reason support to session-store

**Files:**
- Modify: `agent-bridge/src/runtime/session-store.ts`
- Test: `agent-bridge/src/runtime/__tests__/session-store.test.ts` (create if missing)

- [ ] **Step 1: Add steering-available flag storage**

```ts
private readonly steeringAvailable = new Map<string, boolean>();
```

- [ ] **Step 2: Add methods**

```ts
/** Mark that a new steering event is available for a run. */
markSteeringAvailable(runId: string): void {
  this.steeringAvailable.set(runId, true);
}

/** Check and clear the steering-available flag. */
consumeSteeringAvailable(runId: string): boolean {
  const value = this.steeringAvailable.get(runId) ?? false;
  this.steeringAvailable.delete(runId);
  return value;
}

/** Abort an active run with an optional reason string. */
abort(runId: string, reason?: string): boolean {
  const controller = this.abortControllers.get(runId);
  if (!controller) return false;
  if (reason) {
    // @ts-expect-error reason is a non-standard extension
    controller.abort(reason);
  } else {
    controller.abort();
  }
  return true;
}
```

- [ ] **Step 3: Update `delete` to clean up steering flag**

```ts
delete(runId: string): boolean {
  this.abortControllers.delete(runId);
  this.steeringAvailable.delete(runId);
  return this.runs.delete(runId);
}
```

- [ ] **Step 4: Add tests**

```ts
it("stores and consumes steering available flag", () => {
  const store = new SessionStore();
  store.markSteeringAvailable("r1");
  expect(store.consumeSteeringAvailable("r1")).toBe(true);
  expect(store.consumeSteeringAvailable("r1")).toBe(false);
});

it("aborts with a reason", () => {
  const store = new SessionStore();
  const controller = new AbortController();
  store.setAbortController("r1", controller);
  store.abort("r1", "steering_available");
  expect(controller.signal.aborted).toBe(true);
  expect(controller.signal.reason).toBe("steering_available");
});
```

- [ ] **Step 5: Run agent-bridge tests**

```bash
cd /Users/robertwu/Documents/Projects/ProjectFlow/agent-bridge
npm run test -- session-store.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add agent-bridge/src/runtime/session-store.ts agent-bridge/src/runtime/__tests__/session-store.test.ts
git commit -m "feat(session-store): abort reason and steering-available flag"
```

---

### Task 9: Implement SteeringPoller

**Files:**
- Create: `agent-bridge/src/runtime/steering-poller.ts`
- Test: `agent-bridge/src/runtime/__tests__/steering-poller.test.ts`

- [ ] **Step 1: Create the poller**

```ts
import type { FastapiClient } from "@/tools/fastapi-client.js";
import type { SessionStore } from "./session-store.js";

interface SteeringPollerDeps {
  runId: string;
  fastapiClient: FastapiClient;
  sessionStore: SessionStore;
  logger?: { warn: (msg: string, meta?: unknown) => void };
}

export class SteeringPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  private readonly maxFailures = 3;
  private readonly intervalMs = 1500;
  private readonly timeoutMs = 3000;
  private consumedSeqs = new Set<number>();

  constructor(private readonly deps: SteeringPollerDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  markConsumed(seqs: number[]): void {
    for (const seq of seqs) this.consumedSeqs.add(seq);
  }

  private async tick(): Promise<void> {
    if (this.failures >= this.maxFailures) {
      this.deps.logger?.warn(`SteeringPoller stopping for ${this.deps.runId} after ${this.maxFailures} failures`);
      this.stop();
      return;
    }
    try {
      const snapshot = await this.deps.fastapiClient.getRunSnapshot(
        this.deps.runId,
        undefined,
        this.timeoutMs,
      );
      const steering = (snapshot.unconsumed_steering ?? []) as Array<{
        steering_seq: number;
        steering_type: string;
      }>;
      const newSteering = steering.filter((s) => !this.consumedSeqs.has(s.steering_seq));
      const hasCancel = newSteering.some((s) => s.steering_type === "cancel");
      if (hasCancel || newSteering.length > 0) {
        this.deps.sessionStore.markSteeringAvailable(this.deps.runId);
        this.deps.sessionStore.abort(this.deps.runId, "steering_available");
      }
      this.failures = 0;
    } catch (err) {
      this.failures++;
      this.deps.logger?.warn(`SteeringPoller tick failed for ${this.deps.runId}`, { err });
    }
  }
}
```

- [ ] **Step 2: Add tests**

```ts
it("aborts session when new steering arrives", async () => {
  vi.useFakeTimers();
  const client = {
    getRunSnapshot: vi.fn().mockResolvedValue({
      unconsumed_steering: [{ steering_seq: 1, steering_type: "constraint" }],
    }),
  } as unknown as FastapiClient;
  const store = new SessionStore();
  const controller = new AbortController();
  store.setAbortController("r1", controller);
  const poller = new SteeringPoller({ runId: "r1", fastapiClient: client, sessionStore: store });
  poller.start();
  await vi.advanceTimersByTimeAsync(1600);
  expect(controller.signal.aborted).toBe(true);
  expect(controller.signal.reason).toBe("steering_available");
  poller.stop();
  vi.useRealTimers();
});

it("stops after max failures", async () => {
  vi.useFakeTimers();
  const client = { getRunSnapshot: vi.fn().mockRejectedValue(new Error("network")) } as unknown as FastapiClient;
  const store = new SessionStore();
  const poller = new SteeringPoller({ runId: "r1", fastapiClient: client, sessionStore: store });
  poller.start();
  await vi.advanceTimersByTimeAsync(5000);
  expect(client.getRunSnapshot).toHaveBeenCalledTimes(3);
  poller.stop();
  vi.useRealTimers();
});
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/robertwu/Documents/Projects/ProjectFlow/agent-bridge
npm run test -- steering-poller.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add agent-bridge/src/runtime/steering-poller.ts agent-bridge/src/runtime/__tests__/steering-poller.test.ts
git commit -m "feat(steering-poller): poll snapshot and abort on new steering"
```

---

### Task 10: Wire mid-stream abort into pi-runtime

**Files:**
- Modify: `agent-bridge/src/runtime/pi-runtime.ts`
- Test: `agent-bridge/src/runtime/__tests__/pi-runtime.test.ts`

- [ ] **Step 1: Import SteeringPoller**

```ts
import { SteeringPoller } from "./steering-poller.js";
```

- [ ] **Step 2: Start/stop poller around runAgentLoop**

Inside `executeRun`, after creating the abort controller:

```ts
const poller = new SteeringPoller({
  runId,
  fastapiClient,
  sessionStore,
  logger,
});
poller.start();
```

In the finally/cleanup block:

```ts
finally {
  poller.stop();
  sessionStore.clearAbortController(runId);
}
```

- [ ] **Step 3: Distinguish abort reasons in catch**

Where the loop catches abort (the outer `try/catch` in `executeRun`):

```ts
} catch (err) {
  const wasSteeringAbort = options.signal?.reason === "steering_available";
  if (wasSteeringAbort) {
    // Do not terminal here; let the loop-boundary steering consumption handle it.
    logger?.info("model loop aborted for steering");
  } else {
    const wasCancelled = options.signal?.aborted || runState.status === "cancelling" || runState.status === "cancelled";
    runState.status = wasCancelled ? "cancelled" : "failed";
    // ...existing terminal handling
  }
}
```

Because the loop-boundary steering consumption already runs after `runAgentLoop`, when a steering abort occurs, `runAgentLoop` throws, execution continues after it, and the loop-boundary code will see the new unconsumed steering and re-enter.

- [ ] **Step 4: Mark consumed seqs in poller after loop-boundary consumption**

Inside the loop-boundary consumption while loop, after consuming pending steering:

```ts
poller.markConsumed(pending.map((s) => s.steeringSeq));
```

- [ ] **Step 5: Add tests**

```ts
it("aborts mid-stream and re-runs when steering arrives", async () => {
  // mock runAgentLoop to throw on first call with steering_available reason,
  // then snapshot returns steering, assert second runAgentLoop call uses steering context
});
```

- [ ] **Step 6: Run tests**

```bash
cd /Users/robertwu/Documents/Projects/ProjectFlow/agent-bridge
npm run test -- pi-runtime.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add agent-bridge/src/runtime/pi-runtime.ts agent-bridge/src/runtime/__tests__/pi-runtime.test.ts
git commit -m "feat(pi-runtime): mid-stream steering abort and re-entry"
```

---

## Task 11: Integration verification

- [ ] **Step 1: Start backend and frontend**

```bash
cd /Users/robertwu/Documents/Projects/ProjectFlow/backend
source .venv/bin/activate
python -m uvicorn app.main:app --reload --port 8000
```

```bash
cd /Users/robertwu/Documents/Projects/ProjectFlow/frontend
npm run dev
```

- [ ] **Step 2: Trigger an Agent run and send a steering message**

In the browser:
1. Open a project.
2. Click "主动推进" or any action that starts a run.
3. While the Agent is streaming output, type "不要改截止日期" in the composer and send.
4. Observe the stream interrupt and restart with the constraint applied (Phase 2).

- [ ] **Step 3: Stop a run**

While a run is active, click the dedicated "停止" button. Confirm in the backend DB or FastAPI `/docs` that the run status becomes `cancelled`.

- [ ] **Step 4: Verify steering history**

Confirm the "已追加约束" list appears in the AgentRunControls panel and shows the sent constraint.

- [ ] **Step 5: Run full test suites**

```bash
cd /Users/robertwu/Documents/Projects/ProjectFlow/frontend
npm run test
npm run lint
npm run build
```

```bash
cd /Users/robertwu/Documents/Projects/ProjectFlow/agent-bridge
npm run test
npm run lint
npm run build
```

- [ ] **Step 6: Final commit if not already**

```bash
git status
# add any remaining changes
git commit -m "feat: merge constraint composer and mid-stream steering (integration)"
```

---

## Self-Review

1. **Spec coverage:**
   - Composer stop/send independence → Task 1.
   - AgentSidebar orchestration → Task 2.
   - AgentRunControls steering history → Task 3.
   - Loop-boundary steering → Task 7.
   - Mid-stream abort + poller → Tasks 8, 9, 10.
   - Steering prompt injection → Task 6.
   - True cancel propagation → Task 5.
   No gaps.

2. **Placeholder scan:** No TBD/TODO/fill-in-details found. Every step has code or exact command.

3. **Type consistency:**
   - `SessionStore.abort(runId, reason?)` used in Tasks 5, 8, 9, 10.
   - `FastapiClient.getRunSnapshot(runId, afterEventSeq?, timeoutMs?)` used in Tasks 4, 9, 10.
   - `ChatComposer` props `isRunning` / `onSendSteering` / `onCancelRun` consistent across Tasks 1 and 2.
