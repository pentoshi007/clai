import { Box, Text, useInput } from "ink";
import type { PendingConfirm } from "../state.js";

export interface ConfirmModalProps {
  confirm: PendingConfirm;
  onAnswer: (ok: boolean) => void;
  /** Called for the plan-implement prompt's "p" shortcut to view the full plan. */
  onViewPlan?: (() => void) | undefined;
}

export function ConfirmModal({ confirm, onAnswer, onViewPlan }: ConfirmModalProps) {
  useInput((input, key) => {
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
          <Text color="green" inverse> r:reset </Text>
          {"  ·  "}
          <Text color="red" inverse> esc:cancel </Text>
        </Text>
      ) : isPlan ? (
        <Text bold>
          <Text color="green" inverse> y:implement </Text>
          {"  ·  "}
          <Text color="red" inverse> n:discard </Text>
          {"  ·  "}
          <Text color="cyan" inverse> p:view-plan </Text>
        </Text>
      ) : (
        <Text bold>
          <Text color="green" inverse>
            {isContinue ? " y:continue " : " y:approve "}
          </Text>
          {"  ·  "}
          <Text color="red" inverse>
            {isContinue ? " n:stop " : " n:deny "}
          </Text>
        </Text>
      )}
    </Box>
  );
}
