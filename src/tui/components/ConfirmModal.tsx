import { Box, Text, useInput } from "ink";
import type { PendingConfirm } from "../state.js";

export interface ConfirmModalProps {
  confirm: PendingConfirm;
  onAnswer: (ok: boolean) => void;
  /** Called for the plan-implement prompt's "p" shortcut to view the full plan. */
  onViewPlan?: (() => void) | undefined;
  overlayOpen?: boolean | undefined;
}

export function ConfirmModal({ confirm, onAnswer, onViewPlan, overlayOpen }: ConfirmModalProps) {
  useInput((input, key) => {
    if (overlayOpen) return;
    const ch = input.toLowerCase();
    if (confirm.kind === "reset") {
      if (ch === "r") {
        onAnswer(true);
      } else if (key.escape) {
        onAnswer(false);
      }
    } else if (confirm.kind === "plan") {
      // y / i → implement · n / d / Esc → discard · p → view the full plan
      if (ch === "y" || ch === "i") {
        onAnswer(true);
      } else if (ch === "n" || ch === "d" || key.escape) {
        onAnswer(false);
      } else if (ch === "p") {
        onViewPlan?.();
      }
    } else {
      if (ch === "y") {
        onAnswer(true);
      } else if (ch === "n" || key.escape) {
        onAnswer(false);
      }
    }
  });

  const isReset = confirm.kind === "reset";
  const isContinue = confirm.kind === "continue";
  const isPlan = confirm.kind === "plan";
  const color = confirm.kind === "pentest"
    ? "red"
    : isContinue || isPlan
      ? "cyan"
      : "yellow";
  return (
    <Box
      borderStyle="double"
      borderColor={color}
      flexDirection="column"
      paddingX={1}
      marginX={2}
    >
      <Text color={color} bold inverse>
        {confirm.kind === "pentest"
          ? " ACTION REQUIRED · AUTHORIZATION "
          : isReset
            ? " ACTION REQUIRED · RESET CONFIRMATION "
            : isContinue
              ? " STEP LIMIT REACHED "
              : isPlan
                ? " PLAN READY · IMPLEMENT OR DISCARD "
                : " ACTION REQUIRED · CONFIRMATION "}
      </Text>
      <Text>{confirm.prompt}</Text>
      {isReset ? (
        <Text bold>
          Press <Text color="green" inverse> R </Text> to reset  ·  Press <Text color="red" inverse> Esc </Text> to cancel
        </Text>
      ) : isPlan ? (
        <Text bold>
          Press <Text color="green" inverse> Y </Text> to implement  ·  Press <Text color="red" inverse> N </Text> to discard  ·  Press <Text color="cyan" inverse> P </Text> to view plan
        </Text>
      ) : (
        <Text bold>
          Press <Text color="green" inverse> Y </Text> to {isContinue ? "continue" : "approve"}  ·  Press <Text color="red" inverse> N </Text> to {isContinue ? "stop" : "deny"}
        </Text>
      )}
    </Box>
  );
}
