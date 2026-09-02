/** @jsxImportSource @opentui/react */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { useTerminalDimensionsContext } from "../../hooks/terminal-dimensions.js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { chordFromKeyEvent } from "../../input/chord-from-opentui-key.js";
import {
  activeIndex,
  filterPickerOptions,
  type PickerOption,
} from "../../../ui-core/rendering/picker-filter.js";
import type { PickerRequest } from "../../../ui-core/controllers/overlay-controller.js";

export interface PickerProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly request: PickerRequest;
}

const HIDDEN_SCROLLBARS = {
  visible: false,
  showArrows: false,
} as const;

function isPrintableFilterChar(key: {
  readonly name: string;
  readonly sequence: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly option?: boolean;
  readonly super?: boolean;
}): boolean {
  if (key.ctrl || key.meta || key.option || key.super) return false;
  const seq = key.sequence;
  if (!seq || seq.length !== 1) return false;
  if (seq === "\x1b" || seq < " ") return false;
  if (
    [
      "return",
      "enter",
      "escape",
      "tab",
      "backspace",
      "delete",
      "up",
      "down",
      "left",
      "right",
      "home",
      "end",
      "pageup",
      "pagedown",
    ].includes(key.name)
  ) {
    return false;
  }
  return true;
}

function pad(text: string, width: number): string {
  if (width <= 0) return text;
  if (text.length >= width) return text.slice(0, Math.max(1, width - 1)) + "…";
  return text + " ".repeat(width - text.length);
}

export function Picker(props: PickerProps): ReactNode {
  const { services, theme, request } = props;
  const { width: termWidth, height: termHeight } = useTerminalDimensionsContext();
  const [query, setQuery] = useState("");
  const [hovered, setHovered] = useState<number | undefined>(undefined);
  const [cursor, setCursor] = useState(() => activeIndex(request.options));
  const [paintTick, setPaintTick] = useState(0);
  useEffect(() => {
    const id = setTimeout(() => setPaintTick(1), 0);
    return () => clearTimeout(id);
  }, []);

  const isHistory = Boolean(request.historyStyle);
  const filtered = useMemo(
    () =>
      filterPickerOptions(request.options, query, {
        searchDescription: request.searchDescription ?? isHistory,
      }),
    [request.options, query, request.searchDescription, isHistory],
  );

  useEffect(() => {
    const next = activeIndex(filtered);
    setCursor(next >= 0 ? next : 0);
    setHovered(undefined);
  }, [filtered]);

  const selected = Math.min(hovered ?? cursor, Math.max(0, filtered.length - 1));

  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const rowHeight = request.twoLine || isHistory ? 2 : 1;
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb) return;
    const viewportHeight = sb.viewport?.height ?? 0;
    if (viewportHeight <= 0) return;
    const top = selected * rowHeight;
    const bottom = top + rowHeight;
    if (top < sb.scrollTop) {
      sb.scrollTo(top);
    } else if (bottom > sb.scrollTop + viewportHeight) {
      sb.scrollTo(bottom - viewportHeight);
    }
  }, [selected, rowHeight, filtered.length]);

  function accept(): void {
    const option = filtered[selected];
    if (option) services.overlay.selectPicker(option.value);
  }

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);

    if (chord === "up") {
      key.preventDefault();
      setHovered(undefined);
      setCursor((i) =>
        filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length,
      );
      return;
    }
    if (chord === "down") {
      key.preventDefault();
      setHovered(undefined);
      setCursor((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
      return;
    }
    if (chord === "enter") {
      key.preventDefault();
      accept();
      return;
    }
    if (chord === "escape") {
      key.preventDefault();
      services.overlay.close();
      return;
    }
    if (chord === "backspace" || key.name === "delete") {
      key.preventDefault();
      setQuery((q) => q.slice(0, -1));
      return;
    }
    if (chord === "ctrl+u") {
      key.preventDefault();
      setQuery("");
      return;
    }
    if (request.rowAction && chord === request.rowAction.chord) {
      key.preventDefault();
      const option = filtered[selected];
      if (option) services.overlay.actOnPickerRow(option.value);
      return;
    }
    if (isPrintableFilterChar(key)) {
      key.preventDefault();
      setQuery((q) => q + key.sequence);
    }
  });

  const boxWidth = Math.min(
    Math.max(isHistory ? 56 : 48, Math.floor(termWidth * (isHistory ? 0.88 : 0.82))),
    termWidth - 2,
  );
  const boxHeight = Math.min(
    request.twoLine || isHistory
      ? Math.floor(termHeight * 0.78)
      : Math.floor(termHeight * 0.62),
    termHeight - 2,
  );
  const innerW = Math.max(24, boxWidth - 4);

  const titleText = pad(
    isHistory
      ? `  History  ·  ${request.options.length} sessions`
      : `  ${request.title}`,
    innerW,
  );
  const filterText = pad(
    query.length > 0
      ? `  ⌕ ${query}█  ·  ${filtered.length}/${request.options.length}`
      : `  ⌕ type:filter  ·  ${filtered.length}/${request.options.length}`,
    innerW,
  );
  const hintText = pad(
    [
      isHistory
        ? "  ↑↓:move  ·  type:filter  ·  ⌫:edit  ·  ^u:clear  ·  enter:open"
        : "  ↑↓:select  ·  type:filter  ·  ⌫:edit  ·  ^u:clear  ·  enter:confirm",
      request.rowAction ? request.rowAction.hint : "",
      "esc:close",
    ]
      .filter(Boolean)
      .join("  ·  "),
    innerW,
  );

  void paintTick;

  return (
    <box
      style={{
        flexDirection: "column",
        width: boxWidth,
        height: boxHeight,
        border: true,
        borderStyle: "rounded",
        borderColor: isHistory ? theme.accent : theme.modalBorder,
        backgroundColor: theme.statusBackground,
      }}
    >
      {}
      <box
        style={{
          flexDirection: "column",
          width: "100%",
          height: 4,
          flexShrink: 0,
          flexGrow: 0,
        }}
      >
        <text
          selectable={false}
          content={titleText}
          style={{
            fg: theme.white,
            bg: isHistory ? theme.chipIndigo : theme.magenta,
            height: 1,
          }}
        />
        <text
          selectable={false}
          key={`filter:${query.length}:${filtered.length}:${paintTick}`}
          content={filterText}
          style={{
            fg: query.length > 0 ? theme.white : theme.cyan,
            bg: theme.rowA,
            height: 1,
          }}
        />
        <text
          selectable={false}
          key={`hint:${paintTick}`}
          content={hintText}
          style={{ fg: theme.muted, bg: theme.rowB, height: 1 }}
        />
        {}
        <text
          selectable={false}
          content={pad("─".repeat(Math.max(8, innerW)), innerW)}
          style={{ fg: theme.chip, bg: theme.statusBackground, height: 1 }}
        />
      </box>

      {filtered.length === 0 ? (
        <text
          selectable={false}
          content={pad("  no matches  ·  ^u:clear", innerW)}
          style={{ fg: theme.mode, bg: theme.background, height: 1, flexShrink: 0 }}
        />
      ) : null}

      <scrollbox
        ref={scrollRef}
        viewportCulling
        scrollY
        scrollX={false}
        scrollbarOptions={HIDDEN_SCROLLBARS}
        verticalScrollbarOptions={HIDDEN_SCROLLBARS}
        horizontalScrollbarOptions={HIDDEN_SCROLLBARS}
        style={{
          flexGrow: 1,
          flexShrink: 1,
          width: "100%",
          backgroundColor: theme.background,
        }}
      >
        {filtered.map((option, index) => (
          <PickerRow
            key={option.value}
            option={option}
            focused={index === selected}
            twoLine={Boolean(request.twoLine) || isHistory}
            historyStyle={isHistory}
            theme={theme}
            width={innerW}
            stripe={index % 2 === 1}
            onHover={() => setHovered(index)}
            onSelect={() => services.overlay.selectPicker(option.value)}
          />
        ))}
      </scrollbox>
    </box>
  );
}

