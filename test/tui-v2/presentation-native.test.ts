import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();
const cases = [
  ["jump-to-latest", "Native jump-to-latest passed"],
  ["status-navigation", "Native status navigation passed"],
  ["queue-panel", "Native queue panel passed"],
  ["toast-centered", "Native centered toasts passed"],
  ["tool-output-preview", "Native output previews passed"],
  ["tool-card-reachability", "Native tool-card reachability passed"],
  ["scroll-window-race", "Native scroll-window race passed"],
  ["wheel-latency", "Native wheel latency passed"],
  ["tool-input-pager", "Native tool input pager passed"],
  ["pager-colors", "Native pager colors passed"],
  ["prompt-layout", "Native prompt layout passed"],
] as const;

describe.skipIf(!bun)("native terminal presentation", () => {
  it.each(cases)("verifies %s across terminal widths", (name, success) => {
    const cwd = name === "jump-to-latest" ? mkdtempSync(join(tmpdir(), "clai-long-branch-")) : undefined;
    try {
      if (cwd) {
        execFileSync("git", ["init", "--quiet", "--initial-branch=regression/" + "long-branch-name-".repeat(8)], { cwd });
        execFileSync("git", [
          "-c", "user.name=clai test", "-c", "user.email=test@example.invalid",
          "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(cwd, "no-hooks")}`,
          "commit", "--quiet", "--allow-empty", "-m", "Native status fixture",
        ], { cwd });
      }
      const result = spawnSync(bun!, ["run", fileURLToPath(new URL(`./${name}.native.ts`, import.meta.url))], {
        cwd,
        encoding: "utf8",
        timeout: 45_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CLAI_NO_UPDATE_CHECK: "1", CLAI_DISABLE_KEYCHAIN: "1" },
      });
      expect(result.error).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(success);
    } finally {
      if (cwd) rmSync(cwd, { recursive: true, force: true });
    }
  }, 50_000);
});
