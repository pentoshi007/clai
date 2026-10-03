import { randomUUID } from "node:crypto";
import { ProviderError } from "./http.js";
import { FREEBUFF_API_BASE_URL } from "./freebuff-auth.js";

const RUN_PATH = "/api/v1/agent-runs";
const RUN_TIMEOUT_MS = 30_000;

const BASE3_AGENT_BY_MODEL: Readonly<Record<string, string>> = {
  "crof/kimi-k3-eco": "base3-free-kimi-k3-eco",
  "deepseek/deepseek-v4-flash": "base3-free-deepseek-flash",
  "deepseek/deepseek-v4-pro": "base3-free-deepseek",
  "google/gemini-3.8-flash": "base3-free-gemini-3-8-flash",
  "meta/muse-spark-1.2-contributor": "base3-free-muse-spark",
  "meta/muse-spark-1.3-contributor": "base3-free-muse-spark-1-3",
  "mimo/mimo-v2.5": "base3-free-mimo",
  "mimo/mimo-v2.6-pro": "base3-free-mimo-2-6-pro",
  "minimax/minimax-m3": "base3-free-minimax-m3",
  "openai/gpt-5.6-luna": "base3-free-luna",
  "openai/gpt-5.6-luna-es": "base3-free-luna-es",
  "openai/gpt-6-luna": "base3-free-luna-6",
  "stealth/ox-alpha": "base3-free-ox-alpha",
  "stealth/space-bunny-alpha": "base3-free-space-bunny-alpha",
  "upstage/solar-mini4": "base3-free-solar-mini4",
  "upstage/solar-pro4": "base3-free-solar-pro4",
  "z-ai/glm-5.2": "base3-free-glm",
  "z-ai/glm-5.3-flash": "base3-free-glm-5-3-flash",
};

const BASE2_AGENT_BY_MODEL: Readonly<Record<string, string>> = {
  "anthropic/claude-fable-5.1": "base2-free-fable",
  "anthropic/claude-opus-4.8": "base2-free-claude-opus-4-8",
  "anthropic/claude-opus-5": "base2-free-claude-opus-5",
  "anthropic/claude-opus-5.5": "base2-free-claude-opus-5-5",
  "anthropic/claude-sonnet-4.6": "base2-free-claude-sonnet-4-6",
  "anthropic/claude-sonnet-5": "base2-free-claude-sonnet-5",
  "crof/kimi-k3-eco": "base2-free-kimi-k3-eco",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "deepseek/deepseek-v4.1-flash": "base2-free-deepseek-v4-1-flash",
  "google/gemini-3.1-pro-preview": "base2-free-gemini-3-1-pro",
  "google/gemini-3.5-flash": "base2-free-gemini-3-5-flash",
  "google/gemini-3.6-flash": "base2-free-gemini-3-6-flash",
  "google/gemini-3.7-flash": "base2-free-gemini-3-7-flash",
  "google/gemini-3.8-flash": "base2-free-gemini-3-8-flash",
  "meta-llama/llama-4-maverick": "base2-free-llama-4-maverick",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
  "meta/muse-spark-1.3-contributor": "base2-free-muse-spark-1-3",
  "mimo/mimo-v2.5": "base2-free-mimo",
  "mimo/mimo-v2.5-pro": "base2-free-mimo-2-5-pro",
  "mimo/mimo-v2.6-pro": "base2-free-mimo-2-6-pro",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "mistralai/codestral-2508": "base2-free-codestral-2508",
  "mistralai/mistral-large": "base2-free-mistral-large",
  "moonshotai/kimi-k3": "base2-free-kimi-k3",
  "openai/gpt-5.4-pro": "base2-free-gpt-5-4-pro",
  "openai/gpt-5.5": "base2-free-gpt-5-5",
  "openai/gpt-5.5-pro": "base2-free-gpt-5-5-pro",
  "openai/gpt-5.6-luna": "base2-free-luna",
  "openai/gpt-5.6-luna-es": "base2-free-luna-es",
  "openai/gpt-5.6-luna-pro": "base2-free-gpt-5-6-luna-pro",
  "openai/gpt-5.6-sol": "base2-free-gpt-5-6-sol",
  "openai/gpt-5.6-sol-pro": "base2-free-gpt-5-6-sol-pro",
  "openai/gpt-5.6-terra": "base2-free-gpt-5-6-terra",
  "openai/gpt-5.6-terra-pro": "base2-free-gpt-5-6-terra-pro",
  "openai/gpt-6-astra": "base2-free-gpt-6-astra",
  "openai/gpt-6-astra-pro": "base2-free-gpt-6-astra-pro",
  "openai/gpt-6-luna": "base2-free-luna-6",
  "openai/gpt-6-luna-pro": "base2-free-gpt-6-luna-pro",
  "openai/gpt-6-sol": "base2-free-gpt-6-sol",
  "openai/gpt-6-sol-pro": "base2-free-gpt-6-sol-pro",
  "openai/o3-pro": "base2-free-o3-pro",
  "qwen/qwen3.6-max-preview": "base2-free-qwen3-6-max-preview",
  "qwen/qwen3.6-plus": "base2-free-qwen3-6-plus",
  "qwen/qwen3.7-max": "base2-free-qwen3-7-max",
  "qwen/qwen3.7-plus": "base2-free-qwen3-7-plus",
  "qwen/qwen3.8-27b": "base2-free-qwen3-8-27b",
  "qwen/qwen3.8-flash": "base2-free-qwen3-8-flash",
  "qwen/qwen3.8-max-0902": "base2-free-qwen3-8-max-0902",
  "qwen/qwen3.8-max-prime": "base2-free-qwen3-8-max-prime",
  "stealth/ox-alpha": "base2-free-ox-alpha",
  "stealth/space-bunny-alpha": "base2-free-space-bunny-alpha",
  "upstage/solar-mini4": "base2-free-solar-mini4",
  "upstage/solar-pro4": "base2-free-solar-pro4",
  "x-ai/grok-4.20": "base2-free-grok-4-20",
  "x-ai/grok-4.5": "base2-free-grok-4-5",
  "x-ai/grok-4.6": "base2-free-grok-4-6",
  "x-ai/grok-4.7": "base2-free-grok-4-7",
  "z-ai/glm-5-turbo": "base2-free-glm-5-turbo",
  "z-ai/glm-5.2": "base2-free-glm",
  "z-ai/glm-5.3": "base2-free-glm-5-3",
  "z-ai/glm-5.3-flash": "base2-free-glm-5-3-flash",
  "z-ai/glm-5.3-flashx": "base2-free-glm-5-3-flashx",
  "z-ai/glm-5.3-prime": "base2-free-glm-5-3-prime",
};

