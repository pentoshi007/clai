import { execFile } from "node:child_process";
import { appendFileSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readdir, stat, statfs } from "node:fs/promises";
import { arch, availableParallelism, freemem, platform, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { McpManager } from "../src/mcp/manager.js";
import { McpRuntime } from "../src/mcp/runtime.js";
import { describeEngines } from "../src/rea/engine-report.js";
import { collectEngineReport } from "../src/rea/engine-status.js";
import { discardTree, engineRoots, readEngineSettings } from "../src/rea/engines.js";
import { bundlesDecompiler, currentHost, decompilerBuildTarget, installGhidra, isMuslLinux, missingBuildTools, resolveGhidraRelease } from "../src/rea/ghidra.js";
import { runReaMaintenance, reaRoot } from "../src/rea/install.js";
import { installJdk, javaVersion, resolveJdkRelease } from "../src/rea/jdk.js";
import { manageRea } from "../src/rea/runtime.js";
import { REA_SERVER } from "../src/rea/workflow.js";
import type { FetchFunction } from "../src/rea/download.js";

const run = promisify(execFile);
const token = process.env.GITHUB_TOKEN;
const label = process.env.TMP_LABEL ?? `${platform()}-${arch()}`;
const host = currentHost();
const started = performance.now();
const failures: string[] = [];
const rows: string[] = [];

const authorized: FetchFunction = (input, init) => {
  if (!token || !input.startsWith("https://api.github.com/")) return fetch(input, init);
  return fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } });
};

function note(step: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ label, step, s: Math.round((performance.now() - started) / 100) / 10, rssMb: Math.round(process.resourceUsage().maxRSS / 1024), ...data });
  writeSync(1, `${line}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded<T>(ms: number, work: () => Promise<T>): Promise<{ value?: T; error?: string; timedOut: boolean; ms: number }> {
  const begun = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    const outcome = await Promise.race([work(), timeout]);
    const elapsed = Math.round(performance.now() - begun);
    return outcome === "timeout" ? { timedOut: true, ms: elapsed } : { value: outcome, timedOut: false, ms: elapsed };
  } catch (error) {
    return { error: `${(error as NodeJS.ErrnoException).code ?? "error"}: ${(error as Error).message.slice(0, 240)}`, timedOut: false, ms: Math.round(performance.now() - begun) };
  } finally {
    clearTimeout(timer);
  }
}

async function liveProcesses(): Promise<string> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("tasklist", ["/FO", "CSV", "/NH"], { timeout: 30_000, windowsHide: true });
      const wanted = stdout.split(/\r?\n/).map((line) => line.split('","')).filter((cells) => /^"?(java|javaw|decompile|node)\.exe$/i.test(cells[0] ?? ""));
      return wanted.map((cells) => `${(cells[0] ?? "").replace(/"/g, "")}#${cells[1] ?? ""}`).join(" ") || "none";
    }
    const { stdout } = await run("ps", ["-A", "-o", "pid=,comm="], { timeout: 30_000 });
    return stdout.split("\n").filter((line) => /(java|decompile)/.test(line)).map((line) => line.trim()).join(" | ") || "none";
  } catch (error) {
    return `unavailable: ${(error as Error).message.slice(0, 120)}`;
  }
}

setTimeout(() => {
  note("watchdog", { message: "the script ran longer than 35 minutes and was stopped" });
  process.exit(3);
}, 35 * 60 * 1000).unref();

function row(step: string, ok: boolean, detail: string): void {
  rows.push(`| ${step} | ${ok ? "ok" : "FAILED"} | ${detail.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 300)} |`);
  if (!ok) failures.push(`${step}: ${detail.slice(0, 300)}`);
}

async function sizeOf(path: string): Promise<{ files: number; mb: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(full)).size;
      }
    }
  };
  await walk(path);
  return { files, mb: Math.round(bytes / 1_048_576) };
}

function progress(name: string): (event: { phase: string; message: string; receivedBytes?: number; totalBytes?: number }) => void {
  let phase = "";
  let lastTenth = -1;
  return (event) => {
    if (event.phase !== phase) {
      phase = event.phase;
      lastTenth = -1;
      note(`${name}:${phase}`, { message: event.message });
    }
    if (event.totalBytes && event.receivedBytes !== undefined) {
      const tenth = Math.floor((event.receivedBytes / event.totalBytes) * 10);
      if (tenth > lastTenth) {
        lastTenth = tenth;
        note(`${name}:progress`, { percent: tenth * 10 });
      }
    }
  };
}

