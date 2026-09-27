import {
  createReasoningArtifact,
  createSignedThinkingArtifacts,
} from "./reasoning-artifacts.js";
import type {
  ReasoningArtifact,
  ReasoningArtifactProvenance,
  ReasoningBlock,
} from "../types.js";

const PLACEHOLDER_REASONING = /^[\s.\u2026]*$/;

export function isKiroReasoningPlaceholder(text: string): boolean {
  return PLACEHOLDER_REASONING.test(text);
}

export interface KiroReasoningAccumulator {
  push(chunk: string): void;
  sign(signature: string): void;
  redact(content: string): void;
  finish(): void;
  readonly text: string;
  readonly signature: string;
  readonly redactedContent: string;
  readonly opaque: boolean;
}

export function createKiroReasoningAccumulator(
  emit: (text: string) => void,
): KiroReasoningAccumulator {
  let text = "";
  let pending = "";
  let emitted = false;
  let signature = "";
  let redactedContent = "";
  const isOpaque = (): boolean =>
    Boolean(signature) && !emitted && isKiroReasoningPlaceholder(text);
  return {
    push(chunk) {
      if (!chunk) return;
      text += chunk;
      if (!emitted && isKiroReasoningPlaceholder(pending + chunk)) {
        pending += chunk;
        return;
      }
      emit(pending + chunk);
      pending = "";
      emitted = true;
    },
    sign(value) {
      if (value) signature = value;
    },
    redact(value) {
      if (value) redactedContent += value;
    },
    finish() {
      if (!pending || isOpaque()) return;
      if (pending.trim()) emit(pending);
      pending = "";
    },
    get text() {
      return text;
    },
    get signature() {
      return signature;
    },
    get redactedContent() {
      return redactedContent;
    },
    get opaque() {
      return isOpaque();
    },
  };
}

export function sentKiroReasoningEffort(
  fields: Record<string, unknown> | undefined,
): string | undefined {
  for (const key of ["reasoning", "output_config"]) {
    const holder = fields?.[key];
    if (!holder || typeof holder !== "object") continue;
    const effort = (holder as Record<string, unknown>).effort;
    if (typeof effort === "string" && effort) return effort;
  }
  return undefined;
}

export function kiroPrivateReasoningNote(input: {
  model: string;
  effort: string | undefined;
  signatureChars: number;
}): string {
  const effortText = input.effort ? ` at ${input.effort} effort` : "";
  return `Reasoning is private on Kiro for ${input.model}: the model reasoned${effortText}, but Kiro returns only an encrypted reasoning signature (${input.signatureChars.toLocaleString("en-US")} chars) and no reasoning text to display.`;
}

export function kiroReasoningResult(input: {
  reasoning: KiroReasoningAccumulator;
  provenance: ReasoningArtifactProvenance;
  hasToolCalls: boolean;
}): {
  artifacts: readonly ReasoningArtifact[];
  block: ReasoningBlock | undefined;
} {
  const { reasoning, provenance, hasToolCalls } = input;
  const toolPosition = hasToolCalls ? { toolCallIndex: 0 } : {};
  const artifacts: ReasoningArtifact[] = [];
  const displayText = reasoning.text.trim();
  if (reasoning.opaque) {
    artifacts.push(createReasoningArtifact({
      kind: "signed",
      raw: { text: reasoning.text, signature: reasoning.signature },
      provenance,
      replay: { scope: "tool-turn", persistence: "tool-turn" },
      position: {
        sequence: 0,
        placement: hasToolCalls ? "before-tool-call" : "assistant",
        ...toolPosition,
      },
    }));
  } else if (displayText) {
    artifacts.push(...createSignedThinkingArtifacts({
      blocks: [{
        sequence: 0,
        thinking: displayText,
        ...(reasoning.signature ? { signature: reasoning.signature } : {}),
        raw: reasoning.signature
          ? { text: reasoning.text, signature: reasoning.signature }
          : displayText,
        ...toolPosition,
      }],
      provenance,
    }));
  }
  if (reasoning.redactedContent) {
    artifacts.push(createReasoningArtifact({
      kind: "encrypted",
      raw: { redactedContent: reasoning.redactedContent },
      provenance,
      replay: hasToolCalls
        ? { scope: "tool-turn", persistence: "tool-turn" }
        : { scope: "none", persistence: "never" },
      position: {
        sequence: artifacts.length,
        placement: hasToolCalls ? "before-tool-call" : "assistant",
        ...toolPosition,
      },
    }));
  }
  const block = !reasoning.opaque && displayText
    ? {
        text: displayText,
        ...(reasoning.signature ? { signature: reasoning.signature } : {}),
      }
    : undefined;
  return { artifacts, block };
}

function schemaRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function schemaChild(
  schema: Record<string, unknown> | undefined,
  name: string,
): Record<string, unknown> | undefined {
  return schemaRecord(schemaRecord(schema?.properties)?.[name]);
}

function schemaStrings(schema: Record<string, unknown> | undefined): string[] {
  return Array.isArray(schema?.enum)
    ? schema.enum.filter((value): value is string => typeof value === "string")
    : [];
}

export function kiroCatalogEfforts(schema: unknown): string[] {
  const root = schemaRecord(schema);
  const efforts = [
    ...schemaStrings(schemaChild(schemaChild(root, "output_config"), "effort")),
    ...schemaStrings(schemaChild(schemaChild(root, "reasoning"), "effort")),
  ];
  if (efforts.length === 0) return [];
  const thinkingTypes = schemaStrings(
    schemaChild(schemaChild(root, "thinking"), "type"),
  );
  const canDisable = thinkingTypes.includes("disabled");
  return [...new Set([...(canDisable ? ["none"] : []), ...efforts])];
}
