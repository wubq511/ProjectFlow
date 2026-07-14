import { describe, expect, it } from "vitest";

import {
  parseSlashCommand,
  getLeadingSlashCommand,
  SLASH_COMMANDS,
} from "@/components/project/project-actions";

// ---------------------------------------------------------------------------
// parseSlashCommand
// ---------------------------------------------------------------------------

describe("parseSlashCommand", () => {
  it("parses /plan without additional text", () => {
    const result = parseSlashCommand("/plan");
    expect(result).toEqual({
      skill: "project-planning",
      command: "plan",
      content: "请执行 plan 模块",
    });
  });

  it("parses /plan with additional text — content is pure user context, no prefix", () => {
    const result = parseSlashCommand("/plan 按三周节奏");
    expect(result).toEqual({
      skill: "project-planning",
      command: "plan",
      content: "按三周节奏",
    });
  });

  it("parses /clarify with additional text", () => {
    const result = parseSlashCommand("/clarify 我们做的是在线教育");
    expect(result).toEqual({
      skill: "project-intake",
      command: "clarify",
      content: "我们做的是在线教育",
    });
  });

  it("parses /risk without additional text", () => {
    const result = parseSlashCommand("/risk");
    expect(result).toEqual({
      skill: "risk-analysis",
      command: "risk",
      content: "请执行 risk 模块",
    });
  });

  it("parses /checkin without additional text", () => {
    const result = parseSlashCommand("/checkin");
    expect(result).toEqual({
      skill: "risk-analysis",
      command: "checkin",
      content: "请执行 checkin 模块",
    });
  });

  it("returns null for unknown command", () => {
    expect(parseSlashCommand("/xyz")).toBeNull();
  });

  it("returns null for plain text without slash", () => {
    expect(parseSlashCommand("普通消息")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSlashCommand("")).toBeNull();
  });

  it("trims whitespace in additional text", () => {
    const result = parseSlashCommand("/plan   按三周节奏  ");
    expect(result).toEqual({
      skill: "project-planning",
      command: "plan",
      content: "按三周节奏",
    });
  });

  it("handles multi-line additional text", () => {
    const result = parseSlashCommand("/plan 第一周做需求\n第二周做开发\n第三周做测试");
    expect(result).toEqual({
      skill: "project-planning",
      command: "plan",
      content: "第一周做需求\n第二周做开发\n第三周做测试",
    });
  });
});

// ---------------------------------------------------------------------------
// SLASH_COMMANDS integrity
// ---------------------------------------------------------------------------

describe("SLASH_COMMANDS", () => {
  it("has 8 commands", () => {
    expect(SLASH_COMMANDS).toHaveLength(8);
  });

  it("has unique command names", () => {
    const names = SLASH_COMMANDS.map((c) => c.command);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has unique skills mapping (except checkin/risk sharing risk-analysis)", () => {
    const skills = SLASH_COMMANDS.map((c) => c.skill);
    // checkin and risk both use risk-analysis — that's intentional
    const uniqueSkills = new Set(skills);
    expect(uniqueSkills.size).toBeGreaterThanOrEqual(7);
  });

  it("every command has a non-empty defaultInstruction", () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.defaultInstruction.length).toBeGreaterThan(0);
    }
  });

  it("no defaultInstruction is a bare label in _AMBIGUOUS_BARE_LABELS", () => {
    // These bare labels would be rejected by the backend if skill were lost.
    // defaultInstruction must be a full instruction like "请执行 X 模块".
    const ambiguousLabels = ["方向澄清", "阶段计划", "任务拆解", "推荐分工", "风险分析", "签到分析"];
    for (const cmd of SLASH_COMMANDS) {
      expect(ambiguousLabels).not.toContain(cmd.defaultInstruction);
    }
  });

  it("supports filtering by command prefix", () => {
    const filtered = SLASH_COMMANDS.filter((c) => c.command.startsWith("pl"));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.command).toBe("plan");
  });

  it("supports filtering by label includes", () => {
    const filtered = SLASH_COMMANDS.filter((c) => c.label.includes("风险"));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.command).toBe("risk");
  });
});

// ---------------------------------------------------------------------------
// getLeadingSlashCommand
// ---------------------------------------------------------------------------

describe("getLeadingSlashCommand", () => {
  it("returns the command definition for a valid leading command", () => {
    const cmd = getLeadingSlashCommand("/clarify 请帮我梳理");
    expect(cmd).toBeTruthy();
    expect(cmd!.command).toBe("clarify");
  });

  it("returns null when the command is not followed by whitespace", () => {
    expect(getLeadingSlashCommand("/clarify")).toBeNull();
  });

  it("returns null for unknown commands", () => {
    expect(getLeadingSlashCommand("/xyz abc")).toBeNull();
  });

  it("returns null when the command is not at the start", () => {
    expect(getLeadingSlashCommand("hello /clarify ")).toBeNull();
  });

  it("returns null for leading whitespace before slash", () => {
    expect(getLeadingSlashCommand("  /clarify hello")).toBeNull();
  });

  it("matches commands case-insensitively", () => {
    const cmd = getLeadingSlashCommand("/CLARIFY hello");
    expect(cmd).toBeTruthy();
    expect(cmd!.command).toBe("clarify");
  });

  it("matches multi-word context after the command", () => {
    const cmd = getLeadingSlashCommand("/plan 第一周\n第二周");
    expect(cmd).toBeTruthy();
    expect(cmd!.command).toBe("plan");
  });
});
