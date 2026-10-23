import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectInstallMethod, installViaPackageManager } from "../src/commands/update-install.js";
import { runUpdateCommand } from "../src/commands/update/process.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function packageArchive(root: string, version: string, name = "@pentoshi/clai"): { archive: Buffer; filename: string; manifest: { name: string; version: string; bin: Record<string, string> } } {
  const dir = join(root, `package-${name.replace(/[@/]/g, "-")}-${version}`); mkdirSync(join(dir, "bin"), { recursive: true });
  const manifest = { name, version, bin: { [name === "@pentoshi/clai" ? "clai" : "sibling-fixture"]: "bin/clai.mjs" } };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "bin", "clai.mjs"), `#!/usr/bin/env node\nconsole.log(process.argv.includes('--probe')?JSON.stringify({argv1:process.argv[1],execPath:process.execPath}):'${version}');\n`, { mode: 0o755 });
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const list: unknown = JSON.parse(output);
  const entries: unknown[] = Array.isArray(list) ? list : Object.values(list ?? {});
  const entry = entries[0];
  if (!entry || typeof entry !== "object" || !("filename" in entry) || typeof entry.filename !== "string") throw new Error("invalid package fixture output");
  return { archive: readFileSync(join(root, entry.filename)), filename: entry.filename, manifest };
}

async function registry(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const packages = [packageArchive(root, "4.14.4"), packageArchive(root, "9.9.9"), packageArchive(root, "1.0.0", "clai-updater-sibling-fixture"), packageArchive(root, "2.0.0", "clai-updater-sibling-fixture")];
  let url = "";
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const binary = packages.find((entry) => path === `/${entry.filename}`);
    if (binary) { response.writeHead(200, { "content-type": "application/octet-stream", "content-length": binary.archive.length }); response.end(binary.archive); return; }
    const group = packages.filter((entry) => path === `/${entry.manifest.name}`);
    if (group.length === 0) { response.writeHead(404); response.end(); return; }
    const versions = Object.fromEntries(group.map((entry) => [entry.manifest.version, { ...entry.manifest, dist: { tarball: `${url}/${entry.filename}`, shasum: createHash("sha1").update(entry.archive).digest("hex"), integrity: `sha512-${createHash("sha512").update(entry.archive).digest("base64")}` } }]));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: group[0]!.manifest.name, "dist-tags": { latest: group.at(-1)!.manifest.version }, versions }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture registry did not bind");
  url = `http://127.0.0.1:${address.port}`;
  return { url, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }) };
}

