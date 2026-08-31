import { classifyNvidiaModel } from "../model-families.js";
import { codeFact } from "../provider-profile-layers.js";
import type { ProviderProfileLayer } from "../provider-profile.js";

export function nvidiaModelLayer(
  model: string,
): ProviderProfileLayer | undefined {
  switch (classifyNvidiaModel(model)) {
    case "kimi-thinking":
      return {
        evidence: codeFact("nim-kimi-thinking"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "kimi-template-thinking",
            status: "supported",
            evidence: codeFact("nim-kimi-thinking"),
          },
          disable: "supported",
          disableForm: "template-thinking-false",
          replayScope: "tool-turn",
        },
      };
    case "deepseek-v4":
      return {
        evidence: codeFact("nim-deepseek-v4"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "chat-template-thinking",
            status: "supported",
            evidence: codeFact("nim-deepseek-v4"),
          },
          acceptedEfforts: ["none", "high"],
          disable: "supported",
          disableForm: "template-thinking-false",
          replayScope: "tool-turn",
          outputShapes: ["reasoning-content"],
        },
      };
    case "thinking":
      return {
        evidence: codeFact("nim-chat-template-thinking"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "chat-template-thinking",
            status: "supported",
            evidence: codeFact("nim-chat-template-thinking"),
          },
          disable: "supported",
          disableForm: "template-thinking-false",
        },
      };
    case "nemotron-3":
      return {
        evidence: codeFact("nim-nemotron-3"),
        reasoning: {
          control: {
            dialect: "nemotron-reasoning-budget",
            status: "supported",
            evidence: codeFact("nim-nemotron-3"),
          },
          disable: "supported",
          disableForm: "template-enable-thinking-false",
        },
      };
    case "glm-thinking":
      return {
        evidence: codeFact("nim-glm-thinking"),
        reasoning: {
          control: {
            dialect: "glm-enable-thinking",
            status: "supported",
            evidence: codeFact("nim-glm-thinking"),
          },
          disable: "supported",
          disableForm: "template-enable-thinking-false",
        },
      };
    case "enable-thinking":
      return {
        evidence: codeFact("nim-gemma-enable-thinking"),
        reasoning: {
          control: {
            dialect: "glm-enable-thinking",
            status: "supported",
            evidence: codeFact("nim-gemma-enable-thinking"),
          },
          disable: "supported",
          disableForm: "template-enable-thinking-false",
        },
      };
    case "effort-only":
      if (/gpt-oss/i.test(model)) {
        return {
          evidence: codeFact("nim-gpt-oss-effort"),
          reasoning: {
            generation: "default-on",
            control: {
              dialect: "openai-effort",
              status: "supported",
              evidence: codeFact("nim-gpt-oss-effort"),
            },
            acceptedEfforts: ["low", "medium", "high"],
            disable: "unsupported",
            disableForm: "effort-minimal-floor",
          },
        };
      }
      return {
        evidence: codeFact("nim-effort-only"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "openai-effort",
            status: "supported",
            evidence: codeFact("nim-effort-only"),
          },
          acceptedEfforts: ["none", "low", "medium", "high"],
          disable: "supported",
          disableForm: "effort-none",
        },
      };
    default:
      return {
        evidence: codeFact("nim-no-thinking-knob"),
        reasoning: {
          generation: "unknown",
          control: {
            dialect: "none",
            status: "unsupported",
            evidence: codeFact("nim-no-thinking-knob"),
          },
        },
      };
  }
}
