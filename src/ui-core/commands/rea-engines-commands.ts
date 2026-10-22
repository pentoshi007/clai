import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readyEngines, type ReaEngine } from "../../rea/availability.js";
import { describeEngines, engineSummary } from "../../rea/engine-report.js";
import { collectEngineReport, type EngineReport } from "../../rea/engine-status.js";
import { discardTree, engineRoots, readEngineSettings, updateEngineSettings, type EngineId } from "../../rea/engines.js";
import {
  buildToolsHelp, bundlesDecompiler, currentHost, decompilerDirectory, ghidraDiskBytes, GHIDRA_INSTALLED_BYTES, inspectGhidraDirectory,
  installGhidra, missingBuildTools, resolveGhidraRelease, GHIDRA_SERIES, type EngineHost, type EngineProgress,
} from "../../rea/ghidra.js";
import { reaRoot } from "../../rea/install.js";
import { installJdk, javaVersion, jdkDiskBytes, JDK_MAJOR, resolveJdkRelease } from "../../rea/jdk.js";
import { manageRea, reaAvailability } from "../../rea/runtime.js";
import { reaConnection } from "../../rea/connection.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { ConfirmRequest } from "../controllers/overlay-controller.js";
import type { PickerOption } from "../rendering/picker-filter.js";

const TOAST_KEY = "rea-engines";
const GIGABYTE = 1e9;
const MEGABYTE = 1e6;

export interface EngineCommandDeps {
  readonly report: typeof collectEngineReport;
  readonly resolveGhidra: typeof resolveGhidraRelease;
  readonly installGhidra: typeof installGhidra;
  readonly resolveJdk: typeof resolveJdkRelease;
  readonly installJdk: typeof installJdk;
  readonly missingTools: typeof missingBuildTools;
  readonly manage: typeof manageRea;
  readonly discard: typeof discardTree;
  readonly host: () => EngineHost;
}

export const defaultEngineDeps: EngineCommandDeps = {
  report: collectEngineReport,
  resolveGhidra: resolveGhidraRelease,
  installGhidra,
  resolveJdk: resolveJdkRelease,
  installJdk,
  missingTools: missingBuildTools,
  manage: manageRea,
  discard: discardTree,
  host: currentHost,
};

export interface EngineCommand {
  readonly verb: "status" | "install" | "use" | "remove" | "help";
  readonly engine?: EngineId | "java" | undefined;
  readonly value?: string | undefined;
  readonly error?: string | undefined;
}

const VERBS: Readonly<Record<string, EngineCommand["verb"]>> = {
  status: "status", list: "status", check: "status", install: "install", get: "install", use: "use", set: "use",
  remove: "remove", uninstall: "remove", forget: "remove", help: "help",
};
const ENGINES: Readonly<Record<string, EngineId | "java">> = {
  ghidra: "ghidra", java: "java", jdk: "java", hopper: "hopper", ida: "ida", kuna: "kuna",
};

let activeOperation: string | undefined;

export function isEnginesCommand(args: string): boolean {
  const [first, second] = args.trim().split(/\s+/);
  if (!first || !/^engines?$/i.test(first)) return false;
  return second === undefined || second in VERBS || second.toLowerCase() in VERBS;
}

export function parseEngineCommand(args: string): EngineCommand {
  const text = args.trim().replace(/^engines?\b/i, "").trim();
  if (!text) return { verb: "status" };
  const match = /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/.exec(text);
  const verb = VERBS[(match?.[1] ?? "").toLowerCase()];
  if (!match || !verb) return { verb: "help", error: `Unknown engines command: ${text.split(/\s+/)[0]}` };
  if (verb === "status" || verb === "help") return { verb };
  const engine = ENGINES[(match[2] ?? "").toLowerCase()];
  if (!engine) return { verb: "help", error: `Choose an engine: ${Object.keys(ENGINES).filter((name) => name !== "jdk").join(", ")}` };
  if (verb === "use") {
    const value = unquote(match[3] ?? "");
    return value ? { verb, engine, value } : { verb: "help", error: `Give the location: \`/rea engines use ${engine} <location>\`` };
  }
  if (verb === "install" && engine !== "ghidra" && engine !== "java") {
    return { verb: "help", error: `${engine} is not installed by clai; install it yourself, then \`/rea engines use ${engine} <location>\`` };
  }
  return { verb, engine };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2]! : trimmed;
}

