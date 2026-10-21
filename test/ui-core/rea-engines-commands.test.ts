import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaAvailability, ReaEngine } from "../../src/rea/availability.js";
import type { EngineReport } from "../../src/rea/engine-status.js";
import { engineRoots, readEngineSettings, updateEngineSettings } from "../../src/rea/engines.js";
import type { EngineHost, GhidraRelease } from "../../src/rea/ghidra.js";
import { reaRoot } from "../../src/rea/install.js";
import type { JdkRelease } from "../../src/rea/jdk.js";
import {
  ENGINE_HELP, enginePickerOptions, expandPath, handleEngineCommand, isEnginesCommand, openEnginesPicker, parseEngineCommand,
  type EngineCommandDeps,
} from "../../src/ui-core/commands/rea-engines-commands.js";
import type { AppServices } from "../../src/ui-core/bootstrap/composition-root.js";

const directories: string[] = [];
const LINUX: EngineHost = { platform: "linux", arch: "x64" };
const MAC: EngineHost = { platform: "darwin", arch: "arm64" };

const engine = (id: string, ready: boolean, extra: Partial<ReaEngine> = {}): ReaEngine => ({
  id, name: id, ready, code: ready ? undefined : "not_configured", reason: ready ? undefined : `${id} is not configured`, failed: [], java: "21", ...extra,
});
const availability = (...engines: ReaEngine[]): ReaAvailability => ({ engines, open: new Set(), deep: new Set(), blocked: new Set(), blockedGroups: [] });
const report = (engines: ReaEngine[], host: EngineHost = LINUX, rea = true): EngineReport => ({
  rea: rea ? { state: "ready", installation: { version: "6.7.0", node: "/n", entry: "/e", directory: "/d" } } : { state: "missing" },
  settings: {}, availability: availability(...engines), failure: undefined, found: [], host,
});

const RELEASE: GhidraRelease = { version: "12.1.4", tag: "Ghidra_12.1.4_build", name: "ghidra_12.1.4_PUBLIC_20260921.zip", url: "https://github.com/x", bytes: 569_649_598, sha256: "a".repeat(64) };
const JDK: JdkRelease = { name: "jdk-21.0.12.1+1", url: "https://github.com/y", bytes: 200_073_404, sha256: "b".repeat(64), format: "tar.gz" };

let notices: Array<[string, string]>;
let confirms: string[];
let requests: Array<{ kind: string; prompt: string; review?: { title: string; body: string } }>;
let answers: boolean[];
let running: boolean;
let controller: AbortController;
let pagers: Array<[string, string]>;
let connected: boolean;
let picked: ((value: string) => void) | undefined;
let pickerOptions: Array<{ value: string }>;
let services: AppServices;

function fakeServices(): AppServices {
  return {
    session: { sessionId: "engines", notice: (level: string, text: string) => notices.push([level, text]), getState: () => ({ running }) },
    mcp: { getState: () => ({ snapshot: { statuses: connected ? [{ name: "clai-rea", status: "ready", toolCount: 3 }] : [], tools: [] }, selection: { mode: "off" } }) },
    toast: { info: vi.fn(() => 1), dismiss: vi.fn() },
    interruptible: { begin: () => controller, end: vi.fn() },
    overlay: {
      openPager: (title: string, body: string) => pagers.push([title, body]),
      openConfirm: async (request: { kind: string; prompt: string; review?: { title: string; body: string } }) => { requests.push(request); confirms.push(request.prompt); return answers.shift() ?? true; },
      close: vi.fn(),
      openPicker: (request: { options: Array<{ value: string }> }, callback: (value: string) => void) => { pickerOptions = request.options; picked = callback; },
      replacePickerOptions: (options: Array<{ value: string }>) => { pickerOptions = options; },
      getState: () => ({ kind: "picker", onSelect: picked }),
    },
  } as unknown as AppServices;
}

