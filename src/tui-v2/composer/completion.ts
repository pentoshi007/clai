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
  if (!value.startsWith("/")) return undefined;
  const firstLineEnd = value.indexOf("\n");
  const lineEnd = firstLineEnd === -1 ? value.length : firstLineEnd;
  if (cursorOffset > lineEnd) return undefined;
  const line = value.slice(0, lineEnd);
  const boundary = line.search(/\s/);
  const tokenEnd = boundary === -1 ? line.length : boundary;
  if (cursorOffset > tokenEnd && /\S/.test(line.slice(tokenEnd))) return undefined;
  const token = line.slice(0, tokenEnd);
  // Absolute/relative path drops (`/Users/...`, `/\...`) are not commands —
  // leave the menu free for normal prompt + @-mention flow.
  const name = token.slice(1);
  if (name.includes("/") || name.includes("\\")) return undefined;
  return { token, start: 0, end: tokenEnd };
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
