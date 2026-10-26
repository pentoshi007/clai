import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findBunExecutable } from "../src/os/bun-runtime.js";

const bun = findBunExecutable();

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("responder UI placement", () => {
  it("keeps responder lifecycle text out of the composer StatusLine", async () => {
    const text = await source("../src/tui-v2/components/status/status-line.tsx");
    const statusLine = text.slice(text.indexOf("function StatusLine("));

    expect(statusLine).not.toContain("responderStatusText(");
    expect(statusLine).not.toContain("state.responder");
  });

  it("initializes the dedicated responder panel collapsed", async () => {
    const text = await source("../src/tui-v2/components/jobs/jobs-panel.tsx");
    const panel = text.slice(text.indexOf("function ResponderPanel("));

    expect(panel).toMatch(/const \[collapsed, setCollapsed\] = useState\(true\)/);
    expect(panel).toContain('const header = `${collapsed ? "▸" : "▾"} Responder:');
  });

  it.skipIf(!bun)("removes delivered responder results from the native composer area without consuming them", () => {
    const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./tui-v2/responder-panel.native.ts", import.meta.url))], {
      encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CLAI_NO_UPDATE_CHECK: "1", CLAI_DISABLE_KEYCHAIN: "1" },
    });
    expect(result.error, result.stderr || result.stdout).toBeUndefined();
    expect(result.signal, result.stderr || result.stdout).toBeNull();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("Native responder panel passed");
  }, 50_000);
});
