import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, posix, win32 } from "node:path";
import { formatSudoStdinPassword, obtainSudoPassword } from "../../tools/sudo-session.js";
import { PACKAGE_NAME, REPO, type InstallMethod, type PerformUpdateOptions, type UpdateInstallResult } from "./installers.js";
import { writableDirectory } from "./native.js";
import { runUpdateCommand, throwIfCancelled, windowsCommand, type UpdateCommand } from "./process.js";
import { installedVersionCommand, releaseVersion, verifyCommand } from "./verification.js";
import { stageWindowsUpdate } from "./windows-stage.js";

export function managerUpdateCommands(method: InstallMethod, version: string, platform = process.platform, groupSpec?: string): readonly UpdateCommand[] {
  const api = platform === "win32" ? win32 : posix;
  const suffix = platform === "win32" ? ".cmd" : "";
  const file = method.managerPath ?? `${method.type}${suffix}`;
  const spec = `${PACKAGE_NAME}@${version}`;
  if (method.type === "brew") {
    return [{ file: method.managerPath ?? "brew", args: ["update"] }, { file: method.managerPath ?? "brew", args: ["upgrade", `${REPO}/clai`] }];
  }
  if (!method.prefix) throw new Error(`cannot safely target the active ${method.type} installation without its installation directory`);
  const cwd = method.prefix;
  if (method.type === "scoop") {
    const env = method.scope === "global" ? { SCOOP_GLOBAL: cwd } : { SCOOP: cwd };
    const scoop = method.managerPath ?? api.join(cwd, "apps", "scoop", "current", "bin", "scoop.ps1");
    return [{ file: scoop, args: ["update"], env }, { file: scoop, args: ["update", "clai", ...(method.scope === "global" ? ["--global"] : [])], env }];
  }
  if (!method.packageRoot || !method.runtimePath) throw new Error("cannot safely update an unidentified JS package installation");
  switch (method.type) {
    case "npm":
      return [{ file, args: ["install", ...(method.scope === "global" ? ["--global"] : ["--save-exact"]), "--prefix", cwd, spec, "--no-audit", "--no-fund"], cwd }];
    case "bun": {
      const standardGlobal = method.scope === "global" && /[\\/]install[\\/]global$/.test(cwd);
      const env = standardGlobal ? { BUN_INSTALL_GLOBAL_DIR: cwd, BUN_INSTALL_BIN: api.join(api.dirname(api.dirname(cwd)), "bin") } : undefined;
      return [{ file: method.managerPath ?? (platform === "win32" ? "bun.exe" : "bun"), args: ["add", ...(standardGlobal ? ["--global"] : []), "--exact", spec], cwd, ...(env ? { env } : {}) }];
    }
    case "pnpm": {
      if (method.scope !== "global") return [{ file, args: ["add", "--save-exact", spec], cwd }];
      const normalized = cwd.replace(/\\/g, "/");
      const isolated = normalized.indexOf("/global/v");
      const home = isolated >= 0 ? cwd.slice(0, isolated) : api.dirname(api.dirname(cwd));
      const bin = isolated >= 0 ? api.join(home, "bin") : home;
      const path = `${bin}${platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
      return [{ file, args: ["add", "--global", "--global-dir", api.join(home, "global"), groupSpec ?? spec], ...(isolated >= 0 ? { cwd } : {}), env: { PNPM_HOME: home, PNPM_SHIM_BYPASS: "1", PATH: path } }];
    }
    case "yarn":
      return [{ file, args: ["--cwd", cwd, "add", "--exact", spec], cwd }];
    default: throw new Error(`no package manager command for install method: ${method.type}`);
  }
}

function absoluteManager(file: string): string {
  if (isAbsolute(file)) return file;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, file);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error(`could not locate ${file}; install the original package manager before updating`);
}

async function runManager(command: UpdateCommand, options: PerformUpdateOptions): Promise<void> {
  const method = options.method;
  if (method.scope !== "global" || !method.packageRoot || writableDirectory(dirname(method.packageRoot))) {
    await runUpdateCommand(command, { signal: options.signal, log: options.log });
    return;
  }
  const auth = options.elevation?.auth ?? (options.requestSecret ? await obtainSudoPassword({
    requestSecret: options.requestSecret,
    title: "Administrator access",
    prompt: `Updating this ${method.type} installation at ${method.packageRoot} needs sudo permission. Enter your password; Esc cancels.`,
    operation: { name: "clai.update", args: { version: options.version, destination: method.packageRoot, manager: method.type, elevation: "sudo" } },
    ...(options.signal ? { signal: options.signal } : {}),
  }, {}) : undefined);
  if (auth?.status === "cancelled") throw new Error("update cancelled before the package-manager operation");
  if (auth?.status === "failed") throw new Error("sudo authentication failed before the package-manager operation");
  throwIfCancelled(options.signal);
  const args = auth?.status === "granted" ? ["-S", "-p", ""] : ["-n"];
  const env = { PATH: process.env.PATH ?? "", ...command.env };
  const environment = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => `${key}=${value}`);
  try {
    await runUpdateCommand({ file: "sudo", args: [...args, "--", "env", ...environment, absoluteManager(command.file), ...command.args], ...(command.cwd ? { cwd: command.cwd } : {}) }, {
      signal: options.signal, log: options.log, ...(auth?.status === "granted" ? { input: formatSudoStdinPassword(auth.password) } : {}),
    });
  } catch (error) {
    throwIfCancelled(options.signal);
    throw new Error(`could not update protected ${method.type} installation at ${method.packageRoot}; retry the administrator prompt or run this installation's update with sudo: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const JS_MANAGER_ENTRIES = { npm: [["npm", "bin", "npm-cli.js"]], pnpm: [["pnpm", "bin", "pnpm.mjs"], ["pnpm", "bin", "pnpm.cjs"]], yarn: [["yarn", "bin", "yarn.js"]] } as const;

function nativeManagerCommand(command: UpdateCommand, method: InstallMethod): UpdateCommand {
  if (process.platform !== "win32" || !/\.cmd$/i.test(command.file)) return command;
  if (method.type !== "npm" && method.type !== "pnpm" && method.type !== "yarn") return command;
  const file = absoluteManager(command.file);
  const base = join(dirname(file), "node_modules");
  const entries = [...JS_MANAGER_ENTRIES[method.type].map((relative) => join(base, ...relative)), join(base, "corepack", "dist", `${method.type}.js`)];
  const entry = entries.find(existsSync);
  const node = join(dirname(file), "node.exe");
  const runtime = existsSync(node) ? node : method.runtimePath;
  if (entry && runtime) return { ...command, file: runtime, args: [entry, ...command.args] };
  if (command.args.some((arg) => /%[^%]+%/.test(arg))) throw new Error("cannot safely pass this Windows installation path through an unidentified .cmd wrapper; reinstall the original package manager");
  return command;
}

function isolatedGroupSpec(method: InstallMethod, version: string): string | undefined {
  if (method.type !== "pnpm" || method.scope !== "global" || !method.prefix || !/[\\/]global[\\/]v\d+[\\/]/.test(method.prefix)) return undefined;
  const manifest: unknown = JSON.parse(readFileSync(join(method.prefix, "package.json"), "utf8"));
  if (!manifest || typeof manifest !== "object" || !("dependencies" in manifest) || !manifest.dependencies || typeof manifest.dependencies !== "object" || !(PACKAGE_NAME in manifest.dependencies)) throw new Error("cannot safely identify clai's isolated global pnpm group");
  const entries: [string, unknown][] = Object.entries(manifest.dependencies);
  const specs = entries.map(([name, selector]) => {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name) || typeof selector !== "string") throw new Error("invalid isolated pnpm group dependency");
    if (name === PACKAGE_NAME) return `${name}@${version}`;
    const installed: unknown = JSON.parse(readFileSync(join(method.prefix!, "node_modules", name, "package.json"), "utf8"));
    if (!installed || typeof installed !== "object" || !("version" in installed)) throw new Error(`cannot preserve bundled pnpm dependency: ${name}`);
    const pinned = releaseVersion(installed.version);
    if (!pinned || /^(?:file:|link:|workspace:|git|https?:)/.test(selector)) throw new Error(`bundled pnpm dependency ${name} needs a manual update; existing group was kept`);
    if (selector.startsWith("npm:")) {
      if (!("name" in installed) || typeof installed.name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(installed.name)) throw new Error("invalid bundled pnpm alias");
      return `${name}@npm:${installed.name}@${pinned}`;
    }
    return `${name}@${pinned}`;
  });
  return specs.sort().join(",");
}

export async function installViaPackageManager(options: PerformUpdateOptions): Promise<UpdateInstallResult> {
  throwIfCancelled(options.signal);
  const groupSpec = isolatedGroupSpec(options.method, options.version);
  const commands = managerUpdateCommands(options.method, options.version, process.platform, groupSpec).map((command) => nativeManagerCommand(command, options.method));
  const verification = installedVersionCommand(options.method);
  const allowNewer = options.method.type === "brew" || options.method.type === "scoop";
  options.onProgress?.({ phase: "installing", detail: `${options.method.type} · ${options.method.prefix ?? options.method.detail}` });
  if (process.platform === "win32") {
    const elevated = options.method.scope === "global" && options.method.prefix !== undefined && !writableDirectory(options.method.packageRoot ? dirname(options.method.packageRoot) : options.method.prefix);
    const statusFile = await stageWindowsUpdate({ kind: "commands", commands: commands.map(windowsCommand), verification: windowsCommand(verification), version: options.version, allowNewer }, { signal: options.signal, ...(options.lockFile ? { lockFile: options.lockFile, lockToken: options.lockToken } : {}) }, elevated);
    return { ok: true, method: options.method.type, outcome: "staged", needsRestart: true, statusFile, message: `update staged for this ${options.method.type} installation; close clai to apply and verify it. Result: ${statusFile}` };
  }
  for (const command of commands) {
    options.log?.(`Running ${command.file} ${command.args.join(" ")}`);
    await runManager(command, options);
  }
  const installedVersion = await verifyCommand(verification, options.version, {}, allowNewer);
  return { ok: true, method: options.method.type, outcome: "applied", installedVersion, needsRestart: true, message: `updated and verified v${installedVersion} via ${options.method.type}` };
}
