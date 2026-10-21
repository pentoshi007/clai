import type { ReaBlockedGroup, ReaEngine } from "./availability.js";
import type { EngineReport } from "./engine-status.js";
import { bundlesDecompiler, GHIDRA_SERIES } from "./ghidra.js";

const LABELS: Readonly<Record<string, string>> = { ghidra: "Ghidra", hopper: "Hopper", ida: "IDA", kuna: "Kuna" };
const FALLBACK_ENGINES = ["ghidra", "hopper", "ida", "kuna"] as const;
const MAX_BLOCKED_LINES = 8;
const code = (text: string): string => `\`${text}\``;

function hint(engine: string, report: EngineReport): string[] {
  const { host, settings, found } = report;
  const windows = host.platform === "win32";
  if (engine === "ghidra") {
    const lines: string[] = [];
    if (settings.ghidra) lines.push(`configured: ${code(settings.ghidra.dir)} (${settings.ghidra.managed ? "installed by clai" : "your own installation"}${settings.ghidra.version ? `, ${settings.ghidra.version}` : ""})`);
    const existing = found.find((entry) => entry.dir !== settings.ghidra?.dir);
    if (existing) {
      lines.push(`found ${existing.version} at ${code(existing.dir)}${existing.decompiler ? "" : " (no native decompiler for this machine)"}`);
      if (existing.decompiler) lines.push(code(`/rea engines use ghidra ${existing.dir}`));
    }
    lines.push(`${code("/rea engines install ghidra")} official Ghidra ${GHIDRA_SERIES}.x from github.com, about 570 MB, checksum verified${bundlesDecompiler(host) ? "" : ", then builds its native decompiler once (needs make, a C++ compiler and bison)"}`);
    lines.push(`${code("/rea engines use ghidra <folder>")} point at an extracted Ghidra you already have`);
    if (windows) lines.push("REA's Windows Ghidra support is experimental (x64 only)");
    return lines;
  }
  if (engine === "hopper") {
    return windows
      ? ["Hopper is not available on Windows"]
      : [`commercial app: install it yourself (hopperapp.com), then ${code("/rea engines use hopper <launcher path>")}`];
  }
  if (engine === "ida") return [`needs your IDA installation plus an MCP registration: ${code("/rea engines use ida <registration.json>")}`];
  if (engine === "kuna") {
    return windows
      ? ["Kuna is not supported on Windows"]
      : [`bring your own executable: ${code("/rea engines use kuna <executable>")} (ELF and thin Mach-O only)`];
  }
  return [];
}

function engineLines(engine: ReaEngine | { id: string; name: string; ready: boolean; reason: string | undefined }, report: EngineReport): string[] {
  const head = `${engine.ready ? "✓" : "✗"} ${LABELS[engine.id] ?? engine.name}${engine.ready ? " · ready" : engine.reason ? ` · ${engine.reason}` : " · not available"}`;
  return [head, ...(engine.ready ? [] : hint(engine.id, report).map((line) => `    ${line}`))];
}

export function describeEngines(report: EngineReport, blocked: readonly ReaBlockedGroup[] = []): string {
  const lines: string[] = [];
  if (report.rea.state === "ready") lines.push(`REA ${report.rea.installation.version} is installed.`);
  else lines.push(`REA is not installed: run ${code("/rea setup")} first, then ${code("/rea engines")}.`);
  lines.push("", "Native decompilation (procedures, pseudocode, strings, cross-references) needs one analysis engine:", "");
  const engines = report.availability?.engines.length
    ? report.availability.engines
    : FALLBACK_ENGINES.map((id) => ({ id, name: LABELS[id]!, ready: false, reason: report.failure }));
  for (const engine of engines) lines.push(...engineLines(engine, report));
  if (report.failure && report.rea.state === "ready") lines.push("", `Could not read REA's engine report: ${report.failure}`);
  lines.push(
    "",
    "Without an engine REA still handles JavaScript and Electron apps, .NET assemblies, archives, Mach-O headers, plists and signatures.",
    `Engines are installed only when you run ${code("/rea engines install")}; the agent never installs or configures them.`,
  );
  if (blocked.length > 0) {
    lines.push("", "Other tasks that need extra tools on this machine:");
    for (const group of blocked.slice(0, MAX_BLOCKED_LINES)) lines.push(`  ${group.tools.slice(0, 3).join(", ")}${group.tools.length > 3 ? ", …" : ""}: ${group.remediation}`);
    if (blocked.length > MAX_BLOCKED_LINES) lines.push(`  … and ${blocked.length - MAX_BLOCKED_LINES} more`);
  }
  return lines.join("\n");
}

export function engineSummary(report: EngineReport): string {
  const ready = report.availability?.engines.filter((engine) => engine.ready) ?? [];
  if (ready.length > 0) return `engine ready: ${ready.map((engine) => LABELS[engine.id] ?? engine.name).join(", ")}`;
  return "no analysis engine ready · /rea engines";
}
