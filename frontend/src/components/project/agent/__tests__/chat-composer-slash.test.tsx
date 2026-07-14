import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChatComposer } from "@/components/project/agent/ChatComposer";

function ChatComposerWrapper(props: {
  initialValue?: string;
  onSubmit: (text: string) => void;
  onSlashSubmit?: (content: string, skill: string) => void;
  isRunning?: boolean;
  onSendSteering?: (content: string) => void | Promise<void>;
  onCancelRun?: () => void | Promise<void>;
}) {
  const [value, setValue] = useState(props.initialValue ?? "");
  return (
    <ChatComposer
      value={value}
      onChange={setValue}
      onSubmit={props.onSubmit}
      onSlashSubmit={props.onSlashSubmit}
      isRunning={props.isRunning}
      onSendSteering={props.onSendSteering}
      onCancelRun={props.onCancelRun}
    />
  );
}

function expectVisible(element: HTMLElement | null) {
  expect(element).toBeTruthy();
}

describe("ChatComposer slash command handling", () => {
  it("shows unknown command hint and does not submit for /xyz", () => {
    const onSubmit = vi.fn();
    const onSlashSubmit = vi.fn();

    render(
      <ChatComposerWrapper
        onSubmit={onSubmit}
        onSlashSubmit={onSlashSubmit}
      />,
    );

    const textarea = screen.getByPlaceholderText(/告诉 Agent/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/xyz" } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    expectVisible(screen.getByText(/未知命令：\/xyz/));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSlashSubmit).not.toHaveBeenCalled();
  });

  it("selects and submits slash command for /clarify", () => {
    const onSubmit = vi.fn();
    const onSlashSubmit = vi.fn();

    render(
      <ChatComposerWrapper
        onSubmit={onSubmit}
        onSlashSubmit={onSlashSubmit}
      />,
    );

    const textarea = screen.getByPlaceholderText(/告诉 Agent/) as HTMLTextAreaElement;

    // Type / and select first command (clarify) with Enter
    fireEvent.change(textarea, { target: { value: "/" } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    // With the command active, the textarea only renders the body (empty) and
    // the chip is rendered as a separate element.
    expect(textarea.value).toBe("");
    expectVisible(screen.getByText("方向澄清"));

    // Submit the filled command
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    expect(onSlashSubmit).toHaveBeenCalledWith("请执行 clarify 模块", "project-intake", "clarify");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("filters commands when typing /br", () => {
    render(
      <ChatComposerWrapper
        onSubmit={vi.fn()}
        onSlashSubmit={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/告诉 Agent/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/br" } });

    expectVisible(screen.getByText("任务拆解"));
    expect(screen.queryByText("方向澄清")).toBeNull();
  });

  it("closes slash menu with Escape even when no results match", () => {
    render(
      <ChatComposerWrapper
        onSubmit={vi.fn()}
        onSlashSubmit={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/告诉 Agent/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/xyz" } });
    expectVisible(screen.getByText("没有匹配的命令"));

    fireEvent.keyDown(textarea, { key: "Escape", code: "Escape" });
    expect(screen.queryByText("没有匹配的命令")).toBeNull();
  });

  it("renders a highlighted chip for a leading slash command", () => {
    render(
      <ChatComposerWrapper
        initialValue="/clarify 帮我梳理目标"
        onSubmit={vi.fn()}
        onSlashSubmit={vi.fn()}
      />,
    );

    expectVisible(screen.getByText("方向澄清"));
  });

  it("keeps the command prefix while the user types body text", () => {
    const onChange = vi.fn();

    render(
      <ChatComposer
        value="/clarify "
        onChange={onChange}
        onSubmit={vi.fn()}
        onSlashSubmit={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/补充上下文/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "帮我梳理目标" } });

    expect(onChange).toHaveBeenCalledWith("/clarify 帮我梳理目标");
  });

  it("removes the whole command with Backspace when cursor is at the start of the body", () => {
    const onChange = vi.fn();

    render(
      <ChatComposer
        value="/clarify 帮我梳理目标"
        onChange={onChange}
        onSubmit={vi.fn()}
        onSlashSubmit={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/补充上下文/) as HTMLTextAreaElement;
    // The textarea only contains the body; cursor at the very start of the body.
    fireEvent.focus(textarea);
    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "Backspace", code: "Backspace", keyCode: 8, which: 8 });

    expect(onChange).toHaveBeenCalledWith("帮我梳理目标");
  });

  it("does not remove the command with Delete at the start of the body", () => {
    const onChange = vi.fn();

    render(
      <ChatComposer
        value="/clarify 帮我梳理目标"
        onChange={onChange}
        onSubmit={vi.fn()}
        onSlashSubmit={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/补充上下文/) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "Delete", code: "Delete" });

    // Delete at the start of the body should act on body text, not the chip.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not remove the whole command when body text is selected", () => {
    const onChange = vi.fn();

    render(
      <ChatComposer
        value="/clarify 帮我梳理目标"
        onChange={onChange}
        onSubmit={vi.fn()}
        onSlashSubmit={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/补充上下文/) as HTMLTextAreaElement;
    textarea.focus();
    // Select a range inside the body text
    textarea.setSelectionRange(2, 6);
    const event = fireEvent.keyDown(textarea, { key: "Backspace", code: "Backspace" });

    // Our handler should not intercept the event when a range is selected.
    expect(event).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("removes the whole command via the chip remove button", () => {
    const onChange = vi.fn();

    render(
      <ChatComposer
        value="/clarify 帮我梳理目标"
        onChange={onChange}
        onSubmit={vi.fn()}
        onSlashSubmit={vi.fn()}
      />,
    );

    const removeButton = screen.getByLabelText("移除命令");
    fireEvent.click(removeButton);

    expect(onChange).toHaveBeenCalledWith("帮我梳理目标");
  });
});

describe("ChatComposer runtime steering", () => {
  it("shows stop button when running and input is empty", () => {
    render(
      <ChatComposer
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        isRunning
        onCancelRun={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /停止运行/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /发送/i })).toBeNull();
  });

  it("shows active send button when running and input has text", () => {
    render(
      <ChatComposer
        value="请优先做 MVP"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        isRunning
        onSendSteering={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /停止运行/i })).toBeNull();
    expect((screen.getByRole("button", { name: /发送/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("calls onSendSteering and clears input when running and submitted", async () => {
    const onSendSteering = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();
    render(
      <ChatComposer
        value="请优先做 MVP"
        onChange={onChange}
        onSubmit={vi.fn()}
        isRunning
        onSendSteering={onSendSteering}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /发送/i }));
    expect(onSendSteering).toHaveBeenCalledWith("请优先做 MVP");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(""));
  });

  it("calls onCancelRun when stop is clicked", () => {
    const onCancelRun = vi.fn();
    render(
      <ChatComposer
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        isRunning
        onCancelRun={onCancelRun}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /停止运行/i }));
    expect(onCancelRun).toHaveBeenCalled();
  });

  it("keeps stop button clickable while running even when composer is externally disabled", () => {
    const onCancelRun = vi.fn();
    render(
      <ChatComposer
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        isRunning
        disabled
        onCancelRun={onCancelRun}
      />,
    );
    const stopButton = screen.getByRole("button", { name: /停止运行/i }) as HTMLButtonElement;
    expect(stopButton.disabled).toBe(false);
    fireEvent.click(stopButton);
    expect(onCancelRun).toHaveBeenCalled();
  });

  it("keeps textarea and steering send enabled while running even when externally disabled", () => {
    const onSendSteering = vi.fn();
    render(
      <ChatComposer
        value="请优先做 MVP"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        isRunning
        disabled
        onSendSteering={onSendSteering}
      />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    const sendButton = screen.getByRole("button", { name: /发送/i }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);
  });

  it("does not open slash menu while running", () => {
    render(
      <ChatComposer
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        isRunning
      />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/" } });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("uses running placeholder when isRunning is true", () => {
    render(
      <ChatComposer
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        isRunning
      />,
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).placeholder).toBe(
      "追加约束或纠正当前运行...",
    );
  });
});
