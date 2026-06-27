import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";

export interface PickerOption {
  value: string;
  label: string;
  description?: string;
  active?: boolean;
}

export function PickerPanel({
  title,
  options,
  height,
  onSelect,
  onClose,
}: {
  title: string;
  options: PickerOption[];
  height: number;
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  const initial = Math.max(0, options.findIndex((item) => item.active));
  const [selected, setSelected] = useState(initial);
  const [query, setQuery] = useState("");

  useEffect(() => setSelected(initial), [initial, options]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    const matches = options.filter((item) => {
      const haystack = `${item.label} ${item.value} ${item.description ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    });
    return matches.sort((a, b) => {
      const aText = `${a.label} ${a.value}`.toLowerCase();
      const bText = `${b.label} ${b.value}`.toLowerCase();
      const aStarts = aText.startsWith(needle) ? 0 : 1;
      const bStarts = bText.startsWith(needle) ? 0 : 1;
      return aStarts - bStarts;
    });
  }, [options, query]);

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

  const pageSize = Math.max(1, height - 6);
  const safeSelected = Math.min(selected, Math.max(0, filtered.length - 1));
  const start = Math.max(0, Math.min(safeSelected - Math.floor(pageSize / 2), filtered.length - pageSize));
  const visible = filtered.slice(start, start + pageSize);

  return (
    <Box flexDirection="column" height={height} borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">{title}</Text>
      <Text>
        <Text color="cyan">filter › </Text>
        {query ? <Text color="white">{query}</Text> : <Text dimColor>type to search</Text>}
        <Text dimColor>{`  ·  ${filtered.length}/${options.length}`}</Text>
      </Text>
      <Text dimColor>↑/↓ select · type filters · backspace edits · ctrl+u clears · enter confirm · esc close</Text>
      {filtered.length === 0 ? <Text color="yellow">No matches</Text> : null}
      {visible.map((item, index) => {
        const absolute = start + index;
        const focused = absolute === safeSelected;
        return (
          <Text key={item.value} wrap="truncate-end" backgroundColor={focused ? "magenta" : index % 2 === 0 ? "gray" : "black"}>
            <Text color={focused ? "black" : "white"} bold={focused}>
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
