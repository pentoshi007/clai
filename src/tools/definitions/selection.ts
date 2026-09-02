import type { ToolDefinition } from "../../types.js";
import { TOOL_DEFINITIONS } from "./aggregate.js";
import { NON_REGISTRY_TOOL_NAMES } from "../definitions.js";

export const byName = new Map(TOOL_DEFINITIONS.map((d) => [d.name, d]));

export function getToolDefinitions(filter?: {
  askMode?: boolean;
  names?: string[];
  compact?: boolean;
}): ToolDefinition[] {
  let defs = TOOL_DEFINITIONS;
  if (filter?.askMode) {
    defs = defs.filter((d) => d.askMode);
  }
  if (filter?.names) {
    const allow = new Set(filter.names);
    defs = defs.filter((d) => allow.has(d.name));
  }
  if (filter?.compact) {
    const core = new Set([
      "fs.read",
      "fs.write",
      "fs.writeMany",
      "fs.list",
      "fs.search",
      "fs.edit",
      "fs.append",
      "fs.delete",
      "shell.exec",
      "shell.start",
      "shell.jobs",
      "shell.tail",
      "shell.wait",
      "shell.stop",
      "terminal.start",
      "terminal.send",
      "terminal.read",
      "terminal.status",
      "terminal.list",
      "terminal.resize",
      "terminal.close",
      "web.search",
      "web.fetch",
      "http.fetch",
      "dns.lookup",
      "whois.lookup",
      "net.context",
      "pentest.recon",
      "wordlist.find",
      "sysinfo",
      "tool.check",
      "image.view",
      "image.ocr",
      "skill.load",
      "skill.list",
      "instructions.record",
      "plan.create",
      "task.add",
      "task.move",
      "job.read",
      "task.read",
      "task.update",
    ]);
    defs = defs.filter((d) => core.has(d.name));
  }
  return defs.map((d) => ({ ...d }));
}

export function getCompactToolDefinitions(): ToolDefinition[] {
  return getToolDefinitions({ compact: true });
}

export function assertDefinitionRegistryConsistency(
  registryKeys: string[],
): void {
  const reg = new Set(registryKeys);
  const defNames = new Set(TOOL_DEFINITIONS.map((d) => d.name));
  const wires = new Set<string>();

  for (const d of TOOL_DEFINITIONS) {
    if (wires.has(d.wireName)) {
      throw new Error(`Duplicate wire name: ${d.wireName}`);
    }
    wires.add(d.wireName);
    if (!NON_REGISTRY_TOOL_NAMES.has(d.name) && !reg.has(d.name)) {
      throw new Error(
        `Definition "${d.name}" has no toolRegistry handler (and is not a meta tool)`,
      );
    }
  }
  for (const key of registryKeys) {
    if (!defNames.has(key)) {
      throw new Error(`toolRegistry key "${key}" has no ToolDefinition`);
    }
  }
}
