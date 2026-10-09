
import { getMentionQuery, findFileSuggestions, type FileSuggestion } from "../../ui/mentions.js";
import type { CommandRegistry } from "../../app/commands/registry.js";
import type { CommandDefinition } from "../../app/commands/command.js";

export interface SlashToken {
  readonly token: string;
  readonly start: number;
  readonly end: number;
}

export function detectSlashToken(value: string, cursorOffset: number): SlashToken | undefined {
  const upto = value.slice(0, cursorOffset);
  if (!/(^|\s)\/[^\/\s]*\s*$/.test(upto)) return undefined;
  const slash = upto.lastIndexOf("/");
  const lineEnd = value.indexOf("\n", slash);
  const searchEnd = lineEnd === -1 ? value.length : lineEnd;
  const rest = value.slice(slash, searchEnd);
  const boundary = rest.search(/\s/);
  const tokenEnd = boundary === -1 ? searchEnd : slash + boundary;
  if (cursorOffset > searchEnd || /\S/.test(value.slice(tokenEnd, cursorOffset))) return undefined;
  const token = value.slice(slash, tokenEnd);
  const name = token.slice(1);
  if (name.includes("/") || name.includes("\\")) return undefined;
  return { token, start: slash, end: tokenEnd };
}

export function slashSuggestions(
  registry: CommandRegistry,
  value: string,
  cursorOffset: number,
): CommandDefinition[] {
  const token = detectSlashToken(value, cursorOffset);
  if (!token) return [];
  return commandSuggestions(registry, token.token);
}

function commandSuggestions(registry: CommandRegistry, token: string): CommandDefinition[] {
  const items = registry.suggestions(token);
  const exact = registry.resolve(token);
  const index = items.findIndex((item) => item.name === exact);
  if (index > 0) items.unshift(...items.splice(index, 1));
  return items;
}

export interface MentionMatch {
  readonly start: number;
  readonly query: string;
  readonly suggestions: readonly FileSuggestion[];
}

export function mentionSuggestions(
  value: string,
  cursorOffset: number,
  baseDir?: string,
  limit = 12,
): MentionMatch | undefined {
  const mention = getMentionQuery(value, cursorOffset);
  if (!mention) return undefined;
  const suggestions = findFileSuggestions(mention.query, baseDir, limit);
  return { start: mention.start, query: mention.query, suggestions };
}

export type CompletionMenu =
  | { readonly kind: "slash"; readonly start: number; readonly end: number; readonly items: readonly CommandDefinition[] }
  | { readonly kind: "mention"; readonly start: number; readonly items: readonly FileSuggestion[] }
  | { readonly kind: "none" };

export interface ActivatedSlashCompletion {
  readonly command: string;
  readonly value: string;
  readonly cursorOffset: number;
}

export function activateSlashCompletion(
  menu: CompletionMenu,
  value: string,
  index: number,
): ActivatedSlashCompletion | undefined {
  if (menu.kind !== "slash") return undefined;
  const item = menu.items[index];
  if (!item) return undefined;
  if (!value.slice(0, menu.start).trim()) {
    return {
      command: `/${item.name}${value.slice(menu.end)}`.trimEnd(),
      value: "",
      cursorOffset: 0,
    };
  }
  const suffix = value.slice(menu.end).replace(/^[ \t]+/, "");
  return {
    command: `/${item.name}`,
    value: value.slice(0, menu.start) + suffix,
    cursorOffset: menu.start,
  };
}

export function completionSelection(
  previous: CompletionMenu,
  next: CompletionMenu,
  selected: number,
): number {
  if (previous.kind === "none" || next.kind === "none" || next.kind !== previous.kind) return 0;
  const name = previous.kind === "slash"
    ? previous.items[selected]?.name
    : previous.items[selected]?.value;
  if (!name) return 0;
  const index = next.kind === "slash"
    ? next.items.findIndex((item) => item.name === name)
    : next.items.findIndex((item) => item.value === name);
  return Math.max(0, index);
}

export function sameCompletionMenu(a: CompletionMenu, b: CompletionMenu): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "none" || b.kind === "none") return true;
  if (a.start !== b.start) return false;
  if (a.kind === "slash" && b.kind === "slash") {
    return (
      a.end === b.end &&
      a.items.length === b.items.length &&
      a.items.every((item, index) => item.name === b.items[index]?.name)
    );
  }
  if (a.kind === "mention" && b.kind === "mention") {
    return (
      a.items.length === b.items.length &&
      a.items.every((item, index) => item.value === b.items[index]?.value)
    );
  }
  return false;
}

export function resolveCompletionMenu(
  registry: CommandRegistry,
  value: string,
  cursorOffset: number,
  baseDir?: string,
): CompletionMenu {
  const slashToken = detectSlashToken(value, cursorOffset);
  if (slashToken) {
    const items = commandSuggestions(registry, slashToken.token);
    if (items.length > 0 || slashToken.token === "/") {
      return {
        kind: "slash",
        start: slashToken.start,
        end: slashToken.end,
        items:
          items.length > 0
            ? items
            : registry.suggestions(""),
      };
    }
  }
  const mention = mentionSuggestions(value, cursorOffset, baseDir);
  if (mention && mention.suggestions.length > 0) {
    return { kind: "mention", start: mention.start, items: mention.suggestions };
  }
  return { kind: "none" };
}
