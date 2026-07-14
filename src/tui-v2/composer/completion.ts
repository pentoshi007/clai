/**
 * Cursor-aware slash and file-mention completion (INPUT-008, V2-044/045).
 *
 * Slash commands are only recognized while the cursor is still inside the
 * command token on the first line — once the cursor moves past it (typing
 * arguments) or onto a later line, the menu closes even though the value
 * still starts with "/". File mentions reuse the existing renderer-independent
 * detector (`src/ui/mentions.ts`) so v2 and the classic REPL agree on the
 * token/suggestion rules.
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
  if (!value.startsWith("/")) return undefined;
  const firstLineEnd = value.indexOf("\n");
  const lineEnd = firstLineEnd === -1 ? value.length : firstLineEnd;
  if (cursorOffset > lineEnd) return undefined;
  const line = value.slice(0, lineEnd);
  const boundary = line.search(/\s/);
  const tokenEnd = boundary === -1 ? line.length : boundary;
  if (cursorOffset > tokenEnd) return undefined;
  return { token: line.slice(0, tokenEnd), start: 0, end: tokenEnd };
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
    if (items.length > 0) {
      return { kind: "slash", start: slashToken.start, end: slashToken.end, items };
    }
  }
  const mention = mentionSuggestions(value, cursorOffset, baseDir);
  if (mention && mention.suggestions.length > 0) {
    return { kind: "mention", start: mention.start, items: mention.suggestions };
  }
  return { kind: "none" };
}
