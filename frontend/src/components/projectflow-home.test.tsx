import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { ProjectFlowHome } from "./projectflow-home";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    h1: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
    p: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  },
}));

describe("ProjectFlowHome", () => {
  it("shows the landing page with call-to-action when no workspace is stored", () => {
    render(<ProjectFlowHome />);

    expect(screen.getByRole("heading", { name: /学生项目的主动推进工作台/ })).toBeTruthy();
    expect(screen.getByText("ProjectFlow / 项目操作系统")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /开始使用/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /加载演示数据/ })).toBeTruthy();
    expect(screen.getByText("Campus Demo Workspace")).toBeTruthy();
    expect(screen.getByText("下一步行动")).toBeTruthy();
    expect(screen.getByText("计划可能超范围")).toBeTruthy();
  });
});
