import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  return receiptAt(value.status);
}
function receiptAt(status: string): { state: string; message: string } {
  const data: unknown = JSON.parse(readFileSync(status, "utf8").replace(/^\uFEFF/, ""));
  if (!data || typeof data !== "object" || !("state" in data) || typeof data.state !== "string" || !("message" in data) || typeof data.message !== "string") throw new Error("invalid worker receipt");
  return { state: data.state, message: data.message };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!powershell)("actual PowerShell worker execution on the host", () => {
  it("promotes an actual executable, verifies it and cleans staging", async () => {
    const value = fixture();
    const receipt = await apply(value);
    expect(receipt, receipt.message).toMatchObject({ state: "applied" });
    expect(existsSync(value.stage)).toBe(false);
    expect(await runUpdateCommand({ file: value.task.destination, args: ["--version"] })).toBe(`v${version}`);
  }, 30_000);
  it.each([
    ["checksum", "checksum mismatch"],
    ["version", "version mismatch"],
    ["changed-destination", "Installation changed"],
  ] as const)("keeps the previous executable after %s rejection", async (failure, message) => {
    const value = fixture();
    let task = value.task;
    if (failure === "checksum") task = { ...task, digest: "0".repeat(64) };
    if (failure === "version") task = { ...task, version: "0.0.0" };
    if (failure === "changed-destination") writeFileSync(task.destination, "changed by another updater");
    const previous = readFileSync(task.destination);
    const receipt = await apply(value, task);
    expect(receipt, receipt.message).toMatchObject({ state: "failed", message: expect.stringContaining(message) });
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
    const receipt = await apply(value, task);
    expect(receipt, receipt.message).toMatchObject({ state });
    if (state === "failed") expect(receipt.message).toContain("Installer did not reach version");
  }, 30_000);
  it.each(["installer", "verifier"] as const)("preserves a nonzero %s exit despite valid version output", async (failure) => {
    const value = fixture();
    const successful = { file: process.execPath, args: ["--version"] };
    const failing = { file: process.execPath, args: ["-e", `console.log('${version}'); process.exit(7)`] };
    const task: WindowsUpdateTask = {
      kind: "commands", commands: failure === "installer" ? [failing] : [],
      verification: failure === "verifier" ? failing : successful, version, allowNewer: false,
    };
    const receipt = await apply(value, task);
    expect(receipt, receipt.message).toMatchObject({ state: "failed", message: expect.stringContaining("exited with status 7") });
    expect(existsSync(value.stage)).toBe(false);
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
    const receipt = await apply(value, task);
    expect(receipt, receipt.message).toMatchObject({ state: outcome === "success" ? "applied" : "failed" });
    if (outcome === "cancel") expect(receipt.message).toContain("cancelled");
    if (outcome === "failure") expect(receipt.message).toContain("exited with status 1");
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

const hasBun = process.platform === "win32" && spawnSync("bun", ["--version"], { windowsHide: true }).status === 0;

describe.skipIf(process.platform !== "win32")("native Windows staging handshake and owner exit", () => {
  for (const runtime of ["node", "standalone"] as const) {
    it.skipIf(runtime === "standalone" && !hasBun)(`acknowledges and applies after the ${runtime} owner exits`, async () => {
      const root = mkdtempSync(join(tmpdir(), "clai-stage's & %fixture%-")); roots.push(root);
      const fixturePath = resolve("test/fixtures/windows-update-stage.ts");
      const executable = join(root, "stage-fixture.exe");
      if (runtime === "standalone") {
        await runUpdateCommand({ file: "bun", args: ["build", "--compile", fixturePath, "--outfile", executable] }, { timeoutMs: 60_000 });
      }
      const command = runtime === "node"
        ? { file: process.execPath, args: ["--import", "tsx", fixturePath, root, process.execPath, version] }
        : { file: executable, args: [root, process.execPath, version] };
      const output = await runUpdateCommand({ ...command, env: { TEMP: root, TMP: root, TMPDIR: root } }, { timeoutMs: 90_000 });
      const receipt: unknown = JSON.parse(output);
      if (!receipt || typeof receipt !== "object" || !("status" in receipt) || typeof receipt.status !== "string") throw new Error("missing stage receipt");
      const status = receipt.status;
      await expect.poll(() => receiptAt(status), { timeout: 20_000 }).toMatchObject({ state: "applied" });
      expect(readFileSync(join(root, "applied.txt"), "utf8")).toBe("applied after owner exit");
      await expect.poll(() => readdirSync(root).filter((name) => name.startsWith("clai-update-stage-")), { timeout: 10_000 }).toEqual([]);
      for (const suffix of ["stdout.log", "stderr.log"]) expect(existsSync(`${status}.${suffix}`)).toBe(true);
      await expect.poll(() => {
        try {
          for (const suffix of ["stdout.log", "stderr.log"]) rmSync(`${status}.${suffix}`, { force: true });
          return true;
        } catch { return false; }
      }, { timeout: 10_000 }).toBe(true);
    }, 120_000);
  }
});
