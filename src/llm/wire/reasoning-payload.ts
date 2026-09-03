import type { ProviderId, ReasoningPreference } from "../../types.js";
import {
  modelReasoningEfforts,
  modelSupportsThinking,
} from "../capabilities.js";
import { classifyBynaraModel, classifyNvidiaModel } from "../model-families.js";
import { emitReasoningControls } from "../reasoning-controls.js";
import type { ReasoningControlSurface } from "../reasoning-controls.js";

export type ReasoningStyle =
  | "openai"
  | "nvidia"
  | "openrouter"
  | "agentrouter"
  | "modal"
  | "stepfun"
  | "meta"
  | "bynara"
  | "none";

function supportsOpenRouterReasoning(model: string): boolean {
  return /:thinking|deepseek-r1|qwen3|kimi-k2|claude-(?:opus|sonnet|haiku)-4|gpt-5|(?:^|\/)o[134]|grok.*reasoner/i.test(
    model,
  );
}

const MODAL_DEFAULT_EFFORTS = ["low", "high", "max"];

const MODAL_EFFORT_PREFERENCE: Record<string, string[]> = {
  minimal: ["minimal", "low", "medium", "high", "max"],
  low: ["low", "minimal", "medium", "high", "max"],
  medium: ["medium", "high", "low", "max"],
  high: ["high", "max", "medium", "low"],
  xhigh: ["xhigh", "max", "high", "medium", "low"],
  max: ["max", "xhigh", "high", "medium", "low"],
};

function pickAdvertisedEffort(
  effort: string,
  advertised: readonly string[],
): string {
  const order =
    MODAL_EFFORT_PREFERENCE[effort] ?? MODAL_EFFORT_PREFERENCE.medium!;
  return (
    order.find((candidate) => advertised.includes(candidate)) ??
    advertised[advertised.length - 1]!
  );
}

export interface ReasoningControlContext {
  readonly profile: ReasoningControlSurface;
  readonly willReplayReasoning: boolean;
  readonly suppressed?: boolean | undefined;
}