const FALLBACK_AGENT_ID = "codebuff/base2-free";

export function freebuffAgentId(model: string): string {
  const id = model.trim();
  const agent = BASE3_AGENT_BY_MODEL[id] ?? BASE2_AGENT_BY_MODEL[id];
  return agent ? `codebuff/${agent}` : FALLBACK_AGENT_ID;
}

export interface FreebuffRun {
  readonly runId: string;
  readonly clientId: string;
  readonly agentId: string;
  readonly startedAt: string;
}

export interface FreebuffRunDeps {
  readonly fetch?: typeof fetch | undefined;
  readonly baseUrl?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly clientId?: string | undefined;
  readonly errorMessage?: string | undefined;
}

function runUrl(base: string): string {
  return `${base.replace(/\/$/, "")}${RUN_PATH}`;
}

function runSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function postRun(
  token: string,
  body: Record<string, unknown>,
  action: string,
  deps: FreebuffRunDeps,
): Promise<Record<string, unknown> | undefined> {
  const response = await (deps.fetch ?? fetch)(runUrl(deps.baseUrl ?? FREEBUFF_API_BASE_URL), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: runSignal(deps.signal),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new ProviderError(
      `Freebuff ${action} failed (${response.status}${text ? `: ${text.slice(0, 300)}` : ""})`,
      response.status,
      text.slice(0, 2_000),
    );
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function startFreebuffRun(
  token: string,
  model: string,
  deps: FreebuffRunDeps = {},
): Promise<FreebuffRun> {
  const agentId = freebuffAgentId(model);
  const payload = await postRun(
    token,
    { action: "START", agentId, ancestorRunIds: [] },
    "run start",
    deps,
  );
  const runId = payload?.["runId"];
  if (typeof runId !== "string" || !runId) {
    throw new ProviderError(
      "Freebuff run start returned no runId; the completion endpoint rejects unregistered runs.",
    );
  }
  return { runId, clientId: deps.clientId ?? randomUUID(), agentId, startedAt: new Date().toISOString() };
}

export async function finishFreebuffRun(
  token: string,
  run: FreebuffRun,
  status: "completed" | "failed" | "cancelled",
  steps: number,
  deps: FreebuffRunDeps = {},
): Promise<void> {
  await postRun(
    token,
    {
      action: "FINISH",
      runId: run.runId,
      status,
      totalSteps: steps,
      directCredits: 0,
      totalCredits: 0,
      ...(deps.errorMessage ? { errorMessage: deps.errorMessage.slice(0, 5_000) } : {}),
      steps: Array.from({ length: steps }, (_, stepNumber) => ({
        id: randomUUID(),
        stepNumber,
        messageId: null,
        status: "completed",
        startTime: run.startedAt,
      })),
    },
    "run finish",
    deps,
  ).catch(() => undefined);
}
