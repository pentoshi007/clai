/**
 * Cursor-aware slash and file-mention completion (INPUT-008, V2-044/045).
 *
 * Slash commands are recognized through the command token and its trailing
 * whitespace on the first line. File mentions reuse the existing
 * renderer-independent detector (`src/ui/mentions.ts`).
 */

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
  if (cursorOffset > tokenEnd && /\S/.test(value.slice(tokenEnd, searchEnd))) return undefined;
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
  return registry.suggestions(token.token);
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
  const suffix = value.slice(menu.end).replace(/^[ \t]+/, "");
  return {
    command: `/${item.name}`,
    value: value.slice(0, menu.start) + suffix,
    cursorOffset: menu.start,
  };
}

/** True when a native cursor/input event would render the identical menu. */
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

/** Slash takes priority since a mention cannot start a line with "/". */
export function resolveCompletionMenu(
  registry: CommandRegistry,
  value: string,
  cursorOffset: number,
  baseDir?: string,
): CompletionMenu {
  const slashToken = detectSlashToken(value, cursorOffset);
  if (slashToken) {
    const items = registry.suggestions(slashToken.token);
    // Always surface the slash menu while the token is active — including a
    // bare `/` (full catalogue) — so the user never loses command discovery
    // after a focus glitch or an @-mention session.
    if (items.length > 0 || slashToken.token === "/") {
      return {
        kind: "slash",
        start: slashToken.start,
        end: slashToken.end,
        items:
          items.length > 0
            ? items
            : registry.suggestions(""), // full catalogue fallback
      };
    }
  }
  const mention = mentionSuggestions(value, cursorOffset, baseDir);
  if (mention && mention.suggestions.length > 0) {
    return { kind: "mention", start: mention.start, items: mention.suggestions };
  }
  return { kind: "none" };
}