function deps(overrides: Partial<EngineCommandDeps> = {}): EngineCommandDeps {
  return {
    report: vi.fn(async () => report([engine("ghidra", false)])),
    resolveGhidra: vi.fn(async () => RELEASE),
    installGhidra: vi.fn(async () => ({ ok: true as const, dir: "/tools/ghidra/12.1.4", version: "12.1.4", built: false, changed: true })),
    resolveJdk: vi.fn(async () => ({ ok: true as const, release: JDK })),
    installJdk: vi.fn(async () => ({ ok: true as const, home: "/tools/jdk", version: "21.0.12", changed: true })),
    missingTools: vi.fn(async () => []),
    manage: vi.fn(async () => ({ ok: true, output: "connected", exitCode: 0 })),
    host: () => LINUX,
    ...overrides,
  } as EngineCommandDeps;
}

const last = (): string => notices.at(-1)?.[1] ?? "";

beforeEach(() => {
  notices = []; confirms = []; requests = []; answers = []; pagers = []; running = false; connected = false; picked = undefined; pickerOptions = [];
  controller = new AbortController();
  services = fakeServices();
});

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  await rm(engineRoots(reaRoot()).settings, { force: true });
  await rm(engineRoots(reaRoot()).ghidra, { recursive: true, force: true });
  await rm(engineRoots(reaRoot()).java, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clai-engines-ui-"));
  directories.push(path);
  return path;
}

describe("/rea engines parsing", () => {
  it("recognises the subcommand without hijacking ordinary tasks", () => {
    for (const text of ["engines", "engine", "ENGINES status", "engines install ghidra", "engines use ghidra /x", "engines help"]) expect(isEnginesCommand(text)).toBe(true);
    for (const text of ["engines of this application", "inspect the engines folder", "enginesx", ""]) expect(isEnginesCommand(text)).toBe(false);
  });

  it("parses verbs, engines and paths with spaces or quotes", () => {
    expect(parseEngineCommand("engines")).toEqual({ verb: "status" });
    expect(parseEngineCommand("engines list")).toEqual({ verb: "status" });
    expect(parseEngineCommand("engines install ghidra")).toEqual({ verb: "install", engine: "ghidra" });
    expect(parseEngineCommand("engines get jdk")).toEqual({ verb: "install", engine: "java" });
    expect(parseEngineCommand('engines use ghidra "/Applications/My Tools/ghidra_12.1.4_PUBLIC"')).toEqual({ verb: "use", engine: "ghidra", value: "/Applications/My Tools/ghidra_12.1.4_PUBLIC" });
    expect(parseEngineCommand("engines set hopper C:\\Program Files\\Hopper\\hopper.exe")).toEqual({ verb: "use", engine: "hopper", value: "C:\\Program Files\\Hopper\\hopper.exe" });
    expect(parseEngineCommand("engines remove kuna")).toEqual({ verb: "remove", engine: "kuna" });
    expect(parseEngineCommand("engines uninstall Ghidra")).toEqual({ verb: "remove", engine: "ghidra" });
  });

  it("explains mistakes instead of guessing", () => {
    expect(parseEngineCommand("engines frobnicate")).toMatchObject({ verb: "help", error: expect.stringContaining("Unknown engines command: frobnicate") });
    expect(parseEngineCommand("engines install")).toMatchObject({ verb: "help", error: expect.stringContaining("Choose an engine: ghidra, java, hopper, ida, kuna") });
    expect(parseEngineCommand("engines use ghidra")).toMatchObject({ verb: "help", error: expect.stringContaining("Give the location") });
    expect(parseEngineCommand("engines install hopper")).toMatchObject({ verb: "help", error: expect.stringContaining("hopper is not installed by clai") });
  });

  it("expands home-relative paths", () => {
    expect(expandPath("~/tools/ghidra", "/home/me")).toBe(join("/home/me", "tools", "ghidra"));
    expect(expandPath("~", "/home/me")).toBe("/home/me");
  });
});

