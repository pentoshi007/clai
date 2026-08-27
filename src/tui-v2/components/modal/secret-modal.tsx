/** @jsxImportSource @opentui/react */
/**
 * Masked secret entry (INPUT-009, CORE-002, V2-073).
 *
 * Docked above the composer — same chrome as confirmations (no full-screen
 * black wash). Keys are handled via `useKeyboard` (not a focus-trapped
 * 1-cell input) so click-away cannot freeze typing/Esc, and bullets always
 * reflect keystrokes. Value only leaves via onSubmit / answerSecret.
 */

import { useRef, useState, type ReactNode } from "react";
import { useKeyboard, usePaste } from "@opentui/react";
import {
  TextAttributes,
  decodePasteBytes,
} from "@opentui/core";
import { sanitizeDisplayText } from "../../../ui-core/rendering/sanitize-display.js";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { chordFromKeyEvent } from "../../input/chord-from-opentui-key.js";
import type { SecretRequestView } from "../../../ui-core/controllers/overlay-controller.js";
import { SecretBuffer } from "../../../ui-core/composer/secret-buffer.js";

export interface SecretModalProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly request: SecretRequestView;
  readonly docked?: boolean | undefined;
}

const ACCENT = "#e0b000";

function isPrintableSequence(seq: string): boolean {
  if (!seq) return false;
  for (let i = 0; i < seq.length; i += 1) {
    const code = seq.charCodeAt(i);
    // Allow space and printable ASCII; reject control bytes.
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export function SecretModal(props: SecretModalProps): ReactNode {
  const { services, theme, request, docked } = props;
  const bufferRef = useRef(
    (() => {
      const buffer = new SecretBuffer();
      buffer.insert(request.initialValue ?? "", 0);
      return buffer;
    })(),
  );
  const revealed = request.reveal === true;
  const [mask, setMask] = useState(() =>
    revealed ? bufferRef.current.reveal() : bufferRef.current.masked(),
  );

  function refreshMask(): void {
    setMask(revealed ? bufferRef.current.reveal() : bufferRef.current.masked());
  }

  function cancel(): void {
    bufferRef.current.clear();
    services.overlay.answerSecret(undefined);
  }

  function submit(): void {
    const value = bufferRef.current.reveal();
    bufferRef.current.clear();
    // Empty submit = cancel (same as Esc) — never send empty password to sudo.
    services.overlay.answerSecret(value.length > 0 ? value : undefined);
  }

  // Global keyboard (like ConfirmModal) — does not depend on input focus.
  // A previous 1-cell hidden <input> lost focus after clicks and stopped
  // accepting keys; Esc only worked when that cell was focused.
  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);

    if (chord === "escape") {
      key.preventDefault();
      cancel();
      return;
    }
    if (chord === "ctrl+c") {
      // Cancel the password UI immediately. App / SIGINT still own double-press quit.
      key.preventDefault();
      cancel();
      if (services.session.getState().running) {
        services.session.abort();
      }
      return;
    }
    if (chord === "enter") {
      key.preventDefault();
      submit();
      return;
    }
    if (chord === "backspace" || key.name === "delete") {
      key.preventDefault();
      const buf = bufferRef.current;
      buf.deleteBackward(buf.length);
      refreshMask();
      return;
    }
    // Ignore other chords (arrows, ctrl+*, etc.) so they don't inject garbage.
    if (key.ctrl || key.meta || key.option || key.super) return;
    if (
      [
        "up",
        "down",
        "left",
        "right",
        "home",
        "end",
        "tab",
        "escape",
      ].includes(key.name)
    ) {
      key.preventDefault();
      return;
    }

    // Prefer sequence; fall back to single-char name (some terminals omit sequence).
    const seq =
      typeof key.sequence === "string" && key.sequence.length > 0
        ? key.sequence
        : key.name.length === 1
          ? key.name
          : "";
    if (!isPrintableSequence(seq)) return;
    key.preventDefault();
    const buf = bufferRef.current;
    buf.insert(seq, buf.length);
    refreshMask();
  });

  // Paste into the secret buffer (composer paste is disabled while overlay open).
  usePaste((event) => {
    try {
      const text = sanitizeDisplayText(decodePasteBytes(event.bytes));
      if (!text || !isPrintableSequence(text.replace(/\r?\n/g, ""))) return;
      event.preventDefault();
      const cleaned = text.replace(/\r?\n/g, "");
      if (!cleaned) return;
      const buf = bufferRef.current;
      buf.insert(cleaned, buf.length);
      refreshMask();
    } catch {
      // ignore paste decode errors
    }
  });

  return (
    <box
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: docked ? "100%" : "70%",
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
          {revealed
            ? ` ${request.title.toUpperCase()} `
            : ` SECURE · ${request.title.toUpperCase()} `}
        </text>
        <text content=" " />
        <text style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
          {revealed ? "not written to history" : "never logged or echoed"}
        </text>
      </box>
      <text style={{ fg: theme.foreground }}>{request.prompt}</text>
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text style={{ fg: ACCENT, attributes: TextAttributes.BOLD }}>
          {revealed ? "value › " : "password › "}
        </text>
        <text style={{ fg: theme.foreground }}>
          {mask.length > 0 ? mask : "█"}
        </text>
        <text style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
          {mask.length > 0
            ? revealed
              ? ""
              : `  (${String(mask.length)} chars · not shown)`
            : revealed
              ? "  type or paste the value"
              : "  type password — bullets appear as you type"}
        </text>
      </box>
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text style={{ fg: theme.cyan, attributes: TextAttributes.BOLD }}>› </text>
        <text style={{ fg: theme.cyan }}>
          enter submit  ·  esc cancel  ·  ctrl+c cancel (again to quit)
        </text>
      </box>
    </box>
  );
}
