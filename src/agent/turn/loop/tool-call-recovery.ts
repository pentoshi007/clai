import type { ChatMessage } from "../../../types.js";
import type { SalvagedWrite } from "../../tool-call-parser.js";
import {
  countToolFences,
  looksLikeTruncatedToolCall,
  salvageTruncatedWrite,
} from "../../tool-call-parser.js";
import { stripThinking } from "../../../ui/thinking.js";
import { toolNudge } from "../../../prompts/index.js";

const SENTINEL_TOOL_CALL =
  /<\|tool_call(?:s_section)?_begin\|>|<\|tool_call_argument_begin\|>|<[|｜]+DSML[|｜]+(?:tool_calls|invoke|parameter)\b|<[|｜]+tool[_▁](?:calls?[_▁]begin|sep)[|｜]+>/i;

const FENCED_CALL_SHAPE = /```tool\s*\n[\s\S]*?"(?:name|args)"\s*:/i;

export interface SalvagedWriteOutcome {
  readonly ok: boolean;
  readonly bytesOnDisk: number;
}

export interface ToolCallRecoveryState {
  bareToolJsonRetries: number;
  truncatedToolRetries: number;
  malformedFenceRetries: number;
}

export interface ToolCallRecoveryPorts {
  readonly messages: ChatMessage[];
  readonly toolsAttached: boolean;
  readonly planModeWithoutPlan: boolean;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly commitAssistantRetry: (text: string) => void;
  readonly recoveryUserMessage: (content: string) => ChatMessage;
  readonly applySalvagedWrite: (
    salvaged: SalvagedWrite,
  ) => Promise<SalvagedWriteOutcome>;
}

export type ToolCallRecoveryDecision = "retry" | "proceed";

const bareArgsNudge = (ports: ToolCallRecoveryPorts): string => {
  if (ports.planModeWithoutPlan) {
    return ports.toolsAttached
      ? "Your previous message was a bare JSON args object with no tool name, so NOTHING ran. " +
          "In plan mode: call plan.create (or research tools) via the platform tool interface."
      : "Your previous message was a bare JSON args object with no tool name and no ```tool fence, so NOTHING ran. " +
          "In plan mode, call plan.create with a proper ```tool block when ready, e.g.:\n" +
          '```tool\n{"name":"plan.create","args":{"goal":"…","detail":"…","tasks":["…"],"kind":"coding"}}\n```';
  }
  return ports.toolsAttached
    ? "Your previous message was a bare JSON args object with no tool name, so NOTHING ran. " +
        toolNudge(true) +
        " Include the tool name and full args via the platform tool interface — do not use markdown fences."
    : "Your previous message was a bare JSON args object with no tool name and no ```tool fence, so NOTHING ran. " +
        "Reply with ONLY a fenced ```tool block of the form " +
        '`{"name": "<tool>", "args": { ... }}`. For example, to read a PDF:\n' +
        '```tool\n{"name":"pdf.read","args":{"path":"/abs/file.pdf"}}\n```\n' +
        "Choose the correct tool name for the task and include those args.";
};

const sentinelNudge = (ports: ToolCallRecoveryPorts): string =>
  ports.toolsAttached
    ? "Your previous tool call was malformed or truncated. " +
      toolNudge(true) +
      " Pass valid JSON arguments via the platform tool interface — do not use fence or sentinel markers."
    : "Your previous tool call was malformed or truncated. " +
      "Reply with ONLY a fenced ```tool block containing valid JSON " +
      'of the form `{"name": "<tool>", "args": { ... }}`. ' +
      "Do not use <|tool_call_begin|> markers.";

