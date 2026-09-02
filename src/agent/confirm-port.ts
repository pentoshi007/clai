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
  confirmAgentSwitch?(info: {
    reason: string;
    tools: string[];
  }): Promise<boolean>;
}

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
  if (config.pentestAuthorized) return true;
  if (session.pentestAuthorized.value) return true;

  if (autoConfirm) {
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
  if (call.name === "fs.delete") {
    return confirmPort.confirmTool(call);
  }
  const config = getConfig();
  if (config.permissions === "allow-all") return true;
  if (options?.forceConfirm) return confirmPort.confirmTool(call);
  if (autoConfirm) return true;
  if (session.allow.has(call.name)) return true;
  if (config.allowAlwaysTools.includes(call.name)) return true;

  return confirmPort.confirmTool(call);
}
