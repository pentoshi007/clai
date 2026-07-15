import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";

export interface PickerOption {
  value: string;
  label: string;
  description?: string;
  active?: boolean;
}

/**
 * Returns the span (last matched index - first matched index) of `needle` as a
 * subsequence of `text`, or `null` when `text` does not contain every character
 * of `needle` in order. A subsequence requires all query characters to appear,
 * left to right, but not consecutively — so `mini3` matches `minimax-m3`, while
 * `free` only matches fields that actually contain f-r-e-e in order. A smaller
 * span means the matched characters are packed more tightly, which ranks higher.
 */
function subsequenceSpan(needle: string, text: string): number | null {
  let j = 0;
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < text.length && j < needle.length; i++) {
    if (text[i] === needle[j]) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
      j++;
    }
  }
  if (j !== needle.length) return null;
  return lastIdx - firstIdx;
}

export function PickerPanel({
  title,
  options,
  searchDescription = true,
  twoLine = false,
  height,
  onSelect,
  onClose,
}: {
  title: string;
  options: PickerOption[];
  searchDescription?: boolean | undefined;
  twoLine?: boolean | undefined;
  height: number;
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  const initial = Math.max(0, options.findIndex((item) => item.active));
  const [selected, setSelected] = useState(initial);
  const [query, setQuery] = useState("");

  useEffect(() => setSelected(initial), [initial, options]);

  const filtered = useMemo(() => {
    // Collapse whitespace so multi-word queries ("gpt 4o") match ids ("gpt-4o").
    const needle = query.trim().toLowerCase().replace(/\s+/g, "");
    if (!needle) return options;

    const scored: Array<{ item: PickerOption; score: number }> = [];
    for (const item of options) {
      // Match each field on its own. Concatenating fields would let a query
      // borrow characters across field boundaries (and across the duplicated
      // label/value pair), producing matches that share only scattered chars.
      const fields = [item.label, item.value];
      if (searchDescription && item.description) fields.push(item.description);

      let best: number | null = null;
      const seen = new Set<string>();
      for (let rank = 0; rank < fields.length; rank++) {
        const field = fields[rank]!.toLowerCase();
        if (seen.has(field)) continue;
        seen.add(field);
        const span = subsequenceSpan(needle, field);
        if (span === null) continue;
        // Lower score = better. Reward tight matches and substring/prefix hits,
        // and prefer label/value (lower rank) over description.
        let score = span + rank * 10_000;
        if (field.startsWith(needle)) score -= 1_000_000;
        else if (field.includes(needle)) score -= 500_000;
        if (best === null || score < best) best = score;
      }
      if (best !== null) scored.push({ item, score: best });
    }

    scored.sort((a, b) => a.score - b.score);
    return scored.map((entry) => entry.item);
  }, [options, query, searchDescription]);

  useEffect(() => {
    const active = filtered.findIndex((item) => item.active);
    setSelected(Math.max(0, active));
  }, [filtered]);

  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.backspace || key.delete) {
      setQuery((value) => value.slice(0, -1));
      return;
    }
    if (key.ctrl && input === "u") {
      setQuery("");
      return;
    }
    if (key.upArrow) {
      if (filtered.length) setSelected((value) => (value - 1 + filtered.length) % filtered.length);
      return;
    }
    if (key.downArrow) {
      if (filtered.length) setSelected((value) => (value + 1) % filtered.length);
      return;
    }
    if (key.return && filtered[selected]) {
      onSelect(filtered[selected]!.value);
      return;
    }
    if (!key.ctrl && !key.meta && input && input.length === 1) {
      setQuery((value) => value + input);
    }
  });

  // In two-line mode each row spans a name line plus a dim meta line, so half
  // as many rows fit. Remaining lines cover border + header (title/filter/hint/rule/gap).
  const linesPerItem = twoLine ? 2 : 1;
  const pageSize = Math.max(1, Math.floor((height - 8) / linesPerItem));
  const safeSelected = Math.min(selected, Math.max(0, filtered.length - 1));
  const start = Math.max(0, Math.min(safeSelected - Math.floor(pageSize / 2), filtered.length - pageSize));
  const visible = filtered.slice(start, start + pageSize);

  return (
    <Box flexDirection="column" height={height} borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">{title}</Text>
      <Text>
        <Text color="cyan">filter › </Text>
        {query ? <Text color="white">{query}</Text> : <Text dimColor>type:filter</Text>}
        <Text dimColor>{`  ·  ${filtered.length}/${options.length}`}</Text>
      </Text>
      <Text dimColor>↑↓:select  ·  type:filter  ·  ⌫:edit  ·  ^u:clear  ·  enter:confirm  ·  esc:close</Text>
      <Text color="#334155">{"─".repeat(48)}</Text>
      {filtered.length === 0 ? <Text color="yellow">No matches</Text> : null}
      {visible.map((item, index) => {
        const absolute = start + index;
        const focused = absolute === safeSelected;
        const background = focused
          ? "#2563EB"
          : index % 2 === 0
            ? "#1E293B"
            : "#0F172A";
        if (twoLine) {
          return (
            <Box key={item.value} flexDirection="column">
              <Text wrap="truncate-end" backgroundColor={background}>
                <Text color="#FFFFFF" bold={focused}>
                  {focused ? "❯ " : "  "}{item.label}
                </Text>
                {item.active ? <Text color="green">  active</Text> : null}
              </Text>
              <Text wrap="truncate-end" backgroundColor={background} dimColor>
                {item.description ? `    ${item.description}` : " "}
              </Text>
            </Box>
          );
        }
        return (
          <Text key={item.value} wrap="truncate-end" backgroundColor={background}>
            <Text color="#FFFFFF" bold={focused}>
              {focused ? "❯ " : "  "}{item.label}
            </Text>
            {item.active ? <Text color="green">  active</Text> : null}
            {item.description ? <Text dimColor>  {item.description}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}
