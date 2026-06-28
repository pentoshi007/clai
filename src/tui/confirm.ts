import type { ConfirmPort } from "../agent/runner.js";
import type { ToolCall } from "../types.js";

function describeCall(call: ToolCall): string {
  if (call.name === "shell.exec") return String(call.args.command ?? "");
  try {
    const json = JSON.stringify(call.args);
    return json.length > 120 ? `${json.slice(0, 117)}…` : json;
  } catch {
    return "";
  }
}

/**
 * A confirm provider for the TUI. Inquirer can't run inside Ink (both fight
 * for stdin), so instead of prompting directly we hand the request to the
 * React layer via `request()`, which renders an in-app modal and resolves the
 * returned promise when the user answers.
 */
export interface TuiConfirmController {
  port: ConfirmPort;
  /** Called by the App to register how confirm requests reach the UI. */
  setHandler: (
    handler: (req: { kind: "tool" | "pentest" | "continue"; prompt: string }) => Promise<boolean>,
  ) => void;
}

export function createTuiConfirmPort(): TuiConfirmController {
  let handler:
    | ((req: { kind: "tool" | "pentest" | "continue"; prompt: string }) => Promise<boolean>)
    | undefined;

  const ask = async (req: {
    kind: "tool" | "pentest" | "continue";
    prompt: string;
  }): Promise<boolean> => {
    if (!handler) return false;
    return handler(req);
  };

  const port: ConfirmPort = {
    async confirmTool(call: ToolCall): Promise<boolean> {
      const args = describeCall(call);
      return ask({
        kind: "tool",
        prompt: `Run ${call.name}${args ? ` ${args}` : ""}?`,
      });
    },
    async confirmPentest(): Promise<boolean> {
      return ask({
        kind: "pentest",
        prompt:
          "This is a security/pentest action. Confirm you are authorized to run it against this target.",
      });
    },
    async confirmContinue(steps: number): Promise<boolean> {
      return ask({
        kind: "continue",
        prompt: `${steps} steps reached — continue running?`,
      });
    },
  };

  return {
    port,
    setHandler(h) {
      handler = h;
    },
  };
}
