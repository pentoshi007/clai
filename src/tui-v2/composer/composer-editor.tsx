/** @jsxImportSource @opentui/react */
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { countRender } from "../perf/render-counters.js";
import {
  decodePasteBytes,
  type KeyEvent,
  type MouseEvent,
  type TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { shouldStoreInPromptHistory } from "../../ui-core/composer/input-history.js";
import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { formatAttachmentReference } from "../../ui/mentions.js";
import { getConfig, getProviderModel } from "../../store/config.js";
import { effectiveThinkingEffort } from "../../llm/capabilities.js";
import type { AppServices } from "../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../ui-core/rendering/theme.js";
import { chordFromKeyEvent } from "../input/chord-from-opentui-key.js";
import { PromptHistory } from "../../ui-core/composer/prompt-history.js";
import {
  ARROW_BURST_WINDOW_MS,
  resolveArrowIntent,
} from "../../ui-core/composer/arrow-intent.js";
import {
  isLargePaste,
  PasteRegistry,
  samePastePlaceholderEntries,
  type PastePlaceholderEntry,
} from "../../ui-core/composer/paste-placeholder.js";
import {
  activateSlashCompletion,
  resolveCompletionMenu,
  sameCompletionMenu,
  type CompletionMenu,
} from "../../ui-core/composer/completion.js";
import {
  initialCompletionViewportState,
  reduceCompletionViewport,
  type CompletionViewportAction,
} from "../../ui-core/composer/completion-viewport.js";
import { buildComposerTextareaOverrides } from "./textarea-keybindings.js";
import { composerActionPort } from "../../ui-core/composer/composer-action-port.js";
import { useDraftActions } from "./use-draft-actions.js";
import { createComposerImagePaste } from "./composer-image-paste.js";
import { notify } from "../../ui-core/notify.js";
import { CompletionMenuView } from "../components/completion/completion-menu.js";
import { ComposerInputBox } from "../components/composer/composer-input-box.js";
import { PasteChipRow } from "../components/composer/paste-chip.js";
import { paintDraftMentions } from "./composer-highlight.js";
import { skillNamesSnapshot } from "../../skills/registry.js";
import { useOverlayState } from "../../ui-core/react/use-overlay.js";
import { useSessionState } from "../../ui-core/react/use-session-state.js";
import { clipComposerMeta, formatComposerMeta } from "../../ui-core/composer/composer-meta.js";
import { transcriptScrollPort } from "../components/transcript/transcript-scroll-port.js";
import { consumePlanSuggestionInput } from "../../ui-core/plan/plan-lifecycle.js";
import {
  countComposerVisualLines,
  resolveComposerTextRows,
} from "../../ui-core/composer/composer-height.js";
import {
  composerDraftOverflows,
  composerOwnsWheel,
  measureComposerLines,
  wheelChatDelta,
} from "./composer-wheel.js";
import { disableNativeTextareaScroll } from "./disable-native-textarea-scroll.js";

export interface ComposerEditorProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly width: number;
  readonly height: number;
  readonly maxSuggestions?: number | undefined;
  readonly running?: boolean | undefined;
  readonly inputSuspended?: boolean | undefined;
  readonly focused: boolean;
  readonly onEscapeCancel?: (() => void) | undefined;
  readonly seedDraft?: { readonly token: number; readonly text: string } | undefined;
}
const textareaKeyBindings = buildComposerTextareaOverrides() as never;