const truncatedNudge = (ports: ToolCallRecoveryPorts): string =>
  ports.toolsAttached
    ? "Your previous tool call was cut off before it finished — the JSON was incomplete, so NOTHING ran. " +
      "Prefer ONE complete fs.write when it fits. If the file is too large: (1) fs.write the first large section, " +
      "(2) fs.append the rest with expectedPriorBytes from the write receipt, (3) repeat with large chunks. " +
      "Keep reasoning SHORT and call the tool via the platform interface. Do NOT claim a file was written until a tool call succeeds."
    : "Your previous tool call was cut off before it finished — the JSON was incomplete, so NOTHING ran. " +
      "Prefer ONE complete fs.write when it fits (~32k output tokens is a lot of file content if reasoning stays short). " +
      "If the file is too large for one call:\n" +
      "1. fs.write the first large section (as much as fits — hundreds+ of lines)\n" +
      "2. fs.append the rest with expectedPriorBytes from the write receipt\n" +
      "3. Repeat append only if still incomplete — large chunks, not ~100-line drips\n" +
      "Keep reasoning SHORT — emit the ```tool block early. Do NOT claim a file was written until a tool call succeeds.";

const malformedFenceNudge = (ports: ToolCallRecoveryPorts): string =>
  ports.toolsAttached
    ? "Your previous tool call JSON was INVALID, so NOTHING ran. " +
      "Common causes: unescaped newlines/quotes, unbalanced braces, or content too large. " +
      toolNudge(true) +
      " Prefer ONE complete fs.write when it fits; if cut off, continue with large fs.append + expectedPriorBytes. " +
      "Do NOT claim any file was written until a tool call actually succeeds."
    : "Your previous message contained a ```tool block, but its JSON was INVALID, so NOTHING ran. " +
      "Common causes: unescaped newlines or quotes inside a string value, an extra or missing `}` / `]`, or content too large for the output window. " +
      'Re-emit ONE valid ```tool block of the exact form {"name":"<tool>","args":{...}} with balanced braces. ' +
      "IMPORTANT: Prefer ONE complete fs.write when it fits. Keep reasoning SHORT. " +
      "Only if the output window cuts you off, continue with large fs.append chunks + expectedPriorBytes. " +
      "Do NOT claim any file was written until a tool call actually succeeds.";

const salvageContinuationNudge = (
  ports: ToolCallRecoveryPorts,
  salvaged: SalvagedWrite,
  lineCount: number,
  priorBytes: number,
): string => {
  const toolName = salvaged.operation === "append" ? "fs.append" : "fs.write";
  const head =
    `Your ${toolName} tool call was cut off at the token limit, but the system salvaged the partial content and wrote ${lineCount} lines (file is now ${priorBytes} bytes) to ${salvaged.path}. ` +
    `The file ends with: ${JSON.stringify(salvaged.lastLine)}\n\n`;
  return ports.toolsAttached
    ? head +
        `CONTINUE by calling fs.append now with path=${JSON.stringify(salvaged.path)}, expectedPriorBytes=${priorBytes}, and content set to ONLY the remaining content (prefer large chunks). Use the platform tool interface — no markdown fences.`
    : head +
        `CONTINUE with ONE large fs.append of the remaining content (prefer hundreds of lines per call — do NOT use tiny ~100-line chunks):\n` +
        '```tool\n{"name":"fs.append","args":{"path":' +
        JSON.stringify(salvaged.path) +
        ',"expectedPriorBytes":' +
        priorBytes +
        ',"content":"...ONLY the remaining content not already on disk..."}}\n```\n' +
        `expectedPriorBytes must match the receipt so append cannot double-write. ` +
        `Do NOT re-read the full file; do NOT re-send content already saved.`;
};

const trySalvage = async (
  ports: ToolCallRecoveryPorts,
  visible: string,
  buildNudge: (salvaged: SalvagedWrite, outcome: SalvagedWriteOutcome, lineCount: number) => string,
  announce: (salvaged: SalvagedWrite, lineCount: number) => string,
): Promise<boolean> => {
  const salvaged = salvageTruncatedWrite(visible);
  if (!salvaged) return false;
  try {
    const outcome = await ports.applySalvagedWrite(salvaged);
    if (!outcome.ok) return false;
    const lineCount = salvaged.content.split("\n").length;
    ports.notify("info", announce(salvaged, lineCount));
    ports.commitAssistantRetry(stripThinking(visible).visible);
    ports.messages.push({
      role: "user",
      content: buildNudge(salvaged, outcome, lineCount),
    });
    return true;
  } catch {
    return false;
  }
};

