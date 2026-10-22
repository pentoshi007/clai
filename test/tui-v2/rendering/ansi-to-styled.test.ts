import { describe, expect, it } from "vitest";
import chalk from "chalk";
import { TextAttributes } from "@opentui/core";
import { ansiToStyledText } from "../../../src/tui-v2/rendering/ansi-to-styled.js";
import { renderIntroHeaderLines } from "../../../src/ui-core/rendering/intro-header.js";

describe("ansiToStyledText", () => {
  it("preserves plain text", () => {
    const st = ansiToStyledText("hello");
    expect(st.chunks).toHaveLength(1);
    expect(st.chunks[0]?.text).toBe("hello");
  });

  it.each([
    [3, 23, TextAttributes.ITALIC],
    [4, 24, TextAttributes.UNDERLINE],
    [9, 29, TextAttributes.STRIKETHROUGH],
  ])("preserves SGR %s and clears it with %s", (open, close, attribute) => {
    const styled = ansiToStyledText(`plain\x1b[${open}mstyled\x1b[${close}mplain`);
    expect(styled.chunks.map((chunk) => chunk.text)).toEqual(["plain", "styled", "plain"]);
    expect(styled.chunks[1]?.attributes).toBe(attribute);
    expect(styled.chunks[0]?.attributes ?? 0).toBe(0);
    expect(styled.chunks[2]?.attributes ?? 0).toBe(0);
  });

  it("keeps bold active when nested emphasis ends", () => {
    const styled = ansiToStyledText("\x1b[1;3mcombined\x1b[23mbold\x1b[22mplain");
    expect(styled.chunks[0]?.attributes).toBe(TextAttributes.BOLD | TextAttributes.ITALIC);
    expect(styled.chunks[1]?.attributes).toBe(TextAttributes.BOLD);
    expect(styled.chunks[2]?.attributes ?? 0).toBe(0);
  });

  it("applies defaultFg when no SGR color is present", () => {
    const st = ansiToStyledText("hello", { defaultFg: "#4ADE80" });
    expect(st.chunks[0]?.fg).toBeDefined();
  });

  it("keeps fg/bg/bold from chalk truecolor sequences", () => {
    const prev = chalk.level;
    chalk.level = 3;
    try {
      const colored = chalk.bgHex("#B45309").whiteBright.bold(" AGENT MODE ");
      const st = ansiToStyledText(colored);
      const body = st.chunks.find((c) => c.text.includes("AGENT MODE"));
      expect(body).toBeDefined();
      expect(body?.bg).toBeDefined();
      expect(body?.fg).toBeDefined();
      expect(body?.attributes && body.attributes & 1).toBeTruthy();
    } finally {
      chalk.level = prev;
    }
  });

  it("converts intro header lines into multi-chunk styled rows", () => {
    const lines = renderIntroHeaderLines({
      width: 100,
      version: "1.0.0",
      mode: "agent",
      provider: "test-provider",
      model: "test-model",
      permissions: "allow-all",
      workdir: "~/Desktop/CL",
    });
    const hasColor = lines.some((l) => l.includes("\x1b["));
    expect(hasColor).toBe(true);

    const modeLine = lines.find((l) => l.includes("AGENT MODE"));
    expect(modeLine).toBeDefined();
    const st = ansiToStyledText(modeLine!);
    expect(st.chunks.length).toBeGreaterThan(1);
    const joined = st.chunks.map((c) => c.text).join("");
    expect(joined).toContain("AGENT MODE");
    expect(st.chunks.some((c) => c.bg)).toBe(true);
  });
});
