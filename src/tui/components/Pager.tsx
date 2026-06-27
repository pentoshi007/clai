import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface PagerProps {
  title: string;
  /** Pre-rendered body (may contain ANSI). */
  body: string;
  /** Available content height (rows) for the pager region. */
  height: number;
  onClose: () => void;
}

/**
 * A scrollable region for long content (full tool output, the plan document).
 * Arrow keys / PgUp-PgDn / g-G scroll; q or Esc closes. Sized to the height it
 * is given so it fits inside the pinned-composer layout.
 */
export function Pager({ title, body, height, onClose }: PagerProps) {
  const viewport = Math.max(3, height - 5);
  const lines = body.replace(/\n+$/, "").split("\n");
  const maxOffset = Math.max(0, lines.length - viewport);
  const [offset, setOffset] = useState(maxOffset);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      onClose();
      return;
    }
    if (key.downArrow || input === "j") setOffset((o) => Math.min(maxOffset, o + 1));
    else if (key.upArrow || input === "k") setOffset((o) => Math.max(0, o - 1));
    else if (key.pageDown || input === " ") setOffset((o) => Math.min(maxOffset, o + viewport));
    else if (key.pageUp) setOffset((o) => Math.max(0, o - viewport));
    else if (input === "g") setOffset(0);
    else if (input === "G") setOffset(maxOffset);
  });

  const off = Math.min(offset, maxOffset);
  const visible = lines.slice(off, off + viewport);
  const pct = maxOffset === 0 ? 100 : Math.round((off / maxOffset) * 100);

  return (
    <Box flexDirection="column" height={height} borderStyle="round" borderColor="gray" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">{title}</Text>
        <Text dimColor>{`${off + 1}-${Math.min(off + viewport, lines.length)} / ${lines.length} · ${pct}%`}</Text>
      </Box>
      <Text dimColor>↑/↓ or j/k scroll · PgUp/PgDn page · g/G jump · q/Esc close</Text>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
        {visible.map((line, i) => (
          <Text key={off + i} wrap="truncate-end" backgroundColor="black">
            <Text dimColor>{String(off + i + 1).padStart(4, " ")} │ </Text>
            {line === "" ? " " : line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