const recoverBareArgs = (
  ports: ToolCallRecoveryPorts,
  state: ToolCallRecoveryState,
  visible: string,
): ToolCallRecoveryDecision => {
  state.bareToolJsonRetries += 1;
  if (state.bareToolJsonRetries > 3) return "proceed";
  ports.notify(
    "warn",
    ports.toolsAttached
      ? "tool call missing its name — asking the model to call a tool properly"
      : "tool call missing its name/fence — asking the model to re-emit a proper ```tool block",
  );
  ports.commitAssistantRetry(visible);
  ports.messages.push(ports.recoveryUserMessage(bareArgsNudge(ports)));
  return "retry";
};

const recoverSentinel = (
  ports: ToolCallRecoveryPorts,
  visible: string,
): ToolCallRecoveryDecision => {
  ports.notify(
    "warn",
    "tool call was malformed or cut off — asking the model to retry in JSON form",
  );
  ports.commitAssistantRetry(visible);
  ports.messages.push(ports.recoveryUserMessage(sentinelNudge(ports)));
  return "retry";
};

const recoverTruncated = async (
  ports: ToolCallRecoveryPorts,
  state: ToolCallRecoveryState,
  visible: string,
): Promise<ToolCallRecoveryDecision> => {
  state.truncatedToolRetries += 1;
  if (state.truncatedToolRetries <= 5) {
    const salvagedOk = await trySalvage(
      ports,
      visible,
      (salvaged, outcome, lineCount) =>
        salvageContinuationNudge(ports, salvaged, lineCount, outcome.bytesOnDisk),
      (salvaged, lineCount) =>
        `tool call was truncated — salvaged ${lineCount} lines and wrote to ${salvaged.path}`,
    );
    if (salvagedOk) return "retry";
  }
  if (state.truncatedToolRetries > 3) return "proceed";
  ports.notify(
    "warn",
    "tool call was cut off (output too long) — asking the model to retry safely",
  );
  ports.commitAssistantRetry(stripThinking(visible).visible);
  ports.messages.push({ role: "user", content: truncatedNudge(ports) });
  return "retry";
};

const recoverMalformedFence = async (
  ports: ToolCallRecoveryPorts,
  state: ToolCallRecoveryState,
  visible: string,
): Promise<ToolCallRecoveryDecision> => {
  const salvagedOk = await trySalvage(
    ports,
    visible,
    (salvaged, _outcome, lineCount) =>
      `The system extracted and wrote ${lineCount} lines to ${salvaged.path} from your malformed tool call. ` +
      `The file content ends at: "${salvaged.lastLine}"\n\n` +
      `If the file is complete, proceed with the next step. ` +
      `If more content is needed, use one large fs.append with expectedPriorBytes from the write receipt (not tiny chunks).`,
    (salvaged, lineCount) =>
      `malformed tool call salvaged — wrote ${lineCount} lines to ${salvaged.path}`,
  );
  if (salvagedOk) return "retry";

  state.malformedFenceRetries += 1;
  if (state.malformedFenceRetries > 3) return "proceed";
  ports.notify(
    "warn",
    "tool block present but its JSON didn't parse — asking the model to re-emit valid JSON",
  );
  ports.commitAssistantRetry(stripThinking(visible).visible);
  ports.messages.push({ role: "user", content: malformedFenceNudge(ports) });
  return "retry";
};

export const recoverMissingToolCall = async (
  ports: ToolCallRecoveryPorts,
  state: ToolCallRecoveryState,
  input: { readonly visible: string; readonly bareArgsOnly: boolean },
): Promise<ToolCallRecoveryDecision> => {
  if (input.bareArgsOnly) {
    if (recoverBareArgs(ports, state, input.visible) === "retry") return "retry";
  }
  if (SENTINEL_TOOL_CALL.test(input.visible)) {
    return recoverSentinel(ports, input.visible);
  }
  if (looksLikeTruncatedToolCall(input.visible)) {
    const decision = await recoverTruncated(ports, state, input.visible);
    if (decision === "retry") return "retry";
  }
  const hasFencedCallShape =
    countToolFences(input.visible) > 0 && FENCED_CALL_SHAPE.test(input.visible);
  if (hasFencedCallShape) {
    const decision = await recoverMalformedFence(ports, state, input.visible);
    if (decision === "retry") return "retry";
  }
  return "proceed";
};
