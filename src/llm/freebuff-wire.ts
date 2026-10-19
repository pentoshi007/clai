import { freebuffEnvProfile } from "./freebuff-env-profile.js";

const PROVIDER_ORDER: Readonly<Record<string, readonly string[]>> = {
  "anthropic/claude-4-sonnet-20250522": ["Google", "Anthropic", "Amazon Bedrock"],
  "anthropic/claude-sonnet-4.5": ["Google", "Anthropic", "Amazon Bedrock"],
  "anthropic/claude-opus-4.1": ["Google", "Anthropic"],
};

export function freebuffProviderRouting(model: string): Record<string, unknown> {
  const order = PROVIDER_ORDER[model];
  return { data_collection: "deny", ...(order ? { order } : {}) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function markBoundary(message: Record<string, unknown>): void {
  if (Array.isArray(message.content)) {
    const part = record(message.content.at(-1));
    if (part) part.cache_control = { type: "ephemeral" };
    return;
  }
  const calls = message.tool_calls;
  if (!message.content && Array.isArray(calls)) {
    const call = record(calls.at(-1));
    if (call) call.cache_control = { type: "ephemeral" };
    return;
  }
  message.cache_control = { type: "ephemeral" };
}

export function freebuffMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const wire = messages.map((message) => {
    const cloned = structuredClone(message);
    if (cloned.role === "user" && typeof cloned.content === "string") {
      cloned.content = [{ type: "text", text: cloned.content }];
    }
    if (Array.isArray(cloned.content)) {
      for (const part of cloned.content) {
        const image = record(record(part)?.image_url);
        if (image) delete image.detail;
      }
    }
    if (cloned.role === "assistant" && cloned.content === null) cloned.content = "";
    return cloned;
  });
  const beforeRole = (role: string): number => {
    for (let index = wire.length - 1; index >= 0; index -= 1) {
      if (wire[index]!.role === role) return index - 1;
    }
    return -1;
  };
  for (const index of new Set([beforeRole("assistant"), beforeRole("user"), wire.length - 1])) {
    if (index >= 0) markBoundary(wire[index]!);
  }
  return wire;
}

export function freebuffUserAgent(): string {
  return "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser";
}

export const FREEBUFF_CLI_VERSION = "0.2.29";

export function freebuffTimezoneHeader(): Record<string, string> {
  try {
    return { "x-fb-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone };
  } catch {
    return {};
  }
}

let envHeaderValue: string | undefined;

export function freebuffEnvHeaderValue(): string {
  if (envHeaderValue === undefined) envHeaderValue = freebuffEnvProfile();
  return envHeaderValue;
}

export function resetFreebuffEnvHeaderValue(): void {
  envHeaderValue = undefined;
}

export function freebuffClientHeaders(): Record<string, string> {
  return {
    ...freebuffTimezoneHeader(),
    "x-freebuff-env": freebuffEnvHeaderValue(),
    "x-freebuff-client-version": FREEBUFF_CLI_VERSION,
  };
}

export function freebuffPlainHeaders(): Record<string, string> {
  return {
    "user-agent": "Bun/1.3.14",
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br",
  };
}

let actingUserId: string | undefined;

export function setFreebuffActingUserId(userId: string | undefined): void {
  actingUserId = userId;
}

export function freebuffActingUserHeaders(): Record<string, string> {
  return actingUserId ? { "x-freebuff-acting-user-id": actingUserId } : {};
}
