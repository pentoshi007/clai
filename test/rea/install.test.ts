import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectRea, reaMaintenance, runReaMaintenance } from "../../src/rea/install.js";
import { resolveReaNode, runReaNode } from "../../src/rea/node.js";
import type { ReaInstallation } from "../../src/rea/types.js";

vi.mock("../../src/rea/node.js", () => ({ resolveReaNode: vi.fn(), runReaNode: vi.fn() }));

let root: string;
let releaseVersion = "6.7.0";
const packageBytes = Buffer.from("verified package tarball");
const fetchMock = vi.fn();
const node = vi.mocked(runReaNode);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clai-rea-install-"));
  releaseVersion = "6.7.0";
  vi.mocked(resolveReaNode).mockResolvedValue({ node: process.execPath, npm: join(root, "npm-cli.js") });
  node.mockReset();
  node.mockImplementation(async (_node, args, options) => {
    if (args[1] === "install" && options?.cwd) {
      const entry = join(options.cwd, "node_modules", "rea-agents", "scripts", "rea.mjs");
      await mkdir(join(options.cwd, "node_modules", "rea-agents", "scripts"), { recursive: true });
      await writeFile(entry, "rea");
      return "installed";
    }
    return releaseVersion;
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: URL) => new Response(url.pathname.endsWith(".tgz") ? packageBytes : JSON.stringify({
    name: "rea-agents", version: releaseVersion,
    dist: { tarball: `https://registry.npmjs.org/rea-agents/-/rea-agents-${releaseVersion}.tgz`, integrity: `sha512-${createHash("sha512").update(packageBytes).digest("base64")}` },
  })));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

async function seed(version = "6.6.0"): Promise<ReaInstallation> {
  const directory = join(root, "versions", "previous");
  await mkdir(directory, { recursive: true });
  const entry = join(directory, "rea.mjs");
  await writeFile(entry, "rea");
  const installation = { version, directory, entry, node: process.execPath };
  await writeFile(join(root, "current.json"), JSON.stringify(installation));
  return installation;
}

describe("managed REA installation", () => {
  it("installs the verified exact package privately without npm/npx on PATH", async () => {
    const result = await runReaMaintenance("install", { root });
    expect(result.ok).toBe(true);
    expect(await detectRea(root)).toMatchObject({ state: "ready", installation: { version: "6.7.0" } });
    const call = node.mock.calls.find((entry) => entry[1][1] === "install")!;
    expect(call[1]).toEqual(expect.arrayContaining(["--ignore-scripts", "--engine-strict", "--registry=https://registry.npmjs.org"]));
    expect(call[0]).toBe(process.execPath);
    expect(reaMaintenance(root)).toBeUndefined();
  });

  it("keeps an already installed version usable without fetching metadata", async () => {
    const previous = await seed("6.7.0");
    const result = await runReaMaintenance("install", { root });
    expect(result).toEqual({ ok: true, changed: false, installation: previous });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent maintenance rather than launching two installers", async () => {
    const first = runReaMaintenance("install", { root });
    expect(runReaMaintenance("update", { root })).toBe(first);
    expect(reaMaintenance(root)?.action).toBe("install");
    await first;
    expect(node.mock.calls.filter((entry) => entry[1][1] === "install")).toHaveLength(1);
  });

  it("atomically updates while retaining the prior installation for active servers", async () => {
    const previous = await seed();
    node.mockImplementationOnce(async () => "6.6.0");
    const result = await runReaMaintenance("update", { root });
    expect(result).toMatchObject({ ok: true, changed: true, installation: { version: "6.7.0" } });
    expect(await readFile(previous.entry, "utf8")).toBe("rea");
    expect((await detectRea(root))).toMatchObject({ installation: { version: "6.7.0" } });
  });

  it("does not replace a working installation when package installation fails", async () => {
    const previous = await seed();
    node.mockImplementationOnce(async () => "6.6.0").mockRejectedValueOnce(new Error("network failure"));
    expect(await runReaMaintenance("update", { root })).toMatchObject({ ok: false, reason: expect.stringContaining("network failure") });
    expect(await detectRea(root)).toEqual({ state: "ready", installation: previous });
    expect(await readdir(join(root, "versions"))).toEqual(["previous"]);
  });

  it("does not publish a package whose launcher reports the wrong version", async () => {
    node.mockImplementationOnce(async () => "installed").mockResolvedValueOnce("1.0.0");
    expect(await runReaMaintenance("install", { root })).toMatchObject({ ok: false, reason: expect.stringContaining("verification failed") });
    expect(await detectRea(root)).toEqual({ state: "missing" });
  });

  it("rejects tampered downloads before running npm", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ name: "rea-agents", version: "6.7.0", dist: { tarball: "https://registry.npmjs.org/rea-agents/-/rea.tgz", integrity: `sha512-${Buffer.alloc(64).toString("base64")}` } })));
    expect(await runReaMaintenance("install", { root })).toMatchObject({ ok: false, reason: expect.stringContaining("checksum mismatch") });
    expect(node).not.toHaveBeenCalled();
  });

  it("reports broken manifests and missing files with a repair action", async () => {
    await writeFile(join(root, "current.json"), "invalid");
    expect(await detectRea(root)).toMatchObject({ state: "broken", reason: expect.stringContaining("/rea install") });
    await seed();
    const status = await detectRea(root);
    expect(status.state).toBe("ready");
    if (status.state === "ready") await rm(status.installation.entry);
    expect(await detectRea(root)).toMatchObject({ state: "broken" });
  });

  it("cancels without changing the current installation", async () => {
    const signal = AbortSignal.abort();
    expect(await runReaMaintenance("install", { root, signal })).toMatchObject({ ok: false });
    await expect(access(join(root, "current.json"))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