describe("/rea engines status and help", () => {
  it("opens a report with the next command for each missing engine", async () => {
    await handleEngineCommand(services, "engines", deps());
    expect(pagers).toHaveLength(1);
    expect(pagers[0]![0]).toBe("REA · Analysis engines");
    expect(pagers[0]![1]).toContain("/rea engines install ghidra");
  });

  it("writes every command with a placeholder inside code so the markdown pager keeps it", () => {
    for (const line of ENGINE_HELP.split("\n")) expect(line).toMatch(/^- `\/rea engines[^`]*`/);
    expect(ENGINE_HELP).toContain("`/rea engines use <engine> <location>`");
    expect(parseEngineCommand("engines use ghidra").error).toBe("Give the location: `/rea engines use ghidra <location>`");
    expect(parseEngineCommand("engines install hopper").error).toContain("then `/rea engines use hopper <location>`");
  });

  it("shows usage for help and for mistakes", async () => {
    await handleEngineCommand(services, "engines help", deps());
    await handleEngineCommand(services, "engines bogus", deps());
    expect(pagers[0]![1]).toBe(ENGINE_HELP);
    expect(pagers[1]![1]).toContain("Unknown engines command: bogus");
    expect(pagers[1]![1]).toContain(ENGINE_HELP);
  });
});

describe("/rea engines install ghidra", () => {
  it("asks first, installs, verifies with REA and reconnects a running connection", async () => {
    const calls = deps({ report: vi.fn().mockResolvedValueOnce(report([engine("ghidra", false)])).mockResolvedValue(report([engine("ghidra", true)])) });
    connected = true;
    await handleEngineCommand(services, "engines install ghidra", calls);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain("Install Ghidra 12.1.4 for REA?");
    expect(confirms[0]).toContain("570 MB, SHA-256 verified");
    expect(requests[0]).toMatchObject({ kind: "install", review: { title: "Install Ghidra 12.1.4 for REA", body: confirms[0] } });
    expect(confirms[0].split("\n").length).toBeLessThanOrEqual(6);
    expect(confirms[0]).not.toContain("\n\n");
    expect(confirms[0]).toContain("1.6 GB while installing, 900 MB afterwards");
    expect(confirms[0]).toContain(engineRoots(reaRoot()).ghidra);
    expect(confirms[0]).toContain("The native decompiler is included for this system");
    expect(confirms[0]).toContain("Java 21 was found");
    expect(calls.installGhidra).toHaveBeenCalledOnce();
    expect(calls.manage).toHaveBeenCalledWith(services.mcp, "reconnect", {});
    expect(last()).toContain("Ghidra 12.1.4 is ready");
    expect(last()).toContain("REA reconnected");
    expect(notices.every(([level]) => level === "info")).toBe(true);
  });

  it("does not download anything unless the user confirms", async () => {
    answers = [false];
    const calls = deps();
    await handleEngineCommand(services, "engines install ghidra", calls);
    expect(calls.installGhidra).not.toHaveBeenCalled();
    expect(last()).toBe("Ghidra install cancelled · nothing was downloaded");
  });

  it("says how large the build is and which tools it needs on systems without a bundled decompiler", async () => {
    const calls = deps({ host: () => MAC, report: vi.fn(async () => report([engine("ghidra", false, { java: undefined })], MAC)) });
    await handleEngineCommand(services, "engines install ghidra", calls);
    expect(confirms[0]).toContain("built once on this machine (darwin/arm64)");
    expect(confirms[0]).toContain("No Java was found");
  });

  it("stops before downloading when the build tools are missing", async () => {
    const calls = deps({ host: () => MAC, missingTools: vi.fn(async () => ["Xcode Command Line Tools"]) });
    await handleEngineCommand(services, "engines install ghidra", calls);
    expect(calls.installGhidra).not.toHaveBeenCalled();
    expect(confirms).toEqual([]);
    expect(last()).toContain("needs Xcode Command Line Tools");
    expect(last()).toContain("xcode-select --install");
  });

  it("refuses unsupported systems, a missing REA and an engine that is already ready", async () => {
    await handleEngineCommand(services, "engines install ghidra", deps({ host: () => ({ platform: "freebsd", arch: "x64" }) }));
    expect(last()).toContain("freebsd/x64");
    await handleEngineCommand(services, "engines install ghidra", deps({ report: vi.fn(async () => report([], LINUX, false)) }));
    expect(last()).toContain("REA is not installed: run /rea setup first");
    const ready = deps({ report: vi.fn(async () => report([engine("ghidra", true)])) });
    await handleEngineCommand(services, "engines install ghidra", ready);
    expect(last()).toContain("Ghidra is already ready");
    expect(ready.resolveGhidra).not.toHaveBeenCalled();
    expect(confirms).toEqual([]);
  });

  it("reports an install failure with the reason", async () => {
    const calls = deps({ installGhidra: vi.fn(async () => ({ ok: false as const, reason: "Downloaded file checksum mismatch" })) });
    await handleEngineCommand(services, "engines install ghidra", calls);
    expect(notices.at(-1)).toEqual(["warn", "Ghidra install failed: Downloaded file checksum mismatch"]);
    expect(calls.manage).not.toHaveBeenCalled();
  });

  it("offers a private JDK when REA says Java is the problem, then verifies again", async () => {
    const noJava = engine("ghidra", false, { failed: ["java"], reason: "Update JAVA_HOME to the root of a 64-bit full JDK 21 or newer installation.", code: "runtime_missing" });
    const calls = deps({ report: vi.fn().mockResolvedValueOnce(report([engine("ghidra", false, { java: undefined })])).mockResolvedValueOnce(report([noJava])).mockResolvedValue(report([engine("ghidra", true)])) });
    await handleEngineCommand(services, "engines install ghidra", calls);
    expect(confirms).toHaveLength(2);
    expect(confirms[1]).toContain("Install a portable JDK 21 for Ghidra?");
    expect(confirms[1]).toContain("Update JAVA_HOME");
    expect(confirms[1]).toContain("your system Java is untouched");
    expect(confirms[1]).toContain("200 MB, SHA-256 verified");
    expect(requests[1]).toMatchObject({ kind: "install", review: { title: "Install JDK 21 for REA", body: confirms[1] } });
    expect(confirms[1]).not.toContain("\n\n");
    expect(calls.installJdk).toHaveBeenCalledOnce();
    expect(last()).toContain("Ghidra 12.1.4 is ready");
  });

  it("keeps Ghidra but explains what is still missing when the JDK is declined", async () => {
    answers = [true, false];
    const noJava = engine("ghidra", false, { failed: ["java"], reason: "needs a JDK" });
    const calls = deps({ report: vi.fn(async () => report([noJava])) });
    await handleEngineCommand(services, "engines install ghidra", calls);
    expect(calls.installJdk).not.toHaveBeenCalled();
    expect(notices.at(-1)![0]).toBe("warn");
    expect(last()).toContain("Ghidra 12.1.4 is installed but REA does not accept it yet: needs a JDK");
  });

  it("does not interrupt a running turn with a reconnect", async () => {
    connected = true;
    running = true;
    const calls = deps({ report: vi.fn().mockResolvedValueOnce(report([engine("ghidra", false)])).mockResolvedValue(report([engine("ghidra", true)])) });
    await handleEngineCommand(services, "engines install ghidra", calls);
    expect(calls.manage).not.toHaveBeenCalled();
    expect(last()).toContain("Run /rea reconnect when the current turn finishes");
  });

  it("reports cancellation as such and runs one operation at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls = deps({ resolveGhidra: vi.fn(async () => { await gate; return RELEASE; }) });
    const first = handleEngineCommand(services, "engines install ghidra", calls);
    await vi.waitFor(() => expect(calls.resolveGhidra).toHaveBeenCalled());
    await handleEngineCommand(services, "engines install java", calls);
    expect(last()).toContain("Ghidra install is already running");
    controller.abort(new Error("stopped"));
    release();
    await first;
    expect(last()).toBe("REA engines: Ghidra install cancelled · nothing was changed");
  });
});

describe("/rea engines install java", () => {
  it("asks, installs and tells the user how REA picks it up", async () => {
    const calls = deps();
    await handleEngineCommand(services, "engines install java", calls);
    expect(confirms[0]).toContain("Install a portable JDK 21 for Ghidra?");
    expect(calls.installJdk).toHaveBeenCalledOnce();
    expect(last()).toContain("JDK 21 installed for REA");
  });

  it("explains when no portable JDK exists for this system", async () => {
    const calls = deps({ resolveJdk: vi.fn(async () => ({ ok: false as const, reason: "No official portable JDK 21 exists for linux/arm64 (musl libc is not covered)." })) });
    await handleEngineCommand(services, "engines install java", calls);
    expect(calls.installJdk).not.toHaveBeenCalled();
    expect(notices[0]).toEqual(["warn", expect.stringContaining("musl")]);
  });
});

describe("/rea engines use", () => {
  async function fakeGhidraAt(path: string, decompiler = true): Promise<void> {
    await mkdir(join(path, "Ghidra"), { recursive: true });
    await writeFile(join(path, "Ghidra", "application.properties"), "application.version=12.1.4\n");
    await mkdir(join(path, "support"), { recursive: true });
    await writeFile(join(path, "support", "analyzeHeadless"), "#!/bin/sh\n");
    if (decompiler) {
      await mkdir(join(path, "Ghidra", "Features", "Decompiler", "os", "linux_x86_64"), { recursive: true });
      await writeFile(join(path, "Ghidra", "Features", "Decompiler", "os", "linux_x86_64", "decompile"), "x");
    }
  }

  it("saves a valid Ghidra folder, checks it with REA and reports readiness", async () => {
    const path = join(await workspace(), "ghidra");
    await fakeGhidraAt(path);
    const calls = deps({ report: vi.fn(async () => report([engine("ghidra", true)])) });
    await handleEngineCommand(services, `engines use ghidra ${path}`, calls);
    expect(await readEngineSettings()).toEqual({ ghidra: { dir: path, managed: false } });
    expect(last()).toContain("ghidra is ready.");
  });

  it("warns when the folder has no native decompiler for this machine", async () => {
    const path = join(await workspace(), "ghidra");
    await fakeGhidraAt(path, false);
    await handleEngineCommand(services, `engines use ghidra ${path}`, deps({ report: vi.fn(async () => report([engine("ghidra", false, { reason: "native decompiler missing" })])) }));
    expect(notices.at(-1)![0]).toBe("warn");
    expect(last()).toContain("Saved, but REA does not accept it yet: native decompiler missing");
    expect(last()).toContain("has no native decompiler for linux/x64");
  });

  it("refuses paths that are not what they claim to be and saves nothing", async () => {
    const base = await workspace();
    await writeFile(join(base, "file.txt"), "x");
    await handleEngineCommand(services, "engines use ghidra relative/path", deps());
    expect(last()).toContain(`${join(process.cwd(), "relative", "path")} is not an extracted Ghidra release`);
    await handleEngineCommand(services, `engines use ghidra ${base}`, deps());
    expect(last()).toContain("not an extracted Ghidra release");
    await handleEngineCommand(services, `engines use hopper ${join(base, "missing")}`, deps());
    expect(last()).toContain("is not a file");
    await handleEngineCommand(services, `engines use java ${base}`, deps());
    expect(last()).toContain("is not a JDK home");
    expect(await readEngineSettings()).toEqual({});
  });

  it("records file-based engines once they exist", async () => {
    const base = await workspace();
    for (const name of ["hopper", "ida.json", "kuna"]) await writeFile(join(base, name), "x");
    const calls = deps({ report: vi.fn(async () => report([engine("hopper", true), engine("ida", true), engine("kuna", true)])) });
    await handleEngineCommand(services, `engines use hopper ${join(base, "hopper")}`, calls);
    await handleEngineCommand(services, `engines use ida ${join(base, "ida.json")}`, calls);
    await handleEngineCommand(services, `engines use kuna ${join(base, "kuna")}`, calls);
    expect(await readEngineSettings()).toEqual({ hopper: { launcher: join(base, "hopper") }, ida: { config: join(base, "ida.json") }, kuna: { command: join(base, "kuna") } });
  });

  it.skipIf(process.platform === "win32")("accepts a JDK 21 and rejects an older one", async () => {
    const base = await workspace();
    for (const [name, version] of [["jdk21", "21.0.2"], ["jdk8", "1.8.0_402"], ["jdk19", "19.0.2"]] as const) {
      await mkdir(join(base, name, "bin"), { recursive: true });
      await writeFile(join(base, name, "bin", "java"), `#!/bin/sh\necho 'openjdk version "${version}" 2026-01-01' >&2\n`);
      await chmod(join(base, name, "bin", "java"), 0o755);
    }
    await handleEngineCommand(services, `engines use java ${join(base, "jdk8")}`, deps());
    expect(last()).toContain("Java 1.8.0_402 is too old");
    await handleEngineCommand(services, `engines use java ${join(base, "jdk19")}`, deps());
    expect(last()).toContain("Java 19.0.2 is too old");
    await handleEngineCommand(services, `engines use java ${join(base, "jdk21")}`, deps({ report: vi.fn(async () => report([engine("ghidra", true)])) }));
    expect(await readEngineSettings()).toEqual({ java: { home: join(base, "jdk21"), managed: false } });
  });
});

