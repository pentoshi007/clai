import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composerTopBorder } from "../../../src/classic/chrome/Composer.js";
import { composerFrame } from "../../../src/classic/chrome/composer-frame.js";
import { plainText } from "../../../src/classic/render/ansi-text.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { displayWidth } from "../../../src/classic/render/measure.js";

const ink = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });

function frame(columns = 80) {
  return composerFrame({
    columns,
    allocatedRows: 3,
    text: "",
    mode: "agent",
    phase: "idle",
    unicode: true,
    metaLabel: "openai · gpt-test · default",
  });
}

describe("classic composer MCP selection", () => {
  it("renders an explicitly selected server in bold aqua inside the border", () => {
    const output = composerTopBorder(ink, frame(), "docs");
    expect(output).toContain(
      ink.style(" @mcp:docs ", { fg: "inputBorder", bold: true }),
    );
    expect(plainText(output)).toContain("@mcp:docs");
    expect(displayWidth(output)).toBe(frame().width);
  });

  it("shows no MCP token when selection is off or all-live", () => {
    const output = composerTopBorder(ink, frame(), undefined);
    expect(plainText(output)).not.toContain("@mcp:");
    expect(displayWidth(output)).toBe(frame().width);
    const app = readFileSync("src/classic/app/ClassicApp.tsx", "utf8");
    expect(app).toContain('mcpState.selection.mode === "server"');
    expect(app).toContain("selectedMcpServer={selectedMcpServer}");
  });

  it("clips a long selected server without overflowing narrow composers", () => {
    const narrow = frame(24);
    const output = composerTopBorder(
      ink,
      narrow,
      "a-very-long-server-name-that-cannot-fit",
    );
    expect(plainText(output)).toContain("@mcp:");
    expect(displayWidth(output)).toBeLessThanOrEqual(narrow.width);
  });
});