export function expandPath(value: string, home = homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  return resolve(value);
}

export const ENGINE_HELP = [
  "- `/rea engines` shows which analysis engines are ready",
  "- `/rea engines install ghidra` downloads and sets up Ghidra for REA (asks first)",
  "- `/rea engines install java` downloads a portable JDK 21 for Ghidra (asks first)",
  "- `/rea engines use <engine> <location>` uses a copy you already have: ghidra, java, hopper, ida or kuna",
  "- `/rea engines remove <engine>` forgets an engine; installs made by clai are deleted after asking",
].join("\n");

function megabytes(bytes: number): string {
  return bytes >= GIGABYTE ? `${(bytes / GIGABYTE).toFixed(1)} GB` : `${Math.round(bytes / MEGABYTE)} MB`;
}

function progressToast(services: AppServices): { update: (progress: EngineProgress) => void; stop: () => void } {
  let id: ReturnType<AppServices["toast"]["info"]> | undefined;
  const show = (message: string): void => {
    id = services.toast.info(message, { key: TOAST_KEY, sticky: true });
  };
  return {
    update: (progress) => {
      const percent = progress.totalBytes && progress.receivedBytes !== undefined ? ` ${Math.min(100, Math.round(progress.receivedBytes / progress.totalBytes * 100))}%` : "";
      show(`${progress.message}${percent}…`);
    },
    stop: () => {
      if (id !== undefined) services.toast.dismiss(id);
    },
  };
}

async function adoptChange(services: AppServices, deps: EngineCommandDeps): Promise<string> {
  const { server } = reaConnection(services.mcp);
  if (!server) return "REA picks it up the next time it starts.";
  if (services.session.getState().running) return "Run /rea reconnect when the current turn finishes so REA picks it up.";
  const result = await deps.manage(services.mcp, "reconnect", {});
  return result.ok ? "REA reconnected with it (the open analysis was reset)." : `REA could not reconnect: ${result.output.split("\n")[0]}. Try /rea reconnect.`;
}

function ghidraOf(report: EngineReport): ReaEngine | undefined {
  return report.availability?.engines.find((engine) => engine.id === "ghidra");
}

async function guarded(services: AppServices, name: string, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
  if (activeOperation) {
    services.session.notice("info", `REA engines: ${activeOperation} is already running · wait for it to finish`);
    return;
  }
  activeOperation = name;
  const controller = services.interruptible.begin();
  try {
    await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) services.session.notice("info", `REA engines: ${name} cancelled · nothing was changed`);
    else services.session.notice("warn", `REA engines: ${name} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  } finally {
    activeOperation = undefined;
    services.interruptible.end(controller);
  }
}

export async function showEngines(services: AppServices, deps: EngineCommandDeps = defaultEngineDeps): Promise<void> {
  const sessionId = services.session.sessionId;
  const toast = services.toast.info("Checking REA engines…", { key: TOAST_KEY, sticky: true });
  try {
    const report = await deps.report();
    if (services.session.sessionId !== sessionId) return;
    const blocked = reaAvailability(services.mcp)?.blockedGroups ?? [];
    services.overlay.openPager("REA · Analysis engines", describeEngines(report, blocked), undefined, undefined, "force");
  } catch (error) {
    services.session.notice("warn", `REA engines check failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    services.toast.dismiss(toast);
  }
}

async function confirm(services: AppServices, request: ConfirmRequest): Promise<boolean> {
  const approved = await services.overlay.openConfirm(request);
  services.overlay.close();
  return approved;
}

const installRequest = (title: string, lines: readonly string[]): ConfirmRequest => {
  const prompt = lines.join("\n");
  return { kind: "install", prompt, review: { title, body: prompt } };
};

async function offerJava(services: AppServices, deps: EngineCommandDeps, signal: AbortSignal, why: string): Promise<boolean> {
  const host = deps.host();
  const resolution = await deps.resolveJdk(host, { signal });
  if (!resolution.ok) {
    services.session.notice("warn", resolution.reason);
    return false;
  }
  const { release } = resolution;
  const approved = await confirm(services, installRequest(`Install JDK ${JDK_MAJOR} for REA`, [
    `Install a portable JDK ${JDK_MAJOR} for Ghidra?`,
    why,
    `• Download: Eclipse Temurin ${release.name}, ${megabytes(release.bytes)}, SHA-256 verified`,
    `• Location: ${engineRoots(reaRoot()).java}, about ${megabytes(jdkDiskBytes(release))} while installing (used only by REA's server; your system Java is untouched)`,
  ]));
  if (!approved) {
    services.session.notice("info", "JDK install cancelled · nothing was downloaded");
    return false;
  }
  const toast = progressToast(services);
  try {
    const result = await deps.installJdk({ release, host, signal, onProgress: toast.update });
    if (!result.ok) {
      services.session.notice("warn", `JDK install failed: ${result.reason}`);
      return false;
    }
    return true;
  } finally {
    toast.stop();
  }
}