export function buildReasoningPayload(
  reasoning: ReasoningPreference | undefined,
  style: ReasoningStyle,
  model?: string,
  providerId?: ProviderId | undefined,
  control?: ReasoningControlContext | undefined,
): Record<string, unknown> {
  if (control) {
    return {
      ...emitReasoningControls({
        profile: control.profile,
        preference: reasoning,
        willReplayReasoning: control.willReplayReasoning,
      }),
    };
  }
  if (style === "none") return {};
  const enabled = Boolean(reasoning?.enabled);
  const effort = reasoning?.effort ?? "medium";

  const clampEffort = (e: string): "low" | "medium" | "high" => {
    if (e === "none" || e === "minimal" || e === "low") return "low";
    if (e === "max" || e === "xhigh" || e === "high") return "high";
    return "medium";
  };

  switch (style) {
    case "meta": {
      const metaEffort = (e: string): string => {
        if (e === "none" || e === "minimal") return "minimal";
        if (e === "max" || e === "xhigh") return "xhigh";
        return e;
      };
      if (!enabled) return { reasoning_effort: "minimal" };
      return { reasoning_effort: metaEffort(effort) };
    }
    case "openai": {
      if (!enabled) {
        return effort === "none" ? { reasoning_effort: "none" } : {};
      }
      return { reasoning_effort: clampEffort(effort) };
    }
    case "bynara": {
      const kind = classifyBynaraModel(model ?? "");
      const noThinking = !enabled || effort === "none" || effort === "minimal";
      switch (kind) {
        case "kimi":
          if (noThinking) return { chat_template_kwargs: { thinking: false } };
          if (effort === "high" || effort === "xhigh" || effort === "max") {
            return {
              chat_template_kwargs: { thinking: true },
              reasoning_effort: "high",
            };
          }
          if (effort === "low") {
            return {
              chat_template_kwargs: { thinking: true },
              reasoning_effort: "low",
            };
          }
          return { chat_template_kwargs: { thinking: true } };
        case "deepseek":
        case "agnes":
          if (noThinking) return { reasoning_effort: "none" };
          return { reasoning_effort: clampEffort(effort) };
        case "stepfun":
          if (noThinking) return {};
          return { reasoning_effort: clampEffort(effort) };
        case "qwen": {
          if (noThinking) return { reasoning_effort: "none" };
          if (/qwen-?3\.?8-?max/i.test(model ?? "")) {
            if (effort === "low") return { reasoning_effort: "low" };
            return { reasoning_effort: "medium" };
          }
          if (effort === "low") return { reasoning_effort: "low" };
          if (effort === "medium") return { reasoning_effort: "medium" };
          return { reasoning_effort: "xhigh" };
        }
        case "none":
          return {};
      }
      return {};
    }
    case "agentrouter": {
      const m = (model ?? "").toLowerCase();
      const clamped = clampEffort(effort);
      if (/(?:^|\/)gpt-5|(?:^|\/)o[134](?:\b|-)/.test(m)) {
        if (!enabled) return { reasoning_effort: "minimal" };
        const gptEffort =
          effort === "none"
            ? "minimal"
            : effort === "xhigh" || effort === "max"
              ? "high"
              : effort;
        return { reasoning_effort: gptEffort };
      }
      if (/glm/.test(m)) {
        if (!enabled) return { thinking: { type: "disabled" } };
        return { reasoning_effort: clamped };
      }
      if (/claude/.test(m)) {
        if (!enabled) return {};
        return { reasoning_effort: clamped };
      }
      if (!enabled) return {};
      return { reasoning_effort: clamped };
    }
    case "openrouter":
      if (!enabled) return {};
      if (!supportsOpenRouterReasoning(model ?? "")) return {};
      return { reasoning: { enabled: true, effort: clampEffort(effort) } };
    case "modal": {
      const advertised =
        providerId !== undefined && model
          ? modelReasoningEfforts(providerId, model)
          : undefined;
      if (
        !advertised &&
        providerId !== undefined &&
        model &&
        !modelSupportsThinking(providerId, model)
      ) {
        return {};
      }
      if (!enabled || effort === "none") return { reasoning_effort: "none" };
      return {
        reasoning_effort: pickAdvertisedEffort(
          effort,
          advertised ?? MODAL_DEFAULT_EFFORTS,
        ),
      };
    }
    case "stepfun":
      return { chat_template_kwargs: { enable_thinking: enabled } };
    case "nvidia": {
      const kind = classifyNvidiaModel(model ?? "");
      switch (kind) {
        case "kimi-thinking":
          return {
            chat_template_kwargs: {
              thinking: enabled,
            },
          };
        case "deepseek-v4":
          return {
            chat_template_kwargs: {
              thinking: enabled,
              reasoning_effort: enabled
                ? clampEffort(effort) === "low"
                  ? "none"
                  : "high"
                : "none",
            },
          };
        case "thinking":
          return {
            chat_template_kwargs: {
              thinking: enabled,
            },
          };
        case "nemotron-3": {
          if (!enabled) {
            return {
              chat_template_kwargs: { enable_thinking: false },
            };
          }
          const clamped = clampEffort(effort);
          const budget =
            clamped === "low" ? 4_096 : clamped === "high" ? 16_384 : 8_192;
          return {
            reasoning_budget: budget,
            chat_template_kwargs: { enable_thinking: true },
          };
        }
        case "glm-thinking":
          return {
            chat_template_kwargs: enabled
              ? { enable_thinking: true, clear_thinking: false }
              : { enable_thinking: false },
          };
        case "enable-thinking":
          return {
            chat_template_kwargs: { enable_thinking: enabled },
          };
        case "effort-only":
          if (!enabled && /gpt-oss/i.test(model ?? "")) {
            return { reasoning_effort: "low" };
          }
          if (!enabled && /qwen3|mistral-/i.test(model ?? "")) {
            return { reasoning_effort: "none" };
          }
          return { reasoning_effort: clampEffort(effort) };
        case "none":
        default:
          return {};
      }
    }
    default:
      return {};
  }
}