async function guarded<T>(step: string, work: () => Promise<T>): Promise<T | undefined> {
  const begun = performance.now();
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    note(`${step}:error`, { message: message.slice(0, 1200) });
    row(step, false, `${message.slice(0, 250)} (${Math.round((performance.now() - begun) / 1000)}s)`);
    return undefined;
  }
}

function describePayload(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    const strings: Array<[string, string]> = [];
    const walk = (node: unknown, path: string, depth: number): void => {
      if (typeof node === "string") strings.push([path, node]);
      else if (depth < 5 && node !== null && typeof node === "object") for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`, depth + 1);
    };
    walk(value, "$", 0);
    strings.sort((left, right) => right[1].length - left[1].length);
    const longest = strings[0];
    return { keys: value !== null && typeof value === "object" ? Object.keys(value).slice(0, 12) : [], longest: longest ? { path: longest[0], chars: longest[1].length, head: longest[1].slice(0, 700) } : null };
  } catch {
    return { notJson: text.slice(0, 300) };
  }
}

async function freeGb(path: string): Promise<number> {
  const info = await statfs(path);
  return Math.round((info.bavail * info.bsize) / 1_073_741_824);
}

const work = await mkdtemp(join(tmpdir(), "clai-engines-live-"));
const workspace = join(work, "workspace");
await mkdir(workspace);
const runtime = new McpRuntime({ manager: new McpManager({ discovery: { workspaceFolder: workspace, homeDir: join(work, "home"), env: {}, platform: process.platform } }) });

try {
  note("host", {
    platform: host.platform, arch: host.arch, node: process.version, musl: isMuslLinux(), cpus: availableParallelism(),
    totalMb: Math.round(totalmem() / 1_048_576), freeMb: Math.round(freemem() / 1_048_576), freeDiskGb: await freeGb(tmpdir()),
    javaHome: process.env.JAVA_HOME ?? null, ghidraDir: process.env.GHIDRA_INSTALL_DIR ?? null, dataDir: process.env.CLAI_DATA_DIR ?? "(default ~/.clai)", reaRoot: reaRoot(),
  });
  row("host", true, `${host.platform}/${host.arch}, node ${process.version}, JAVA_HOME=${process.env.JAVA_HOME ?? "unset"}, bundled decompiler=${bundlesDecompiler(host)}`);

  const installed = await guarded("rea-install", async () => {
    const begun = performance.now();
    const result = await runReaMaintenance("install", { portableRuntime: true });
    if (!result.ok) throw new Error(result.reason);
    note("rea-install", { version: result.installation.version, ms: Math.round(performance.now() - begun) });
    row("rea-install", true, `REA ${result.installation.version} in ${Math.round((performance.now() - begun) / 1000)}s`);
    return result.installation;
  });
  if (!installed) throw new Error("REA could not be installed");

  const before = await guarded("report-before", async () => {
    const report = await collectEngineReport();
    const text = describeEngines(report);
    note("report-before", { ghidraReady: report.availability?.engines.find((e) => e.id === "ghidra")?.ready ?? null, failure: report.failure ?? null, found: report.found.length });
    console.log(text);
    row("report-before", true, `ghidra ready=${report.availability?.engines.find((e) => e.id === "ghidra")?.ready ?? "unknown"}, ambient java: ${report.availability?.engines.find((e) => e.id === "ghidra")?.reason ?? "none"}`);
    return report;
  });
  void before;

  const target = decompilerBuildTarget(host);
  let missing = await missingBuildTools(host);
  note("build-tools", { builds: !bundlesDecompiler(host), target: target?.directory ?? null, missing });
  if (!bundlesDecompiler(host) && missing.length > 0 && host.platform === "linux" && process.env.CI) {
    note("build-tools:install", { using: "apt-get", missing });
    await run("sudo", ["apt-get", "update"], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    await run("sudo", ["apt-get", "install", "-y", "build-essential", "bison"], { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
    missing = await missingBuildTools(host);
  }
  row("build-tools", missing.length === 0 || bundlesDecompiler(host), bundlesDecompiler(host) ? "decompiler ships in the Ghidra release, nothing to build" : `build target ${target?.directory}; missing: ${missing.join(", ") || "nothing"}`);

  const javaResult = await guarded("jdk", async () => {
    const resolution = await resolveJdkRelease(host, { fetch: authorized });
    if (!resolution.ok) throw new Error(resolution.reason);
    note("jdk:resolved", { name: resolution.release.name, format: resolution.release.format, mb: Math.round(resolution.release.bytes / 1_048_576) });
    const begun = performance.now();
    const result = await installJdk({ release: resolution.release, fetch: authorized, onProgress: progress("jdk") });
    if (!result.ok) throw new Error(result.reason);
    const size = await sizeOf(engineRoots().java);
    const reported = await javaVersion(result.home);
    note("jdk", { home: result.home, version: result.version, reported, ...size, ms: Math.round(performance.now() - begun) });
    if (!reported?.startsWith("21")) throw new Error(`java reported ${reported}`);
    row("jdk", true, `${resolution.release.name} -> java ${reported}; ${size.files} files, ${size.mb} MB; ${Math.round((performance.now() - begun) / 1000)}s`);
    return result;
  });
  void javaResult;

  const ghidra = await guarded("ghidra", async () => {
    const release = await resolveGhidraRelease({ fetch: authorized });
    note("ghidra:resolved", { version: release.version, mb: Math.round(release.bytes / 1_048_576) });
    const begun = performance.now();
    const result = await installGhidra({ release, fetch: authorized, onProgress: progress("ghidra") });
    if (!result.ok) throw new Error(result.reason);
    const size = await sizeOf(engineRoots().ghidra);
    note("ghidra", { dir: result.dir, built: result.built, ...size, ms: Math.round(performance.now() - begun), cpuUserS: Math.round(process.resourceUsage().userCPUTime / 1e6), cpuSysS: Math.round(process.resourceUsage().systemCPUTime / 1e6) });
    row("ghidra", true, `${result.version}, built=${result.built}; ${size.files} files, ${size.mb} MB; ${Math.round((performance.now() - begun) / 1000)}s`);
    return result;
  });
  if (!ghidra) throw new Error("Ghidra could not be installed");

  const settings = await readEngineSettings();
  note("settings", { ghidra: settings.ghidra ?? null, java: settings.java ?? null });

  const after = await guarded("report-after", async () => {
    const report = await collectEngineReport();
    console.log(describeEngines(report));
    const engine = report.availability?.engines.find((e) => e.id === "ghidra");
    note("report-after", { ghidraReady: engine?.ready ?? null, code: engine?.code ?? null, reason: engine?.reason ?? null, failure: report.failure ?? null });
    if (!engine?.ready) throw new Error(`REA does not see Ghidra as ready: ${engine?.code ?? "no report"} ${engine?.reason ?? report.failure ?? ""}`);
    row("report-after", true, "REA reports Ghidra ready with the JDK we installed, over the runner's ambient JAVA_HOME");
    return report;
  });
  void after;

  const enabled = await guarded("rea-enable", async () => {
    const begun = performance.now();
    const result = await manageRea(runtime, "enable");
    if (!result.ok) throw new Error(result.output.slice(0, 600));
    const context = runtime.promptContext({ nativeTools: true }) ?? "";
    const engineLine = /^ENGINE:.*$/m.exec(`${result.output}\n${context}`)?.[0] ?? "(no ENGINE line)";
    note("rea-enable", { ms: Math.round(performance.now() - begun), engineLine, tools: runtime.getState().activeToolCount });
    if (!/ghidra ready/i.test(engineLine)) throw new Error(`ENGINE line: ${engineLine}`);
    row("rea-enable", true, `${engineLine} (${Math.round(performance.now() - begun)}ms)`);
    return result;
  });

  if (enabled) {
    const roots = engineRoots();
    let path: string;
    if (host.platform === "win32") path = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
    else if (host.platform === "darwin") {
      const { stdout } = await run("/usr/bin/lipo", ["-archs", "/bin/ls"]);
      const archs = stdout.trim().split(/\s+/);
      const wanted = host.arch === "arm64" ? ["arm64", "arm64e"] : ["x86_64"];
      const slice = wanted.find((name) => archs.includes(name)) ?? archs[0]!;
      path = join(work, "ls-thin");
      await run("/usr/bin/lipo", ["/bin/ls", "-thin", slice, "-output", path]);
      note("target", { archs, slice });
    } else path = "/usr/bin/ls";
    const tool = (name: string): string => `mcp.${REA_SERVER}.${name}`;
    const call = async (name: string, args: Record<string, unknown>, timeoutMs = 900_000): Promise<string | undefined> => {
      const begun = performance.now();
      const result = await runtime.callTool(tool(name), args, { timeoutMs });
      note(`call:${name}`, { ok: result.ok, ms: Math.round(performance.now() - begun), chars: result.output.length, head: result.output.slice(0, 500) });
      if (!result.ok) {
        row(name, false, result.output.slice(0, 300));
        return undefined;
      }
      row(name, true, `${result.output.length} chars in ${Math.round(performance.now() - begun)}ms`);
      return result.output;
    };

    const opened = await call("open_binary", { path });
    if (opened) {
      const procedures = await call("list_procedures", {});
      const searched = await call("search_procedures", { pattern: "entry" });
      void searched;
      const named = /\bentry\b/.test(procedures ?? "") ? "entry" : /0x[0-9a-fA-F]+/.exec(procedures ?? "")?.[0];
      note("procedure-choice", { named: named ?? null });
      if (named) {
        const code = await call("procedure_pseudo_code", { procedure: named });
        if (code !== undefined) {
          const payload = describePayload(code);
          note("pseudo-code", payload);
          const body = (payload.longest as { head?: string; chars?: number } | null | undefined);
          const looksLikeCode = (body?.chars ?? 0) > 30 && /[{};]/.test(body?.head ?? "");
          row("pseudo-code-content", looksLikeCode, looksLikeCode ? `decompiled text of ${body?.chars} chars` : `no C-like text found: ${JSON.stringify(payload).slice(0, 200)}`);
        }
      } else row("procedure-choice", false, "could not choose a procedure from list_procedures output");

      note("processes-while-open", { list: await liveProcesses() });
      for (const [name, path] of [["ghidra", roots.ghidra], ["jdk", roots.java]] as const) {
        const attempt = await bounded(60_000, () => discardTree(path, { attempts: 2, delayMs: 100 }));
        const outcome = attempt.timedOut ? "TIMED OUT after 60s" : attempt.error ?? attempt.value ?? "unknown";
        note("discard-while-open", { target: name, result: outcome, ms: attempt.ms });
        const expected = process.platform === "win32" ? "busy" : "removed";
        rows.push(`| discard ${name} while a binary is open | ${outcome === expected ? "ok" : "FAILED"} | ${outcome.replace(/\|/g, "/")} in ${attempt.ms}ms (expected ${expected}) |`);
        if (outcome !== expected) failures.push(`discard ${name} while open: ${outcome}, expected ${expected}`);
      }
    }
    const disabled = await bounded(90_000, () => manageRea(runtime, "disable"));
    note("rea-disable", { ok: disabled.value?.ok ?? null, timedOut: disabled.timedOut, error: disabled.error ?? null, ms: disabled.ms });
    await sleep(2_000);
    note("processes-after-disable", { list: await liveProcesses() });
    for (const [name, path] of [["ghidra", roots.ghidra], ["jdk", roots.java]] as const) {
      const attempt = await bounded(300_000, () => discardTree(path));
      const outcome = attempt.timedOut ? "TIMED OUT after 300s" : attempt.error ?? attempt.value ?? "unknown";
      note("discard-after-stop", { target: name, result: outcome, ms: attempt.ms, remaining: await readdir(dirname(path)).catch(() => ["(gone)"]) });
      rows.push(`| discard ${name} after REA stopped | ${outcome === "removed" ? "ok" : "FAILED"} | ${outcome.replace(/\|/g, "/")} in ${attempt.ms}ms |`);
      if (outcome !== "removed") failures.push(`discard ${name} after stop: ${outcome}`);
    }
  }
} finally {
  await runtime.closeAll().catch(() => undefined);
  const usage = process.resourceUsage();
  note("done", { failures: failures.length, maxRssMb: Math.round(usage.maxRSS / 1024), cpuUserS: Math.round(usage.userCPUTime / 1e6), cpuSysS: Math.round(usage.systemCPUTime / 1e6) });
  const table = [`### ${label}`, "", "| step | result | detail |", "|---|---|---|", ...rows, "", `peak RSS of the clai process: ${Math.round(usage.maxRSS / 1024)} MB, CPU ${Math.round(usage.userCPUTime / 1e6)}s user + ${Math.round(usage.systemCPUTime / 1e6)}s system, wall ${Math.round((performance.now() - started) / 1000)}s`, ""].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
  console.log(table);
}

if (failures.length > 0) {
  console.error(`FAILED:\n${failures.join("\n")}`);
  process.exit(1);
}
