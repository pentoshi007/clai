import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineEnvironment, engineRoots, parseEngineSettings, readEngineSettings, updateEngineSettings } from "../../src/rea/engines.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "clai-engines-"));
  directories.push(base);
  return join(base, "tools", "rea");
}

const abs = (...parts: string[]): string => join(process.platform === "win32" ? "C:\\" : "/", ...parts);

describe("REA engine settings", () => {
  it("keeps managed installs beside the REA root rather than inside its releases", async () => {
    const path = await root();
    const roots = engineRoots(path);
    expect(roots.settings).toBe(join(path, "engines.json"));
    expect(roots.ghidra).toBe(join(dirname(path), "ghidra"));
    expect(roots.java).toBe(join(dirname(path), "jdk"));
  });

  it("round-trips settings and ignores everything unsafe or malformed", () => {
    const settings = parseEngineSettings(JSON.stringify({
      v: 1,
      ghidra: { dir: abs("opt", "ghidra"), managed: true, version: "12.1.4" },
      java: { home: abs("jdk"), managed: false, version: "bad version!" },
      hopper: { launcher: "relative/hopper" },
      ida: { config: abs("ida.json") },
      kuna: { command: 42 },
      extra: { anything: true },
    }));
    expect(settings).toEqual({
      ghidra: { dir: abs("opt", "ghidra"), managed: true, version: "12.1.4" },
      java: { home: abs("jdk"), managed: false },
      ida: { config: abs("ida.json") },
    });
    for (const text of ["", "not json", "[]", "null", '{"ghidra":"x"}', JSON.stringify({ ghidra: { dir: `${abs("a")}\0b` } })]) {
      expect(parseEngineSettings(text)).toEqual({});
    }
  });

  it("writes atomically with private permissions and merges updates", async () => {
    const path = await root();
    expect(await readEngineSettings(path)).toEqual({});
    await updateEngineSettings((current) => ({ ...current, ghidra: { dir: abs("g"), managed: true, version: "12.1.4" } }), path);
    await updateEngineSettings((current) => ({ ...current, hopper: { launcher: abs("h") } }), path);
    expect(await readEngineSettings(path)).toEqual({ ghidra: { dir: abs("g"), managed: true, version: "12.1.4" }, hopper: { launcher: abs("h") } });
    const text = JSON.parse(await readFile(join(path, "engines.json"), "utf8")) as Record<string, unknown>;
    expect(text.v).toBe(1);
    if (process.platform !== "win32") expect((await stat(join(path, "engines.json"))).mode & 0o777).toBe(0o600);
    expect((await readdir(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await updateEngineSettings(({ ghidra: _removed, ...rest }) => rest, path);
    expect(await readEngineSettings(path)).toEqual({ hopper: { launcher: abs("h") } });
  });

  it("recovers from a corrupt settings file by starting empty", async () => {
    const path = await root();
    await updateEngineSettings(() => ({ kuna: { command: abs("k") } }), path);
    await writeFile(join(path, "engines.json"), "{ truncated");
    expect(await readEngineSettings(path)).toEqual({});
  });

  it("maps settings to the environment REA reads without overriding what the user exported", () => {
    const settings = parseEngineSettings(JSON.stringify({
      ghidra: { dir: abs("g"), managed: true }, java: { home: abs("j"), managed: true },
      hopper: { launcher: abs("h") }, ida: { config: abs("i.json") }, kuna: { command: abs("k") },
    }));
    expect(engineEnvironment(settings, {})).toEqual({
      GHIDRA_INSTALL_DIR: abs("g"), JAVA_HOME: abs("j"), HOPPER_LAUNCHER_PATH: abs("h"), REA_IDA_MCP_CONFIG: abs("i.json"), REA_KUNA_COMMAND: abs("k"),
    });
    expect(engineEnvironment(settings, { GHIDRA_INSTALL_DIR: "/mine", JAVA_HOME: "/my-jdk" })).toEqual({
      HOPPER_LAUNCHER_PATH: abs("h"), REA_IDA_MCP_CONFIG: abs("i.json"), REA_KUNA_COMMAND: abs("k"),
    });
    expect(engineEnvironment(settings, { GHIDRA_INSTALL_DIR: "" }).GHIDRA_INSTALL_DIR).toBe(abs("g"));
    expect(engineEnvironment({}, {})).toEqual({});
  });

  it("treats environment names case-insensitively on Windows only", () => {
    const settings = parseEngineSettings(JSON.stringify({ ghidra: { dir: abs("g"), managed: true } }));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(engineEnvironment(settings, { ghidra_install_dir: "C:\\mine" })).toEqual({});
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(engineEnvironment(settings, { ghidra_install_dir: "/mine" })).toEqual({ GHIDRA_INSTALL_DIR: abs("g") });
  });
});
