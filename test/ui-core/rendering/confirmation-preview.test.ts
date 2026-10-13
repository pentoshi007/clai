import { describe, expect, it } from "vitest";
import { confirmationPreview, wrapConfirmationText } from "../../../src/ui-core/rendering/confirmation-preview.js";
import { renderColumns } from "../../../src/ui-core/rendering/text-width.js";
import type { ConfirmRequest } from "../../../src/ui-core/controllers/overlay-controller.js";

const request: ConfirmRequest = {
  kind: "tool",
  reason: "Auto-allow requires approval when possible deletions cannot be verified to stay inside the active folder.",
  prompt: `Run shell.exec node <<'NODE'\n${Array.from({ length: 400 }, (_, i) => `  console.log(${i});`).join("\n")}\nNODE?`,
  review: { title: "Full command", body: "complete operation" },
};

describe("confirmation preview", () => {
  it("limits long commands, explains the permission exception first, and advertises the full view", () => {
    const preview = confirmationPreview(request, 76);
    expect(preview.reasonLines.join(" ")).toContain("Reason: Auto-allow");
    expect(preview.reasonLines.join(" ")).toContain("active folder");
    expect(preview.promptLines).toHaveLength(6);
    expect(preview.promptLines[0]).toContain("node <<'NODE'");
    expect(preview.promptLines.at(-1)).toContain("ctrl+o view full");
    expect(preview.hiddenPromptRows).toBeGreaterThan(390);
    expect(request.prompt).toContain("console.log(399)");
  });

  it("bounds wrapped single-line commands and preserves code indentation", () => {
    const preview = confirmationPreview({ kind: "tool", prompt: "x".repeat(10000), review: request.review }, 36, 4);
    expect(preview.promptLines).toHaveLength(4);
    expect(preview.promptLines.at(-1)).toContain("ctrl+o");
    expect(wrapConfirmationText("Run script:\n    nested_call();", 76)).toEqual(["Run script:", "    nested_call();"]);
  });

  it("keeps every preview within its row and column budget after resizing", () => {
    for (const columns of [20, 36, 76, 156]) {
      for (const maxRows of [0, 1, 2, 3, 4, 6, 9]) {
        const preview = confirmationPreview(request, columns, maxRows);
        const lines = [...preview.reasonLines, ...preview.promptLines];
        expect(lines.length).toBeLessThanOrEqual(maxRows);
        for (const line of lines) expect(renderColumns(line)).toBeLessThanOrEqual(columns);
        if (maxRows > 0) expect(preview.reasonLines[0]).toContain("Reason:");
      }
    }
  });
});
