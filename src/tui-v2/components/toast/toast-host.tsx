/** @jsxImportSource @opentui/react */
/**
 * Right-edge toasts. Rendered as direct absolute siblings of the shell
 * (not a full-bleed hit-capturing overlay).
 */

import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { ToastController, ToastLevel } from "../../controllers/toast-controller.js";
import type { Theme } from "../../rendering/theme.js";
import { useToastState } from "../../state/use-toast.js";

export interface ToastHostProps {
  readonly toast: ToastController;
  readonly theme: Theme;
  readonly termWidth: number;
  readonly termHeight: number;
}

function levelChrome(
  level: ToastLevel,
  theme: Theme,
): { border: string; fg: string; bg: string; label: string } {
  switch (level) {
    case "success":
      return { border: "#4ADE80", fg: "#FFFFFF", bg: "#166534", label: " ✓ " };
    case "warn":
      return { border: theme.activity, fg: theme.background, bg: theme.activity, label: " ! " };
    case "error":
      return { border: theme.mode, fg: "#FFFFFF", bg: theme.mode, label: " ✗ " };
    default:
      return { border: theme.cyan, fg: "#FFFFFF", bg: theme.chipTeal, label: " · " };
  }
}

export function ToastHost(props: ToastHostProps): ReactNode {
  const { toast, theme, termWidth, termHeight } = props;
  const items = useToastState(toast);
  if (items.length === 0) return null;

  const maxWidth = Math.min(48, Math.max(26, Math.floor(termWidth * 0.4)));
  const ordered = [...items].reverse();
  const maxStack = Math.max(1, Math.floor((termHeight - 4) / 3));
  const visible = ordered.slice(0, maxStack);

  return (
    <>
      {visible.map((item, index) => {
        const chrome = levelChrome(item.level, theme);
        const toastWidth = Math.min(maxWidth, Math.max(24, item.message.length + 10));
        const left = Math.max(0, termWidth - toastWidth - 1);
        const top = 1 + index * 3;
        return (
          <box
            key={item.id}
            border
            borderStyle="rounded"
            style={{
              position: "absolute",
              top,
              left,
              width: toastWidth,
              zIndex: 999,
              borderColor: chrome.border,
              backgroundColor: theme.statusBackground,
              paddingLeft: 1,
              paddingRight: 1,
              flexDirection: "row",
            }}
          >
            <text
              style={{
                fg: chrome.fg,
                bg: chrome.bg,
                attributes: TextAttributes.BOLD,
              }}
            >
              {chrome.label}
            </text>
            <text content=" " />
            <text style={{ fg: theme.foreground, attributes: TextAttributes.BOLD }}>
              {item.message}
            </text>
          </box>
        );
      })}
    </>
  );
}