function ComposerEditorImpl(props: ComposerEditorProps): ReactNode {
  countRender("ComposerEditor");
  const { services, theme } = props;
  const editorRef = useRef<TextareaRenderable>(null);
  const promptHistory = useRef(new PromptHistory());
  const pasteRegistry = useRef(new PasteRegistry());
  const imagePaste = createComposerImagePaste(services, editorRef, () => {
    syncContentRows();
    refreshMenu();
  });
  const arrowBurst = useRef({ count: 0, lastAt: 0 });
  const [menu, setMenu] = useState<CompletionMenu>({ kind: "none" });
  const [completionView, setCompletionView] = useState(
    initialCompletionViewportState,
  );
  const [acceptedSlash, setAcceptedSlash] = useState<string | undefined>(undefined);
  const [contentRows, setContentRows] = useState(1);
  const [pasteChips, setPasteChips] = useState<PastePlaceholderEntry[]>([]);
  const menuRef = useRef(menu);
  const completionViewRef = useRef(completionView);
  const acceptedSlashRef = useRef(acceptedSlash);
  menuRef.current = menu;
  completionViewRef.current = completionView;
  acceptedSlashRef.current = acceptedSlash;
  const menuKindRef = useRef(menu.kind);
  menuKindRef.current = menu.kind;
  const selected = completionView.selected;

  function applyCompletionViewport(
    action: CompletionViewportAction,
    source: CompletionMenu = menuRef.current,
  ): void {
    const next = reduceCompletionViewport(
      completionViewRef.current,
      action,
      {
        itemCount: source.kind === "none" ? 0 : source.items.length,
        maxRows: props.maxSuggestions ?? 10,
      },
    );
    completionViewRef.current = next;
    setCompletionView(next);
  }

  useEffect(() => {
    applyCompletionViewport({ type: "reconcile" });
  }, [props.maxSuggestions]);
  const overlay = useOverlayState(services.overlay);
  const session = useSessionState(services.session);
  const cfg = getConfig();
  const activeProvider = session.provider ?? cfg.defaultProvider;
  const activeModel = session.model ?? getProviderModel(activeProvider);
  const metaLabel = formatComposerMeta(
    activeProvider,
    activeModel,
    cfg.permissions ?? "default",
    effectiveThinkingEffort(activeProvider, activeModel, cfg.thinking),
  );

  const shouldOwnKeyboard =
    overlay.kind === "none" && props.focused && !props.inputSuspended;
  useEffect(() => {
    if (shouldOwnKeyboard) editorRef.current?.focus();
    else editorRef.current?.blur();
  }, [shouldOwnKeyboard, props.running]);

  useEffect(() => {
    if (shouldOwnKeyboard) return;
    let restore = disableNativeTextareaScroll(editorRef.current);
    const frame = requestAnimationFrame(() => {
      restore();
      restore = disableNativeTextareaScroll(editorRef.current);
    });
    return () => {
      cancelAnimationFrame(frame);
      restore();
    };
  }, [shouldOwnKeyboard]);

  const lastSeedToken = useRef<number | undefined>(undefined);
  useEffect(() => {
    const seed = props.seedDraft;
    if (
      !seed ||
      seed.token === lastSeedToken.current ||
      props.inputSuspended
    ) {
      return;
    }
    lastSeedToken.current = seed.token;
    const editor = editorRef.current;
    if (!editor) return;
    editor.setText(seed.text);
    editor.gotoBufferEnd();
    services.focus.focusRegion("composer");
    editor.focus();
    resetMenuState();
    queueMicrotask(() => {
      refreshMenu();
      syncContentRows();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed token is the trigger
  }, [props.seedDraft?.token, props.inputSuspended]);

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (props.inputSuspended) return;
    const chord = chordFromKeyEvent(key);

    if (imagePaste.handleChord(chord, overlay.kind, key)) return;

    if (overlay.kind !== "none") return;

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
    if (props.inputSuspended || overlay.kind !== "none") return;
    if (!props.focused) {
      services.focus.focusRegion("composer");
      editorRef.current?.focus();
    }
    const text = sanitizeDisplayText(decodePasteBytes(event.bytes));
    if (imagePaste.handlePaste(text, event)) return;
    if (imagePaste.handleDroppedImages(text, event)) return;
    if (!isLargePaste(text)) return;
    event.preventDefault();
    const entry = pasteRegistry.current.register(text);
    editorRef.current?.insertText(entry.token);
    queueMicrotask(syncContentRows);
  });

  function expandPasteChip(id: number): void {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setText(pasteRegistry.current.expandOne(editor.plainText, id));
    editor.gotoBufferEnd();
    queueMicrotask(() => {
      syncContentRows();
      refreshMenu();
    });
  }

  function syncMentions(): void {
    const editor = editorRef.current;
    if (!editor) return;
    const text = editor.plainText;
    const servers = services.mcp.serverNames();
    paintDraftMentions({
      editor,
      text,
      skills: skillNamesSnapshot(),
      skillColor: theme.activity,
      servers,
      serverColor: theme.aqua,
    });
    services.mcp.applyMentionSelection(text);
  }

  function syncContentRows(): void {
    const editor = editorRef.current;
    if (!editor) {
      setContentRows(1);
      setPasteChips([]);
      return;
    }
    syncMentions();
    const wrapWidth = Math.max(10, props.width - 6);
    const estimatedRows = countComposerVisualLines(editor.plainText, wrapWidth);
    const nextRows = measureComposerLines(editor, estimatedRows);
    setContentRows((current) => (current === nextRows ? current : nextRows));
    const nextChips = pasteRegistry.current.activeIn(editor.plainText);
    setPasteChips((current) =>
      samePastePlaceholderEntries(current, nextChips) ? current : nextChips,
    );
    composerActionPort.setHasDraft(editor.plainText.trim().length > 0);
  }

  function refreshMenu(): void {
    const editor = editorRef.current;
    if (!editor) return;
    const next = resolveCompletionMenu(
      services.commands,
      editor.plainText,
      editor.cursorOffset,
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
      if (sameCompletionMenu(prev, next)) {
        menuRef.current = prev;
        menuKindRef.current = prev.kind;
        return prev;
      }
      if (prev.kind === next.kind && next.kind !== "none" && prev.kind !== "none") {
        const sel = completionViewRef.current.selected;
        const prevName =
          prev.kind === "slash"
            ? prev.items[sel]?.name
            : prev.items[sel]?.value;
        if (prevName) {
          const idx =
            next.kind === "slash"
              ? next.items.findIndex((i) => i.name === prevName)
              : next.items.findIndex((i) => i.value === prevName);
          applyCompletionViewport(
            { type: "reconcile", selected: idx >= 0 ? idx : 0 },
            next,
          );
        } else {
          applyCompletionViewport({ type: "reconcile", selected: 0 }, next);
        }
      } else {
        applyCompletionViewport({ type: "reset" }, next);
        if (next.kind !== "none") {
          arrowBurst.current = { count: 0, lastAt: 0 };
        }
      }
      menuRef.current = next;
      menuKindRef.current = next.kind;
      return next;
    });
  }

  function acceptSuggestion(opts?: {
    readonly index?: number;
    readonly drillDir?: boolean;
    readonly attachDir?: boolean;
  }): void {
    const editor = editorRef.current;
    const current = menuRef.current;
    const sel = opts?.index ?? completionViewRef.current.selected;
    if (opts?.index !== undefined) {
      applyCompletionViewport({ type: "select", index: opts.index }, current);
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
        if (item.value === "") {
          replacement = opts?.attachDir ? `@. ` : `@`;
          keepMentionOpen = !opts?.attachDir;
        } else {
          const dirValue = item.value.endsWith("/")
            ? item.value
            : `${item.value}/`;
          if (opts?.attachDir) {
            replacement = `@${dirValue.replace(/\/$/, "")} `;
            keepMentionOpen = false;
          } else {
            replacement = `@${dirValue}`;
            keepMentionOpen = true;
          }
        }
      } else {
        replacement = `${formatAttachmentReference(item.value)} `;
        keepMentionOpen = false;
      }
    }
    const next = value.slice(0, start) + replacement + value.slice(replacementEnd);
    editor.setText(next);
    try {
      editor.editBuffer.setCursorByOffset?.(start + replacement.length);
    } catch {
      try {
        editor.setCursor(0, start + replacement.length);
      } catch {
        editor.gotoBufferEnd();
      }
    }
    applyCompletionViewport({ type: "reset" }, current);
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

  function runSlashCompletion(index: number): void {
    const editor = editorRef.current;
    if (!editor) return;
    const activated = activateSlashCompletion(
      menuRef.current,
      editor.plainText,
      index,
    );
    if (!activated) return;
    editor.setText(activated.value);
    try {
      editor.editBuffer.setCursorByOffset?.(activated.cursorOffset);
    } catch {
      try {
        editor.setCursor(0, activated.cursorOffset);
      } catch {
        editor.gotoBufferEnd();
      }
    }
    menuRef.current = { kind: "none" };
    menuKindRef.current = "none";
    acceptedSlashRef.current = undefined;
    setMenu({ kind: "none" });
    setAcceptedSlash(undefined);
    applyCompletionViewport({ type: "reset" }, { kind: "none" });
    services.focus.focusRegion("composer");
    editor.focus();
    syncContentRows();
    void dispatchOrRunTurn(activated.command);
  }

  function submit(): void {
    const editor = editorRef.current;
    if (!editor) return;
    const current = menuRef.current;
    if (current.kind === "slash") {
      runSlashCompletion(completionViewRef.current.selected);
      return;
    }
    if (current.kind === "mention") {
      const item = current.items[completionViewRef.current.selected];
      if (item?.isDir) {
        acceptSuggestion({ attachDir: true });
        return;
      }
      acceptSuggestion();
      return;
    }
    const expanded = pasteRegistry.current.expand(editor.plainText).trim();
    clearDraftState(editor);
    if (!expanded) return;
    if (shouldStoreInPromptHistory(expanded)) promptHistory.current.push(expanded);
    void dispatchOrRunTurn(expanded);
  }

  async function dispatchOrRunTurn(prompt: string): Promise<void> {
    const trimmed = prompt.trim();
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
    const revision = consumePlanSuggestionInput(services, prompt);
    if (revision) {
      if (services.session.getState().running) {
        services.session.enqueue(revision.modelPrompt, {
          displayPrompt: revision.displayPrompt,
        });
      } else {
        await services.session.submit(revision.modelPrompt, {
          displayPrompt: revision.displayPrompt,
        });
      }
      return;
    }
    if (services.session.getState().running) {
      services.session.enqueue(prompt);
    } else {
      await services.session.submit(prompt);
    }
  }

  function onComposerWheel(event: MouseEvent): void {
    if (props.inputSuspended || !event.scroll || overlay.kind !== "none") return;
    const editor = editorRef.current;
    const visible = resolveComposerTextRows(contentRows, props.height);
    if (shouldOwnKeyboard && editor) {
      const lines = measureComposerLines(editor, contentRows);
      if (composerOwnsWheel(lines) || composerDraftOverflows(lines, visible)) {
        event.stopPropagation();
        return;
      }
    }
    event.preventDefault();
    event.stopPropagation();
    services.focus.focusRegion("transcript");
    editor?.blur();
    const dy = wheelChatDelta(event.scroll.direction, event.scroll.delta);
    if (dy !== 0) transcriptScrollPort.scrollBy(dy);
  }

  function handleMenuOrComposerKey(key: KeyEvent): void {
    const editor = editorRef.current;
    if (!editor) return;
    const chord = chordFromKeyEvent(key);
    const current = menuRef.current;

    if (
      current.kind === "none" &&
      chord === "escape" &&
      (services.session.getState().running ||
        services.session.getState().compacting)
    ) {
      key.preventDefault();
      props.onEscapeCancel?.();
      return;
    }

    if (current.kind !== "none") {
      const itemCount = current.items.length;
      if (chord === "up" && itemCount > 0) {
        const next =
          (completionViewRef.current.selected - 1 + itemCount) % itemCount;
        applyCompletionViewport({ type: "select", index: next }, current);
        key.preventDefault();
        return;
      }
      if (chord === "down" && itemCount > 0) {
        const next = (completionViewRef.current.selected + 1) % itemCount;
        applyCompletionViewport({ type: "select", index: next }, current);
        key.preventDefault();
        return;
      }
      if (chord === "enter" && current.kind === "slash") {
        runSlashCompletion(completionViewRef.current.selected);
        key.preventDefault();
        return;
      }
      if (
        chord === "tab" &&
        current.kind === "slash" &&
        acceptedSlashRef.current
      ) {
        key.preventDefault();
        return;
      }
      if (chord === "tab" || chord === "enter") {
        if (current.kind === "mention") {
          const item = current.items[completionViewRef.current.selected];
          if (item?.isDir) {
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
        resetMenuState();
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
      if (editor.plainText.length === 0) {
        key.preventDefault();
        transcriptScrollPort.scrollToTop();
        notify(services, "Chat · top · ^U", { key: "scroll", durationMs: 1200 });
      }
      return;
    }
    if (chord === "ctrl+x") {
      key.preventDefault();
      void draftActions.cut();
      return;
    }
    if (chord === "ctrl+q") {
      key.preventDefault();
      if (editor.plainText.length > 0) {
        draftActions.clear(editor);
        notify(services, "Draft cleared · ^Q", { key: "draft", durationMs: 1400 });
      }
      return;
    }
    if (chord === "pageup" || chord === "pagedown") {
      key.preventDefault();
      services.focus.focusRegion("transcript");
      editor.blur();
      const page = 10;
      transcriptScrollPort.scrollBy(chord === "pageup" ? -page : page);
      return;
    }

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
    if (props.inputSuspended) return;
    if (!shouldOwnKeyboard && menuKindRef.current === "none") return;
    handleMenuOrComposerKey(key);
  }

  useEffect(() => {
    syncContentRows();
    const frame = requestAnimationFrame(syncContentRows);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- width-only reflow
  }, [props.width]);

  const inputWidth = Math.max(20, props.width);
  const textRows = resolveComposerTextRows(contentRows, props.height);
  const boxHeight = textRows + 2;
  const metaShown = clipComposerMeta(metaLabel, inputWidth);
  const chromeFg = shouldOwnKeyboard ? theme.inputBorder : theme.muted;

  function focusComposer(): boolean {
    if (props.inputSuspended) return false;
    services.focus.focusRegion("composer");
    editorRef.current?.focus();
    return true;
  }

  const resetMenuState = (): void => {
    menuRef.current = { kind: "none" };
    menuKindRef.current = "none";
    acceptedSlashRef.current = undefined;
    setMenu({ kind: "none" });
    setAcceptedSlash(undefined);
    applyCompletionViewport({ type: "reset" }, { kind: "none" });
  };

  const draftActions = useDraftActions({
    editorRef,
    services,
    expandPastes: (text) => pasteRegistry.current.expand(text),
    resetRegistries: () => {
      pasteRegistry.current.clear();
      promptHistory.current.reset();
    },
    resetMenuState,
    setContentRows,
    clearPasteChips: () => setPasteChips([]),
    focusComposer,
    refreshMenu,
    syncContentRows,
    notify: (message, durationMs) =>
      notify(services, message, { key: "draft", durationMs }),
  });
  const clearDraftState = draftActions.clear;

  function hoverCompletion(index: number | undefined): void {
    applyCompletionViewport({ type: "hover", index });
  }

  function scrollCompletion(rows: number): void {
    applyCompletionViewport({ type: "scroll", rows });
  }

  function activateCompletion(index: number): void {
    focusComposer();
    const current = menuRef.current;
    if (current.kind === "none") return;
    if (current.kind === "slash") {
      runSlashCompletion(index);
      return;
    }
    if (current.items[index]?.isDir) {
      acceptSuggestion({ index, drillDir: true });
      return;
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
        hoveredIndex={completionView.hovered}
        viewportOffset={completionView.offset}
        theme={theme}
        width={inputWidth}
        maxRows={props.maxSuggestions ?? 10}
        onHoverIndex={hoverCompletion}
        onActivateIndex={activateCompletion}
        onScrollRows={scrollCompletion}
      />
      <PasteChipRow
        entries={pasteChips}
        theme={theme}
        width={inputWidth}
        onExpand={expandPasteChip}
      />

      <ComposerInputBox
        theme={theme}
        editorRef={editorRef}
        focused={shouldOwnKeyboard}
        running={props.running}
        width={inputWidth}
        boxHeight={boxHeight}
        metaShown={metaShown}
        chromeFg={chromeFg}
        keyBindings={textareaKeyBindings}
        onMouseDown={focusComposer}
        onMouseScroll={onComposerWheel}
        onSubmit={submit}
        onContentChange={() => {
          refreshMenu();
          queueMicrotask(syncContentRows);
        }}
        onCursorChange={() => {
          refreshMenu();
          syncContentRows();
        }}
        onKeyDown={onKeyDown}
      />
    </box>
  );
}
export const ComposerEditor = memo(ComposerEditorImpl);