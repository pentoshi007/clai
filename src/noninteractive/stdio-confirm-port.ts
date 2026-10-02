
import { formatOperationReview } from "../app/operation-review.js";
import type { ConfirmationPort } from "../app/ports/confirm-port.js";
import type { SecretPort } from "../app/ports/secret-port.js";
import {
  PENTEST_PROMPT_TEXT,
  agentSwitchPromptText,
  deletePromptText,
  toolPromptText,
} from "../app/confirm-prompt-text.js";
import type { ToolCall } from "../types.js";
import {
  CONFIRMATION_REQUIRED_MESSAGE,
  askReviewPager,
  askSecret,
  askYesNo,
  isInteractiveStdin,
  type PromptIO,
} from "./readline-prompts.js";

export type StdioConfirmOptions = PromptIO;

function requireTty(io?: PromptIO): void {
  if (!isInteractiveStdin(io)) {
    throw new Error(CONFIRMATION_REQUIRED_MESSAGE);
  }
}

async function confirm(
  prompt: string,
  defaultValue: boolean,
  io?: PromptIO,
  call?: ToolCall,
): Promise<boolean> {
  requireTty(io);
  if (call) {
    const review = formatOperationReview(call);
    if (!(await askReviewPager(review.title, review.body, io))) return false;
  }
  return askYesNo(prompt, { ...io, defaultValue });
}

export function createStdioConfirmPort(
  io?: StdioConfirmOptions,
): ConfirmationPort {
  return {
    async confirmTool(call: ToolCall): Promise<boolean> {
      const path =
        typeof call.args.path === "string" ? call.args.path.trim() : "";
      if (call.name === "fs.delete" && path) {
        return confirm(deletePromptText(path), false, io, call);
      }
      return confirm(toolPromptText(call), true, io, call);
    },
    async confirmPentest(call?: ToolCall): Promise<boolean> {
      return confirm(PENTEST_PROMPT_TEXT, false, io, call);
    },
    async confirmAgentSwitch(info: {
      reason: string;
      tools: string[];
    }): Promise<boolean> {
      return confirm(agentSwitchPromptText(info), true, io);
    },
  };
}

export function createStdioSecretPort(
  io?: StdioConfirmOptions,
): SecretPort["request"] {
  return async (request) => {
    if (request.operation) {
      requireTty(io);
      const review = formatOperationReview(request.operation);
      if (!(await askReviewPager(review.title, review.body, io))) return undefined;
    }
    const prompt = request.prompt || request.title;
    const value = await askSecret(prompt, io);
    return value ? value : undefined;
  };
}
