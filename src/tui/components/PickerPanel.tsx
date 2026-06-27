import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";

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

  useEffect(() => setSelected(initial), [initial, options]);

  useInput((_input, key) => {
    if (key.escape) return onClose();
    if (key.upArrow) {
      setSelected((value) => (value - 1 + options.length) % options.length);
      return;
    }
    if (key.downArrow) {
      setSelected((value) => (value + 1) % options.length);
      return;
    }
    if (key.return && options[selected]) onSelect(options[selected]!.value);
  });

  const pageSize = Math.max(1, height - 4);
  const start = Math.max(0, Math.min(selected - Math.floor(pageSize / 2), options.length - pageSize));
  const visible = options.slice(start, start + pageSize);

  return (
    <Box flexDirection="column" height={height} borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">{title}</Text>
      <Text dimColor>↑/↓ select · enter confirm · esc close</Text>
      {visible.map((item, index) => {
        const absolute = start + index;
        const focused = absolute === selected;
        return (
          <Text key={item.value} wrap="truncate-end">
            <Text color={focused ? "magenta" : "white"} bold={focused}>
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
