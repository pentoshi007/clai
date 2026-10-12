import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runUpdateCommand } from "../src/commands/update/process.js";
import { windowsUpdateScript, type WindowsUpdateTask } from "../src/commands/update/windows-stage.js";

const powershell = process.platform === "win32" ? "powershell.exe" : process.env.CLAI_TEST_POWERSHELL;
const roots: string[] = [];
const version = process.versions.node;
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clai-worker's & %fixture%-")); roots.push(root);
  const stage = join(root, "stage"); mkdirSync(stage);
  const source = join(root, "node-new.exe"); copyFileSync(process.execPath, source); chmodSync(source, 0o755);
  const destination = join(root, "node-active.exe"); writeFileSync(destination, "previous executable");
  const status = join(root, "receipt.json");
  const task: WindowsUpdateTask = { kind: "binary", source, destination, digest: digest(readFileSync(source)), previousDigest: digest(readFileSync(destination)), version };
  return { root, stage, status, task };
}
async function apply(value: ReturnType<typeof fixture>, task: WindowsUpdateTask = value.task, pid = 2147483647, lockFile?: string, lockToken?: string) {
  const script = join(value.stage, "apply.ps1");
  const encoded = Buffer.from(JSON.stringify({ task, stage: value.stage, status: value.status, pid, lockFile, lockToken })).toString("base64");
  writeFileSync(script, windowsUpdateScript(encoded));
  await runUpdateCommand({ file: powershell!, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script] }, { timeoutMs: 30_000 });
  const data: unknown = JSON.parse(readFileSync(value.status, "utf8").replace(/^\uFEFF/, ""));
  if (!data || typeof data !== "object" || !("state" in data) || typeof data.state !== "string" || !("message" in data) || typeof data.message !== "string") throw new Error("invalid worker receipt");
  return { state: data.state, message: data.message };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!powershell)("actual PowerShell worker execution on the host", () => {
  it("promotes an actual executable, verifies it and cleans staging", async () => {
    const value = fixture();
    expect(await apply(value)).toMatchObject({ state: "applied" });
    expect(existsSync(value.stage)).toBe(false);
    expect(await runUpdateCommand({ file: value.task.destination, args: ["--version"] })).toBe(`v${version}`);
  }, 30_000);
  it.each(["checksum", "version", "changed-destination"] as const)("keeps the previous executable after %s rejection", async (failure) => {
    const value = fixture();
    let task = value.task;
    if (failure === "checksum") task = { ...task, digest: "0".repeat(64) };
    if (failure === "version") task = { ...task, version: "0.0.0" };
    if (failure === "changed-destination") writeFileSync(task.destination, "changed by another updater");
    const previous = readFileSync(task.destination);
    expect(await apply(value, task)).toMatchObject({ state: "failed" });
    expect(readFileSync(task.destination).equals(previous)).toBe(true);
  }, 30_000);
  it.each([
    ["9.9.9-rc.2", "9.9.9-rc.10", "failed"],
    ["9.9.9-rc.10", "9.9.9-rc.2", "applied"],
    ["9.9.9-rc.2", "9.9.9", "failed"],
    ["9.9.9+build.2", "9.9.9+build.1", "applied"],
  ])("compares managed version %s with required %s", async (actual, required, state) => {
    const value = fixture();
    const task: WindowsUpdateTask = { kind: "commands", commands: [], verification: { file: process.execPath, args: ["-e", `console.log('${actual}')`] }, version: required!, allowNewer: true };
    expect(await apply(value, task)).toMatchObject({ state });
  }, 30_000);
  it.each(["cancel", "failure", "success"] as const)("runs stage cleanup after %s", async (outcome) => {
    const value = fixture();
    const marker = join(value.root, "cleanup-marker"); writeFileSync(marker, "remove");
    if (outcome === "cancel") writeFileSync(join(value.stage, "cancel"), "cancel");
    const task: WindowsUpdateTask = {
      kind: "commands", commands: outcome === "failure" ? [{ file: process.execPath, args: ["-e", "process.exit(1)"] }] : [],
      verification: { file: process.execPath, args: ["--version"] }, version, allowNewer: false,
      cleanup: { file: process.execPath, args: ["-e", `require('fs').rmSync(${JSON.stringify(marker)})`] },
    };
    expect(await apply(value, task)).toMatchObject({ state: outcome === "success" ? "applied" : "failed" });
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
  it("does not take or delete another attempt's lock", async () => {
    const value = fixture();
    const lock = join(value.root, "lock.json"); const contents = JSON.stringify({ pid: process.pid, token: "another-attempt" }); writeFileSync(lock, contents);
    const receipt = await apply(value, value.task, 2147483647, lock, "obsolete-attempt");
    expect(receipt).toMatchObject({ state: "failed", message: expect.stringContaining("lock changed") });
    expect(readFileSync(lock, "utf8")).toBe(contents);
  }, 30_000);
  it("cancels before applying and keeps the previous executable", async () => {
    const value = fixture(); writeFileSync(join(value.stage, "cancel"), "cancel");
    expect(await apply(value)).toMatchObject({ state: "failed", message: expect.stringContaining("cancelled") });
    expect(readFileSync(value.task.destination, "utf8")).toBe("previous executable");
  }, 30_000);
});
