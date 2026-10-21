import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { parseReaAvailability, type ReaAvailability } from "./availability.js";
import { engineEnvironment, readEngineSettings, type EngineSettings } from "./engines.js";
import { compareVersions, currentHost, inspectGhidraDirectory, type EngineHost, type GhidraInspection } from "./ghidra.js";
import { detectRea, reaRoot } from "./install.js";
import { runReaNode } from "./node.js";
import type { ReaStatus } from "./types.js";

const MAX_EXPANSIONS = 200;

export interface EngineReport {
  readonly rea: ReaStatus;
  readonly settings: EngineSettings;
  readonly availability: ReaAvailability | undefined;
  readonly failure: string | undefined;
  readonly found: readonly Extract<GhidraInspection, { ok: true }>[];
  readonly host: EngineHost;
}

function pathModule(host: EngineHost): typeof posix {
  return host.platform === "win32" ? win32 : posix;
}

export function ghidraSearchPatterns(host: EngineHost, home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const path = pathModule(host);
  const names = ["ghidra*", "Ghidra*", "ghidra_*_PUBLIC"];
  const under = (...bases: string[]): string[] => bases.flatMap((base) => names.map((name) => path.join(base, name)));
  if (host.platform === "darwin") {
    return [
      ...under("/Applications", path.join(home, "Applications"), "/opt", "/usr/local", home, path.join(home, "Downloads"), path.join(home, "tools"), path.join(home, "Tools")),
      path.join("/opt/homebrew/Caskroom/ghidra", "*", "ghidra_*_PUBLIC"),
      path.join("/usr/local/Caskroom/ghidra", "*", "ghidra_*_PUBLIC"),
    ];
  }
  if (host.platform === "win32") {
    const roots = [env.SystemDrive ? `${env.SystemDrive}\\` : "C:\\", env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : undefined, home, path.join(home, "Downloads"), path.join(home, "tools")]
      .filter((entry): entry is string => !!entry);
    return under(...roots);
  }
  return under("/opt", "/usr/local", "/usr/share", "/usr/lib", home, path.join(home, "Downloads"), path.join(home, "tools"), path.join(home, ".local", "share"));
}

async function expand(pattern: string, host: EngineHost): Promise<string[]> {
  const path = pathModule(host);
  const { root } = path.parse(pattern);
  let current: string[] = [root || "."];
  for (const part of pattern.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    const next: string[] = [];
    for (const base of current) {
      if (!part.includes("*")) {
        next.push(path.join(base, part));
        continue;
      }
      const matcher = new RegExp(`^${part.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, host.platform === "linux" ? "" : "i");
      const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && matcher.test(entry.name)) next.push(path.join(base, entry.name));
        if (next.length >= MAX_EXPANSIONS) break;
      }
    }
    current = next.slice(0, MAX_EXPANSIONS);
  }
  return current;
}

export async function discoverGhidra(
  host: EngineHost = currentHost(),
  patterns: readonly string[] = ghidraSearchPatterns(host, homedir()),
): Promise<Array<Extract<GhidraInspection, { ok: true }>>> {
  const candidates = new Set<string>();
  for (const pattern of patterns) {
    for (const path of await expand(pattern, host)) candidates.add(path);
  }
  const found: Array<Extract<GhidraInspection, { ok: true }>> = [];
  for (const directory of candidates) {
    for (const candidate of [directory, join(directory, "libexec")]) {
      const inspection = await inspectGhidraDirectory(candidate, host);
      if (inspection.ok) {
        found.push(inspection);
        break;
      }
    }
  }
  return found.sort((left, right) => Number(right.decompiler) - Number(left.decompiler) || compareVersions(right.version, left.version));
}

function jsonObjectText(text: string): string {
  const start = text.indexOf("{");
  return start >= 0 ? text.slice(start) : text;
}

export async function collectEngineReport(
  options: { root?: string; signal?: AbortSignal; host?: EngineHost; patterns?: readonly string[] } = {},
): Promise<EngineReport> {
  const root = options.root ?? reaRoot();
  const host = options.host ?? currentHost();
  const [rea, settings, found] = await Promise.all([
    detectRea(root),
    readEngineSettings(root),
    discoverGhidra(host, options.patterns),
  ]);
  let availability: ReaAvailability | undefined;
  let failure: string | undefined;
  if (rea.state === "ready") {
    try {
      const output = await runReaNode(rea.installation.node, [rea.installation.entry, "providers", "--json"], {
        timeout: 90_000, maxBuffer: 16 * 1024 * 1024, env: engineEnvironment(settings),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      availability = parseReaAvailability(jsonObjectText(output));
      if (!availability) failure = "REA returned an unexpected provider report";
    } catch (error) {
      failure = error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
  }
  return { rea, settings, availability, failure, found, host };
}
