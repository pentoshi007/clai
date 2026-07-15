/** @jsxImportSource @opentui/react */
/**
 * Composer: completion menu above input; provider/model/permissions on the
 * top border. Focus is region-aware so transcript scroll is not stolen.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  decodePasteBytes,
  stripAnsiSequences,
  TextAttributes,
  type KeyEvent,
  type MouseEvent,
  type TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { shouldStoreInPromptHistory } from "../../tui/input-history.js";
import { safeCwd } from "../../os/cwd.js";
import { getConfig } from "../../store/config.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { Theme } from "../rendering/theme.js";
import { chordFromKeyEvent } from "../actions/chord-from-key.js";
import { PromptHistory } from "./prompt-history.js";
import {
  ARROW_BURST_THRESHOLD,
  ARROW_BURST_WINDOW_MS,
  resolveArrowIntent,
} from "./arrow-intent.js";
import { isLargePaste, PasteRegistry } from "./paste-placeholder.js";
import { resolveCompletionMenu, type CompletionMenu } from "./completion.js";
import { buildComposerTextareaOverrides } from "./textarea-keybindings.js";

import { CompletionMenuView } from "../components/completion/completion-menu.js";
import { useOverlayState } from "../state/use-overlay.js";
import { useSessionState } from "../state/use-session-state.js";
import { clipComposerMeta, formatComposerMeta } from "./composer-meta.js";
import { transcriptScrollPort } from "../components/transcript/transcript-scroll-port.js";
import {
  countComposerVisualLines,
  resolveComposerTextRows,
} from "./composer-height.js";

export interface ComposerEditorProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly width: number;
  /**
   * Maximum editable text rows (not including the rounded border).
   * The box starts at 1 row and grows with content up to this cap.
   */
  readonly height: number;
  /** The command window gets denser on tall terminals, never a one-row list. */
  readonly maxSuggestions?: number | undefined;
  /** Mirrors the legacy composer hint while a turn is active. */
  readonly running?: boolean | undefined;
  /** Visual region focus from the shell (Tab cycle). */
  readonly focused: boolean;
  /**
   * When set (e.g. Edit on a queued prompt), replace the input with this
   * draft. `token` must change each time so the same text can be re-applied.
   */
  readonly seedDraft?: { readonly token: number; readonly text: string } | undefined;
}

const textareaKeyBindings = buildComposerTextareaOverrides() as never;

