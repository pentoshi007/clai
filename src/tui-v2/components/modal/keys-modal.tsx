/** @jsxImportSource @opentui/react */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type InputRenderable, type KeyEvent } from "@opentui/core";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { chordFromKeyEvent } from "../../input/chord-from-opentui-key.js";
import type { KeysEditorRequest } from "../../../ui-core/controllers/overlay-controller.js";
import { MAX_PROVIDER_KEYS } from "../../../llm/key-rotation.js";

export interface KeysModalProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly request: KeysEditorRequest;
  readonly docked?: boolean | undefined;
}

const ACCENT = "#e0b000";
const ACTIVE_FG = "#f5c542";

interface KeyRow {
  readonly id: number;
  readonly slotId?: string | undefined;
  readonly placeholder: string;
  readonly text: string;
  readonly disabled: boolean;
}

let nextRowId = 1;

function itemLabelOf(request: KeysEditorRequest): string {
  return request.itemLabel ?? "API key";
}

function rowsFromRequest(request: KeysEditorRequest): KeyRow[] {
  const label = itemLabelOf(request);
  if (request.initialKeys.length === 0) {
    return [{ id: nextRowId++, placeholder: `paste ${label}`, text: "", disabled: false }];
  }
  return [
    ...request.initialKeys.map((k) => ({
      id: nextRowId++,
      slotId: k.id,
      placeholder: k.masked,
      text: "",
      disabled: k.disabled === true,
    })),
    { id: nextRowId++, placeholder: `paste another ${label}`, text: "", disabled: false },
  ];
}

