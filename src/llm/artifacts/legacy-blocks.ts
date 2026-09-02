import type {
  ChatMessage,
  ReasoningArtifact,
  ReasoningArtifactKind,
  ReasoningArtifactProvenance,
  ReasoningBlock,
} from "../../types.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
  reasoningArtifactItems,
  reasoningArtifactSignature,
  reasoningArtifactText,
} from "../reasoning-artifacts.js";

function legacyProvenance(
  kind: ReasoningArtifactKind,
): ReasoningArtifactProvenance {
  switch (kind) {
    case "signed":
      return createReasoningArtifactProvenance({
        provider: "anthropic",
        dialect: "anthropic-messages",
        legacy: true,
      });
    case "encrypted":
      return createReasoningArtifactProvenance({
        provider: "meta",
        dialect: "meta-responses",
        legacy: true,
      });
    case "thought-signature":
      return createReasoningArtifactProvenance({
        provider: "gemini",
        dialect: "gemini-generate-content",
        legacy: true,
      });
    default:
      return createReasoningArtifactProvenance({
        provider: "legacy",
        dialect: "openai-compatible",
        legacy: true,
      });
  }
}

export function legacyReasoningArtifacts(
  message: ChatMessage,
): ReasoningArtifact[] {
  const artifacts: ReasoningArtifact[] = [];
  let sequence = 0;
  const block = message.reasoningBlock;
  if (block?.signature && block.text) {
    artifacts.push(
      createReasoningArtifact({
        kind: "signed",
        raw: { thinking: block.text, signature: block.signature },
        displaySummary: block.text,
        provenance: legacyProvenance("signed"),
        replay: { scope: "tool-turn", persistence: "tool-turn" },
        position: { sequence: sequence++, placement: "before-tool-call" },
      }),
    );
  } else if (block?.text) {
    artifacts.push(
      createReasoningArtifact({
        kind: "plaintext",
        raw: block.text,
        displaySummary: block.text,
        provenance: legacyProvenance("plaintext"),
        replay: { scope: "all-history", persistence: "all-turns" },
        position: { sequence: sequence++, placement: "assistant" },
      }),
    );
  }
  if (block?.items?.length) {
    artifacts.push(
      createReasoningArtifact({
        kind: "encrypted",
        raw: { items: block.items },
        displaySummary: block.text || undefined,
        provenance: legacyProvenance("encrypted"),
        replay: { scope: "tool-turn", persistence: "tool-turn" },
        position: { sequence: sequence++, placement: "before-tool-call" },
      }),
    );
  }
  for (let index = 0; index < (message.toolCalls?.length ?? 0); index += 1) {
    const call = message.toolCalls![index]!;
    if (!call.thoughtSignature) continue;
    artifacts.push(
      createReasoningArtifact({
        kind: "thought-signature",
        raw: call.thoughtSignature,
        provenance: legacyProvenance("thought-signature"),
        replay: { scope: "tool-turn", persistence: "tool-turn" },
        position: {
          sequence: sequence++,
          placement: "on-tool-call",
          toolCallId: call.id,
          toolCallIndex: index,
        },
      }),
    );
  }
  return artifacts;
}

export function legacyReasoningBlockFromArtifacts(
  artifacts: readonly ReasoningArtifact[],
): ReasoningBlock | undefined {
  let text: string | undefined;
  let signature: string | undefined;
  const items: Array<Record<string, unknown>> = [];
  for (const artifact of [...artifacts].sort(
    (left, right) => left.position.sequence - right.position.sequence,
  )) {
    if (artifact.kind === "signed") {
      text ??= reasoningArtifactText(artifact);
      signature ??= reasoningArtifactSignature(artifact);
      continue;
    }
    if (artifact.kind === "plaintext") {
      text ??= reasoningArtifactText(artifact);
      continue;
    }
    if (artifact.kind === "encrypted") {
      items.push(...reasoningArtifactItems(artifact));
    }
  }
  if (text === undefined && !signature && items.length === 0) return undefined;
  return {
    text: text ?? "",
    ...(signature ? { signature } : {}),
    ...(items.length ? { items } : {}),
  };
}
