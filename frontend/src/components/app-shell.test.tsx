import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell, setLastWorkspaceId } from "./app-shell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/demo-project-001",
}));

vi.mock("framer-motion", () => ({
  motion: {
    header: ({ children, ...props }: React.ComponentProps<"header">) => (
      <header {...props}>{children}</header>
    ),
    main: ({ children, ...props }: React.ComponentProps<"main">) => (
      <main {...props}>{children}</main>
    ),
  },
}));

describe("setLastWorkspaceId", () => {
  it("updates localStorage and dispatches same-page storage event", () => {
    const listener = vi.fn();
    window.addEventListener("storage", listener);

    setLastWorkspaceId("workspace-new");

    expect(localStorage.getItem("projectflow:last-workspace-id")).toBe("workspace-new");
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("storage", listener);
  });
});

describe("AppShell user switcher", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    localStorage.clear();
    localStorage.setItem("projectflow:last-workspace-id", "workspace-1");
    localStorage.setItem("projectflow:current-user-id", "user-lin");
    localStorage.setItem(
      "projectflow:workspace-members",
      JSON.stringify([
        { user_id: "user-lin", display_name: "Lin" },
        { user_id: "user-mia", display_name: "Mia" },
      ]),
    );
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    localStorage.clear();
  });

  it("updates the active user when a member is chosen from the dropdown", async () => {
    render(
      <AppShell>
        <div>Dashboard</div>
      </AppShell>,
    );

    expect(screen.getByRole("button", { name: /Lin/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Lin/ }));
    fireEvent.click(await screen.findByText("Mia"));

    expect(localStorage.getItem("projectflow:current-user-id")).toBe("user-mia");
    expect(screen.getByRole("button", { name: /Mia/ })).toBeTruthy();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("falls back to a valid workspace member when stored user is stale", () => {
    localStorage.setItem("projectflow:current-user-id", "user-deleted");

    render(
      <AppShell>
        <div>Dashboard</div>
      </AppShell>,
    );

    expect(screen.getByRole("button", { name: /Lin/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /选择身份/ })).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
