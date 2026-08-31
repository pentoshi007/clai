import { PARSED_OUTPUT_SHAPES, UNKNOWN_EVIDENCE } from "../provider-profile.js";
import type {
  Pickable,
  ProfileEvidence,
  ProviderProfile,
  ProviderProfileLayer,
  ProviderProfileRoute,
} from "../provider-profile.js";

export function unknownProfile(route: ProviderProfileRoute): ProviderProfile {
  return {
    version: 1,
    route,
    transport: { authType: "bearer", systemPolicy: "single-leading" },
    capabilities: {
      tools: "unknown",
      images: "unknown",
      structuredOutput: "unknown",
      streamOptions: "unknown",
    },
    reasoning: {
      generation: "unknown",
      generationEvidence: UNKNOWN_EVIDENCE,
      control: {
        dialect: "none",
        status: "unknown",
        evidence: UNKNOWN_EVIDENCE,
      },
      acceptedEfforts: [],
      disable: "unknown",
      // unknown routes parse broadly while sending no optional control
      outputShapes: PARSED_OUTPUT_SHAPES,
      replayScope: "none",
      finalTurnPreservation: "unknown",
    },
    sampling: { omit: [], defaults: {} },
    outputBudget: {
      sharedReasoningCap: true,
      visibleAnswerReserveTokens: 1024,
      mandatoryReasoningReserveTokens: 0,
    },
    limits: { source: "unknown" },
    cache: { kind: "unknown", cacheAffectingFields: [] },
    usage: {},
    terminal: {
      proofs: [],
      naturalEofAccepted: false,
      evidence: UNKNOWN_EVIDENCE,
    },
    evidence: UNKNOWN_EVIDENCE,
  };
}

