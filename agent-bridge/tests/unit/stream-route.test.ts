/**
 * Sidecar stream route tests — import production helpers.
 *
 * Validates: tool label mapping, unknown tool fallback, numeric composite key sort.
 */
import { describe, it, expect } from "vitest";
import { toolLabel, compareCompositeKeys } from "../../src/server/routes/start-run-stream.js";
import {
  formatToolStartLabel,
  formatToolCompleteLabel,
  formatToolFailedLabel,
  formatToolBlockedLabel,
} from "../../src/server/routes/run-stream-presentation.js";

describe("sidecar stream route: tool labels (production)", () => {
  it("known tool returns Chinese base label", () => {
    expect(toolLabel("get_project_state")).toBe("获取项目状态");
    expect(toolLabel("generate_stage_plan_proposal")).toBe("生成阶段规划");
    expect(toolLabel("create_risk")).toBe("创建风险记录");
  });

  it("unknown tool returns generic fallback — never raw snake_case", () => {
    const label = toolLabel("some_unknown_tool");
    expect(label).toBe("执行工具");
    expect(label).not.toContain("some_unknown_tool");
    expect(label).not.toContain("some unknown tool");
  });

  it("empty tool name returns generic fallback", () => {
    expect(toolLabel("")).toBe("执行工具");
  });

  it("format helpers produce correct labels for known and unknown tools", () => {
    expect(formatToolStartLabel("get_project_state")).toBe("正在获取项目状态");
    expect(formatToolCompleteLabel("get_project_state")).toBe("已获取项目状态");
    expect(formatToolFailedLabel("get_project_state")).toBe("获取项目状态失败");
    expect(formatToolBlockedLabel("get_project_state")).toBe("获取项目状态已被阻止");

    expect(formatToolStartLabel("unknown")).toBe("正在执行工具");
    expect(formatToolCompleteLabel("unknown")).toBe("已完成工具");
    expect(formatToolFailedLabel("unknown")).toBe("执行工具失败");
    expect(formatToolBlockedLabel("unknown")).toBe("执行工具已被阻止");
  });
});

describe("sidecar stream route: status label fix (fix 4)", () => {
  it("formatToolStartLabel already contains 正在 — status message must not duplicate it", () => {
    // The stream route uses: `正在${baseLabel}...` for status messages,
    // where baseLabel is the raw label WITHOUT 正在 prefix.
    // formatToolStartLabel = "正在获取项目状态", so using it as base would produce "正在正在获取项目状态..."
    const startLabel = formatToolStartLabel("get_project_state");
    expect(startLabel).toBe("正在获取项目状态");

    // The correct base label should NOT have 正在
    const baseLabel = toolLabel("get_project_state");
    expect(baseLabel).toBe("获取项目状态");
    expect(baseLabel).not.toMatch(/^正在/);

    // Status message pattern: `正在${baseLabel}...` → "正在获取项目状态..."
    const statusMessage = `正在${baseLabel}...`;
    expect(statusMessage).toBe("正在获取项目状态...");
    expect(statusMessage).not.toContain("正在正在");
  });
});

describe("sidecar stream route: composite key sort (production)", () => {
  it("sorts by numeric messageSeq first, then contentIndex", () => {
    const keys = ["2:0", "0:1", "0:0", "1:0", "10:0"];
    const sorted = keys.sort(compareCompositeKeys);
    expect(sorted).toEqual(["0:0", "0:1", "1:0", "2:0", "10:0"]);
  });

  it("localeCompare would incorrectly sort '10:0' before '2:0'", () => {
    const keys = ["2:0", "10:0"];
    const localeSorted = [...keys].sort((a, b) => a.localeCompare(b));
    expect(localeSorted).toEqual(["10:0", "2:0"]); // WRONG
    const numericSorted = [...keys].sort(compareCompositeKeys);
    expect(numericSorted).toEqual(["2:0", "10:0"]); // CORRECT
  });

  it("same messageSeq: sorts by contentIndex", () => {
    const keys = ["0:2", "0:0", "0:1"];
    const sorted = keys.sort(compareCompositeKeys);
    expect(sorted).toEqual(["0:0", "0:1", "0:2"]);
  });
});