async function verify(services: AppServices, deps: EngineCommandDeps, signal: AbortSignal): Promise<EngineReport> {
  const toast = services.toast.info("Checking with REA…", { key: TOAST_KEY, sticky: true });
  try {
    return await deps.report({ signal });
  } finally {
    services.toast.dismiss(toast);
  }
}

export async function installGhidraFlow(services: AppServices, deps: EngineCommandDeps = defaultEngineDeps): Promise<void> {
  await guarded(services, "Ghidra install", async (signal) => {
    const host = deps.host();
    if (!decompilerDirectory(host)) {
      services.session.notice("warn", `REA supports Ghidra on macOS (x64, arm64), Linux (x64, arm64) and Windows (x64); this machine is ${host.platform}/${host.arch}.`);
      return;
    }
    const toast = progressToast(services);
    let release: Awaited<ReturnType<typeof deps.resolveGhidra>>;
    let report: EngineReport;
    let missing: string[] = [];
    try {
      toast.update({ phase: "resolving", message: "Checking the latest Ghidra release" });
      report = await deps.report({ signal });
      if (report.rea.state !== "ready") {
        services.session.notice("warn", "REA is not installed: run /rea setup first, then /rea engines install ghidra.");
        return;
      }
      if (ghidraOf(report)?.ready) {
        services.session.notice("info", `Ghidra is already ready for REA${report.settings.ghidra ? ` (${report.settings.ghidra.dir})` : ""}.`);
        return;
      }
      release = await deps.resolveGhidra({ signal });
      if (!bundlesDecompiler(host)) missing = await deps.missingTools(host);
    } finally {
      toast.stop();
    }
    signal.throwIfAborted();
    if (missing.length > 0) {
      services.session.notice("warn", `Ghidra's native decompiler has to be built on this machine and needs ${missing.join(", ")}. ${buildToolsHelp(host)}`);
      return;
    }
    const java = ghidraOf(report)?.java;
    const plan = installRequest(`Install Ghidra ${release.version} for REA`, [
      `Install Ghidra ${release.version} for REA?`,
      `• Download: github.com/NationalSecurityAgency/ghidra, ${megabytes(release.bytes)}, SHA-256 verified`,
      `• Disk: ${megabytes(ghidraDiskBytes(release))} while installing, ${megabytes(GHIDRA_INSTALLED_BYTES)} afterwards, in ${engineRoots(reaRoot()).ghidra}`,
      bundlesDecompiler(host)
        ? "• The native decompiler is included for this system"
        : `• The native decompiler is built once on this machine (${host.platform}/${host.arch}), which takes a few minutes`,
      java ? `• Java ${java} was found; Ghidra ${GHIDRA_SERIES}.x needs 21 or newer` : `• No Java was found; Ghidra needs a 64-bit JDK ${JDK_MAJOR}+ and clai can install one next`,
      "• Nothing else on your system changes; the agent never installs engines",
    ]);
    if (!await confirm(services, plan)) {
      services.session.notice("info", "Ghidra install cancelled · nothing was downloaded");
      return;
    }
    const progress = progressToast(services);
    let outcome: Awaited<ReturnType<typeof deps.installGhidra>>;
    try {
      outcome = await deps.installGhidra({ release, host, signal, onProgress: progress.update });
    } finally {
      progress.stop();
    }
    signal.throwIfAborted();
    if (!outcome.ok) {
      services.session.notice("warn", `Ghidra install failed: ${outcome.reason}`);
      return;
    }
    let after = await verify(services, deps, signal);
    let ghidra = ghidraOf(after);
    if (!ghidra?.ready && ghidra?.failed.includes("java")) {
      const installed = await offerJava(services, deps, signal, `REA reports: ${ghidra.reason ?? "no suitable JDK"}`);
      if (installed) {
        after = await verify(services, deps, signal);
        ghidra = ghidraOf(after);
      }
    }
    if (!ghidra?.ready) {
      services.session.notice("warn", `Ghidra ${outcome.version} is installed but REA does not accept it yet: ${ghidra?.reason ?? after.failure ?? "unknown reason"}. /rea engines shows the details.`);
      return;
    }
    const adopted = await adoptChange(services, deps);
    services.session.notice("info", `Ghidra ${outcome.version} is ready${outcome.built ? " (native decompiler built)" : ""}. ${adopted}`);
  });
}

