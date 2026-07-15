import { describe, expect, it } from "vitest";
import { renderIntroCard } from "../src/ui/intro-card.js";
import { renderIntroHeaderLines } from "../src/ui/intro-header.js";
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
    expect(stripped).toContain("AGENT MODE");
    expect(stripped).toContain("ALLOW-ALL");
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
    expect(joined).toContain("AGENT MODE");
    expect(joined).toContain("PERMISSION");
    expect(joined).toContain("ALLOW-ALL");
    expect(joined).not.toContain("confirm");
  });

  it("shared intro header lines match legacy TUI content", () => {
    const lines = renderIntroHeaderLines({
      width: 100,
      version: "1.0.0",
      mode: "agent",
      provider: "test-provider",
      model: "tencent-hy3",
      permissions: "default",
      workdir: "~/Desktop/CL",
    });
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("workdir");
    expect(joined).toContain("tencent-hy3");
    expect(joined).toContain("test-provider");
    expect(joined).toContain("AGENT MODE");
    expect(joined).toContain("PERMISSION");
    expect(joined).toContain("DEFAULT");
    expect(joined).toContain("Welcome to clai v1.0.0!");
    expect(joined).toContain("/help for commands.");
    expect(joined).toContain(
      "AI-powered terminal assistant · ask & agent modes for shell, files & security workflows",
    );
  });
});
