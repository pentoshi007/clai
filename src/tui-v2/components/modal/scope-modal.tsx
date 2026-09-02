/** @jsxImportSource @opentui/react */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type InputRenderable, type KeyEvent } from "@opentui/core";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { chordFromKeyEvent } from "../../input/chord-from-opentui-key.js";
import type { ScopeEditorRequest } from "../../../ui-core/controllers/overlay-controller.js";

export interface ScopeModalProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly request: ScopeEditorRequest;
  readonly docked?: boolean | undefined;
}

const ACCENT = "#2EEBFF";

interface ScopeRow {
  readonly id: number;
  readonly text: string;
}

let nextRowId = 1;

function rowsFromTargets(targets: readonly string[]): ScopeRow[] {
  if (targets.length === 0) {
    return [{ id: nextRowId++, text: "" }];
  }
  return [
    ...targets.map((text) => ({ id: nextRowId++, text })),
    { id: nextRowId++, text: "" },
  ];
}

export function ScopeModal(props: ScopeModalProps): ReactNode {
  const { services, theme, request, docked } = props;
  const [rows, setRows] = useState<ScopeRow[]>(() =>
    rowsFromTargets(request.initialTargets),
  );
  const [focusIdx, setFocusIdx] = useState(0);
  const inputRefs = useRef<Map<number, InputRenderable | null>>(new Map());
  const prefilled = useRef(false);

  function applyTextToInputs(list: ScopeRow[]): void {
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
      if (!prefilled.current) {
        prefilled.current = true;
        inputRefs.current.get(rows[0]?.id ?? -1)?.focus();
      } else {
        const focused = rows[focusIdx];
        if (focused) inputRefs.current.get(focused.id)?.focus();
      }
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [rows.map((r) => r.id).join(","), focusIdx]);

  function syncFromInputs(): ScopeRow[] {
    return rows.map((row) => {
      const el = inputRefs.current.get(row.id);
      const live = el?.plainText;
      return {
        id: row.id,
        text: live !== undefined ? live : row.text,
      };
    });
  }

  function readTargets(): string[] {
    return syncFromInputs()
      .map((r) => r.text.trim())
      .filter(Boolean);
  }

  function updateRowText(id: number, text: string): void {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, text } : r)),
    );
  }

  function addRow(): void {
    const synced = syncFromInputs();
    const next = [...synced, { id: nextRowId++, text: "" }];
    setRows(next);
    setFocusIdx(next.length - 1);
  }

  function removeRow(index: number): void {
    const synced = syncFromInputs();
    if (synced.length <= 1) {
      const only = { id: nextRowId++, text: "" };
      setRows([only]);
      setFocusIdx(0);
      queueMicrotask(() => applyTextToInputs([only]));
      return;
    }
    const removed = synced[index];
    if (removed) inputRefs.current.delete(removed.id);
    const next = synced.filter((_, i) => i !== index);
    setRows(next);
    setFocusIdx(Math.max(0, Math.min(index, next.length - 1)));
    queueMicrotask(() => applyTextToInputs(next));
  }

  function submit(): void {
    services.overlay.answerScope(readTargets());
  }

  function clearAll(): void {
    services.overlay.answerScope([]);
  }

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);
    if (chord === "escape") {
      key.preventDefault();
      services.overlay.answerScope(undefined);
      return;
    }
    if (chord === "ctrl+a") {
      key.preventDefault();
      addRow();
      return;
    }
    if (chord === "ctrl+enter" || chord === "meta+enter") {
      key.preventDefault();
      submit();
      return;
    }
    if (chord === "enter") {
      key.preventDefault();
      submit();
    }
  });

  const liveTargets = readTargets();
  const scopingOff = liveTargets.length === 0;

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
          {" SCOPE "}
        </text>
        <text content=" " />
        <text style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
          authorized targets · empty = scoping disabled
        </text>
      </box>

      {scopingOff ? (
        <text
          content="Scoping disabled — no authorized targets. Active recon is unrestricted until you add hosts."
          style={{ fg: theme.mode, attributes: TextAttributes.DIM }}
        />
      ) : (
        <text
          content={`Will authorize: ${liveTargets.join(", ")}`}
          style={{ fg: theme.muted, attributes: TextAttributes.DIM }}
        />
      )}

      {rows.map((row, index) => (
        <box
          key={row.id}
          style={{ flexDirection: "row", width: "100%", alignItems: "center" }}
        >
          <text
            content={`${index + 1}. `}
            style={{ fg: theme.muted, width: 4, flexShrink: 0 }}
          />
          <input
            ref={(el: InputRenderable | null) => {
              inputRefs.current.set(row.id, el);
            }}
            focused={focusIdx === index}
            placeholder="host or domain (e.g. example.com)"
            onContentChange={() => {
              const el = inputRefs.current.get(row.id);
              updateRowText(row.id, el?.plainText ?? "");
              setFocusIdx(index);
            }}
            backgroundColor={theme.background}
            textColor={theme.foreground}
            focusedBackgroundColor={theme.background}
            focusedTextColor={theme.foreground}
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
      ))}

      <box style={{ flexDirection: "row", width: "100%" }}>
        <text
          content=" + add "
          style={{
            fg: theme.background,
            bg: theme.chip,
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
          content=" Clear all "
          style={{
            fg: theme.white,
            bg: theme.failedBg,
            attributes: TextAttributes.BOLD,
          }}
          onMouseDown={() => clearAll()}
        />
        <text content=" " />
        <text
          content=" Cancel "
          style={{ fg: theme.foreground, bg: theme.chip }}
          onMouseDown={() => services.overlay.answerScope(undefined)}
        />
      </box>

      <text
        content="enter:save  ·  ^a / +:add  ·  ✕:remove row  ·  clear all:disable  ·  esc:cancel"
        style={{ fg: theme.muted, attributes: TextAttributes.DIM }}
      />
    </box>
  );
}
