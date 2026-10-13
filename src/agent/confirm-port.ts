import { getConfig } from "../store/config.js";
import { isPentestToolCall } from "../safety/classifier.js";
import { filesystemPermissionDecision } from "../safety/filesystem-permissions.js";
import { DEFAULT_PERMISSION_MODE } from "../safety/permission-mode.js";
import type { ConfirmationPort } from "../app/ports/confirm-port.js";
import {
  createStdioConfirmPort,
  createStdioSecretPort,
} from "../noninteractive/stdio-confirm-port.js";
import { restoreInteractiveStdin } from "../noninteractive/readline-prompts.js";
import type { ToolCall } from "../types.js";
import type { SessionPolicy } from "./session-policy.js";

export { restoreInteractiveStdin };

export type ConfirmPort = ConfirmationPort;

export const stdioConfirmPort: ConfirmPort = createStdioConfirmPort();

const requestStdioSecret = createStdioSecretPort();

export async function stdioSecretRequester(request: Parameters<typeof requestStdioSecret>[0]): Promise<string | undefined> {
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
  const mode = config.permissions ?? DEFAULT_PERMISSION_MODE;
  if (mode === "allow-all" || mode === "full-access") return true;
  if (config.pentestAuthorized) return true;
  if (session.pentestAuthorized.value) return true;

  if (autoConfirm) {
    session.pentestAuthorized.value = true;
    return true;
  }

  const ok = await confirmPort.confirmPentest(call);
  if (!ok) return false;
  session.pentestAuthorized.value = true;
  return true;
}

export async function confirmToolExecution(
  call: ToolCall,
  autoConfirm: boolean,
  session: SessionPolicy,
  confirmPort: ConfirmPort,
  options?: { forceConfirm?: boolean | undefined; reason?: string | undefined },
): Promise<boolean> {
  const config = getConfig();
  const mode = config.permissions ?? DEFAULT_PERMISSION_MODE;
  if (mode === "full-access") return true;
  const filesystem = filesystemPermissionDecision(call, mode);
  if (filesystem.permission === "confirm") {
    return confirmPort.confirmTool(call, { reason: filesystem.reason });
  }
  if (filesystem.permission === "allow" || mode === "allow-all") return true;
  const context = { reason: options?.reason || "Default permissions require approval for this tool." };
  if (options?.forceConfirm) return confirmPort.confirmTool(call, context);
  if (autoConfirm) return true;
  if (session.allow.has(call.name)) return true;
  if (config.allowAlwaysTools.includes(call.name)) return true;

  return confirmPort.confirmTool(call, context);
}
