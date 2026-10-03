const FIXED_PROVIDER_MODELS = new Set([
  "gpt-4.1-2025-04-14", "gpt-4o-2024-11-20", "gpt-4o-mini-2024-07-18",
  "o3-mini-2025-01-31", "o3-2025-04-16", "o3-pro-2025-06-10", "o4-mini-2025-04-16",
  "ft:gpt-4o-2024-08-06:manifold-markets:generate-patch-batch2:AKYtDIhk",
  "anthropic/claude-sonnet-4.5", "anthropic/claude-4-sonnet-20250522",
  "anthropic/claude-opus-4.1", "anthropic/claude-3.5-haiku-20241022",
  "anthropic/claude-3.5-sonnet-20240620", "openai/gpt-4o-2024-11-20",
  "openai/gpt-5.1", "openai/gpt-5.1-chat", "openai/gpt-4o-mini-2024-07-18",
  "openai/gpt-4.1-nano", "openai/o3-mini-2025-01-31", "google/gemini-2.5-pro",
  "google/gemini-2.5-flash", "google/gemini-2.5-flash-preview:thinking", "x-ai/grok-4-07-09",
  "deepseek-chat", "deepseek-reasoner", "deepseek-v4-pro", "deepseek/deepseek-v4-pro",
  "deepseek-v4-flash", "deepseek/deepseek-v4-flash", "mimo-v2.5", "mimo/mimo-v2.5",
  "mimo-v2.5-pro", "mimo/mimo-v2.5-pro", "mimo-v2.6-flash", "mimo-v2.6-pro",
  "mimo/mimo-v2.6-pro", "minimax/minimax-m3",
  "196166068534771712", "8493203957034778624", "2589952415784501248",
  "3676445825887633408", "2672143108984012800", "1694861989844615168",
  "3808739064941641728", "6231675664466968576", "1502192368286171136",
]);

const PROVIDER_ORDER: Readonly<Record<string, readonly string[]>> = {
  "anthropic/claude-4-sonnet-20250522": ["Google", "Anthropic", "Amazon Bedrock"],
  "anthropic/claude-sonnet-4.5": ["Google", "Anthropic", "Amazon Bedrock"],
  "anthropic/claude-opus-4.1": ["Google", "Anthropic"],
};

export function freebuffProviderRouting(model: string): Record<string, unknown> {
  const order = PROVIDER_ORDER[model];
  return { ...(order ? { order } : {}), allow_fallbacks: !FIXED_PROVIDER_MODELS.has(model) };
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
  return `ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/0.0.0-test runtime/node.js/${process.version}`;
}
