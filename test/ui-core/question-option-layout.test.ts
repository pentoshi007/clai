import { describe, expect, it } from "vitest";
import { questionOptionLines } from "../../src/ui-core/question/option-layout.js";

describe("question option layout", () => {
  it("keeps a short option and its description on one line", () => {
    expect(questionOptionLines({ prefix: "1. ", label: "Postgres", description: "Already provisioned", width: 60 })).toEqual([
      { label: "1. Postgres", description: " — Already provisioned" },
    ]);
  });

  it("wraps long labels and descriptions under the option number without dropping text", () => {
    const label = "Use a dedicated Postgres schema per tenant with row level security enabled everywhere";
    const description = "Strong isolation, but migrations must run once per tenant which slows deploys";
    const lines = questionOptionLines({ prefix: "1. ", label, description, width: 40 });
    expect(lines.every((line) => (line.label + line.description).length <= 40)).toBe(true);
    expect(lines[0]!.label.startsWith("1. Use a dedicated")).toBe(true);
    expect(lines.slice(1).every((line) => line.label.startsWith("   "))).toBe(true);
    const labelText = lines.filter((line) => !line.description).map((line) => line.label.trim()).join(" ");
    const descriptionText = lines.filter((line) => line.description).map((line) => line.description.trim()).join(" ");
    expect(labelText).toBe(`1. ${label}`);
    expect(descriptionText).toBe(description);
  });
});