export async function installJavaFlow(services: AppServices, deps: EngineCommandDeps = defaultEngineDeps): Promise<void> {
  await guarded(services, "JDK install", async (signal) => {
    if (!await offerJava(services, deps, signal, "Ghidra needs a 64-bit JDK 21 or newer. clai keeps this copy private to REA.")) return;
    const adopted = await adoptChange(services, deps);
    services.session.notice("info", `JDK ${JDK_MAJOR} installed for REA. ${adopted}`);
  });
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile(), () => false);
}

async function validate(engine: EngineId | "java", path: string, host: EngineHost): Promise<{ ok: true; note?: string } | { ok: false; reason: string }> {
  if (!isAbsolute(path)) return { ok: false, reason: `${path} is not an absolute path` };
  if (engine === "ghidra") {
    const inspection = await inspectGhidraDirectory(path, host);
    if (!inspection.ok) return { ok: false, reason: inspection.reason };
    return inspection.decompiler
      ? { ok: true }
      : { ok: true, note: `Ghidra ${inspection.version} has no native decompiler for ${host.platform}/${host.arch}; build it as described in REA's installation guide, or use /rea engines install ghidra for a ready copy.` };
  }
  if (engine === "java") {
    const version = await javaVersion(path, host.platform);
    if (!version) return { ok: false, reason: `${path} is not a JDK home (bin/java did not run)` };
    const major = Number(/^1\.(\d+)/.exec(version)?.[1] ?? /^(\d+)/.exec(version)?.[1]);
    return major >= JDK_MAJOR ? { ok: true } : { ok: false, reason: `Java ${version} is too old; Ghidra needs ${JDK_MAJOR} or newer` };
  }
  if (!await fileExists(path)) return { ok: false, reason: `${path} is not a file` };
  return { ok: true };
}

export async function useEngine(services: AppServices, engine: EngineId | "java", rawPath: string, deps: EngineCommandDeps = defaultEngineDeps): Promise<void> {
  await guarded(services, `${engine} setup`, async (signal) => {
    const path = expandPath(rawPath);
    const checked = await validate(engine, path, deps.host());
    if (!checked.ok) {
      services.session.notice("warn", `Cannot use ${engine}: ${checked.reason}`);
      return;
    }
    await updateEngineSettings((current) => {
      switch (engine) {
        case "ghidra": return { ...current, ghidra: { dir: path, managed: false } };
        case "java": return { ...current, java: { home: path, managed: false } };
        case "hopper": return { ...current, hopper: { launcher: path } };
        case "ida": return { ...current, ida: { config: path } };
        case "kuna": return { ...current, kuna: { command: path } };
      }
    }, undefined, signal);
    const after = await verify(services, deps, signal);
    const state = after.availability?.engines.find((entry) => entry.id === (engine === "java" ? "ghidra" : engine));
    const adopted = await adoptChange(services, deps);
    const outcome = state?.ready
      ? `${state.name} is ready.`
      : `Saved, but REA does not accept it yet: ${state?.reason ?? after.failure ?? "see /rea engines"}.`;
    services.session.notice(state?.ready ? "info" : "warn", `${outcome}${checked.note ? ` ${checked.note}` : ""} ${adopted}`);
  });
}

