import type { CompletionMenu } from "../../ui-core/composer/completion.js";
import { formatAttachmentReference } from "../../ui/mentions.js";
import { replaceRange, type EditorState } from "../chrome/editor-model.js";
import { completionCommonPrefix, sortSuggestions } from "./completion-rows.js";

export type CompletionIntent = "complete" | "accept";

export interface AcceptCompletionInput {
  readonly menu: CompletionMenu;
  readonly state: EditorState;
  readonly active: number;
  readonly intent: CompletionIntent;
  readonly baseDir?: string | undefined;
}

export interface AcceptedCompletion {
  readonly state: EditorState;
  readonly keepMenuOpen: boolean;
  readonly acceptedSlash: string | undefined;
}

function slashReplacementEnd(text: string, end: number): number {
  return /^\s*$/.test(text.slice(end)) ? text.length : end;
}

export function acceptCompletion(
  input: AcceptCompletionInput,
): AcceptedCompletion | undefined {
  const { menu, state } = input;
  if (menu.kind === "none") return undefined;

  if (menu.kind === "slash") {
    const item = menu.items[input.active];
    if (!item) return undefined;
    const replacement = `/${item.name} `;
    return {
      state: replaceRange(
        state,
        menu.start,
        slashReplacementEnd(state.text, menu.end),
        replacement,
      ),
      keepMenuOpen: false,
      acceptedSlash: `/${item.name}`,
    };
  }

  const items = sortSuggestions(menu.items);
  const item = items[input.active];
  if (!item) return undefined;

  if (item.isDir) {
    if (item.value === "") {
      const attach = input.intent === "accept";
      return {
        state: replaceRange(state, menu.start, state.cursor, attach ? "@. " : "@"),
        keepMenuOpen: !attach,
        acceptedSlash: undefined,
      };
    }
    const dir = item.value.endsWith("/") ? item.value : `${item.value}/`;
    const attach = input.intent === "accept";
    return {
      state: replaceRange(
        state,
        menu.start,
        state.cursor,
        attach ? `@${dir.replace(/\/$/, "")} ` : `@${dir}`,
      ),
      keepMenuOpen: !attach,
      acceptedSlash: undefined,
    };
  }

  return {
    state: replaceRange(
      state,
      menu.start,
      state.cursor,
      `${formatAttachmentReference(item.value, input.baseDir)} `,
    ),
    keepMenuOpen: false,
    acceptedSlash: undefined,
  };
}

export function completeCommonPrefix(
  menu: CompletionMenu,
  state: EditorState,
): EditorState | undefined {
  if (menu.kind !== "slash" || menu.items.length < 2) return undefined;
  const prefix = completionCommonPrefix(menu.items.map((item) => `/${item.name}`));
  const current = state.text.slice(menu.start, menu.end);
  if (prefix.length <= current.length) return undefined;
  return replaceRange(state, menu.start, menu.end, prefix);
}
