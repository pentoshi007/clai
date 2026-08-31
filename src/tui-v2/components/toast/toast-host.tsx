/** @jsxImportSource @opentui/react */

import { useEffect, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type {
  ToastController,
  ToastItem,
  ToastLevel,
} from "../../../ui-core/controllers/toast-controller.js";
import { TOAST_ENTER_MS } from "../../../ui-core/controllers/toast-controller.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { useToastState } from "../../../ui-core/react/use-toast.js";
import {
  TOAST_BOX_HEIGHT,
  toastAnimAt,
} from "./toast-anim.js";

export interface ToastHostProps {
  readonly toast: ToastController;
  readonly theme: Theme;
  readonly termWidth: number;
  readonly termHeight: number;
}

const TOAST_STACK_GAP = 1;

const TICK_MS = 33;

const H_PAD = 2;

const MAX_BODY_LINES = 6;

function levelGlyph(level: ToastLevel): string {
  switch (level) {
    case "success":
      return "✓";
    case "warn":
      return "!";
    case "error":
      return "✗";
    default:
      return "·";
  }
}

function levelPlate(level: ToastLevel, theme: Theme): string {
  switch (level) {
    case "success":
      return theme.successBg;
    case "error":
      return theme.failedBg;
    default:
      return theme.mode;
  }
}

export function wrapToastBody(
  level: ToastLevel,
  message: string,
  innerWidth: number,
): string[] {
  const w = Math.max(8, innerWidth);
  const prefix = `${levelGlyph(level)}  `;
  const indent = " ".repeat(Math.min(prefix.length, w));
  const words = message.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return [prefix.trimEnd() || "·"];

  const lines: string[] = [];
  let line = prefix;
  let isFirst = true;

  const push = (s: string): void => {
    lines.push(s);
  };

  for (const word of words) {
    const lead = isFirst ? prefix : indent;
    if (lines.length === 0 && isFirst) {
      if (prefix.length + word.length <= w) {
        line = prefix + word;
        isFirst = false;
        continue;
      }
      const chunk = word.slice(0, Math.max(1, w - prefix.length));
      push(prefix + chunk);
      let rest = word.slice(chunk.length);
      while (rest.length > 0 && lines.length < MAX_BODY_LINES) {
        const piece = rest.slice(0, w - indent.length);
        push(indent + piece);
        rest = rest.slice(piece.length);
      }
      isFirst = false;
      line = indent;
      continue;
    }

    const candidate = `${line} ${word}`;
    if (candidate.length <= w) {
      line = candidate;
      continue;
    }
    push(line);
    if (lines.length >= MAX_BODY_LINES) break;
    if (indent.length + word.length <= w) {
      line = indent + word;
    } else {
      let rest = word;
      while (rest.length > 0 && lines.length < MAX_BODY_LINES) {
        const piece = rest.slice(0, Math.max(1, w - indent.length));
        if (line !== indent && line.length > indent.length) {
          push(line);
          if (lines.length >= MAX_BODY_LINES) break;
        }
        line = indent + piece;
        rest = rest.slice(piece.length);
        if (rest.length === 0) break;
        push(line);
        line = indent;
      }
    }
  }
  if (line.trim().length > 0 && lines.length < MAX_BODY_LINES) {
    if (lines[lines.length - 1] !== line) push(line);
  }

  if (lines.length >= MAX_BODY_LINES) {
    const last = lines[MAX_BODY_LINES - 1] ?? "";
    lines.length = MAX_BODY_LINES;
    if (!last.endsWith("…")) {
      lines[MAX_BODY_LINES - 1] =
        last.length >= w
          ? `${last.slice(0, Math.max(1, w - 1))}…`
          : `${last}…`;
    }
  }

  return lines.map((l) => (l.length > w ? l.slice(0, w) : l));
}

export function padToastLines(bodyLines: string[], chipWidth: number): string[] {
  const inner = Math.max(1, chipWidth - H_PAD * 2);
  return bodyLines.map((line) => {
    const clipped = line.length > inner ? line.slice(0, inner) : line;
    return `${" ".repeat(H_PAD)}${clipped.padEnd(inner)}${" ".repeat(H_PAD)}`;
  });
}

function ToastPill(props: {
  item: ToastItem;
  theme: Theme;
  top: number;
  left: number;
  width: number;
  bodyLines: string[];
  visibility: number;
}): ReactNode {
  const { item, theme, top, left, width, bodyLines, visibility } = props;
  if (visibility <= 0.02) return null;

  const plate = levelPlate(item.level, theme);
  const textFg = theme.white;
  const dim = visibility < 0.85;
  const attrs = dim
    ? TextAttributes.BOLD | TextAttributes.DIM
    : TextAttributes.BOLD;
  const blank = " ".repeat(Math.max(1, width));
  const height = 2 + bodyLines.length;

  return (
    <box
      style={{
        position: "absolute",
        top,
        left,
        width,
        height,
        zIndex: 1000,
        backgroundColor: plate,
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "stretch",
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      <text
        selectable={false}
        content={blank}
        style={{ fg: plate, bg: plate, height: 1, width }}
      />
      {bodyLines.map((line, i) => (
        <text
          key={`${item.id}-L${i}`}
          selectable={false}
          content={line}
          style={{
            fg: textFg,
            bg: plate,
            height: 1,
            width,
            attributes: attrs,
          }}
        />
      ))}
      <text
        selectable={false}
        content={blank}
        style={{ fg: plate, bg: plate, height: 1, width }}
      />
    </box>
  );
}

export function ToastHost(props: ToastHostProps): ReactNode {
  const { toast, theme, termWidth, termHeight } = props;
  const items = useToastState(toast);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (items.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    (id as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(id);
  }, [items.length > 0]);

  if (items.length === 0) return null;

  const maxWidth = Math.max(20, Math.min(termWidth - 4, Math.floor(termWidth * 0.85)));
  const ordered = [...items].reverse();

  const maxStack = Math.max(
    1,
    Math.min(3, Math.floor((termHeight - 4) / (TOAST_BOX_HEIGHT + TOAST_STACK_GAP))),
  );
  const visible = ordered.slice(0, maxStack);

  let stackY = 0;
  return (
    <>
      {visible.map((item) => {
        const innerW = Math.max(8, maxWidth - H_PAD * 2);
        const wrapped = wrapToastBody(item.level, item.message, innerW);
        const padded = padToastLines(wrapped, maxWidth);
        const natural = Math.max(
          ...padded.map((l) => l.length),
          16,
        );
        const toastWidth = Math.min(maxWidth, natural);
        const bodyLines =
          toastWidth === maxWidth
            ? padded
            : padToastLines(
                wrapToastBody(item.level, item.message, toastWidth - H_PAD * 2),
                toastWidth,
              );
        const boxHeight = 2 + bodyLines.length;
        const left = Math.max(0, Math.floor((termWidth - toastWidth) / 2));
        const anim = toastAnimAt(
          item.sticky
            ? Math.min(now - item.createdAt, TOAST_ENTER_MS)
            : now - item.createdAt,
          item.durationMs,
          boxHeight,
        );
        if (anim.phase === "gone") return null;
        const top = anim.top + stackY;
        stackY += boxHeight + TOAST_STACK_GAP;
        if (top + boxHeight < 0) return null;
        return (
          <ToastPill
            key={item.id}
            item={item}
            theme={theme}
            top={top}
            left={left}
            width={toastWidth}
            bodyLines={bodyLines}
            visibility={anim.visibility}
          />
        );
      })}
    </>
  );
}