function firstDefined<T extends Pickable>(
  layers: readonly ProviderProfileLayer[],
  pick: (layer: ProviderProfileLayer) => T | undefined,
): T | undefined {
  for (const layer of layers) {
    const value = pick(layer);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstList<T>(
  layers: readonly ProviderProfileLayer[],
  pick: (layer: ProviderProfileLayer) => readonly T[] | undefined,
): readonly T[] | undefined {
  for (const layer of layers) {
    const value = pick(layer);
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function evidenceFor(
  layers: readonly ProviderProfileLayer[],
  contributes: (layer: ProviderProfileLayer) => boolean,
): ProfileEvidence {
  for (const layer of layers) {
    if (contributes(layer)) return layer.evidence;
  }
  return UNKNOWN_EVIDENCE;
}

export function mergeLayers(
  route: ProviderProfileRoute,
  layers: readonly ProviderProfileLayer[],
): ProviderProfile {
  const base = unknownProfile(route);

  const keyEnv = firstDefined(layers, (l) => l.transport?.keyEnv);
  const baseUrlEnv = firstDefined(layers, (l) => l.transport?.baseUrlEnv);
  const chatPath = firstDefined(layers, (l) => l.transport?.chatPath);
  const modelsPath = firstDefined(layers, (l) => l.transport?.modelsPath);
  const keyless = firstDefined(layers, (l) => l.transport?.keyless);
  const headerLayer = layers.find((layer) => layer.transport?.headers);

  const contextTokens = firstDefined(layers, (l) => l.limits?.contextTokens);
  const outputTokens = firstDefined(layers, (l) => l.limits?.outputTokens);

  const affinityField = firstDefined(layers, (l) => l.cache?.affinityField);
  const isolationField = firstDefined(layers, (l) => l.cache?.isolationField);

  const cachedInput = firstList(layers, (l) => l.usage?.cachedInput);
  const uncachedInput = firstList(layers, (l) => l.usage?.uncachedInput);
  const cacheWrite = firstList(layers, (l) => l.usage?.cacheWrite);
  const reasoningOutput = firstList(layers, (l) => l.usage?.reasoningOutput);

  const controlDialect = firstDefined(
    layers,
    (l) => l.reasoning?.control?.dialect,
  );
  const controlStatus = firstDefined(
    layers,
    (l) => l.reasoning?.control?.status,
  );
  const generation =
    firstDefined(layers, (l) => l.reasoning?.generation) ?? "unknown";
  const disableForm = firstDefined(layers, (l) => l.reasoning?.disableForm);
  const disable =
    firstDefined(layers, (l) => l.reasoning?.disable) ??
    (generation === "mandatory" ? "unsupported" : "unknown");
  const acceptedParameters = firstList(
    layers,
    (l) => l.capabilities?.acceptedParameters,
  );
  const replayOptIn = firstDefined(layers, (l) => l.reasoning?.replayOptIn);
  const defaultEffort = firstDefined(layers, (l) => l.reasoning?.defaultEffort);
  const minOutputTokens = firstDefined(
    layers,
    (l) => l.reasoning?.minOutputTokens,
  );
  const samplingOmit = firstList(layers, (l) => l.sampling?.omit);
  const samplingDefaultsLayer = layers.find(
    (layer) =>
      layer.sampling?.defaults !== undefined &&
      Object.keys(layer.sampling.defaults).length > 0,
  );

  return {
    version: 1,
    route,
    transport: {
      authType:
        firstDefined(layers, (l) => l.transport?.authType) ??
        base.transport.authType,
      ...(keyEnv !== undefined ? { keyEnv } : {}),
      ...(baseUrlEnv !== undefined ? { baseUrlEnv } : {}),
      ...(chatPath !== undefined ? { chatPath } : {}),
      ...(modelsPath !== undefined ? { modelsPath } : {}),
      ...(keyless !== undefined ? { keyless } : {}),
      ...(headerLayer ? { headers: headerLayer.transport!.headers! } : {}),
      systemPolicy:
        firstDefined(layers, (l) => l.transport?.systemPolicy) ??
        base.transport.systemPolicy,
    },
    capabilities: {
      tools:
        firstDefined(layers, (l) => l.capabilities?.tools) ??
        base.capabilities.tools,
      images:
        firstDefined(layers, (l) => l.capabilities?.images) ??
        base.capabilities.images,
      structuredOutput:
        firstDefined(layers, (l) => l.capabilities?.structuredOutput) ??
        base.capabilities.structuredOutput,
      streamOptions:
        firstDefined(layers, (l) => l.capabilities?.streamOptions) ??
        base.capabilities.streamOptions,
      ...(acceptedParameters !== undefined ? { acceptedParameters } : {}),
    },
    reasoning: {
      generation,
      generationEvidence: evidenceFor(
        layers,
        (l) => l.reasoning?.generation !== undefined,
      ),
      control: {
        dialect: controlDialect ?? base.reasoning.control.dialect,
        status: controlStatus ?? base.reasoning.control.status,
        evidence: evidenceFor(
          layers,
          (l) => l.reasoning?.control !== undefined,
        ),
      },
      acceptedEfforts:
        firstList(layers, (l) => l.reasoning?.acceptedEfforts) ?? [],
      disable,
      ...(disableForm !== undefined
        ? { disableForm }
        : generation === "mandatory"
          ? { disableForm: "none-documented" as const }
          : {}),
      outputShapes:
        firstList(layers, (l) => l.reasoning?.outputShapes) ??
        base.reasoning.outputShapes,
      replayScope:
        firstDefined(layers, (l) => l.reasoning?.replayScope) ??
        base.reasoning.replayScope,
      finalTurnPreservation:
        firstDefined(layers, (l) => l.reasoning?.finalTurnPreservation) ??
        base.reasoning.finalTurnPreservation,
      ...(replayOptIn !== undefined ? { replayOptIn } : {}),
      ...(defaultEffort !== undefined ? { defaultEffort } : {}),
      ...(minOutputTokens !== undefined ? { minOutputTokens } : {}),
    },
    sampling: {
      omit: samplingOmit ?? base.sampling.omit,
      defaults:
        samplingDefaultsLayer?.sampling?.defaults ?? base.sampling.defaults,
    },
    outputBudget: {
      sharedReasoningCap:
        firstDefined(layers, (l) => l.outputBudget?.sharedReasoningCap) ??
        base.outputBudget.sharedReasoningCap,
      visibleAnswerReserveTokens:
        firstDefined(
          layers,
          (l) => l.outputBudget?.visibleAnswerReserveTokens,
        ) ?? base.outputBudget.visibleAnswerReserveTokens,
      mandatoryReasoningReserveTokens:
        firstDefined(
          layers,
          (l) => l.outputBudget?.mandatoryReasoningReserveTokens,
        ) ?? base.outputBudget.mandatoryReasoningReserveTokens,
    },
    limits: {
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      source:
        firstDefined(layers, (l) => l.limits?.source) ?? base.limits.source,
    },
    cache: {
      kind: firstDefined(layers, (l) => l.cache?.kind) ?? base.cache.kind,
      ...(affinityField !== undefined ? { affinityField } : {}),
      ...(isolationField !== undefined ? { isolationField } : {}),
      cacheAffectingFields:
        firstList(layers, (l) => l.cache?.cacheAffectingFields) ??
        base.cache.cacheAffectingFields,
      evidence: evidenceFor(layers, (l) => l.cache?.kind !== undefined),
    },
    usage: {
      ...(cachedInput !== undefined ? { cachedInput } : {}),
      ...(uncachedInput !== undefined ? { uncachedInput } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
      ...(reasoningOutput !== undefined ? { reasoningOutput } : {}),
    },
    terminal: {
      proofs:
        firstList(layers, (l) => l.terminal?.proofs) ?? base.terminal.proofs,
      naturalEofAccepted:
        firstDefined(layers, (l) => l.terminal?.naturalEofAccepted) ??
        base.terminal.naturalEofAccepted,
      evidence: evidenceFor(layers, (l) => l.terminal?.proofs !== undefined),
    },
    evidence: layers[0]!.evidence,
  };
}
