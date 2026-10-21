#!/usr/bin/env node

 // Prefer Bun for `npm run dev` so OpenTUI's native FFI loads.
 // Falls back to tsx with a clear warning when Bun is missing.
 
import { spawnSync, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extra = process.argv.slice(2);

function findBun() {
  const fromEnv = process.env.BUN_INSTALL
    ? join(
        process.env.BUN_INSTALL,
        "bin",
        process.platform === "win32" ? "bun.exe" : "bun",
      )
    : undefined;
  const names = process.platform === "win32" ? ["bun.exe"] : ["bun"];
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = [
    fromEnv,
    ...dirs.flatMap((d) => names.map((n) => join(d, n))),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return undefined;
}

const bun = findBun();
const entry = join(root, "src", "index.ts");

if (bun && process.env.CLAI_FORCE_NODE !== "1") {
  const result = spawnSync(bun, ["run", entry, ...extra], {
    stdio: "inherit",
    cwd: root,
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

console.error(
  "warning: Bun not found — OpenTUI will not start under tsx/Node.\n" +
    "  Install Bun (https://bun.sh) then: npm run dev\n" +
    "  Or force classic REPL: npm run dev -- --classic\n" +
    "  Starting with tsx anyway…\n",
);

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsx", entry, ...extra],
  {
    stdio: "inherit",
    cwd: root,
    env: process.env,
    shell: process.platform === "win32",
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
