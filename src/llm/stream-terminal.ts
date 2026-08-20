import type { StreamTerminalProof } from "./provider-profile.js";
import { CHAT_COMPLETIONS_TERMINAL_PROOFS } from "./provider-profile.js";

export interface StreamTerminalPolicy {
  readonly proofs: readonly StreamTerminalProof[];
  readonly naturalEofAccepted: boolean;
}

export interface PartialStreamByteCounts {
  readonly answerBytes: number;
  readonly reasoningBytes: number;
  readonly toolArgumentBytes: number;
}

export const CHAT_COMPLETIONS_STREAM_TERMINAL: StreamTerminalPolicy = {
  proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
  naturalEofAccepted: false,
};

export const ANTHROPIC_STREAM_TERMINAL: StreamTerminalPolicy = {
  proofs: ["message-stop"],
  naturalEofAccepted: false,
};

export const GEMINI_STREAM_TERMINAL: StreamTerminalPolicy = {
  proofs: ["finish-reason"],
  naturalEofAccepted: false,
};

export const META_STREAM_TERMINAL: StreamTerminalPolicy = {
  proofs: ["response-completed", "response-incomplete"],
  naturalEofAccepted: false,
};

export const OLLAMA_STREAM_TERMINAL: StreamTerminalPolicy = {
  proofs: ["done-true"],
  naturalEofAccepted: false,
};

export class PartialStreamError extends Error {
  readonly answerBytes: number;
  readonly reasoningBytes: number;
  readonly toolArgumentBytes: number;

  constructor(
    provider: string,
    expected: readonly StreamTerminalProof[],
    counts: PartialStreamByteCounts,
  ) {
    super(
      `${provider} stream ended without terminal proof (${expected.join(" or ")}) — ` +
        `the connection closed before the provider signalled completion; ` +
        `discarding partial output (answer ${counts.answerBytes}B, ` +
        `reasoning ${counts.reasoningBytes}B, tool arguments ${counts.toolArgumentBytes}B).`,
    );
    this.name = "PartialStreamError";
    this.answerBytes = counts.answerBytes;
    this.reasoningBytes = counts.reasoningBytes;
    this.toolArgumentBytes = counts.toolArgumentBytes;
  }
}

export function isPartialStreamError(
  error: unknown,
): error is PartialStreamError {
  return error instanceof PartialStreamError;
}

export function requireTerminalProof(input: {
  provider: string;
  policy: StreamTerminalPolicy;
  signal: StreamTerminalProof | undefined;
  answerBytes: number;
  reasoningBytes: number;
  toolArgumentBytes: number;
}): void {
  if (input.policy.naturalEofAccepted) return;
  if (input.signal !== undefined && input.policy.proofs.includes(input.signal)) {
    return;
  }
  throw new PartialStreamError(input.provider, input.policy.proofs, {
    answerBytes: input.answerBytes,
    reasoningBytes: input.reasoningBytes,
    toolArgumentBytes: input.toolArgumentBytes,
  });
}
