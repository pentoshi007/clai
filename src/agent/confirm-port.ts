import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { getConfig } from "../store/config.js";
import { isPentestToolCall } from "../safety/classifier.js";
import type { ToolCall } from "../types.js";
import type { SessionPolicy } from "./session-policy.js";
import { formatToolArgs } from "./tool-call-parser.js";

export interface ConfirmPort {
  confirmTool(call: ToolCall): Promise<boolean>;
  confirmPentest(): Promise<boolean>;
  /** Ask the user whether to continue after hitting the step budget. */
  confirmContinue?(steps: number): Promise<boolean>;
  /**
   * Ask whether to leave ask mode and run an action task in agent mode.
   * Optional so existing ports keep working; ask-mode handoff falls back to a
   * default "no" when a port doesn't implement it.
   */
  confirmAgentSwitch?(info: {
    reason: string;
    tools: string[];
  }): Promise<boolean>;
}

/**
 * Re-assert raw mode AND resume stdin after an inquirer prompt
 * (confirm/password). inquirer's readline interface pauses stdin and
 * switches it to cooked mode when it closes; if we only flip raw mode back
 * on but leave stdin paused, no `keypress`/`data` events flow to the REPL's
 * ESC/Ctrl+C abort handler — so a long-running tool launched right after a
 * confirmation can no longer be aborted (the user had to kill the terminal).
 * Calling resume() restores the event flow.
 */
export function restoreInteractiveStdin(): void {
  if (!process.stdin.isTTY) return;
  try {
    if (!(process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
  } catch {
    /* ignore */
  }
}

export const inquirerConfirmPort: ConfirmPort = {
  async confirmTool(call: ToolCall): Promise<boolean> {
    return confirm({
      message: chalk.yellow(`  run ${call.name}: ${formatToolArgs(call)}?`),
      default: true,
    });
  },
  async confirmPentest(): Promise<boolean> {
    return confirm({
      message: chalk.red(
        "clai only assists with security testing on systems you own or have written permission to test. Confirm for this session?",
      ),
      default: false,
    });
  },
  async confirmContinue(steps: number): Promise<boolean> {
    return confirm({
      message: chalk.yellow(`  ${steps} steps reached — continue?`),
      default: true,
    });
  },
  async confirmAgentSwitch(info: {
    reason: string;
    tools: string[];
  }): Promise<boolean> {
    const tools = info.tools.length > 0 ? ` (${info.tools.join(", ")})` : "";
    return confirm({
      message: chalk.yellow(
        `  this needs agent mode${tools} — switch and run it?`,
      ),
      default: true,
    });
  },
};

export async function ensurePentestAuthorization(
  call: ToolCall,
  autoConfirm: boolean,
  session: SessionPolicy,
  confirmPort: ConfirmPort,
): Promise<boolean> {
  if (!isPentestToolCall(call)) return true;
  const config = getConfig();
  if (config.permissions === "allow-all") return true;
  // Persistent auth (via `clai authorize-pentest AGREE`) wins.
  if (config.pentestAuthorized) return true;
  // Session auth flipped earlier in this session — no re-prompt.
  if (session.pentestAuthorized.value) return true;

  if (autoConfirm) {
    // -y is session-scoped only. We do NOT touch the persistent config so
    // a one-shot `-y` cannot silently authorize later interactive runs.
    session.pentestAuthorized.value = true;
    return true;
  }

  const ok = await confirmPort.confirmPentest();
  if (!ok) return false;
  session.pentestAuthorized.value = true;
  return true;
}

export async function confirmToolExecution(
  call: ToolCall,
  autoConfirm: boolean,
  session: SessionPolicy,
  confirmPort: ConfirmPort,
): Promise<boolean> {
  const config = getConfig();
  if (config.permissions === "allow-all") return true;
  if (autoConfirm) return true;
  if (session.allow.has(call.name)) return true;
  // Persistent allowlist kept for backwards compat with users who set it
  // through `clai config` directly, but `/allow` only mutates the session
  // set so authorizations never leak across processes.
  if (config.allowAlwaysTools.includes(call.name)) return true;

  return confirmPort.confirmTool(call);
}
