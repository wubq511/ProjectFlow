import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EvidenceRefList } from "./evidence-ref-list";

describe("EvidenceRefList", () => {
  it("renders readable evidence without exposing raw entity ids", () => {
    const { container } = render(
      <EvidenceRefList
        refs={[
          {
            entity_type: "member",
            entity_id: "user-private-123",
            field: "available_hours_per_week",
            value: "8 小时",
          },
        ]}
      />,
    );

    expect(screen.getByLabelText("结构化依据")).toBeTruthy();
    expect(screen.getByText("每周可用时间：")).toBeTruthy();
    expect(screen.getByText("8 小时")).toBeTruthy();
    expect(container.textContent).not.toContain("user-private-123");
  });

  it("renders nothing for missing evidence", () => {
    const { container } = render(<EvidenceRefList refs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