export async function removeEngine(services: AppServices, engine: EngineId | "java", deps: EngineCommandDeps = defaultEngineDeps): Promise<void> {
  await guarded(services, `${engine} removal`, async (signal) => {
    const settings = await readEngineSettings();
    const entry = engine === "java" ? settings.java : settings[engine];
    if (!entry) {
      services.session.notice("info", `No ${engine} is configured for REA.`);
      return;
    }
    const managed = "managed" in entry && entry.managed;
    const location = engine === "ghidra" ? settings.ghidra?.dir : engine === "java" ? settings.java?.home : undefined;
    const folder = managed && location ? (engine === "ghidra" ? engineRoots(reaRoot()).ghidra : engineRoots(reaRoot()).java) : undefined;
    if (folder) {
      if (reaConnection(services.mcp).server && services.session.getState().running) {
        services.session.notice("info", `REA is connected and a turn is running, so ${engine} may be in use. Run this again when the turn finishes · nothing was changed`);
        return;
      }
      const approved = await confirm(services, { kind: "reset", prompt: `Delete the ${engine} copy that clai installed?\n${folder}\nREA loses native decompilation until you install or point to an engine again.` });
      if (!approved) {
        services.session.notice("info", `${engine} kept`);
        return;
      }
    }
    await updateEngineSettings((current) => {
      const { [engine]: _removed, ...rest } = current;
      return rest;
    }, undefined, signal);
    const adopted = await adoptChange(services, deps);
    if (!folder) {
      services.session.notice("info", `${engine} removed from REA's configuration. ${adopted}`);
      return;
    }
    const problem = await deps.discard(folder).then(
      (state) => state === "busy" ? "another program is still using it" : undefined,
      (error: unknown) => error instanceof Error ? error.message.split("\n")[0] : String(error),
    );
    if (problem) {
      services.session.notice("warn", `${engine} removed from REA's configuration, but ${folder} was not deleted: ${problem}. Delete that folder yourself once nothing uses it (/rea disable stops REA). ${adopted}`);
      return;
    }
    services.session.notice("info", `${engine} removed from REA's configuration and ${folder} deleted. ${adopted}`);
  });
}

export function enginePickerOptions(services: AppServices, report?: EngineReport): PickerOption[] {
  const cached = reaAvailability(services.mcp);
  const ready = report ? readyEngines(report.availability) : readyEngines(cached);
  const summary = report ? engineSummary(report) : cached ? (ready.length > 0 ? `engine ready: ${ready.map((engine) => engine.name).join(", ")}` : "no analysis engine ready") : "checking…";
  return [
    { value: "status", label: "Engine status", icon: "◇", tone: ready.length > 0 ? "success" : "warn", description: summary },
    { value: "install-ghidra", label: "Install Ghidra", icon: "↓", tone: "accent", description: "official release, checksum verified · you confirm before anything downloads" },
    { value: "install-java", label: `Install a portable JDK ${JDK_MAJOR}`, icon: "↓", description: "only needed when Ghidra reports no usable Java" },
    { value: "help", label: "Use an engine you already have", icon: "?", description: "ghidra, java, hopper, ida or kuna · /rea engines use <engine> <location>" },
  ];
}

export function openEnginesPicker(services: AppServices, deps: EngineCommandDeps = defaultEngineDeps): void {
  const sessionId = services.session.sessionId;
  const title = "REA · Analysis engines";
  const onSelect = (value: string): void => {
    services.overlay.close();
    if (value === "status") void showEngines(services, deps);
    else if (value === "install-ghidra") void installGhidraFlow(services, deps);
    else if (value === "install-java") void installJavaFlow(services, deps);
    else if (value === "help") void handleEngineCommand(services, "help", deps);
  };
  services.overlay.openPicker({ title, twoLine: true, searchDescription: true, preserveSelection: true, options: enginePickerOptions(services) }, onSelect);
  void deps.report().then((report) => {
    const overlay = services.overlay.getState();
    if (services.session.sessionId === sessionId && overlay.kind === "picker" && overlay.onSelect === onSelect) {
      services.overlay.replacePickerOptions(enginePickerOptions(services, report), title);
    }
  }).catch(() => undefined);
}

export async function handleEngineCommand(services: AppServices, args: string, deps: EngineCommandDeps = defaultEngineDeps): Promise<void> {
  const command = parseEngineCommand(args);
  switch (command.verb) {
    case "status": await showEngines(services, deps); return;
    case "install":
      if (command.engine === "java") await installJavaFlow(services, deps);
      else await installGhidraFlow(services, deps);
      return;
    case "use": await useEngine(services, command.engine!, command.value!, deps); return;
    case "remove": await removeEngine(services, command.engine!, deps); return;
    case "help":
      services.overlay.openPager("REA · Analysis engines", `${command.error ? `${command.error}\n\n` : ""}${ENGINE_HELP}`, undefined, undefined, "force");
  }
}
