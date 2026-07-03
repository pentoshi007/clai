import { describe, expect, it } from "vitest";
import { renderIntroCard } from "../src/ui/intro-card.js";
import { renderTranscriptLines } from "../src/tui/render-lines.js";
import type { TuiState } from "../src/tui/state.js";

function stripAnsi(text: string): string {
  // biome-ignore lint: ANSI escape sequences are intentional in renderer output.
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("intro card", () => {
  it("renders permissions status in classic REPL intro card", () => {
    const output = renderIntroCard({
      version: "1.0.0",
      workdir: "/test-dir",
      model: "test-model",
      provider: "test-provider",
      mode: "agent",
      permissions: "allow-all",
    });
    const stripped = stripAnsi(output);
    expect(stripped).toContain("AGENT MODE      ALLOW-ALL PERMISSION");
    expect(stripped).not.toContain("permissions:");
  });

  it("renders permissions status in TUI intro header card", () => {
    const mockState: TuiState = {
      items: [],
      scroll: 0,
      thinkingExpanded: false,
      outputExpanded: false,
      status: { running: false },
      composing: { value: "", lines: [] },
      selection: null,
      overlay: { kind: "none" },
    };
    const lines = renderTranscriptLines(mockState, {
      width: 80,
      thinkingExpanded: false,
      outputExpanded: false,
      running: false,
      version: "1.0.0",
      mode: "agent",
      provider: "test-provider",
      model: "test-model",
      permissions: "allow-all",
    });
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("AGENT MODE      ALLOW-ALL PERMISSION");
    expect(joined).not.toContain("confirm");
  });
});
