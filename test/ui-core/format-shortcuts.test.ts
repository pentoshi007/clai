import { describe, expect, it } from "vitest";
import {
  formatShortcutsReference,
  humanizeChord,
} from "../../src/ui-core/actions/format-shortcuts.js";
import { buildDefaultCommandRegistry } from "../../src/app/commands/registry.js";

describe("formatShortcutsReference", () => {
  it("humanizes common chords", () => {
    expect(humanizeChord("ctrl+u")).toBe("Ctrl+U");
    expect(humanizeChord("shift+enter")).toBe("Shift+Enter");
    expect(humanizeChord("meta+backspace")).toBe("Cmd/Meta+Backspace");
  });

  it("lists key sections and well-known bindings as markdown tables", () => {
    const body = formatShortcutsReference();
    expect(body).toMatch(/^# Keyboard shortcuts/m);
    expect(body).toMatch(/## Global/);
    expect(body).toMatch(/## Composer/);
    expect(body).toMatch(/## Transcript/);
    expect(body).toMatch(/## Pager/);
    expect(body).toContain("| Keys | Action |");
    expect(body).toMatch(/Ctrl\+C/);
    expect(body).toMatch(/Ctrl\+X/);
    expect(body).toMatch(/Ctrl\+T/);
    expect(body).toMatch(/Ctrl\+O/);
    expect(body).toMatch(/Ctrl\+D/);
    // Word + full-line kill guidance for Option vs Cmd/Ctrl
    expect(body).toMatch(/Delete previous word/i);
    expect(body).toMatch(/Delete the whole line/i);
    expect(body).toMatch(/\/shortcuts/);
    expect(body).toMatch(/\/mcp/);
    expect(body).toContain(".clai/mcp.json");
    expect(body).toMatch(/off by default/i);
  });
});

describe("/shortcuts registry", () => {
  it("is a registered slash command", () => {
    const reg = buildDefaultCommandRegistry();
    expect(reg.has("shortcuts")).toBe(true);
    expect(reg.get("shortcuts")?.description).toMatch(/keyboard/i);
  });
});
