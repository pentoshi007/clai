import type {
  ReasoningArtifact,
  ReasoningArtifactReplayDecision,
  ReasoningArtifactReplayObserver,
  ReasoningArtifactReplayTarget,
} from "../../types.js";
import { decision } from "../reasoning-artifacts.js";
import type { ReasoningArtifactReplayContext } from "../reasoning-artifacts.js";

function isSameModel(sourceModel: string | undefined, targetModel: string): boolean {
  if (!sourceModel || sourceModel === targetModel) return true;
  const strip = (m: string) => m.toLowerCase().replace(/^(?:free-[12]|openrouter|agentrouter)\//, "");
  return strip(sourceModel) === strip(targetModel);
}

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
  if (source.provider !== target.provider) {
    return decision(artifact, target, "omitted", "provider-mismatch");
  }
  if (source.dialect !== target.dialect) {
    return decision(artifact, target, "omitted", "dialect-mismatch");
  }
  if (source.model && !isSameModel(source.model, target.model)) {
    return decision(artifact, target, "omitted", "model-mismatch");
  }
  if (source.endpointHash && target.endpointHash && source.endpointHash !== target.endpointHash) {
    return decision(artifact, target, "omitted", "endpoint-mismatch");
  }
  if (source.endpointHash && !target.endpointHash && source.provider !== target.provider) {
    return decision(artifact, target, "omitted", "endpoint-unknown");
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
