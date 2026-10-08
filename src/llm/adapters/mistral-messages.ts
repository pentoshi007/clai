import { createHash } from "node:crypto";

export function toMistralMessages(
  messages: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const originalIds = messages.flatMap((message) => {
    if (message.role === "tool" && typeof message.tool_call_id === "string")
      return [message.tool_call_id];
    if (!Array.isArray(message.tool_calls)) return [];
    return message.tool_calls.flatMap((call: { id?: unknown }) =>
      typeof call.id === "string" ? [call.id] : [],
    );
  });
  const ids = new Map<string, string>();
  const reserved = new Set(
    originalIds.filter((id) => /^[A-Za-z0-9]{9}$/.test(id)),
  );
  for (const id of originalIds) {
    if (ids.has(id)) continue;
    if (/^[A-Za-z0-9]{9}$/.test(id)) ids.set(id, id);
    else {
      let attempt = 0;
      let candidate: string;
      do {
        candidate = createHash("sha256")
          .update(JSON.stringify(["clai-mistral-tool", id, attempt++]))
          .digest("hex")
          .slice(0, 9);
      } while (reserved.has(candidate));
      reserved.add(candidate);
      ids.set(id, candidate);
    }
  }
  return messages.map((message) => {
    const nativeContent = message.reasoning_details;
    const content =
      Array.isArray(nativeContent) &&
      nativeContent.some((chunk) => chunk?.type === "thinking")
        ? nativeContent
        : message.content;
    const calls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map(
          (call: { id: string; type: string; function: unknown }) => ({
            id: ids.get(call.id) ?? call.id,
            type: call.type,
            function: call.function,
          }),
        )
      : undefined;
    return {
      role: message.role,
      content,
      ...(calls?.length ? { tool_calls: calls } : {}),
      ...(typeof message.tool_call_id === "string"
        ? {
            tool_call_id: ids.get(message.tool_call_id) ?? message.tool_call_id,
          }
        : {}),
      ...(typeof message.name === "string" ? { name: message.name } : {}),
    };
  });
}
