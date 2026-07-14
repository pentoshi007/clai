import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectSlashToken,
  mentionSuggestions,
  resolveCompletionMenu,
  slashSuggestions,
} from "../../../src/tui-v2/composer/completion.js";
import { buildDefaultCommandRegistry } from "../../../src/app/commands/registry.js";

describe("detectSlashToken", () => {
  it("detects the command token while the cursor is inside it", () => {
    const token = detectSlashToken("/mod", 4);
    expect(token).toEqual({ token: "/mod", start: 0, end: 4 });
  });

  it("returns undefined once the cursor moves past the token into args", () => {
    expect(detectSlashToken("/model gpt-5", 10)).toBeUndefined();
  });

  it("returns undefined once the cursor moves to a later line", () => {
    expect(detectSlashToken("/model\nextra", 8)).toBeUndefined();
  });

  it("returns undefined when the value does not start with a slash", () => {
    expect(detectSlashToken("hello /model", 8)).toBeUndefined();
  });
});

describe("slashSuggestions", () => {
  it("suggests matching commands for the active token", () => {
    const registry = buildDefaultCommandRegistry();
    const items = slashSuggestions(registry, "/mod", 4);
    expect(items.some((c) => c.name === "model")).toBe(true);
  });

  it("returns no suggestions once the cursor leaves the token", () => {
    const registry = buildDefaultCommandRegistry();
    expect(slashSuggestions(registry, "/model x", 8)).toEqual([]);
  });
});

describe("mentionSuggestions", () => {
  it("suggests files under the base directory matching the query", () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-completion-"));
    writeFileSync(join(dir, "readme.md"), "hi");
    const match = mentionSuggestions("see @read", 9, dir);
    expect(match?.query).toBe("read");
    expect(match?.suggestions.some((s) => s.value === "readme.md")).toBe(true);
  });

  it("returns undefined when the cursor is not inside a mention", () => {
    expect(mentionSuggestions("no mentions here", 5)).toBeUndefined();
  });
});

describe("resolveCompletionMenu", () => {
  it("prefers slash suggestions when both could apply", () => {
    const registry = buildDefaultCommandRegistry();
    const menu = resolveCompletionMenu(registry, "/mod", 4);
    expect(menu.kind).toBe("slash");
  });

  it("falls back to mentions when there is no active slash token", () => {
    const registry = buildDefaultCommandRegistry();
    const dir = mkdtempSync(join(tmpdir(), "clai-completion-"));
    writeFileSync(join(dir, "notes.txt"), "hi");
    const menu = resolveCompletionMenu(registry, "look at @notes", 14, dir);
    expect(menu.kind).toBe("mention");
  });

  it("returns none when nothing matches", () => {
    const registry = buildDefaultCommandRegistry();
    expect(resolveCompletionMenu(registry, "plain text", 5).kind).toBe("none");
  });
});
