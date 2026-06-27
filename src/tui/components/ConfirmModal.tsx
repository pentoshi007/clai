import { Box, Text, useInput } from "ink";
import type { PendingConfirm } from "../state.js";

export interface ConfirmModalProps {
  confirm: PendingConfirm;
  onAnswer: (ok: boolean) => void;
}

export function ConfirmModal({ confirm, onAnswer }: ConfirmModalProps) {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === "y") {
      onAnswer(true);
    } else if (ch === "n" || key.escape) {
      onAnswer(false);
    }
  });

  const color = confirm.kind === "pentest" ? "red" : "yellow";
  return (
    <Box
      borderStyle="double"
      borderColor={color}
      flexDirection="column"
      paddingX={1}
      marginX={2}
    >
      <Text color={color} bold inverse>
        {confirm.kind === "pentest" ? " ACTION REQUIRED · AUTHORIZATION " : " ACTION REQUIRED · CONFIRMATION "}
      </Text>
      <Text>{confirm.prompt}</Text>
      <Text bold>
        Press <Text color="green" inverse> Y </Text> to approve  ·  Press <Text color="red" inverse> N </Text> to deny
      </Text>
    </Box>
  );
}
