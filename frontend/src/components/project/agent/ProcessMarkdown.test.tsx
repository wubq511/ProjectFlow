/**
 * ProcessMarkdown tests — verify semantic rendering.
 *
 * ProcessMarkdown degrades headings to compact body text (<p> tags, not <h1>-<h6>)
 * since the process area should not have large visual headings.
 *
 * Strategy: mock next/dynamic to bypass lazy loading (which doesn't work in jsdom),
 * letting the real react-markdown render with ProcessMarkdown's component overrides.
 * remark-gfm is mocked as a no-op plugin since the test content doesn't need GFM.
 */
import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import React from "react";

// Mock next/dynamic: bypass lazy loading, return a wrapper that renders synchronously
vi.mock("next/dynamic", () => ({
  default: (factory: () => Promise<unknown>) => {
    // Load the module eagerly (normally dynamic does this lazily)
    let resolved: React.ComponentType<Record<string, unknown>> | null = null;
    const loadPromise = factory().then((mod: unknown) => {
      const m = mod as { default?: React.ComponentType<Record<string, unknown>> };
      resolved = m.default ?? (m as React.ComponentType<Record<string, unknown>>);
    });

    return function DynamicWrapper(props: Record<string, unknown>) {
      if (!resolved) {
        // In tests, synchronously resolve via require fallback
        try {
          const mod = require("react-markdown");
          resolved = mod.default ?? mod;
        } catch {
          // If require fails, throw the promise for Suspense
          throw loadPromise;
        }
      }
      return React.createElement(resolved!, props);
    };
  },
}));

import { ProcessMarkdown } from "./ProcessMarkdown";

// Helper: render and wait for dynamic component
async function renderPM(content: string) {
  const result = render(<ProcessMarkdown content={content} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return result;
}

describe("ProcessMarkdown semantic rendering", () => {
  it("renders ### heading as compact body text, not raw '###' source", async () => {
    const { container } = await renderPM("### 标题文本");

    // Raw markdown markers must NOT appear in rendered text
    expect(container.textContent).not.toContain("###");
    // The heading text should be present
    expect(container.textContent).toContain("标题文本");
    // ProcessMarkdown degrades h3 to <p> with compact classes
    const pElements = container.querySelectorAll("p");
    const heading = Array.from(pElements).find((p) => p.textContent === "标题文本");
    expect(heading).toBeTruthy();
    expect(heading!.className).toContain("text-[13px]");
  });

  it("renders **bold** as <strong>, not raw '**' markers", async () => {
    const { container } = await renderPM("这是**加粗**内容");

    expect(container.textContent).not.toContain("**");
    const strong = container.querySelector("strong");
    expect(strong).toBeTruthy();
    expect(strong!.textContent).toBe("加粗");
  });

  it("renders --- as <hr>, not raw '---' text", async () => {
    const { container } = await renderPM("---");

    expect(container.textContent).not.toContain("---");
    const hr = container.querySelector("hr");
    expect(hr).toBeTruthy();
  });

  it("renders tables as <table> with <th>", async () => {
    const { container } = await renderPM("| 列1 | 列2 |\n|---|---|\n| a | b |");

    const table = container.querySelector("table");
    expect(table).toBeTruthy();
    const th = container.querySelector("th");
    expect(th).toBeTruthy();
    expect(th!.textContent).toBe("列1");
    const td = container.querySelector("td");
    expect(td).toBeTruthy();
    expect(td!.textContent).toBe("a");
  });

  it("renders list items as <ul>/<li>", async () => {
    const { container } = await renderPM("- 项目一\n- 项目二");

    const ul = container.querySelector("ul");
    expect(ul).toBeTruthy();
    const lis = container.querySelectorAll("li");
    expect(lis.length).toBe(2);
    expect(lis[0].textContent).toBe("项目一");
    expect(lis[1].textContent).toBe("项目二");
  });

  it("renders inline code as <code>", async () => {
    const { container } = await renderPM("使用 `npm install` 安装");

    const code = container.querySelector("code");
    expect(code).toBeTruthy();
    expect(code!.textContent).toBe("npm install");
  });

  it("headings use compact text-[13px] classes", async () => {
    const { container } = await renderPM("### 标题");

    // h3 override degrades to <p> with compact styling
    const p = container.querySelector("p");
    expect(p).toBeTruthy();
    expect(p!.className).toContain("text-[13px]");
  });

  it("renders without crashing for various markdown inputs", async () => {
    const inputs = [
      "普通文本",
      "### 标题\n\n段落内容",
      "- 列表项1\n- 列表项2",
      "| A | B |\n|---|---|\n| 1 | 2 |",
      "---",
      "**加粗**和`代码`",
      "",
    ];
    for (const input of inputs) {
      const { unmount } = await renderPM(input);
      unmount();
    }
  });
});