function PickerRow(props: {
  option: PickerOption;
  focused: boolean;
  twoLine: boolean;
  historyStyle: boolean;
  theme: Theme;
  width: number;
  stripe: boolean;
  onHover: () => void;
  onSelect: () => void;
}): ReactNode {
  const {
    option,
    focused,
    twoLine,
    historyStyle,
    theme,
    width,
    stripe,
    onHover,
    onSelect,
  } = props;

  const idleBg = stripe ? theme.rowB : theme.background;
  const bg = focused
    ? theme.selection
    : option.active
      ? theme.rowA
      : idleBg;
  const mark = focused ? "❯ " : "  ";

  if (historyStyle || twoLine) {
    const badge = option.active ? "● " : focused ? "▸ " : "  ";
    const activeTag = option.active ? "  ·  current" : "";
    const line1 = pad(`${mark}${badge}${option.label}${activeTag}`, width);
    const line2 = pad(
      option.description ? `      ${option.description}` : " ",
      width,
    );
    return (
      <box
        style={{
          flexDirection: "column",
          width: "100%",
          height: 2,
          flexShrink: 0,
          backgroundColor: bg,
        }}
        onMouseOver={onHover}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSelect();
        }}
      >
        <text
          selectable={false}
          content={line1}
          style={{
            fg: focused || option.active ? theme.white : theme.foreground,
            bg,
            height: 1,
          }}
        />
        <text
          selectable={false}
          content={line2}
          style={{
            fg: focused ? theme.cyan : theme.muted,
            bg,
            height: 1,
          }}
        />
      </box>
    );
  }

  const labelFg = focused || option.active ? theme.white : theme.foreground;
  const activeFg = focused ? theme.white : theme.cyan;
  const modelFg = focused ? theme.white : theme.response;
  const trailing = Math.max(
    0,
    width -
      mark.length -
      option.label.length -
      (option.active ? " active".length : 0) -
      (option.description ? 1 + option.description.length : 0),
  );
  const padRight = " ".repeat(trailing);

  return (
    <box
      style={{
        width: "100%",
        height: 1,
        flexShrink: 0,
        backgroundColor: bg,
        flexDirection: "row",
      }}
      onMouseOver={onHover}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelect();
      }}
    >
      <text selectable={false} style={{ fg: labelFg, bg }}>
        {mark}
        {option.label}
      </text>
      {option.active ? (
        <text selectable={false} style={{ fg: activeFg, bg }}>
          {" active"}
        </text>
      ) : null}
      {option.description ? (
        <text selectable={false} style={{ fg: modelFg, bg }}>
          {` ${option.description}`}
        </text>
      ) : null}
      {trailing > 0 ? (
        <text selectable={false} content={padRight} style={{ fg: bg, bg }} />
      ) : null}
    </box>
  );
}
