import { Box, Text, useInput, useStdout } from "ink";
import { useState } from "react";

export interface PagerProps {
  title: string;
  /** Pre-rendered body (may contain ANSI). */
  body: string;
  onClose: () => void;
}

/**
 * A full-height scrollable overlay for long content (full tool output, the
 * plan document). Replaces the classic `openPager` — it can't run inside Ink
 * because both own stdout/raw-mode. Arrow keys / PgUp-PgDn / g-G scroll;
 * q or Esc closes.
 */
export function Pager({ title, body, onClose }: PagerProps) {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 80;
  const viewport = Math.max(3, rows - 4);
  const lines = body.replace(/\n+$/, "").split("\n");
  const maxOffset = Math.max(0, lines.length - viewport);
  const [offset, setOffset] = useState(0);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      onClose();
      return;
    }
    if (key.downArrow || input === "j") {
      setOffset((o) => Math.min(maxOffset, o + 1));
    } else if (key.upArrow || input === "k") {
      setOffset((o) => Math.max(0, o - 1));
    } else if (key.pageDown || input === " ") {
      setOffset((o) => Math.min(maxOffset, o + viewport));
    } else if (key.pageUp) {
      setOffset((o) => Math.max(0, o - viewport));
    } else if (input === "g") {
      setOffset(0);
    } else if (input === "G") {
      setOffset(maxOffset);
    }
  });

  const visible = lines.slice(offset, offset + viewport);
  const pct = maxOffset === 0 ? 100 : Math.round((offset / maxOffset) * 100);

  return (
    <Box
      flexDirection="column"
      width={cols}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text>
        <Text bold color="cyan">
          {title}
        </Text>
        <Text dimColor>{`  (${pct}%  ·  ↑↓/PgUp/PgDn/g/G scroll · q to close)`}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((line, i) => (
          <Text key={offset + i}>{line}</Text>
        ))}
      </Box>
    </Box>
  );
}
