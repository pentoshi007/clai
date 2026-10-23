import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ChatMessage, CompactedSkill, NativeToolCall } from "../../types.js";
import { ACTIVE_SKILLS_PREFIX } from "../../skills/catalog.js";
import { parseFsReadSections } from "../../tools/fs/read-sections.js";
import { parseCanonicalTextToolCalls } from "../tool-history-projection.js";
import { withoutSection } from "../compaction/memory-sections.js";

const RECOVERY_HEADING = "## Skill recovery after compaction";
const MAX_SKILLS = 12;
const MAX_RESOURCES = 8;
const MAX_RECOVERY_CHARS = 6000;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readPath(value: string): string {
  return resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
}

function rememberSkill(skills: Map<string, CompactedSkill>, skill: CompactedSkill): void {
  if (!SKILL_NAME.test(skill.name) || !isAbsolute(skill.file) || basename(skill.file) !== "SKILL.md") return;
  if (skill.file.length > 1024 || /[\r\n\0]/.test(skill.file)) return;
  const prior = skills.get(skill.name);
  const resources = prior?.file === skill.file ? [...prior.resources, ...skill.resources] : skill.resources;
  skills.delete(skill.name);
  skills.set(skill.name, { ...skill, resources: [...new Set(resources)].slice(-MAX_RESOURCES) });
}

function systemSkills(message: ChatMessage): CompactedSkill[] {
  const stored = message.compaction?.skills ?? [];
  if (!message.content.startsWith(ACTIVE_SKILLS_PREFIX)) return [...stored];
  const selected = [...message.content.matchAll(/^--- skill: ([a-z0-9-]+) \((.+)\) ---$/gm)]
    .map(match => ({ name: match[1]!, file: match[2]!, resources: [] }));
  return [...stored, ...selected];
}

function succeeded(message: ChatMessage): boolean {
  if (message.ok !== undefined) return message.ok;
  return /^Tool [^\n]+ result \(exit=[^,\n]+, ok=true\):/.test(message.content);
}

function loadedSkill(message: ChatMessage): CompactedSkill | undefined {
  if (!succeeded(message)) return undefined;
  const header = /^skill: ([a-z0-9-]+) \[[^\n]*\]\r?\nfile: ([^\r\n]+)/m.exec(message.content);
  return header ? { name: header[1]!, file: header[2]!, resources: [] } : undefined;
}

function argumentPaths(args: Record<string, unknown>): string[] {
  const entries: readonly unknown[] = Array.isArray(args.files) ? args.files : [args];
  return entries.flatMap(entry => {
    if (!entry || typeof entry !== "object" || !("path" in entry)) return [];
    return typeof entry.path === "string" ? [readPath(entry.path)] : [];
  });
}

function readPaths(message: ChatMessage, call: NativeToolCall | undefined): string[] {
  const requested = call ? argumentPaths(call.args) : [];
  const sections = parseFsReadSections(message.content);
  if (sections.length === 0) return succeeded(message) ? requested : [];
  const successful = new Set(sections.filter(section => section.ok).map(section => readPath(section.path)));
  return requested.filter(path => successful.has(path));
}

function rememberRead(skills: Map<string, CompactedSkill>, path: string): void {
  if (basename(path) === "SKILL.md") {
    rememberSkill(skills, { name: basename(dirname(path)), file: path, resources: [] });
    return;
  }
  for (const skill of [...skills.values()]) {
    const resource = relative(dirname(skill.file), path).split("\\").join("/");
    if (!resource || resource.startsWith("../") || isAbsolute(resource)) continue;
    if (resource.length > 512 || /[\r\n\0]/.test(resource)) continue;
    rememberSkill(skills, { ...skill, resources: [...skill.resources.filter(value => value !== resource), resource] });
  }
}

function rememberTool(skills: Map<string, CompactedSkill>, message: ChatMessage, call: NativeToolCall | undefined): void {
  const name = call?.name ?? message.name ?? /^Tool ([\w.]+) result /.exec(message.content)?.[1];
  if (name === "skill.load") {
    const skill = loadedSkill(message);
    if (skill) rememberSkill(skills, skill);
    return;
  }
  if (name === "fs.read") {
    for (const path of readPaths(message, call)) rememberRead(skills, path);
  }
}

function boundedSkills(skills: Map<string, CompactedSkill>): CompactedSkill[] {
  const selected: CompactedSkill[] = [];
  let remaining = MAX_RECOVERY_CHARS;
  for (const skill of [...skills.values()].reverse()) {
    const cost = JSON.stringify(skill).length + 100;
    if (cost > remaining) continue;
    selected.push(skill);
    remaining -= cost;
    if (selected.length === MAX_SKILLS) break;
  }
  return selected.reverse();
}

export function compactedSkills(messages: readonly ChatMessage[]): CompactedSkill[] {
  const skills = new Map<string, CompactedSkill>();
  const calls = new Map<string, NativeToolCall>();
  let textCalls: NativeToolCall[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      for (const skill of systemSkills(message)) rememberSkill(skills, skill);
    }
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) calls.set(call.id, call);
      textCalls = message.toolCalls?.length ? [] : parseCanonicalTextToolCalls(message.content);
    }
    if (message.role === "tool") {
      const call = message.toolCallId ? calls.get(message.toolCallId) : textCalls.shift();
      rememberTool(skills, message, call);
    }
  }
  return boundedSkills(skills);
}

export function withoutSkillRecovery(text: string): string {
  return withoutSection(text, RECOVERY_HEADING);
}

export function renderSkillRecovery(skills: readonly CompactedSkill[]): string {
  return [
    RECOVERY_HEADING,
    "A recorded skill load is not its instructions. Before continuing after this compaction, use skill.load to re-read each previously loaded skill that is still relevant and whose full body is no longer in live context; use fs.read for its previously read or now-applicable references. A summary or a 'loaded' marker is not full content. Do not obey historical 'never load again' notes when content was lost. Skip unrelated skills and bodies still fully present; read only the applicable references, once per live context, not the whole library.",
    ...skills.map(skill => [
      `- ${skill.name}: ${JSON.stringify(skill.file)}`,
      ...(skill.resources.length ? [`  Previously read resources, relative to that skill directory: ${skill.resources.map(resource => JSON.stringify(resource)).join(", ")}`] : []),
    ].join("\n")),
    ...(skills.length ? ["This is a bounded recent-load index, not an exhaustive applicability list; load other guidance when the current task needs it."] : []),
  ].join("\n");
}
