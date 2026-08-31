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

  // Map expanded effort levels to the classic low/medium/high subset for
  // providers that only understand the smaller set.
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
      // `reasoning_effort` is the Chat Completions knob. The nested
      // `reasoning` object belongs to the Responses API; strict gateways reject
      // unknown top-level fields with a hard 400.
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
        case "none":
          return {};
      }
      return {};
    }
    case "agentrouter": {
      // AgentRouter proxies three families, each with a *different* reasoning
      // contract (verified live against agentrouter.org/v1, 2026-07). We send
      // only the standard top-level knob each one honours — no redundant
      // `reasoning` object (none of the routed models read it).
      const m = (model ?? "").toLowerCase();
      const clamped = clampEffort(effort);
      // OpenAI gpt-5.x / o-series: top-level `reasoning_effort`, and it uniquely
      // supports "minimal". These models can't be fully disabled, so "off"
      // degrades to the cheapest "minimal" rather than the medium default.
      if (/(?:^|\/)gpt-5|(?:^|\/)o[134](?:\b|-)/.test(m)) {
        if (!enabled) return { reasoning_effort: "minimal" };
        const gptEffort =
          effort === "none"
            ? "minimal"
            : effort === "xhigh" || effort === "max"
              ? "high"
              : effort; // minimal | low | medium | high
        return { reasoning_effort: gptEffort };
      }
      // Zhipu GLM thinks by DEFAULT; `reasoning_effort` only modulates depth and
      // cannot turn it off. The one knob that actually disables it on this
      // gateway is `thinking.type=disabled` — so "off" must send that.
      if (/glm/.test(m)) {
        if (!enabled) return { thinking: { type: "disabled" } };
        return { reasoning_effort: clamped };
      }
      // Anthropic Claude: `reasoning_effort` enables extended thinking (the
      // gateway maps it to a thinking budget). Thinking is OFF by default, so
      // "off" simply omits the knob. `buildChatBody` floors max_tokens above the
      // budget so enabling it never trips the gateway's budget precondition.
      if (/claude/.test(m)) {
        if (!enabled) return {};
        return { reasoning_effort: clamped };
      }
      // Unknown model routed by AgentRouter → plain OpenAI-compatible behavior.
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
      // Step 3.5/3.7 Flash enables a <think> block by default on compatible
      // hosts. Omitting an OpenAI reasoning field does not turn that default
      // off, so compaction would still buy hidden reasoning tokens. vLLM's
      // StepFun template honours this explicit per-request switch.
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
          // NVIDIA's DeepSeek V4 API accepts none/high/max. Map expanded
          // effort levels: none/minimal/low → none; medium/high/xhigh → high.
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
          // Nemotron-3 supports both `enable_thinking` and an optional
          // `reasoning_budget` cap. Map expanded effort to budget values.
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
          // GLM-5 / 4.5 expects `clear_thinking:false` alongside
          // `enable_thinking:true` per the NIM docs example.
          return {
            chat_template_kwargs: enabled
              ? { enable_thinking: true, clear_thinking: false }
              : { enable_thinking: false },
          };
        case "enable-thinking":
          // Gemma 3/4 only documents `enable_thinking`; do not add
          // `clear_thinking` here since the chat template doesn't accept it.
          return {
            chat_template_kwargs: { enable_thinking: enabled },
          };
        case "effort-only":
          // NVIDIA GPT-OSS accepts only low/medium/high, so a retry cannot
          // fully disable it. Keep it at the lowest supported effort instead
          // of omitting the field and reverting to NVIDIA's medium default.
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
