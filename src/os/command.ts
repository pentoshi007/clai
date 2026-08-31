import { accessSync, constants } from "node:fs";
import { access as accessAsync } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { platform } from "node:os";

const FALLBACK_PATH_DIRS_UNIX = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/opt/local/bin",
  "/usr/sbin",
  "/sbin",
] as const;

const FALLBACK_PATH_DIRS_WIN = [
  process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : "",
  process.env.SystemRoot ? join(process.env.SystemRoot, "SysWOW64") : "",
  process.env.WINDIR ? join(process.env.WINDIR, "System32") : "",
].filter(Boolean);

export function augmentedPathEnv(base?: string): string {
  const sep = delimiter;
  const existing = (base ?? process.env.PATH ?? "").split(sep).filter(Boolean);
  const extras =
    platform() === "win32" ? FALLBACK_PATH_DIRS_WIN : [...FALLBACK_PATH_DIRS_UNIX];
  const seen = new Set(existing.map((p) => p.toLowerCase()));
  const out = [...existing];
  for (const dir of extras) {
    if (!dir || seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    out.push(dir);
  }
  return out.join(sep);
}

function buildCandidates(command: string): string[] {
  const extensions =
    platform() === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];

  const candidates: string[] = [];
  if (command.includes("/") || command.includes("\\")) {
    for (const ext of extensions) {
      candidates.push(
        ext && !command.toLowerCase().endsWith(ext.toLowerCase())
          ? `${command}${ext}`
          : command,
      );
    }
    return candidates;
  }

  for (const dir of augmentedPathEnv().split(delimiter)) {
    if (!dir || /node_modules[/\\]\.bin$/i.test(dir)) continue;
    for (const ext of extensions) {
      candidates.push(join(dir, `${command}${ext}`));
    }
  }
  return candidates;
}

export async function findExecutable(
  command: string,
): Promise<string | undefined> {
  if (!command || command.includes("\0")) return undefined;
  const mode = platform() === "win32" ? constants.F_OK : constants.X_OK;
  for (const candidate of buildCandidates(command)) {
    try {
      await accessAsync(candidate, mode);
      return candidate;
    } catch {
    }
  }
  return undefined;
}

export async function commandAvailable(command: string): Promise<boolean> {
  return Boolean(await findExecutable(command));
}

export function findExecutableSync(command: string): string | undefined {
  if (!command || command.includes("\0")) return undefined;
  const mode = platform() === "win32" ? constants.F_OK : constants.X_OK;
  for (const candidate of buildCandidates(command)) {
    try {
      accessSync(candidate, mode);
      return candidate;
    } catch {
    }
  }
  return undefined;
}
