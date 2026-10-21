import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearStaging, engineEnvironment, engineRoots, parseEngineSettings, readEngineSettings, removeTree, stagingName, updateEngineSettings, windowsPathProblem } from "../../src/rea/engines.js";

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
      GHIDRA_INSTALL_DIR: abs("g"), JAVA_HOME: abs("j"), HOPPER_LAUNCHER_PATH: abs("h"), REA_IDA_MCP_CONFIG: abs("i.json"), REA_KUNA_COMMAND: abs("k"),
    });
    expect(engineEnvironment(settings, { GHIDRA_INSTALL_DIR: "" }).GHIDRA_INSTALL_DIR).toBe(abs("g"));
    expect(engineEnvironment({}, {})).toEqual({});
  });

  it("lets a choice made with /rea engines beat a variable already in the environment, and leaves the rest alone", () => {
    const settings = parseEngineSettings(JSON.stringify({ java: { home: abs("jdk21"), managed: true } }));
    expect(engineEnvironment(settings, { JAVA_HOME: "/usr/lib/jvm/17", GHIDRA_INSTALL_DIR: "/mine" })).toEqual({ JAVA_HOME: abs("jdk21") });
    expect(engineEnvironment({}, { JAVA_HOME: "/usr/lib/jvm/17" })).toEqual({});
  });

  it("reuses the spelling of an existing variable on Windows only, so the override replaces it", () => {
    const dir = abs("g");
    const settings = parseEngineSettings(JSON.stringify({ ghidra: { dir, managed: true } }));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(engineEnvironment(settings, { ghidra_install_dir: "C:\\mine" })).toEqual({ ghidra_install_dir: dir });
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(engineEnvironment(settings, { ghidra_install_dir: "/mine" })).toEqual({ GHIDRA_INSTALL_DIR: dir });
  });
});

describe("staging and removal helpers", () => {
  it("names staging folders short enough for Windows and unique per run", () => {
    const names = new Set(Array.from({ length: 50 }, () => stagingName()));
    expect(names.size).toBe(50);
    for (const name of names) expect(name).toMatch(/^\.s-[0-9a-f]{8}$/);
  });

  it("clears only leftovers of crashed installs, old and new style, never installed versions", async () => {
    const base = await mkdtemp(join(tmpdir(), "clai-staging-"));
    directories.push(base);
    const leftovers = [".staging-0b0e4f0e-8c6c-4a0c-9d57-2f1b5e0d9a11", ".s-deadbeef"];
    const keep = ["12.1.4", ".s-zzzz", "my-notes", ".staging-notes"];
    for (const name of [...leftovers, ...keep]) {
      await mkdir(join(base, name, "inner"), { recursive: true });
      await writeFile(join(base, name, "inner", "file"), "x");
    }
    await writeFile(join(base, ".s-feedface"), "a file, not a directory");
    await clearStaging(base);
    expect((await readdir(base)).sort()).toEqual([...keep, ".s-feedface"].sort());
    await expect(clearStaging(join(base, "missing"))).resolves.toBeUndefined();
  });

  it("removes a tree, and a missing one is not an error", async () => {
    const base = await mkdtemp(join(tmpdir(), "clai-remove-"));
    directories.push(base);
    await mkdir(join(base, "a", "b"), { recursive: true });
    await writeFile(join(base, "a", "b", "file"), "x");
    await removeTree(join(base, "a"));
    await removeTree(join(base, "a"));
    expect(await readdir(base)).toEqual([]);
  });

  it("refuses a Windows location whose deepest file would pass the path limit, and only there", () => {
    const shallow = "C:\\Users\\me\\.clai\\tools\\ghidra";
    const deep = `C:\\Users\\a-person-with-a-rather-long-name\\AppData\\Local\\Some Company\\Some Product\\clai-data-folder\\tools\\ghidra`;
    expect(windowsPathProblem("win32", shallow, 140)).toBeUndefined();
    expect(windowsPathProblem("win32", deep, 140)).toMatch(/too deep for Windows.*CLAI_DATA_DIR/);
    expect(windowsPathProblem("linux", deep, 140)).toBeUndefined();
    expect(windowsPathProblem("darwin", deep, 140)).toBeUndefined();
  });
});

