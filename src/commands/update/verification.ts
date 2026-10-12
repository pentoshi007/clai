import { join } from "node:path";
import type { InstallMethod } from "./installers.js";
import { runUpdateCommand, type RunOptions, type UpdateCommand } from "./process.js";

export function releaseVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const version = value.trim().replace(/^v/, "");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match || match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part)))) return undefined;
  if (match[4]?.split(".").some((part) => /^0\d+$/.test(part))) return undefined;
  return version;
}

function components(value: string): { numbers: number[]; pre: string[] } {
  const version = value.split("+")[0]!;
  const index = version.indexOf("-");
  return { numbers: (index < 0 ? version : version.slice(0, index)).split(".").map(Number), pre: index < 0 ? [] : version.slice(index + 1).split(".") };
}

function compareIdentifier(left: string, right: string): number {
  if (left === right) return 0;
  const numericLeft = /^\d+$/.test(left);
  const numericRight = /^\d+$/.test(right);
  if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
  if (numericLeft && left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : 1;
}

export function compareVersions(left: string, right: string): number {
  if (!releaseVersion(left) || !releaseVersion(right)) throw new Error("invalid release version");
  const a = components(left.replace(/^v/, ""));
  const b = components(right.replace(/^v/, ""));
  for (let i = 0; i < 3; i += 1) {
    const difference = a.numbers[i]! - b.numbers[i]!;
    if (difference) return difference;
  }
  if (a.pre.length === 0 || b.pre.length === 0) return Number(b.pre.length > 0) - Number(a.pre.length > 0);
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i += 1) {
    const difference = compareIdentifier(a.pre[i]!, b.pre[i]!);
    if (difference) return difference;
  }
  return a.pre.length - b.pre.length;
}

export function installedVersionCommand(method: InstallMethod): UpdateCommand {
  if (method.type === "pnpm" && method.scope === "global" && method.executablePath && !method.executablePath.endsWith(".mjs")) {
    return { file: method.executablePath, args: ["--version"], env: { PNPM_SHIM_BYPASS: "1" } };
  }
  if (method.packageRoot && method.type !== "dev") {
    if (!method.runtimePath) throw new Error("cannot verify the installed package without its Node/Bun runtime");
    return { file: method.runtimePath, args: [join(method.packageRoot, "bin", "clai.mjs"), "--version"] };
  }
  if (!method.executablePath) throw new Error("cannot verify the active clai installation path");
  return { file: method.executablePath, args: ["--version"] };
}

export async function verifyCommand(command: UpdateCommand, expected: string, options: RunOptions = {}, allowNewer = false): Promise<string> {
  const output = await runUpdateCommand(command, { ...options, timeoutMs: 15_000, log: undefined });
  const actual = releaseVersion(output.replace(/^clai\s+/i, ""));
  if (!actual || (allowNewer ? compareVersions(actual, expected) < 0 : actual !== expected)) {
    throw new Error(`update verification failed: expected ${allowNewer ? "at least " : ""}${expected}, installed command reports ${output.slice(0, 120) || "no version"}; restart or retry with the original installer`);
  }
  return actual;
}

export function verifyExecutable(path: string, expected: string, options: RunOptions = {}): Promise<string> {
  return verifyCommand({ file: path, args: ["--version"] }, expected, options);
}
