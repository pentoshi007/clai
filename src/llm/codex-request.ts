import { createHash } from "node:crypto";

const UUID_NAMESPACE_OID = "6ba7b8129dad11d180b400c04fd430c8";

function uuidV5(namespace: string, value: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(value)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
}

export function finalizeCodexBody(
  body: Record<string, unknown>,
  responsesLite: boolean,
): Record<string, unknown> {
  if (responsesLite) {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const groupedTools = tools.length
      ? [{ type: "namespace", name: "functions", description: "", tools }]
      : [];
    const namespace = uuidV5(UUID_NAMESPACE_OID, String(body.prompt_cache_key));
    const prefix: Record<string, unknown>[] = [{
      type: "additional_tools",
      id: `at_${uuidV5(namespace, sortedJson(groupedTools))}`,
      role: "developer",
      tools: groupedTools,
    }];
    if (typeof body.instructions === "string" && body.instructions) {
      prefix.push({
        type: "message",
        id: `msg_${uuidV5(namespace, body.instructions)}`,
        role: "developer",
        content: [{ type: "input_text", text: body.instructions }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["model.base_instructions"],
        },
      });
    }
    body.input = [...prefix, ...(body.input as unknown[])];
    delete body.instructions;
    delete body.tools;
    body.parallel_tool_calls = false;
  }
  const ordered: Record<string, unknown> = {};
  for (const key of [
    "model", "stream", "service_tier", "instructions", "input", "tools",
    "tool_choice", "parallel_tool_calls", "reasoning", "store", "stream_options",
    "include", "prompt_cache_key", "text", "client_metadata", "access_programs",
  ]) {
    if (key in body) ordered[key] = body[key];
  }
  return ordered;
}
