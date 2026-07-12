import { describe, expect, it } from "vitest";

import { resolveAgentActorId } from "@/lib/agent-identity";

describe("resolveAgentActorId", () => {
  it("returns the selected workspace member identity", () => {
    expect(resolveAgentActorId("user-1")).toBe("user-1");
  });

  it.each([undefined, null, "", "   "])(
    "fails closed when no valid actor is selected (%s)",
    (value) => {
      expect(resolveAgentActorId(value)).toBeNull();
    },
  );
});