export function KeysModal(props: KeysModalProps): ReactNode {
  const { services, theme, request, docked } = props;
  const itemLabel = itemLabelOf(request);
  const itemLabelPlural = `${itemLabel}s`;
  const [rows, setRows] = useState<KeyRow[]>(() => rowsFromRequest(request));
  const existingCount = request.initialKeys.length;
  const [activeKeyIdx, setActiveKeyIdx] = useState(() => {
    const stored = request.activeIndex ?? 0;
    return existingCount > 0 ? Math.min(stored, existingCount - 1) : 0;
  });
  const [focusIdx, setFocusIdx] = useState(() =>
    Math.max(0, request.initialKeys.length),
  );
  const inputRefs = useRef<Map<number, InputRenderable | null>>(new Map());
  const prefilled = useRef(false);

  function applyTextToInputs(list: KeyRow[]): void {
    for (const row of list) {
      const el = inputRefs.current.get(row.id);
      if (!el) continue;
      try {
        if (el.plainText !== row.text) {
          el.setText(row.text);
        }
      } catch {
      }
    }
  }

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      applyTextToInputs(rows);
      prefilled.current = true;
      const idx = Math.max(0, Math.min(focusIdx, rows.length - 1));
      const focused = rows[idx];
      if (focused) inputRefs.current.get(focused.id)?.focus();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [rows.map((r) => r.id).join(","), focusIdx]);

  function syncFromInputs(): KeyRow[] {
    return rows.map((row) => {
      const el = inputRefs.current.get(row.id);
      const live = el?.plainText;
      return {
        ...row,
        text: live !== undefined ? live : row.text,
      };
    });
  }

  function updateRowText(id: number, text: string): void {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, text } : r)));
  }

  function addRow(): void {
    const synced = syncFromInputs();
    const nonEmpty = synced.filter(
      (r) => r.slotId || r.text.trim().length > 0,
    );
    if (nonEmpty.length >= MAX_PROVIDER_KEYS) {
      services.session.notice(
        "warn",
        `at most ${MAX_PROVIDER_KEYS} ${itemLabelPlural} per provider`,
      );
      return;
    }
    const next = [
      ...synced,
      { id: nextRowId++, placeholder: `paste another ${itemLabel}`, text: "", disabled: false },
    ];
    setRows(next);
    setFocusIdx(next.length - 1);
  }

  function removeRow(index: number): void {
    const synced = syncFromInputs();
    if (synced.length <= 1) {
      const only = {
        id: nextRowId++,
        placeholder: `paste ${itemLabel}`,
        text: "",
        disabled: false,
      };
      setRows([only]);
      setFocusIdx(0);
      setActiveKeyIdx(0);
      queueMicrotask(() => applyTextToInputs([only]));
      return;
    }
    const removed = synced[index];
    if (removed) inputRefs.current.delete(removed.id);
    const next = synced.filter((_, i) => i !== index);
    if (removed?.slotId) {
      if (index < activeKeyIdx) {
        setActiveKeyIdx((prev) => Math.max(0, prev - 1));
      } else if (index === activeKeyIdx) {
        setActiveKeyIdx(0);
      }
    }
    setRows(next);
    setFocusIdx(Math.max(0, Math.min(index, next.length - 1)));
    queueMicrotask(() => applyTextToInputs(next));
  }

  function toggleDisabled(index: number): void {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, disabled: !row.disabled } : row)),
    );
  }

  function submit(): void {
    const synced = syncFromInputs();
    const out: { slotId?: string; value: string; disabled?: boolean }[] = [];
    for (const row of synced) {
      const value = row.text.trim();
      if (row.slotId) {
        out.push({ slotId: row.slotId, value, disabled: row.disabled });
      } else if (value) {
        out.push({ value, disabled: row.disabled });
      }
    }
    services.overlay.answerKeys({ action: "save", rows: out, activeIndex: activeKeyIdx });
  }

  function resetAll(): void {
    services.overlay.answerKeys({ action: "reset" });
  }

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);
    if (chord === "escape") {
      key.preventDefault();
      services.overlay.answerKeys(undefined);
      return;
    }
    if (chord === "ctrl+a") {
      key.preventDefault();
      addRow();
      return;
    }
    if (chord === "ctrl+d") {
      key.preventDefault();
      toggleDisabled(focusIdx);
      return;
    }
    if (chord === "ctrl+r") {
      key.preventDefault();
      resetAll();
      return;
    }
    if (chord === "ctrl+enter" || chord === "meta+enter" || chord === "enter") {
      key.preventDefault();
      submit();
    }
  });

  const typedCount = rows.filter((r) => r.text.trim().length > 0).length;
  const showActiveToggle = existingCount > 1;

  return (
    <box
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: docked ? "100%" : "80%",
        borderColor: ACCENT,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text
          style={{
            fg: theme.background,
            bg: ACCENT,
            attributes: TextAttributes.BOLD,
          }}
        >
          {` ${request.heading ?? "KEYS"} `}
        </text>
        <text content=" " />
        <text style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
          {request.provider} · multi {itemLabelPlural} · empty existing = keep
        </text>
      </box>

      <text
        content={
          existingCount > 0
            ? `${existingCount} stored · type to replace a slot · + adds another (max ${MAX_PROVIDER_KEYS})${showActiveToggle ? " · ★ = active" : ""}`
            : `Nothing stored yet · paste one or more ${itemLabelPlural} (max ${MAX_PROVIDER_KEYS})`
        }
        style={{ fg: theme.muted, attributes: TextAttributes.DIM }}
      />

      {rows.map((row, index) => {
        const isExisting = Boolean(row.slotId);
        const isActive = isExisting && index === activeKeyIdx;
        return (
          <box
            key={row.id}
            style={{ flexDirection: "row", width: "100%", alignItems: "center" }}
          >
            <text
              content={`${index + 1}. `}
              style={{ fg: theme.muted, width: 4, flexShrink: 0 }}
            />
            <text
              content={row.disabled ? " ⊘ " : " ○ "}
              style={{
                fg: row.disabled ? theme.white : theme.muted,
                ...(row.disabled ? { bg: theme.failedBg } : {}),
                attributes: row.disabled ? TextAttributes.BOLD : TextAttributes.DIM,
                flexShrink: 0,
              }}
              onMouseDown={() => toggleDisabled(index)}
            />
            {showActiveToggle ? (
              <text
                content={isExisting ? (isActive ? " ★ " : " ☆ ") : "   "}
                style={{
                  fg: isActive ? ACTIVE_FG : theme.muted,
                  attributes: isActive ? TextAttributes.BOLD : TextAttributes.DIM,
                  flexShrink: 0,
                }}
                onMouseDown={() => {
                  if (isExisting) setActiveKeyIdx(index);
                }}
              />
            ) : null}
            <input
              ref={(el: InputRenderable | null) => {
                inputRefs.current.set(row.id, el);
              }}
              focused={focusIdx === index}
              placeholder={row.placeholder}
              onContentChange={() => {
                const el = inputRefs.current.get(row.id);
                updateRowText(row.id, el?.plainText ?? "");
                setFocusIdx(index);
              }}
              backgroundColor={theme.background}
              textColor={row.disabled ? theme.muted : theme.foreground}
              focusedBackgroundColor={theme.background}
              focusedTextColor={row.disabled ? theme.muted : theme.foreground}
              cursorColor={ACCENT}
              style={{ flexGrow: 1, minWidth: 20 }}
            />
            <text content=" " />
            <text
              content=" ✕ "
              style={{
                fg: theme.white,
                bg: theme.failedBg,
                attributes: TextAttributes.BOLD,
                flexShrink: 0,
              }}
              onMouseDown={() => removeRow(index)}
            />
          </box>
        );
      })}

      <box style={{ flexDirection: "row", width: "100%" }}>
        <text
          content=" + add "
          style={{
            fg: theme.background,
            bg: ACCENT,
            attributes: TextAttributes.BOLD,
          }}
          onMouseDown={() => addRow()}
        />
        <text content=" " />
        <text
          content=" Save "
          style={{
            fg: theme.background,
            bg: theme.success,
            attributes: TextAttributes.BOLD,
          }}
          onMouseDown={() => submit()}
        />
        <text content=" " />
        <text
          content=" Reset all "
          style={{
            fg: theme.white,
            bg: theme.failedBg,
            attributes: TextAttributes.BOLD,
          }}
          onMouseDown={() => resetAll()}
        />
        <text content=" " />
        <text
          content=" Cancel "
          style={{ fg: theme.foreground, bg: theme.chip }}
          onMouseDown={() => services.overlay.answerKeys(undefined)}
        />
      </box>

      <text
        content={`enter:save  ·  ^a / +:add  ·  ✕:remove${showActiveToggle ? "  ·  ★:set active" : ""}  ·  ^d / ○:disable  ·  ^r:reset all  ·  esc:cancel${typedCount ? `  ·  ${typedCount} new/edited` : ""}`}
        style={{ fg: theme.muted, attributes: TextAttributes.DIM }}
      />
    </box>
  );
}