describe("/rea engines remove", () => {
  it("forgets a user-supplied engine without touching its files", async () => {
    const base = await workspace();
    await writeFile(join(base, "kuna"), "x");
    await updateEngineSettings((current) => ({ ...current, kuna: { command: join(base, "kuna") } }));
    await handleEngineCommand(services, "engines remove kuna", deps());
    expect(confirms).toEqual([]);
    expect(await readEngineSettings()).toEqual({});
    expect(last()).toContain("kuna removed from REA's configuration");
    expect((await stat(join(base, "kuna"))).isFile()).toBe(true);
  });

  it("deletes a managed install only after confirmation", async () => {
    const roots = engineRoots(reaRoot());
    const install = join(roots.ghidra, "12.1.4");
    await mkdir(install, { recursive: true });
    await writeFile(join(install, "marker"), "x");
    await updateEngineSettings((current) => ({ ...current, ghidra: { dir: install, managed: true, version: "12.1.4" } }));
    answers = [false];
    await handleEngineCommand(services, "engines remove ghidra", deps());
    expect(last()).toBe("ghidra kept");
    expect((await readEngineSettings()).ghidra).toBeDefined();
    answers = [true];
    await handleEngineCommand(services, "engines remove ghidra", deps());
    expect(confirms.at(-1)).toContain("Delete the ghidra copy that clai installed?");
    expect(requests.at(-1)).toMatchObject({ kind: "reset" });
    expect(await readEngineSettings()).toEqual({});
    await expect(stat(install)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("says so when nothing is configured", async () => {
    await handleEngineCommand(services, "engines remove ida", deps());
    expect(last()).toBe("No ida is configured for REA.");
  });
});

describe("/rea engines picker", () => {
  it("offers status, Ghidra, a JDK and a pointer to existing installs, and routes each choice", async () => {
    const calls = deps();
    openEnginesPicker(services, calls);
    expect(pickerOptions.map((option) => option.value)).toEqual(["status", "install-ghidra", "install-java", "help"]);
    await vi.waitFor(() => expect(calls.report).toHaveBeenCalled());
    picked!("help");
    await vi.waitFor(() => expect(pagers).toHaveLength(1));
    picked!("status");
    await vi.waitFor(() => expect(pagers).toHaveLength(2));
    picked!("install-java");
    await vi.waitFor(() => expect(calls.installJdk).toHaveBeenCalled());
    await vi.waitFor(() => expect(notices.some(([, text]) => text.includes("JDK 21 installed"))).toBe(true));
    picked!("install-ghidra");
    await vi.waitFor(() => expect(calls.installGhidra).toHaveBeenCalled());
  });

  it("summarises readiness from the latest check", () => {
    const ready = enginePickerOptions(services, report([engine("ghidra", true)])) as unknown as Array<{ value: string; tone?: string; description: string }>;
    expect(ready[0]).toMatchObject({ value: "status", tone: "success", description: "engine ready: Ghidra" });
    const none = enginePickerOptions(services, report([engine("ghidra", false)])) as unknown as Array<{ tone?: string; description: string }>;
    expect(none[0]).toMatchObject({ tone: "warn", description: "no analysis engine ready · /rea engines" });
  });
});
