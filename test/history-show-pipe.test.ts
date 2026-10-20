import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { findBunExecutable } from "../src/os/bun-runtime.js";

const bun = findBunExecutable();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.skipIf(!bun)("prints a whole large session to a pipe under Bun", () => {
  const dir = mkdtempSync(join(tmpdir(), "clai-history-show-"));
  dirs.push(dir);
  const messages = Array.from({ length: 2_000 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `turn ${index}` }));
  writeFileSync(join(dir, "history.jsonl"), `${JSON.stringify({
    id: "large-show",
    name: "large-show",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    messages,
  })}\n`);
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("../src/index.ts", import.meta.url)), "history", "--show", "large-show"], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      CLAI_HISTORY_DIR: dir,
      CLAI_DATA_DIR: join(dir, "data"),
      CLAI_CONFIG_DIR: join(dir, "config"),
      CLAI_NO_UPDATE_CHECK: "1",
      CLAI_DISABLE_SESSION_RUNTIME: "1",
      CLAI_NO_BUN_REEXEC: "1",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.length).toBeGreaterThan(65_536);
  expect(JSON.parse(result.stdout).messages).toEqual(messages);
}, 70_000);
