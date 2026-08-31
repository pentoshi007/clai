import type {
  ReasoningArtifact,
  ReasoningArtifactReplayDecision,
  ReasoningArtifactReplayObserver,
  ReasoningArtifactReplayTarget,
} from "../../types.js";
import { decision } from "../reasoning-artifacts.js";
import type { ReasoningArtifactReplayContext } from "../reasoning-artifacts.js";

export function reasoningArtifactReplayDecision(
  artifact: ReasoningArtifact,
  target: ReasoningArtifactReplayTarget,
  context: ReasoningArtifactReplayContext = {},
): ReasoningArtifactReplayDecision {
  if (!context.forceScope) {
    if (artifact.replay.scope === "none") {
      return decision(artifact, target, "omitted", "replay-disabled");
    }
    if (artifact.replay.scope === "tool-turn" && !context.hasToolCalls) {
      return decision(artifact, target, "omitted", "not-a-tool-turn");
    }
  }

  const source = artifact.provenance;
  const legacyPlaintext =
    source.legacy === true &&
    (artifact.kind === "plaintext" || artifact.kind === "summary");
  if (legacyPlaintext) {
    return target.dialect === "openai-compatible"
      ? decision(artifact, target, "replayed")
      : decision(artifact, target, "omitted", "dialect-mismatch");
  }
  if (source.provider !== target.provider) {
    return decision(artifact, target, "omitted", "provider-mismatch");
  }
  if (source.dialect !== target.dialect) {
    return decision(artifact, target, "omitted", "dialect-mismatch");
  }
  if (source.model && source.model !== target.model) {
    return decision(artifact, target, "omitted", "model-mismatch");
  }
  if (source.endpointHash && !target.endpointHash) {
    return decision(artifact, target, "omitted", "endpoint-unknown");
  }
  if (source.endpointHash && source.endpointHash !== target.endpointHash) {
    return decision(artifact, target, "omitted", "endpoint-mismatch");
  }
  return decision(artifact, target, "replayed");
}

export function selectReasoningArtifactsForReplay(input: {
  artifacts: readonly ReasoningArtifact[] | undefined;
  target: ReasoningArtifactReplayTarget;
  context?: ReasoningArtifactReplayContext | undefined;
  observe?: ReasoningArtifactReplayObserver | undefined;
}): readonly ReasoningArtifact[] {
  if (!input.artifacts?.length) return [];
  const selected: ReasoningArtifact[] = [];
  for (const artifact of input.artifacts) {
    const replay = reasoningArtifactReplayDecision(
      artifact,
      input.target,
      input.context,
    );
    input.observe?.(replay);
    if (replay.action === "replayed") selected.push(artifact);
  }
  return selected;
}
