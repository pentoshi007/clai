import type { ChatMessage } from "../../types.js";
import { estimateMessagesTokens } from "../request-accounting.js";
import { expandKeepStartForToolPairs } from "../tool-history.js";

export function compactionSourcePrefixEnd(input: {
  readonly messages: readonly ChatMessage[];
  readonly start: number;
  readonly tailStart: number;
  readonly prompt: string;
  readonly budgetTokens: number;
}): number | undefined {
  if (input.budgetTokens <= 0) return undefined;
  let low = input.start + 1;
  let high = input.tailStart;
  let end = input.start;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const tokens = estimateMessagesTokens([
      ...input.messages.slice(0, middle),
      { role: "user", content: input.prompt },
    ]);
    if (tokens <= input.budgetTokens) {
      end = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  end = expandKeepStartForToolPairs([...input.messages], end);
  return end > input.start ? end : undefined;
}
