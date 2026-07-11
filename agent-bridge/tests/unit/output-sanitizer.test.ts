import { describe, expect, it } from "vitest";
import { createOutputSanitizer, sanitizeModelOutput } from "../../src/runtime/output-sanitizer.js";

const workspaceState = {
  members: [
    { user_id: "user-lin", display_name: "小林" },
    { user_id: "user-wang", display_name: "小王" },
  ],
  project: {
    id: "proj-eval",
    name: "智慧课表",
    stages: [{ id: "stage-2", name: "分工" }],
    tasks: [{ id: "task-api", title: "后端 API 开发" }],
  },
};

describe("output-sanitizer", () => {
  it("replaces known internal IDs with display labels", () => {
    const output = "建议 user-wang 负责 task-api，项目 proj-eval 当前在 stage-2。";

    expect(sanitizeModelOutput(output, workspaceState)).toBe(
      "建议 小王 负责 后端 API 开发，项目 智慧课表 当前在 分工。",
    );
  });

  it("redacts unknown internal IDs and UUIDs", () => {
    const output = "user-unknown / task-secret / 123e4567-e89b-42d3-a456-426614174000";
    const sanitized = sanitizeModelOutput(output, workspaceState);

    expect(sanitized).not.toContain("user-unknown");
    expect(sanitized).not.toContain("task-secret");
    expect(sanitized).not.toContain("123e4567");
  });

  it("sanitizes an ID split across streaming chunks", () => {
    const sanitizer = createOutputSanitizer(workspaceState);
    const streamed = [
      sanitizer.push("推荐 user-"),
      sanitizer.push("wang 负责后端。"),
      sanitizer.flush(),
    ].join("");

    expect(streamed).toBe("推荐 小王 负责后端。");
    expect(streamed).not.toContain("user-wang");
  });
});
