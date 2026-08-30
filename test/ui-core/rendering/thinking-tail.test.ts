import { describe, expect, it } from "vitest";
import {
  LIVE_THINKING_TAIL_CHARS,
  liveCompactionHeadTail,
  liveThinkingDisplay,
  liveThinkingFull,
  liveThinkingTail,
} from "../../../src/ui-core/rendering/thinking-tail.js";

describe("live thinking tail (TUI-004)", () => {
  it("passes short reasoning through untouched", () => {
    expect(liveThinkingTail("short reasoning")).toBe("short reasoning");
  });

  it("bounds the painted tail for long reasoning", () => {
    const content = `${"reasoning step\n".repeat(4_000)}final line`;
    const tail = liveThinkingTail(content);
    expect(tail.length).toBeLessThanOrEqual(LIVE_THINKING_TAIL_CHARS + 2);
    expect(tail.startsWith("…\n")).toBe(true);
    expect(tail.endsWith("final line")).toBe(true);
  });

  it("keeps the tail size constant as reasoning grows", () => {
    const shorter = liveThinkingTail("word ".repeat(2_000));
    const longer = liveThinkingTail("word ".repeat(40_000));
    expect(longer.length).toBe(shorter.length);
  });

  it("keeps both the stable head and live tail of a streaming compaction", () => {
    const content = `# Goals\n${"middle line\n".repeat(2_000)}## Remaining\n- verify`;
    const bounded = liveCompactionHeadTail(content, 120, 160);
    expect(bounded).toContain("# Goals");
    expect(bounded).toContain("streaming middle omitted");
    expect(bounded).toContain("## Remaining");
    expect(bounded).toContain("- verify");
    expect(bounded.length).toBeLessThan(400);
  });
});

describe("live thinking display (tool-surface hygiene)", () => {
  it("passes plain reasoning through", () => {
    expect(liveThinkingDisplay("short reasoning")).toBe("short reasoning");
  });

  it("hides a DSML block the model is drafting while it streams", () => {
    const content =
      "Planning the layout: rays cast from the camera.\n" +
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="fs.write">\n<｜DSML｜parameter name="path" string="true">/repo/scene.js`;
    const display = liveThinkingDisplay(content);
    expect(display).not.toContain("DSML");
    expect(display).not.toContain("fs.write");
    expect(display).toContain("Planning the layout");
  });

  it("paints only the ellipsis marker while inside a huge parameter body", () => {
    const content =
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="fs.write">\n<｜DSML｜parameter name="content" string="true">${"scene code line\n".repeat(300)}`;
    expect(liveThinkingDisplay(content)).toBe("…");
  });

  it("resumes painting once the surface closes and prose follows", () => {
    const content =
      `<｜DSML｜tool_calls><｜DSML｜invoke name="fs.list"><｜DSML｜parameter name="path" string="true">.</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>` +
      "\nNow checking the raycast math for the platform edge.";
    const display = liveThinkingDisplay(content);
    expect(display).not.toContain("DSML");
    expect(display).toContain("raycast math");
  });
});

describe("live thinking full (OpenTUI untruncated stream)", () => {
  it("passes plain reasoning through untouched", () => {
    expect(liveThinkingFull("short reasoning")).toBe("short reasoning");
  });

  it("keeps long reasoning from the first character to the last", () => {
    const content = `opening thought\n${"reasoning step\n".repeat(4_000)}final line`;
    expect(liveThinkingFull(content)).toBe(content);
  });

  it("strips a drafting tool surface without dropping earlier prose", () => {
    const content =
      "Planning the layout first.\n" +
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="fs.write">`;
    const display = liveThinkingFull(content);
    expect(display).toContain("Planning the layout first.");
    expect(display).not.toContain("DSML");
    expect(display).not.toContain("fs.write");
  });

  it("paints only the ellipsis marker while inside a huge parameter body", () => {
    const content =
      `<｜DSML｜tool_calls>\n<｜DSML｜parameter name="content" string="true">${"code line\n".repeat(300)}`;
    expect(liveThinkingFull(content)).toBe("…");
  });
});
