/**
 * Adapts `OverlayController` into the typed app-layer confirm/secret ports
 * (CORE-002, V2-073). The agent never reads the terminal directly: it awaits
 * these promises, which resolve once the user answers the rendered modal.
 * Prompt text is ported from the classic TUI's `confirm.ts` so both
 * frontends read the same way.
 */

import type { ToolCall } from "../../types.js";
import type { ConfirmationPort } from "../../app/ports/confirm-port.js";
import type { SecretPort } from "../../app/ports/secret-port.js";
import type { OverlayController } from "../controllers/overlay-controller.js";

function describeCall(call: ToolCall): string {
  if (call.name === "shell.exec") return String(call.args.command ?? "");
  try {
    const json = JSON.stringify(call.args);
    return json.length > 120 ? `${json.slice(0, 117)}…` : json;
  } catch {
    return "";
  }
}

export function createOverlayConfirmPort(overlay: OverlayController): ConfirmationPort {
  return {
    async confirmTool(call: ToolCall): Promise<boolean> {
      const args = describeCall(call);
      return overlay.openConfirm({ kind: "tool", prompt: `Run ${call.name}${args ? ` ${args}` : ""}?` });
    },
    async confirmPentest(): Promise<boolean> {
      return overlay.openConfirm({
        kind: "pentest",
        prompt:
          "This is a security/pentest action. Confirm you are authorized to run it against this target.",
      });
    },
    async confirmContinue(steps: number): Promise<boolean> {
      return overlay.openConfirm({ kind: "continue", prompt: `${steps} steps reached — continue running?` });
    },
    async confirmAgentSwitch(info: { reason: string; tools: string[] }): Promise<boolean> {
      const tools = info.tools.length > 0 ? ` (${info.tools.join(", ")})` : "";
      const why = info.reason ? `${info.reason}\n\n` : "";
      return overlay.openConfirm({
        kind: "switch",
        prompt: `${why}This needs agent mode${tools}, which ask mode can't do. Switch to agent mode and run it?`,
      });
    },
  };
}

export function createOverlaySecretPort(overlay: OverlayController): SecretPort["request"] {
  return (request) => overlay.openSecret(request);
}
