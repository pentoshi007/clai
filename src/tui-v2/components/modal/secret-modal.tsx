/** @jsxImportSource @opentui/react */
/**
 * Masked secret entry (INPUT-009, CORE-002, V2-073).
 *
 * Ported from the classic TUI's `SecretInputPanel`, append/backspace only —
 * a password field has no reason to support mid-string cursor movement, and
 * disabling it means the cursor never sits on a previously-typed character
 * (a moved cursor can reveal its glyph via inverse-video rendering even when
 * the glyph's own color matches the background). The real `<input>` still
 * owns typing/backspace/unicode natively (proven in `ComposerEditor`); only
 * its rendered color is set to the background, and the visible dots are a
 * separate `<text>` driven by length alone. The value only leaves this
 * component through `onSubmit`'s single call, never through logging.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { InputRenderable, KeyEvent } from "@opentui/core";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { Theme } from "../../rendering/theme.js";
import { chordFromKeyEvent } from "../../actions/chord-from-key.js";
import type { SecretRequestView } from "../../controllers/overlay-controller.js";

export interface SecretModalProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly request: SecretRequestView;
}

const BLOCKED_CHORDS = new Set(["left", "right", "home", "end", "up", "down"]);

export function SecretModal(props: SecretModalProps): ReactNode {
  const { services, theme, request } = props;
  const inputRef = useRef<InputRenderable>(null);
  const [length, setLength] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function onKeyDown(key: KeyEvent): void {
    const chord = chordFromKeyEvent(key);
    if (chord === "escape") {
      key.preventDefault();
      services.overlay.answerSecret(undefined);
      return;
    }
    if (BLOCKED_CHORDS.has(chord)) key.preventDefault();
  }

  function submit(): void {
    const value = inputRef.current?.plainText ?? "";
    services.overlay.answerSecret(value.length > 0 ? value : undefined);
  }

  return (
    <box
      style={{
        flexDirection: "column",
        width: "70%",
        border: true,
        borderColor: theme.border,
        backgroundColor: theme.background,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text style={{ fg: theme.background, bg: "#e0b000" }}> SECURE INPUT · {request.title.toUpperCase()} </text>
      <text style={{ fg: theme.foreground }}>{request.prompt}</text>
      <box style={{ flexDirection: "row" }}>
        <text style={{ fg: "#e0b000" }}>password › </text>
        <text style={{ fg: theme.foreground }}>{"•".repeat(length)}</text>
        <input
          ref={inputRef}
          focused
          onContentChange={() => setLength(inputRef.current?.plainText.length ?? 0)}
          onSubmit={submit}
          onKeyDown={onKeyDown}
          textColor={theme.background}
          backgroundColor={theme.background}
          style={{ width: 1 }}
        />
      </box>
      <text style={{ fg: theme.border }}>{"─".repeat(40)}</text>
      <text content=" " />
      <text style={{ fg: theme.muted }}>enter:submit  ·  esc:cancel  ·  never saved or displayed</text>
    </box>
  );
}
