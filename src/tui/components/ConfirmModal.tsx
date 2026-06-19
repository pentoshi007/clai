import { Box, Text, useInput } from "ink";
import type { PendingConfirm } from "../state.js";

export interface ConfirmModalProps {
  confirm: PendingConfirm;
  onAnswer: (ok: boolean) => void;
}

export function ConfirmModal({ confirm, onAnswer }: ConfirmModalProps) {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === "y" || key.return) {
      onAnswer(true);
    } else if (ch === "n" || key.escape) {
      onAnswer(false);
    }
  });

  const color = confirm.kind === "pentest" ? "red" : "yellow";
  return (
    <Box
      borderStyle="round"
      borderColor={color}
      flexDirection="column"
      paddingX={1}
    >
      <Text color={color} bold>
        {confirm.kind === "pentest" ? "⚠ Authorization required" : "Confirm action"}
      </Text>
      <Text>{confirm.prompt}</Text>
      <Text dimColor>
        {"  "}
        <Text color="green">y</Text>/enter = yes · <Text color="red">n</Text>/esc = no
      </Text>
    </Box>
  );
}
