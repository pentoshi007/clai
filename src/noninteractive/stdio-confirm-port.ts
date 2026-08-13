/**
 * readline-backed `ConfirmationPort` / `SecretPort["request"]` for the
 * non-interactive surface (06-ONESHOT.md §4). Prompt wording comes from
 * `app/confirm-prompt-text.ts`, shared with the overlay surface.
 *
 * A confirmation on a non-TTY stdin cannot be answered, so it rejects with
 * `CONFIRMATION_REQUIRED_MESSAGE` and the runner surfaces it as a blocked
 * tool. The previous inquirer prompt hung forever in that case.
 */

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
): Promise<boolean> {
  requireTty(io);
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
        return confirm(deletePromptText(path), false, io);
      }
      return confirm(toolPromptText(call), true, io);
    },
    async confirmPentest(): Promise<boolean> {
      return confirm(PENTEST_PROMPT_TEXT, false, io);
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
    const prompt = request.prompt || request.title;
    const value = await askSecret(prompt, io);
    return value ? value : undefined;
  };
}
