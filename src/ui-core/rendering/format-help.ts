/**
 * Markdown body for `/help` and Ctrl+G command reference.
 *
 * Uses bullet lists (not tables): usage strings often contain `|` and `<>`
 * which break markdown table cell parsing in our renderer (even when escaped).
 */

import type { CommandHelpEntry } from "../../app/commands/registry.js";

/**
 * Group slash commands into readable sections by prefix / role.
 */
function sectionFor(command: string): string {
  const name = command.replace(/^\//, "").toLowerCase();
  if (["ask", "agent", "plan", "implement", "discard"].includes(name)) {
    return "Mode & plan";
  }
  if (
    ["model", "models", "provider", "use", "search", "search-provider", "effort", "reasoning"].includes(
      name,
    )
  ) {
    return "Model & providers";
  }
  if (["set", "unset", "keys", "info"].includes(name)) {
    return "Credentials";
  }
  if (
    ["permissions", "allow", "disallow", "freeonly", "fallback", "scope", "privacy"].includes(
      name,
    )
  ) {
    return "Permissions & safety";
  }
  if (
    ["history", "clear", "new", "save", "reset", "compact", "context", "think", "thinking", "output", "cwd"].includes(
      name,
    )
  ) {
    return "Session";
  }
  if (["jobs", "update", "help", "shortcuts", "exit", "quit"].includes(name)) {
    return "App";
  }
  return "Other";
}

const SECTION_ORDER = [
  "Mode & plan",
  "Model & providers",
  "Credentials",
  "Permissions & safety",
  "Session",
  "App",
  "Other",
] as const;

/** Collapse whitespace so a command never splits mid-token in the pager. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Format one command as a markdown list item.
 * Command + usage stay in a single backtick span so `|` / `<>` are literal.
 */
export function formatHelpEntry(entry: CommandHelpEntry): string {
  const usage = entry.usage ? ` ${oneLine(entry.usage)}` : "";
  const cmd = oneLine(`${entry.command}${usage}`);
  let desc = oneLine(entry.description);
  if (entry.aliases.length > 0) {
    const aliasList = entry.aliases.map((a) => `\`${oneLine(a)}\``).join(", ");
    desc += ` · aliases: ${aliasList}`;
  }
  // Em dash between command and description — no table pipes.
  return `- \`${cmd}\` — ${desc}`;
}

/**
 * Format the slash-command catalog as a clean markdown reference.
 */
export function formatCommandHelpMarkdown(
  entries: readonly CommandHelpEntry[],
): string {
  const bySection = new Map<string, CommandHelpEntry[]>();
  for (const e of entries) {
    const sec = sectionFor(e.command);
    const list = bySection.get(sec) ?? [];
    list.push(e);
    bySection.set(sec, list);
  }

  const out: string[] = [
    "# Commands",
    "",
    "Type a command in the composer, or open the completion menu with `/`.",
    "Also: **Ctrl+G** opens this help · **`/shortcuts`** lists keyboard chords.",
    "",
  ];

  for (const sec of SECTION_ORDER) {
    const list = bySection.get(sec);
    if (!list || list.length === 0) continue;
    out.push(`## ${sec}`);
    out.push("");
    const sorted = [...list].sort((a, b) => a.command.localeCompare(b.command));
    for (const e of sorted) {
      out.push(formatHelpEntry(e));
    }
    out.push("");
  }

  out.push("---");
  out.push("");
  out.push("Tip: `q` / `Esc` closes · `↑↓` scroll · `^r` search this page.");

  return out.join("\n");
}
