/** @jsxImportSource @opentui/react */
/**
 * Actions for a user prompt row (copy / resend). Opened by clicking a prompt
 * bubble in the transcript. Centered card with a fixed max width so it never
 * stretches edge-to-edge on wide terminals.
 */

import type { ReactNode } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { PromptActionsRequest } from "../../controllers/overlay-controller.js";
import type { Theme } from "../../rendering/theme.js";
import { chordFromKeyEvent } from "../../actions/chord-from-key.js";

function clipPrompt(text: string, maxLines: number, maxCols: number): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const wrapped: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      wrapped.push("");
      continue;
    }
    for (let i = 0; i < line.length; i += maxCols) {
      wrapped.push(line.slice(i, i + maxCols));
      if (wrapped.length >= maxLines) break;
    }
    if (wrapped.length >= maxLines) break;
  }
  if (wrapped.length > maxLines || text.length > maxLines * maxCols) {
    const kept = wrapped.slice(0, maxLines);
    const last = kept[kept.length - 1] ?? "";
    kept[kept.length - 1] = last.length > 1 ? `${last.slice(0, -1)}…` : "…";
    return kept.join("\n");
  }
  return wrapped.join("\n");
}

export function PromptActionsModal(props: {
  services: AppServices;
  theme: Theme;
  request: PromptActionsRequest;
}): ReactNode {
  const { services, theme, request } = props;
  const { width: termWidth, height: termHeight } = useTerminalDimensions();

  const cardWidth = Math.min(72, Math.max(40, Math.floor(termWidth * 0.55)));
  const bodyCols = Math.max(20, cardWidth - 4);
  const bodyMaxLines = Math.max(4, Math.min(12, Math.floor(termHeight * 0.35)));
  const preview = clipPrompt(request.prompt, bodyMaxLines, bodyCols);

  const copy = (): void => {
    services.overlay.close();
    void services.ports.clipboard.writeText(request.prompt);
  };
  const resend = (): void => {
    services.overlay.close();
    request.onResend();
  };
  const close = (): void => {
    services.overlay.close();
  };

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);
    if (chord === "c") copy();
    else if (chord === "r" || chord === "enter") resend();
    else if (chord === "escape") close();
    else return;
    key.preventDefault();
  });

  return (
    <box
      border
      borderStyle="rounded"
      title=" Prompt "
      titleAlignment="center"
      style={{
        flexDirection: "column",
        width: cardWidth,
        maxHeight: Math.max(10, Math.floor(termHeight * 0.7)),
        borderColor: theme.userBorder,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 1,
        paddingBottom: 1,
      }}
    >
      <box style={{ flexDirection: "row", marginBottom: 1 }}>
        <text content=" YOU " style={{ fg: theme.white, bg: theme.prompt }} />
        <text content="  actions for this message" style={{ fg: theme.muted }} />
      </box>

      <box
        border
        borderStyle="rounded"
        style={{
          flexDirection: "column",
          width: "100%",
          borderColor: theme.chipIndigo,
          backgroundColor: theme.background,
          paddingLeft: 1,
          paddingRight: 1,
          marginBottom: 1,
        }}
      >
        <text style={{ fg: theme.foreground }}>{preview || " "}</text>
      </box>

      <box style={{ flexDirection: "row", justifyContent: "flex-start", width: "100%" }}>
        <text
          content=" c:copy "
          style={{ fg: theme.white, bg: theme.chipTeal }}
          onMouseDown={copy}
        />
        <text content="  " />
        <text
          content=" r:resend "
          style={{ fg: theme.white, bg: theme.mode }}
          onMouseDown={resend}
        />
        <text content="  " />
        <text
          content=" esc:close "
          style={{ fg: theme.white, bg: theme.chipIndigo }}
          onMouseDown={close}
        />
      </box>
    </box>
  );
}
