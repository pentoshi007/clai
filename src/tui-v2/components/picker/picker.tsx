/** @jsxImportSource @opentui/react */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensionsContext } from "../../hooks/terminal-dimensions.js";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { chordFromKeyEvent } from "../../input/chord-from-opentui-key.js";
import { activeIndex, filterPickerOptions } from "../../../ui-core/rendering/picker-filter.js";
import { layoutPickerOptions, pickerItemAtRow, pickerScrollTop, pickerWindow } from "../../../ui-core/rendering/picker-layout.js";
import { fitOneLine } from "../../../ui-core/rendering/pager-chrome.js";
import { overlaySize } from "../../../ui-core/layout/overlay-size.js";
import type { PickerRequest } from "../../../ui-core/controllers/overlay-controller.js";

export interface PickerProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly request: PickerRequest;
}

const HIDDEN_SCROLLBARS = { visible: false, showArrows: false } as const;

function isPrintableFilterChar(key: {
  readonly name: string;
  readonly sequence: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly option?: boolean;
  readonly super?: boolean;
}): boolean {
  if (key.ctrl || key.meta || key.option || key.super) return false;
  return key.sequence.length === 1 && key.sequence >= " " && key.sequence !== "\x7f";
}

export function Picker(props: PickerProps): ReactNode {
  const { services, theme, request } = props;
  const { width: termWidth, height: termHeight } = useTerminalDimensionsContext();
  const size = overlaySize(termWidth, termHeight);
  const border = size.width >= 5 && size.height >= 3;
  const innerW = Math.max(1, size.width - (border ? 2 : 0));
  const innerH = Math.max(1, size.height - (border ? 2 : 0));
  const bodyHeight = innerH - Number(innerH >= 4) - Number(innerH >= 3) - Number(innerH >= 2);
  const [query, setQuery] = useState("");
  const [hovered, setHovered] = useState<number | undefined>(undefined);
  const [cursor, setCursor] = useState(() => activeIndex(request.options));
  const [paintTick, setPaintTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const isHistory = Boolean(request.historyStyle);
  const filtered = useMemo(() => filterPickerOptions(request.options, query, {
    searchDescription: request.searchDescription ?? isHistory,
  }), [request.options, query, request.searchDescription, isHistory]);
  const items = useMemo(
    () => layoutPickerOptions(filtered, innerW, Boolean(request.twoLine) || isHistory),
    [filtered, innerW, request.twoLine, isHistory],
  );
  const selected = Math.min(hovered ?? cursor, Math.max(0, filtered.length - 1));
  const window = pickerWindow(items, scrollTop, bodyHeight);

  useEffect(() => {
    const id = setTimeout(() => setPaintTick(1), 0);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    setCursor(activeIndex(filtered));
    setHovered(undefined);
  }, [filtered]);
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb) return;
    const syncViewport = (): void => {
      setScrollTop(Math.max(0, sb.scrollTop));
    };
    sb.verticalScrollBar.on("change", syncViewport);
    sb.viewport.on("resized", syncViewport);
    syncViewport();
    return () => {
      sb.verticalScrollBar.off("change", syncViewport);
      sb.viewport.off("resized", syncViewport);
    };
  }, []);
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb || sb.viewport.height <= 0) return;
    sb.scrollTo(pickerScrollTop(items, selected, sb.viewport.height, sb.scrollTop));
  }, [selected, items, paintTick, innerH]);

  const move = (next: number): void => {
    setHovered(undefined);
    setCursor(next);
    scrollRef.current?.scrollTo(items[next]?.top ?? 0);
  };
  useKeyboard((key) => {
    if (key.defaultPrevented || key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);
    if (chord === "up" || chord === "down") {
      key.preventDefault();
      move(filtered.length === 0 ? 0 : (selected + (chord === "up" ? -1 : 1) + filtered.length) % filtered.length);
      return;
    }
    if (["pageup", "pagedown", "left", "right"].includes(chord)) {
      key.preventDefault();
      const sb = scrollRef.current;
      const direction = chord === "pageup" || chord === "left" ? -1 : 1;
      const distance = chord === "left" || chord === "right" ? 1 : Math.max(1, sb?.viewport.height ?? 1);
      const delta = direction * distance;
      sb?.scrollBy(delta);
      if (sb) {
        const item = items[selected];
        if (!item || item.top + item.height <= sb.scrollTop || item.top >= sb.scrollTop + sb.viewport.height) {
          setHovered(undefined);
          setCursor(Math.max(0, pickerItemAtRow(items, sb.scrollTop)));
        }
      }
      return;
    }
    if (chord === "home" || chord === "end") {
      key.preventDefault();
      move(chord === "home" ? 0 : Math.max(0, filtered.length - 1));
      return;
    }
    if (chord === "enter") {
      key.preventDefault();
      const option = filtered[selected];
      if (option) services.overlay.selectPicker(option.value);
      return;
    }
    if (chord === "escape") {
      key.preventDefault();
      services.overlay.close();
      return;
    }
    if (chord === "backspace" || key.name === "delete") {
      key.preventDefault();
      setQuery((value) => value.slice(0, -1));
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
      setQuery((value) => value + key.sequence);
    }
  });

  const hints = [
    "↑↓ move",
    "pg↑↓ scroll",
    `enter ${isHistory ? "resume" : "select"}`,
    request.rowAction?.hint,
    "esc close",
  ].filter(Boolean).join(" · ");
  return (
    <box style={{
      flexDirection: "column",
      width: size.width,
      height: size.height,
      border,
      borderStyle: "rounded",
      borderColor: isHistory ? theme.accent : theme.modalBorder,
      backgroundColor: theme.statusBackground,
    }}>
      {innerH >= 4 ? (
        <text
          selectable={false}
          content={fitOneLine([request.title], innerW)}
          style={{ fg: theme.white, bg: isHistory ? theme.chipIndigo : theme.magenta, height: 1, flexShrink: 0 }}
        />
      ) : null}
      {innerH >= 3 ? (
        <text
          selectable={false}
          content={fitOneLine([
            `${query ? `filter: ${query}█` : "type to filter"} · ${filtered.length}/${request.options.length}`,
          ], innerW)}
          style={{ fg: theme.cyan, height: 1, flexShrink: 0 }}
        />
      ) : null}
      <scrollbox
        id="picker-options"
        ref={scrollRef}
        viewportCulling
        scrollY
        scrollX={false}
        scrollbarOptions={HIDDEN_SCROLLBARS}
        verticalScrollbarOptions={HIDDEN_SCROLLBARS}
        horizontalScrollbarOptions={HIDDEN_SCROLLBARS}
        style={{ flexGrow: 1, flexShrink: 1, minHeight: 1, width: "100%", backgroundColor: theme.background }}
      >
        {filtered.length === 0 ? <text content="no matches" style={{ fg: theme.muted, height: 1 }} /> : null}
        <box key="before" style={{ height: window.before, flexShrink: 0 }} />
        {window.rows.map(({ itemIndex: index, lineIndex, line }) => {
          const focused = index === selected;
          const option = filtered[index]!;
          const bg = focused ? theme.selection : index % 2 === 1 ? theme.rowB : theme.background;
          return (
            <box
              key={`${option.value}:${lineIndex}`}
              style={{ width: "100%", height: 1, flexShrink: 0, backgroundColor: bg }}
              onMouseOver={() => setHovered(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                services.overlay.selectPicker(option.value);
              }}
            >
              <text
                selectable={false}
                content={`${innerW >= 3 ? focused && lineIndex === 0 ? "❯ " : "  " : ""}${line.text}`}
                style={{
                  fg: line.description
                    ? focused ? theme.cyan : theme.muted
                    : focused || option.active ? theme.white : theme.foreground,
                  bg,
                  height: 1,
                  flexShrink: 0,
                }}
              />
            </box>
          );
        })}
        <box key="after" style={{ height: window.after, flexShrink: 0 }} />
      </scrollbox>
      {innerH >= 2 ? (
        <text
          selectable={false}
          content={fitOneLine([hints, "↑↓ move · pg↑↓ scroll · enter select · esc close", "↑↓ · enter · esc"], innerW)}
          style={{ fg: theme.muted, bg: theme.rowB, height: 1, flexShrink: 0 }}
        />
      ) : null}
    </box>
  );
}
