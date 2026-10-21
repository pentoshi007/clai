import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectEngineReport, discoverGhidra, ghidraSearchPatterns } from "../../src/rea/engine-status.js";
import { updateEngineSettings } from "../../src/rea/engines.js";
import type { EngineHost } from "../../src/rea/ghidra.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clai-engine-status-"));
  directories.push(path);
  return path;
}

const HOST: EngineHost = { platform: "linux", arch: "x64" };

async function ghidraTree(path: string, version = "12.1.4", decompiler = true): Promise<void> {
  await mkdir(join(path, "Ghidra"), { recursive: true });
  await writeFile(join(path, "Ghidra", "application.properties"), `application.version=${version}\n`);
  await mkdir(join(path, "support"), { recursive: true });
  await writeFile(join(path, "support", "analyzeHeadless"), "#!/bin/sh\n");
  if (decompiler) {
    await mkdir(join(path, "Ghidra", "Features", "Decompiler", "os", "linux_x86_64"), { recursive: true });
    await writeFile(join(path, "Ghidra", "Features", "Decompiler", "os", "linux_x86_64", "decompile"), "x");
  }
}

async function fakeRea(script: string): Promise<string> {
  const root = join(await workspace(), "tools", "rea");
  const directory = join(root, "versions", "6.7.0-test");
  await mkdir(directory, { recursive: true });
  const entry = join(directory, "rea.mjs");
  await writeFile(entry, script);
  await writeFile(join(root, "current.json"), JSON.stringify({ version: "6.7.0", node: process.execPath, entry, directory }));
  return root;
}

const PROVIDERS_SCRIPT = `
const ready = Boolean(process.env.GHIDRA_INSTALL_DIR);
console.log("update available: 6.8.0");
console.log(JSON.stringify({
  open: false,
  analysis_provider_candidates: [
    { provider: { id: "ghidra", name: "Ghidra" }, availability: ready ? { status: "available" } : { status: "unavailable", code: "not_configured", reason: "Set GHIDRA_INSTALL_DIR" } },
    { provider: { id: "hopper", name: "Hopper" }, availability: { status: "unavailable", code: "executable_missing", reason: "no launcher" } },
  ],
}));
`;

describe("engine discovery", () => {
  it("looks where each system usually puts Ghidra", () => {
    const mac = ghidraSearchPatterns({ platform: "darwin", arch: "arm64" }, "/Users/me");
    expect(mac).toEqual(expect.arrayContaining([join("/Applications", "ghidra*"), join("/Users/me", "Downloads", "ghidra_*_PUBLIC"), join("/opt/homebrew/Caskroom/ghidra", "*", "ghidra_*_PUBLIC")]));
    const linux = ghidraSearchPatterns({ platform: "linux", arch: "x64" }, "/home/me");
    expect(linux).toEqual(expect.arrayContaining([join("/opt", "ghidra*"), join("/home/me", "ghidra*"), join("/usr/share", "ghidra*")]));
    const windows = ghidraSearchPatterns({ platform: "win32", arch: "x64" }, "C:\\Users\\me", { SystemDrive: "C:", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" });
    expect(windows).toEqual(expect.arrayContaining(["C:\\ghidra*", "C:\\Program Files\\ghidra*", "C:\\Users\\me\\AppData\\Local\\Programs\\ghidra*", "C:\\Users\\me\\Downloads\\ghidra_*_PUBLIC"]));
  });

  it("finds valid installations, prefers ones with a decompiler and newer versions, and ignores the rest", async () => {
    const base = await workspace();
    await ghidraTree(join(base, "apps", "ghidra_12.1.2_PUBLIC"), "12.1.2");
    await ghidraTree(join(base, "apps", "ghidra_12.1.4_PUBLIC"), "12.1.4");
    await ghidraTree(join(base, "apps", "ghidra_nodecompiler"), "12.1.9", false);
    await ghidraTree(join(base, "apps", "ghidra_old"), "11.4.3");
    await mkdir(join(base, "apps", "ghidra_empty"), { recursive: true });
    await writeFile(join(base, "apps", "ghidra-notes.txt"), "not a directory");
    await ghidraTree(join(base, "Caskroom", "ghidra", "12.1.3", "ghidra_12.1.3_PUBLIC"), "12.1.3");
    await ghidraTree(join(base, "brew", "ghidra", "libexec"), "12.1.1");
    const found = await discoverGhidra(HOST, [
      join(base, "apps", "ghidra*"),
      join(base, "Caskroom", "ghidra", "*", "ghidra_*_PUBLIC"),
      join(base, "brew", "ghidra*"),
      join(base, "missing", "ghidra*"),
    ]);
    expect(found.map((entry) => [entry.version, entry.decompiler])).toEqual([
      ["12.1.4", true], ["12.1.3", true], ["12.1.2", true], ["12.1.1", true], ["12.1.9", false],
    ]);
    expect(found[3]!.dir).toBe(join(base, "brew", "ghidra", "libexec"));
  });

  it("finds nothing in an empty system", async () => {
    expect(await discoverGhidra(HOST, [join(await workspace(), "nothing", "ghidra*")])).toEqual([]);
  });
});

describe("engine report", () => {
  it("does not start REA when it is not installed", async () => {
    const root = join(await workspace(), "tools", "rea");
    const report = await collectEngineReport({ root, host: HOST, patterns: [] });
    expect(report).toMatchObject({ rea: { state: "missing" }, availability: undefined, failure: undefined, found: [] });
  });

  it("asks the installed REA which engines are ready, passing the engines clai manages", async () => {
    const root = await fakeRea(PROVIDERS_SCRIPT);
    const before = await collectEngineReport({ root, host: HOST, patterns: [] });
    expect(before.availability?.engines.map((engine) => [engine.id, engine.ready])).toEqual([["ghidra", false], ["hopper", false]]);
    expect(before.failure).toBeUndefined();
    await updateEngineSettings((current) => ({ ...current, ghidra: { dir: join(root, "ghidra"), managed: true } }), root);
    const after = await collectEngineReport({ root, host: HOST, patterns: [] });
    expect(after.availability?.engines.map((engine) => [engine.id, engine.ready])).toEqual([["ghidra", true], ["hopper", false]]);
    expect(after.settings.ghidra?.managed).toBe(true);
  });

  it("includes installations found on disk", async () => {
    const root = await fakeRea(PROVIDERS_SCRIPT);
    const base = await workspace();
    await ghidraTree(join(base, "ghidra_12.1.4_PUBLIC"));
    const report = await collectEngineReport({ root, host: HOST, patterns: [join(base, "ghidra*")] });
    expect(report.found.map((entry) => entry.version)).toEqual(["12.1.4"]);
  });

  it("reports why the engine list is unavailable instead of throwing", async () => {
    const crashing = await collectEngineReport({ root: await fakeRea("console.error('boom: provider probe crashed'); process.exit(3);"), host: HOST, patterns: [] });
    expect(crashing.availability).toBeUndefined();
    expect(crashing.failure).toBeTruthy();
    const garbage = await collectEngineReport({ root: await fakeRea("console.log('not json at all')"), host: HOST, patterns: [] });
    expect(garbage).toMatchObject({ availability: undefined, failure: "REA returned an unexpected provider report" });
  });
});
