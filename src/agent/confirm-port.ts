import { getConfig } from "../store/config.js";
import { isPentestToolCall } from "../safety/classifier.js";
import {
  createStdioConfirmPort,
  createStdioSecretPort,
} from "../noninteractive/stdio-confirm-port.js";
import { restoreInteractiveStdin } from "../noninteractive/readline-prompts.js";
import type { ToolCall } from "../types.js";
import type { SessionPolicy } from "./session-policy.js";

export { restoreInteractiveStdin };

export interface ConfirmPort {
  confirmTool(call: ToolCall): Promise<boolean>;
  confirmPentest(): Promise<boolean>;
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

/** Default port: readline prompts on the process stdio (06-ONESHOT.md §4). */
export const stdioConfirmPort: ConfirmPort = createStdioConfirmPort();

const requestStdioSecret = createStdioSecretPort();

export async function stdioSecretRequester(request: {
  title: string;
  prompt: string;
}): Promise<string | undefined> {
  return requestStdioSecret(request);
}

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
  options?: { forceConfirm?: boolean | undefined },
): Promise<boolean> {
  // fs.delete always prompts — at every permission level, even allow-all / -y.
  // Deletion is irreversible; never auto-approve. Everything else (including
  // out-of-cwd writes) honors allow-all.
  if (call.name === "fs.delete") {
    return confirmPort.confirmTool(call);
  }
  const config = getConfig();
  if (config.permissions === "allow-all") return true;
  if (options?.forceConfirm) return confirmPort.confirmTool(call);
  if (autoConfirm) return true;
  if (session.allow.has(call.name)) return true;
  // Persistent allowlist kept for backwards compat with users who set it
  // through `clai config` directly, but `/allow` only mutates the session
  // set so authorizations never leak across processes.
  if (config.allowAlwaysTools.includes(call.name)) return true;

  return confirmPort.confirmTool(call);
}
