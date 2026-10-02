
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { formatOperationReview, reviewDisplayText } from "../../app/operation-review.js";
import { resolveFsToolPath } from "../../tools/fs.js";
import type { ToolCall } from "../../types.js";
import type { ConfirmationPort } from "../../app/ports/confirm-port.js";
import type { SecretPort } from "../../app/ports/secret-port.js";
import type { OverlayController } from "../controllers/overlay-controller.js";
import {
  PENTEST_PROMPT_TEXT,
  agentSwitchPromptText,
  deletePromptText,
  toolPromptText,
} from "../../app/confirm-prompt-text.js";

const PREVIEW_MAX_BYTES = 256 * 1024;

function expandUserPath(path: string): string {
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  if (path === "~") return homedir();
  return path;
}

export async function loadDeletePreview(path: string): Promise<string> {
  const resolved = resolveFsToolPath(expandUserPath(path));
  try {
    const buf = await readFile(resolved);
    const head = buf.subarray(0, PREVIEW_MAX_BYTES);
    let nuls = 0;
    for (let i = 0; i < head.length; i += 1) {
      if (head[i] === 0) nuls += 1;
    }
    if (nuls > 0 && nuls / Math.max(1, head.length) > 0.01) {
      return (
        `File: ${resolved}\nSize: ${buf.length} bytes\n\n` +
        `(binary or non-text content — not shown as UTF-8)\n` +
        `Approve with y to delete, or n/esc to cancel.`
      );
    }
    let text = head.toString("utf8");
    if (buf.length > PREVIEW_MAX_BYTES) {
      text +=
        `\n\n… truncated preview (${PREVIEW_MAX_BYTES} of ${buf.length} bytes). ` +
        `Full file still on disk until you approve delete.`;
    }
    return `File: ${resolved}\nSize: ${buf.length} bytes\n\n${text}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      `File: ${resolved}\n\n(could not read for preview: ${msg})\n` +
      `You can still approve delete with y, or cancel with n/esc.`
    );
  }
}

export function createOverlayConfirmPort(overlay: OverlayController): ConfirmationPort {
  return {
    async confirmTool(call: ToolCall): Promise<boolean> {
      const review = formatOperationReview(call);
      const isDelete = call.name === "fs.delete";
      const path =
        typeof call.args.path === "string" ? call.args.path.trim() : "";
      if (isDelete && path) {
        const prompt = deletePromptText(path, { viewHint: true });
        const request = { kind: "tool" as const, prompt, viewPath: path, review };
        return overlay.openConfirm(
          request,
          undefined,
          () => {
            void (async () => {
              const body = await loadDeletePreview(path);
              const state = overlay.getState();
              if (state.kind !== "confirm" || state.request !== request) return;
              overlay.openPager(review.title, `${review.body}\n\nExisting deletion target (content preview limited to ${PREVIEW_MAX_BYTES} bytes):\n${reviewDisplayText(body)}`, undefined, path, "plain");
            })();
          },
        );
      }
      return overlay.openConfirm({
        kind: "tool",
        prompt: toolPromptText(call),
        review,
      });
    },
    async confirmPentest(call?: ToolCall): Promise<boolean> {
      return overlay.openConfirm({
        kind: "pentest",
        prompt: PENTEST_PROMPT_TEXT,
        review: call ? formatOperationReview(call) : undefined,
      });
    },
    async confirmAgentSwitch(info: { reason: string; tools: string[] }): Promise<boolean> {
      return overlay.openConfirm({
        kind: "switch",
        prompt: agentSwitchPromptText(info),
      });
    },
  };
}

export function createOverlaySecretPort(overlay: OverlayController): SecretPort["request"] {
  return (request) => overlay.openSecret({ ...request, review: request.operation ? formatOperationReview(request.operation) : { title: `Review · ${request.title}`, body: reviewDisplayText(request.prompt) } });
}
