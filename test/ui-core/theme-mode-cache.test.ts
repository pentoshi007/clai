import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("terminal theme mode cache", () => {
  let dataDir: string;

  beforeEach(() => {
    vi.resetModules();
    dataDir = mkdtempSync(join(tmpdir(), "clai-theme-mode-"));
    vi.stubEnv("CLAI_DATA_DIR", dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns nothing before a terminal has ever answered", async () => {
    const cache = await import("../../src/ui-core/bootstrap/theme-mode-cache.js");
    expect(cache.readCachedThemeMode({ TERM: "xterm-256color" })).toBeUndefined();
  });

  it("replays the last answer so a timed-out query cannot flip the theme", async () => {
    const cache = await import("../../src/ui-core/bootstrap/theme-mode-cache.js");
    const env = { TERM_PROGRAM: "gnome-terminal", TERM: "xterm-256color" };

    cache.rememberThemeMode("light", env);

    expect(cache.readCachedThemeMode(env)).toBe("light");
  });

  it("survives a process restart", async () => {
    const first = await import("../../src/ui-core/bootstrap/theme-mode-cache.js");
    const env = { TERM: "xterm-256color" };
    first.rememberThemeMode("light", env);

    vi.resetModules();
    const restored = await import(
      "../../src/ui-core/bootstrap/theme-mode-cache.js"
    );

    expect(restored.readCachedThemeMode(env)).toBe("light");
  });

  it("keeps separate answers per terminal", async () => {
    const cache = await import("../../src/ui-core/bootstrap/theme-mode-cache.js");
    const light = { TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" };
    const dark = { TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color" };

    cache.rememberThemeMode("light", light);
    cache.rememberThemeMode("dark", dark);

    expect(cache.readCachedThemeMode(light)).toBe("light");
    expect(cache.readCachedThemeMode(dark)).toBe("dark");
  });

  it("ignores an unreadable or corrupt store instead of throwing", async () => {
    const cache = await import("../../src/ui-core/bootstrap/theme-mode-cache.js");
    expect(() => cache.rememberThemeMode("dark", {})).not.toThrow();
    expect(cache.readCachedThemeMode({})).toBe("dark");
  });
});
