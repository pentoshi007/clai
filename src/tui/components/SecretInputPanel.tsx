import { Box, Text, useInput } from "ink";
import { useState } from "react";

export function SecretInputPanel({
  title,
  prompt,
  onSubmit,
  onCancel,
}: {
  title: string;
  prompt: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) { if (value) onSubmit(value); return; }
    if (key.backspace || key.delete) { setValue((current) => current.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta && input) setValue((current) => current + input);
  });

  return (
    <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1} marginX={2}>
      <Text color="yellow" bold inverse> SECURE INPUT · {title.toUpperCase()} </Text>
      <Text>{prompt}</Text>
      <Text><Text color="yellow">password › </Text>{"•".repeat(value.length)}<Text inverse> </Text></Text>
      <Text dimColor>Enter submits · Esc cancels · input is never saved or displayed</Text>
    </Box>
  );
}