const cases = ["npm-global", "npm-local", "bun-global", "bun-custom", "pnpm-isolated", "pnpm-bundled", "yarn-global"] as const;
function toolAvailable(file: string, minimum: number, maximum = Infinity): boolean {
  if (process.platform === "win32") return false;
  try {
    const output = execFileSync(file, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const major = Number(/^(?:v)?(\d+)\./.exec(output.trim())?.[1]);
    return major >= minimum && major <= maximum;
  } catch { return false; }
}
const tools = { bun: toolAvailable("bun", 1), pnpm: toolAvailable("pnpm", 11), yarn: toolAvailable("yarn", 1, 1) };
if (process.env.CLAI_TEST_REQUIRE_MANAGERS === "1" && Object.values(tools).some((available) => !available)) throw new Error("updater CI requires Bun, pnpm 11+ and Yarn Classic on PATH");
function channelAvailable(channel: typeof cases[number]): boolean {
  if (channel.startsWith("bun")) return tools.bun;
  if (channel.startsWith("pnpm")) return tools.pnpm;
  if (channel.startsWith("yarn")) return tools.yarn;
  return true;
}

describe.skipIf(process.platform === "win32")("real manager updates against an isolated local registry", () => {
  describe.each(cases)("%s", (channel) => {
  it.skipIf(!channelAvailable(channel))("updates only the active installation and verifies its launcher (requires the owning manager)", async () => {
    const root = mkdtempSync(join(tmpdir(), "clai-real-manager-")); roots.push(root);
    const service = await registry(root);
    vi.stubEnv("npm_config_registry", service.url);
    vi.stubEnv("npm_config_cache", join(root, "npm-cache"));
    vi.stubEnv("YARN_CACHE_FOLDER", join(root, "yarn-cache"));
    vi.stubEnv("COREPACK_ENABLE_PROJECT_SPEC", "0");
    const config = join(root, "fixture.npmrc"); writeFileSync(config, `registry=${service.url}\n`);
    vi.stubEnv("npm_config_userconfig", config);
    try {
      let type: "npm" | "bun" | "pnpm" | "yarn" = "npm";
      let prefix = join(root, channel);
      let scope: "global" | "local" = "global";
      let initialFile = "npm";
      let initialArgs = ["install", "--global", "--prefix", prefix, "@pentoshi/clai@4.14.4", "--no-audit", "--no-fund"];
      let env: NodeJS.ProcessEnv = {};
      let launcher = join(prefix, "lib", "node_modules", "@pentoshi", "clai", "bin", "clai.mjs");
      if (channel === "npm-local") {
        scope = "local"; initialArgs = initialArgs.filter((arg) => arg !== "--global");
        launcher = join(prefix, "node_modules", "@pentoshi", "clai", "bin", "clai.mjs");
      }
      if (channel.startsWith("bun")) {
        type = "bun"; initialFile = "bun";
        prefix = channel === "bun-global" ? join(root, ".bun", "install", "global") : join(root, "bun-custom");
        initialArgs = ["add", ...(channel === "bun-global" ? ["--global"] : []), "@pentoshi/clai@4.14.4"];
        env = { BUN_INSTALL_GLOBAL_DIR: prefix, BUN_INSTALL_BIN: join(root, ".bun", "bin") };
        launcher = join(prefix, "node_modules", "@pentoshi", "clai", "bin", "clai.mjs");
      }
      if (channel.startsWith("pnpm")) {
        type = "pnpm"; initialFile = "pnpm"; prefix = join(root, "pnpm");
        initialArgs = ["add", "--global", channel === "pnpm-bundled" ? "@pentoshi/clai@4.14.4,clai-updater-sibling-fixture@1.0.0" : "@pentoshi/clai@4.14.4"];
        env = { PNPM_HOME: prefix, PNPM_SHIM_BYPASS: "1", PATH: `${join(prefix, "bin")}:${process.env.PATH ?? ""}` };
        launcher = join(prefix, "bin", "clai");
      }
      if (channel === "yarn-global") {
        type = "yarn"; initialFile = "yarn"; prefix = join(root, "yarn", "global");
        initialArgs = ["global", "add", "@pentoshi/clai@4.14.4", "--global-folder", prefix, "--prefix", join(root, "yarn-bins")];
        launcher = join(prefix, "node_modules", "@pentoshi", "clai", "bin", "clai.mjs");
      }
      mkdirSync(prefix, { recursive: true });
      writeFileSync(join(prefix, ".npmrc"), `registry=${service.url}\n`);
      if (channel === "npm-local" || channel === "bun-custom") writeFileSync(join(prefix, "package.json"), '{"name":"fixture","private":true}');
      await runUpdateCommand({ file: initialFile, args: initialArgs, cwd: prefix, env }, { timeoutMs: 120_000 });
      const probeText = await runUpdateCommand(channel.startsWith("pnpm") ? { file: launcher, args: ["--probe"], env } : { file: process.execPath, args: [launcher, "--probe"] });
      const probe: unknown = JSON.parse(probeText);
      if (!probe || typeof probe !== "object" || !("argv1" in probe) || typeof probe.argv1 !== "string" || !("execPath" in probe) || typeof probe.execPath !== "string") throw new Error("invalid launcher probe");
      const active = detectInstallMethod({ argv1: probe.argv1, execPath: probe.execPath, runtimePath: probe.execPath, platform: process.platform, home: root, packageManager: type, scope });
      expect(active.type).toBe(type);
      const other = join(root, "unrelated-installation"); mkdirSync(other); writeFileSync(join(other, "clai-version"), "4.14.4");
      vi.stubEnv("npm_config_prefix", other);
      vi.stubEnv("BUN_INSTALL_GLOBAL_DIR", other);
      vi.stubEnv("BUN_INSTALL_BIN", join(other, "bin"));
      vi.stubEnv("PNPM_HOME", other);
      const lines: string[] = [];
      const result = await installViaPackageManager({ version: "9.9.9", method: active, log: (line) => lines.push(line), stdio: "pipe" }).catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(active)}\n${lines.join("\n")}`);
      });
      expect(result).toMatchObject({ ok: true, outcome: "applied", installedVersion: "9.9.9" });
      const output = await runUpdateCommand(channel.startsWith("pnpm") ? { file: launcher, args: ["--version"], env } : { file: process.execPath, args: [launcher, "--version"] });
      expect(output).toBe("9.9.9");
      if (channel === "pnpm-bundled") {
        expect(await runUpdateCommand({ file: join(prefix, "bin", "sibling-fixture"), args: ["--version"], env })).toBe("1.0.0");
      }
      expect(readFileSync(join(other, "clai-version"), "utf8")).toBe("4.14.4");
      expect(readFileSync(config, "utf8")).toBe(`registry=${service.url}\n`);
    } finally { await service.close(); }
  }, 180_000);
  });
});
