import type { Mode, ProviderId, ChatImage } from "../types.js";
import {
  modelVisionSupport,
  preferredVisionModel,
  recordVisionSubstitution,
  visionCapabilitySource,
  visionEvidence,
  type VisionSupport,
} from "../llm/capabilities.js";
import { safeCwd } from "../os/cwd.js";
import {
  expandMentions,
  loadImagePaths,
  type Attachment,
} from "../ui/mentions.js";
import { imageBudgetFor } from "./image-content.js";

export interface ResolvedTurnInput {
  readonly prompt: string;
  readonly mode: Mode;
  readonly provider: ProviderId;
  readonly model: string;
  readonly attachments: readonly Attachment[];
  readonly images: readonly ChatImage[];
  readonly capability: {
    readonly vision: boolean;
    readonly support: VisionSupport;
    readonly source: "provider" | "user" | "fallback-table";
  };
  readonly fallbackReason?: string | undefined;
  readonly imageIssues: readonly string[];
}

function isImage(attachment: Attachment): boolean {
  return attachment.kind === "image";
}

function isSendableImage(attachment: Attachment): boolean {
  return attachment.kind === "image" && attachment.sendable !== false;
}

export function resolveTurnInput(input: {
  prompt: string;
  mode: Mode;
  provider: ProviderId;
  model: string;
  baseDir?: string | undefined;
}): ResolvedTurnInput {
  const baseDir = input.baseDir ?? safeCwd();
  let model = input.model;
  let support = modelVisionSupport(input.provider, model);
  let budget = imageBudgetFor(input.provider, model);
  let expansion = expandMentions(input.prompt, baseDir, {
    visionCapable: support !== "no",
    budget,
  });
  let fallbackReason: string | undefined;

  if (expansion.attachments.some(isSendableImage) && support === "no") {
    const evidence = visionEvidence(input.provider, model);
    const fallback = preferredVisionModel(input.provider, model);
    if (fallback && fallback !== model) {
      recordVisionSubstitution(input.provider, fallback, model);
      const reason =
        evidence === "observed"
          ? `${input.model} refused image input`
          : `${input.model} is a known text-only model`;
      model = fallback;
      support = "yes";
      budget = imageBudgetFor(input.provider, model);
      fallbackReason =
        `Selected same-provider vision model ${fallback} because ${reason} ` +
        `(capability source: ${visionCapabilitySource(input.provider, fallback)}).`;
      expansion = expandMentions(input.prompt, baseDir, {
        visionCapable: true,
        budget,
      });
    }
  }

  const candidates = expansion.attachments.filter(isSendableImage);
  const images =
    support === "no"
      ? []
      : loadImagePaths(
          candidates.map((attachment) => attachment.path),
          budget,
          baseDir,
        );

  if (fallbackReason && images.length === 0) {
    model = input.model;
    support = modelVisionSupport(input.provider, model);
    budget = imageBudgetFor(input.provider, model);
    fallbackReason =
      "Kept the current model: the referenced image could not be attached, so no vision model was needed.";
    expansion = expandMentions(input.prompt, baseDir, {
      visionCapable: support !== "no",
      budget,
    });
  }

  const imageIssues = expansion.attachments
    .filter((attachment) => isImage(attachment) && attachment.sendable === false)
    .map((attachment) => `${attachment.path} — ${attachment.note ?? "not attached"}`);
  if (support !== "no" && candidates.length > images.length) {
    const dropped = candidates.length - images.length;
    imageIssues.push(
      dropped === candidates.length
        ? `${dropped} image(s) passed validation but could not be encoded for ${input.provider}/${model}.`
        : `${dropped} of ${candidates.length} image(s) were left out to stay inside the ${budget.label} per-request image limit (${budget.maxCount}).`,
    );
  }

  return {
    prompt: expansion.text,
    mode: input.mode,
    provider: input.provider,
    model,
    attachments: expansion.attachments,
    images,
    capability: {
      vision: support !== "no",
      support,
      source: visionCapabilitySource(input.provider, model),
    },
    fallbackReason,
    imageIssues,
  };
}

export function shouldRunImageOcr(input: {
  hasImage: boolean;
  visionCapable: boolean;
  prompt: string;
  support?: VisionSupport | undefined;
}): boolean {
  if (!input.hasImage) return false;
  const support = input.support ?? (input.visionCapable ? "yes" : "no");
  if (support === "yes") return false;
  return /\b(?:ocr|extract|transcribe|read)\b[\s\S]{0,30}\btext\b|\btext\b[\s\S]{0,30}\b(?:image|screenshot)\b/i.test(
    input.prompt,
  );
}