export function ComposerEditor(props: ComposerEditorProps): ReactNode {
  const { services, theme } = props;
  const editorRef = useRef<TextareaRenderable>(null);
  const promptHistory = useRef(new PromptHistory());
  const pasteRegistry = useRef(new PasteRegistry());
  /** Trackpad-as-arrows: count rapid ↑/↓ so we scroll chat instead of history. */
  const arrowBurst = useRef({ count: 0, lastAt: 0 });
  const [menu, setMenu] = useState<CompletionMenu>({ kind: "none" });
  const [selected, setSelected] = useState(0);
  const [acceptedSlash, setAcceptedSlash] = useState<string | undefined>(undefined);
  /** Visual rows of current prompt — drives grow-with-content height. */
  const [contentRows, setContentRows] = useState(1);
  // Refs mirror React state so OpenTUI key handlers never see a stale menu
  // after @ completion or focus reclaim (the intermittent "arrows dead / /
  // menu missing" failure mode).
  const menuRef = useRef(menu);
  const selectedRef = useRef(selected);
  const acceptedSlashRef = useRef(acceptedSlash);
  menuRef.current = menu;
  selectedRef.current = selected;
  acceptedSlashRef.current = acceptedSlash;
  const menuKindRef = useRef(menu.kind);
  menuKindRef.current = menu.kind;
  const overlay = useOverlayState(services.overlay);
  const session = useSessionState(services.session);
  // Prefer live session selection; fall back to config so the border always
  // shows provider · model · permissions (never empty of provider).
  const cfg = getConfig();
  const metaLabel = formatComposerMeta(
    session.provider ?? cfg.defaultProvider,
    session.model ?? cfg.defaultModel,
    cfg.permissions ?? "default",
  );

  // Own the keyboard only when the shell says the composer is focused and no
  // overlay is open. Always blur when we don't own input — otherwise the
  // textarea keeps focus and touchpad/↑↓ walk prompt history instead of
  // scrolling the chat.
  const shouldOwnKeyboard = overlay.kind === "none" && props.focused;
  useEffect(() => {
    if (shouldOwnKeyboard) editorRef.current?.focus();
    else editorRef.current?.blur();
  }, [shouldOwnKeyboard]);

  // Pull a draft from the queue "Edit" action into the input.
  const lastSeedToken = useRef<number | undefined>(undefined);
  useEffect(() => {
    const seed = props.seedDraft;
    if (!seed || seed.token === lastSeedToken.current) return;
    lastSeedToken.current = seed.token;
    const editor = editorRef.current;
    if (!editor) return;
    editor.setText(seed.text);
    editor.gotoBufferEnd();
    services.focus.focusRegion("composer");
    editor.focus();
    menuRef.current = { kind: "none" };
    menuKindRef.current = "none";
    acceptedSlashRef.current = undefined;
    setMenu({ kind: "none" });
    setAcceptedSlash(undefined);
    queueMicrotask(() => {
      refreshMenu();
      syncContentRows();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed token is the trigger
  }, [props.seedDraft?.token]);

  // Global keyboard: (1) keep completion menus navigable even if the textarea
  // briefly loses focus after @/click, (2) reclaim the composer on printable
  // keys so typing never feels dead.
  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);

    // Esc aborts a live turn from any region (menu closed). Ctrl+C is owned
    // by App (`app.interrupt`: abort then double-press exit) so we must not
    // swallow it here — otherwise the quit arm never arms and exit needs
    // three presses.
    if (
      overlay.kind === "none" &&
      menuKindRef.current === "none" &&
      chord === "escape" &&
      services.session.getState().running
    ) {
      key.preventDefault();
      services.session.abort();
      return;
    }

    if (overlay.kind !== "none") return;

    // Completion menu wins over transcript scroll / history when the
    // textarea has lost focus (post-@ / click glitch). When the composer
    // already owns input, onKeyDown handles menu keys — avoid double-step.
    if (menuKindRef.current !== "none" && !shouldOwnKeyboard) {
      if (
        chord === "up" ||
        chord === "down" ||
        chord === "tab" ||
        chord === "enter" ||
        chord === "escape"
      ) {
        services.focus.focusRegion("composer");
        editorRef.current?.focus();
        handleMenuOrComposerKey(key);
        return;
      }
    }

    if (shouldOwnKeyboard) return;

    const activeContext = services.focus.activeContext();
    if (activeContext === "transcript-search") return;
    // Don't steal navigation keys from transcript/plan scroll.
    if (
      chord === "up" ||
      chord === "down" ||
      chord === "pageup" ||
      chord === "pagedown" ||
      chord === "home" ||
      chord === "end" ||
      key.name === "up" ||
      key.name === "down"
    ) {
      return;
    }
    if (key.ctrl || key.meta || key.option || key.super) return;
    const text = key.sequence;
    if (!text || text.length !== 1 || text < " " || key.name === "tab") return;
    key.preventDefault();
    services.focus.focusRegion("composer");
    editorRef.current?.focus();
    editorRef.current?.insertText(text);
    queueMicrotask(() => {
      refreshMenu();
      syncContentRows();
    });
  });

  usePaste((event) => {
    if (!shouldOwnKeyboard) return;
    const text = stripAnsiSequences(decodePasteBytes(event.bytes));
    if (!isLargePaste(text)) return;
    event.preventDefault();
    const entry = pasteRegistry.current.register(text);
    editorRef.current?.insertText(entry.token);
    queueMicrotask(syncContentRows);
  });

  /** Grow/shrink the input box with newlines and soft-wrap (classic parity). */
  function syncContentRows(): void {
    const editor = editorRef.current;
    if (!editor) {
      setContentRows(1);
      return;
    }
    // Prompt "❯ " (2) + horizontal padding (2) leave this for wrapped text.
    const wrapWidth = Math.max(10, props.width - 4);
    setContentRows(countComposerVisualLines(editor.plainText, wrapWidth));
  }

  function refreshMenu(): void {
    const editor = editorRef.current;
    if (!editor) return;
    const next = resolveCompletionMenu(
      services.commands,
      editor.plainText,
      editor.cursorOffset,
      safeCwd(),
    );
    setAcceptedSlash((accepted) => {
      if (!accepted || next.kind !== "slash") return undefined;
      const token = editor.plainText.slice(next.start, next.end);
      const suffix = editor.plainText.slice(next.end);
      const kept =
        token === accepted && !/\S/.test(suffix) ? accepted : undefined;
      acceptedSlashRef.current = kept;
      return kept;
    });
    setMenu((prev) => {
      // Keep selection stable when the filtered list only shrinks/grows.
      if (prev.kind === next.kind && next.kind !== "none" && prev.kind !== "none") {
        const sel = selectedRef.current;
        const prevName =
          prev.kind === "slash"
            ? prev.items[sel]?.name
            : prev.items[sel]?.value;
        if (prevName) {
          const idx =
            next.kind === "slash"
              ? next.items.findIndex((i) => i.name === prevName)
              : next.items.findIndex((i) => i.value === prevName);
          const nextSel = idx >= 0 ? idx : 0;
          selectedRef.current = nextSel;
          setSelected(nextSel);
        } else {
          selectedRef.current = 0;
          setSelected(0);
        }
      } else {
        selectedRef.current = 0;
        setSelected(0);
        // Opening a menu resets trackpad burst so ↑/↓ navigate options
        // instead of immediately scrolling the transcript.
        if (next.kind !== "none") {
          arrowBurst.current = { count: 0, lastAt: 0 };
        }
      }
      menuRef.current = next;
      menuKindRef.current = next.kind;
      return next;
    });
  }

  /**
   * Accept the highlighted completion.
   * - slash: insert `/name `
   * - mention file: insert `@path ` and close
   * - mention dir + drill: insert `@path/` and keep browsing children (Tab)
   * - mention dir + attach: insert `@path ` and close (Enter) so the whole
   *   folder is attached on submit
   */
  function acceptSuggestion(opts?: {
    readonly index?: number;
    readonly drillDir?: boolean;
    readonly attachDir?: boolean;
  }): void {
    const editor = editorRef.current;
    const current = menuRef.current;
    const sel = opts?.index ?? selectedRef.current;
    if (opts?.index !== undefined) {
      selectedRef.current = opts.index;
      setSelected(opts.index);
    }
    if (!editor || current.kind === "none") return;
    const cursor = editor.cursorOffset;
    const value = editor.plainText;
    let replacement: string;
    let start: number;
    let replacementEnd: number;
    let keepMentionOpen = false;
    if (current.kind === "slash") {
      const item = current.items[sel];
      if (!item) return;
      replacement = `/${item.name} `;
      start = current.start;
      replacementEnd = /^\s*$/.test(value.slice(current.end))
        ? value.length
        : current.end;
      const accepted = `/${item.name}`;
      acceptedSlashRef.current = accepted;
      setAcceptedSlash(accepted);
    } else {
      const item = current.items[sel];
      if (!item) return;
      start = current.start;
      replacementEnd = cursor;
      acceptedSlashRef.current = undefined;
      setAcceptedSlash(undefined);
      if (item.isDir) {
        // `../` to project root uses empty value — back to `@` listing.
        if (item.value === "") {
          replacement = opts?.attachDir ? `@. ` : `@`;
          keepMentionOpen = !opts?.attachDir;
        } else {
          const dirValue = item.value.endsWith("/")
            ? item.value
            : `${item.value}/`;
          if (opts?.attachDir) {
            // Whole directory as an attachment token (space closes the mention).
            replacement = `@${dirValue.replace(/\/$/, "")} `;
            keepMentionOpen = false;
          } else {
            // Drill into the directory (Tab).
            replacement = `@${dirValue}`;
            keepMentionOpen = true;
          }
        }
      } else {
        replacement = `@${item.value} `;
        keepMentionOpen = false;
      }
    }
    const next = value.slice(0, start) + replacement + value.slice(replacementEnd);
    editor.setText(next);
    // Place cursor after the inserted token.
    try {
      editor.editBuffer.setCursorByOffset?.(start + replacement.length);
    } catch {
      try {
        editor.setCursor(0, start + replacement.length);
      } catch {
        editor.gotoBufferEnd();
      }
    }
    selectedRef.current = 0;
    setSelected(0);
    // `setText` can move native focus in OpenTUI. Keep the cursor live after
    // a Tab/Enter completion rather than leaving the user in a dead region.
    services.focus.focusRegion("composer");
    editor.focus();
    if (current.kind === "mention" && !keepMentionOpen) {
      menuRef.current = { kind: "none" };
      menuKindRef.current = "none";
      setMenu({ kind: "none" });
    }
    queueMicrotask(() => {
      refreshMenu();
      syncContentRows();
    });
  }

  function submit(): void {
    const editor = editorRef.current;
    if (!editor) return;
    const current = menuRef.current;
    const accepted = acceptedSlashRef.current;
    // With the slash menu open on an already-accepted token (`/model `),
    // Enter runs the command. Otherwise Enter accepts the highlight first.
    if (current.kind !== "none" && !(current.kind === "slash" && accepted)) {
      // Enter on a directory attaches the whole folder; Tab drills (handled
      // in the key handler). Enter here defaults to attach for dirs.
      if (current.kind === "mention") {
        const item = current.items[selectedRef.current];
        if (item?.isDir) {
          acceptSuggestion({ attachDir: true });
          return;
        }
      }
      acceptSuggestion();
      return;
    }
    const expanded = pasteRegistry.current.expand(editor.plainText).trim();
    editor.clear();
    pasteRegistry.current.clear();
    promptHistory.current.reset();
    menuRef.current = { kind: "none" };
    menuKindRef.current = "none";
    acceptedSlashRef.current = undefined;
    setMenu({ kind: "none" });
    setAcceptedSlash(undefined);
    setContentRows(1);
    if (!expanded) return;
    if (shouldStoreInPromptHistory(expanded)) promptHistory.current.push(expanded);
    void dispatchOrRunTurn(expanded);
  }

  async function dispatchOrRunTurn(prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    // Never send slash-shaped input as an agent prompt — that was the
    // intermittent "typed /help and it became a chat message" bug when the
    // completion menu failed to accept first.
    if (services.commands.looksLikeCommand(trimmed)) {
      const invocation = services.commands.parse(trimmed);
      if (!invocation) {
        const token = trimmed.split(/\s/, 1)[0] ?? trimmed;
        services.session.notice(
          "warn",
          `unknown command: ${token}. Try /help`,
        );
        return;
      }
      const handled = await services.commands.dispatch(invocation);
      if (!handled) {
        services.session.notice(
          "warn",
          `command /${invocation.name} is not available right now`,
        );
      }
      return;
    }
    if (services.session.getState().running) {
      services.session.enqueue(prompt);
    } else {
      await services.session.submit(prompt);
    }
  }

  /**
   * Trackpad over the input must scroll the chat — never prompt history.
   * OpenTUI hit-tests the focused textarea first; without this, wheel never
   * reaches the transcript ScrollBox.
   */
  function onComposerWheel(event: MouseEvent): void {
    if (!event.scroll || overlay.kind !== "none") return;
    event.preventDefault();
    event.stopPropagation();
    services.focus.focusRegion("transcript");
    editorRef.current?.blur();
    const { direction, delta } = event.scroll;
    const step = Math.max(1, delta || 1) * 3;
    const dy =
      direction === "up" ? -step : direction === "down" ? step : 0;
    if (dy !== 0) transcriptScrollPort.scrollBy(dy);
  }

  function handleMenuOrComposerKey(key: KeyEvent): void {
    const editor = editorRef.current;
    if (!editor) return;
    const chord = chordFromKeyEvent(key);
    const current = menuRef.current;
    const accepted = acceptedSlashRef.current;

    // Abort a live turn on Esc from the textarea path (OpenTUI can swallow ESC
    // before App's global handler). Ctrl+C is owned by App.interrupt so the
    // double-press exit path can arm on the same first press that aborts.
    // Menu open still wins for dismiss-menu.
    if (
      current.kind === "none" &&
      chord === "escape" &&
      services.session.getState().running
    ) {
      key.preventDefault();
      services.session.abort();
      return;
    }

    if (current.kind !== "none") {
      const itemCount = current.items.length;
      if (chord === "up" && itemCount > 0) {
        const next = (selectedRef.current - 1 + itemCount) % itemCount;
        selectedRef.current = next;
        setSelected(next);
        key.preventDefault();
        return;
      }
      if (chord === "down" && itemCount > 0) {
        const next = (selectedRef.current + 1) % itemCount;
        selectedRef.current = next;
        setSelected(next);
        key.preventDefault();
        return;
      }
      if (chord === "enter" && current.kind === "slash" && accepted) {
        submit();
        key.preventDefault();
        return;
      }
      if (chord === "tab" && current.kind === "slash" && accepted) {
        key.preventDefault();
        return;
      }
      if (chord === "tab" || chord === "enter") {
        if (current.kind === "mention") {
          const item = current.items[selectedRef.current];
          if (item?.isDir) {
            // Tab drills into the folder; Enter attaches the whole folder.
            acceptSuggestion(
              chord === "tab" ? { drillDir: true } : { attachDir: true },
            );
          } else {
            acceptSuggestion();
          }
        } else {
          acceptSuggestion();
        }
        key.preventDefault();
        return;
      }
      if (chord === "escape") {
        menuRef.current = { kind: "none" };
        menuKindRef.current = "none";
        acceptedSlashRef.current = undefined;
        setMenu({ kind: "none" });
        setAcceptedSlash(undefined);
        key.preventDefault();
        return;
      }
    }

    if (chord === "ctrl+j") {
      key.preventDefault();
      services.overlay.openJobs();
      return;
    }
    if (chord === "ctrl+u") {
      key.preventDefault();
      editor.clear();
      promptHistory.current.reset();
      menuRef.current = { kind: "none" };
      menuKindRef.current = "none";
      acceptedSlashRef.current = undefined;
      setMenu({ kind: "none" });
      setAcceptedSlash(undefined);
      setContentRows(1);
      return;
    }
    // Page keys always scroll the chat (classic parity) — never history.
    if (chord === "pageup" || chord === "pagedown") {
      key.preventDefault();
      services.focus.focusRegion("transcript");
      editor.blur();
      const page = 10;
      transcriptScrollPort.scrollBy(chord === "pageup" ? -page : page);
      return;
    }

    // ↑/↓ at line boundary → prompt history (classic). Rapid trackpad bursts
    // still scroll chat; wheel uses onComposerWheel. PageUp/Down scroll chat.
    // Never when a completion menu is open (ref-checked above).
    if (chord === "up" || chord === "down") {
      const now = Date.now();
      if (now - arrowBurst.current.lastAt <= ARROW_BURST_WINDOW_MS) {
        arrowBurst.current.count += 1;
      } else {
        arrowBurst.current.count = 0;
      }
      arrowBurst.current.lastAt = now;

      const intent = resolveArrowIntent({
        chord,
        plainText: editor.plainText,
        line: editor.logicalCursor.row,
        lineCount: editor.lineCount,
        menuOpen: menuKindRef.current !== "none",
        isBrowsingHistory: promptHistory.current.isBrowsing(),
        burstCount: arrowBurst.current.count,
      });

      if (intent === "scroll-chat") {
        key.preventDefault();
        services.focus.focusRegion("transcript");
        editor.blur();
        transcriptScrollPort.scrollBy(chord === "up" ? -3 : 3);
        return;
      }

      if (intent === "history") {
        const recalled =
          chord === "up"
            ? promptHistory.current.prev(editor.plainText)
            : promptHistory.current.next();
        if (recalled !== undefined) {
          key.preventDefault();
          editor.setText(recalled);
          editor.gotoBufferEnd();
          refreshMenu();
          syncContentRows();
        }
      }
    }
  }

  function onKeyDown(key: KeyEvent): void {
    // Only handle when the composer actually owns input — never steal from
    // transcript scroll by force-focusing on every key event. (Menu keys are
    // also routed from the global useKeyboard when focus glitches.)
    if (!shouldOwnKeyboard && menuKindRef.current === "none") return;
    handleMenuOrComposerKey(key);
  }

  // Re-measure soft-wrap rows when the terminal width changes.
  useEffect(() => {
    syncContentRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- width-only reflow
  }, [props.width]);

  const inputWidth = Math.max(20, props.width);
  // Grow with content (Shift+Enter, wrap, history); never exceed shell budget.
  const textRows = resolveComposerTextRows(contentRows, props.height);
  // Editable rows + top/bottom border only — meta sits ON the top border.
  const boxHeight = textRows + 2;
  const metaShown = clipComposerMeta(metaLabel, inputWidth);

  function hoverCompletion(index: number): void {
    selectedRef.current = index;
    setSelected(index);
    services.focus.focusRegion("composer");
    editorRef.current?.focus();
  }

  /** Mouse click: slash/file accept; directory drills open (browse). */
  function activateCompletion(index: number): void {
    services.focus.focusRegion("composer");
    editorRef.current?.focus();
    const current = menuRef.current;
    if (current.kind === "none") return;
    if (current.kind === "mention") {
      const item = current.items[index];
      if (item?.isDir) {
        acceptSuggestion({ index, drillDir: true });
        return;
      }
    }
    acceptSuggestion({ index });
  }

  return (
    <box
      style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}
      onMouseScroll={onComposerWheel}
    >
      <CompletionMenuView
        menu={menu}
        selected={selected}
        theme={theme}
        width={inputWidth}
        maxRows={props.maxSuggestions ?? 10}
        onHoverIndex={hoverCompletion}
        onActivateIndex={activateCompletion}
      />
      <box
        border
        borderStyle="rounded"
        // Provider · model · permissions on the top border (right-aligned).
        {...(metaShown
          ? {
              title: ` ${metaShown} `,
              titleAlignment: "right" as const,
              titleColor: theme.muted,
            }
          : {})}
        style={{
          height: boxHeight,
          width: "100%",
          borderColor: theme.inputBorder,
          backgroundColor: theme.statusBackground,
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: "row",
        }}
        onMouseDown={() => {
          // Explicitly reclaim composer focus when the user clicks the input.
          services.focus.focusRegion("composer");
          editorRef.current?.focus();
        }}
        onMouseScroll={onComposerWheel}
      >
        {/* ❯ + cursor: strong aqua (inputBorder), bold mark like command chrome. */}
        <text
          content="❯ "
          style={{
            fg: theme.inputBorder,
            width: 2,
            flexShrink: 0,
            attributes: TextAttributes.BOLD,
          }}
        />
        <textarea
          ref={editorRef}
          focused={shouldOwnKeyboard}
          // No mouse text-selection — OpenTUI selection steals clicks/touch.
          selectable={false}
          placeholder={
            props.running
              ? "type to queue a message…"
              : `ask anything · @ file or folder · Shift+Enter newline`
          }
          placeholderColor={theme.muted}
          textColor={theme.foreground}
          backgroundColor={theme.statusBackground}
          cursorColor={theme.inputBorder}
          keyBindings={textareaKeyBindings}
          wrapMode="word"
          onSubmit={submit}
          onContentChange={() => {
            refreshMenu();
            syncContentRows();
          }}
          onCursorChange={refreshMenu}
          onKeyDown={onKeyDown}
          style={{ flexGrow: 1, height: textRows }}
        />
      </box>
    </box>
  );
}
