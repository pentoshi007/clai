import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activateSlashCompletion,
  detectSlashToken,
  mentionSuggestions,
  resolveCompletionMenu,
  slashSuggestions,
} from "../../../src/ui-core/composer/completion.js";
import { buildDefaultCommandRegistry } from "../../../src/app/commands/registry.js";

describe("detectSlashToken", () => {
  it("detects the command token while the cursor is inside it", () => {
    const token = detectSlashToken("/mod", 4);
    expect(token).toEqual({ token: "/mod", start: 0, end: 4 });
  });

  it("returns undefined once the cursor moves past the token into args", () => {
    expect(detectSlashToken("/model gpt-5", 10)).toBeUndefined();
  });

  it("keeps a completed token active through trailing whitespace", () => {
    expect(detectSlashToken("/model ", 7)).toEqual({ token: "/model", start: 0, end: 6 });
  });

  it("returns undefined once the cursor moves to a later line", () => {
    expect(detectSlashToken("/model\nextra", 8)).toBeUndefined();
  });

  it("detects a slash token after whitespace in the middle of a prompt", () => {
    expect(detectSlashToken("hello /model", 12)).toEqual({
      token: "/model",
      start: 6,
      end: 12,
    });
  });

  it("uses the nearest active slash token and rejects mid-word slashes", () => {
    const value = "use /skills one then /ski";
    expect(detectSlashToken(value, value.length)).toEqual({
      token: "/ski",
      start: value.lastIndexOf("/"),
      end: value.length,
    });
    expect(detectSlashToken("and/or", 6)).toBeUndefined();
  });

  it("ignores absolute path drops so they are not treated as commands", () => {
    expect(detectSlashToken("/Users/me/file.png", 10)).toBeUndefined();
    expect(detectSlashToken("/tmp/out", 5)).toBeUndefined();
  });

  it("keeps a bare slash active so the full command catalogue can show", () => {
    expect(detectSlashToken("/", 1)).toEqual({ token: "/", start: 0, end: 1 });
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

  it("keeps suggestions after completion adds a space", () => {
    const registry = buildDefaultCommandRegistry();
    expect(slashSuggestions(registry, "/model ", 7).map((item) => item.name)).toContain("model");
  });
});


describe("activateSlashCompletion", () => {
  it("returns the selected command and preserves surrounding prompt text", () => {
    const registry = buildDefaultCommandRegistry();
    const value = "build this with /ski please";
    const menu = resolveCompletionMenu(
      registry,
      value,
      value.indexOf("/ski") + 4,
    );
    expect(menu.kind).toBe("slash");
    const activated = activateSlashCompletion(menu, value, 0);
    expect(activated).toEqual({
      command: "/skills",
      value: "build this with please",
      cursorOffset: value.indexOf("/ski"),
    });
  });

  it("returns undefined when no slash match is active", () => {
    expect(
      activateSlashCompletion({ kind: "none" }, "plain prompt", 0),
    ).toBeUndefined();
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

  it("shows the full slash catalogue for a bare /", () => {
    const registry = buildDefaultCommandRegistry();
    const menu = resolveCompletionMenu(registry, "/", 1);
    expect(menu.kind).toBe("slash");
    if (menu.kind === "slash") {
      expect(menu.items.length).toBeGreaterThan(5);
      expect(menu.items.some((c) => c.name === "help")).toBe(true);
    }
  });
});

describe("CommandRegistry slash parse / looksLikeCommand", () => {
  it("resolves unique prefixes so partial commands still dispatch", () => {
    const registry = buildDefaultCommandRegistry();
    expect(registry.parse("/mod")?.name).toBe("model");
    expect(registry.parse("/imp")?.name).toBe("implement");
  });

  it("never treats filesystem paths as commands", () => {
    const registry = buildDefaultCommandRegistry();
    expect(registry.parse("/Users/me/x.png")).toBeUndefined();
    expect(registry.looksLikeCommand("/Users/me/x.png")).toBe(false);
  });

  it("flags real command-shaped input even when the name is unknown", () => {
    const registry = buildDefaultCommandRegistry();
    expect(registry.looksLikeCommand("/help")).toBe(true);
    expect(registry.looksLikeCommand("/not-a-real-cmd")).toBe(true);
    expect(registry.looksLikeCommand("hello")).toBe(false);
  });
});
