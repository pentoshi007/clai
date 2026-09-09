import type { ChatMessage } from "../../types.js";

export function invalidNativeToolHistoryIndexes(
  messages: readonly ChatMessage[],
): ReadonlySet<number> {
  const invalid = new Set<number>();
  const nativeResults = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    const calls = message.toolCalls;
    const callIds = new Set(calls.map((call) => call.id).filter(Boolean));
    let end = index + 1;
    while (messages[end]?.role === "tool") end += 1;
    const results = messages.slice(index + 1, end);
    const resultIds = new Set(
      results.map((result) => result.toolCallId).filter((id): id is string => Boolean(id)),
    );
    const valid =
      callIds.size === calls.length &&
      results.length === calls.length &&
      resultIds.size === results.length &&
      [...callIds].every((id) => resultIds.has(id));
    if (valid) {
      for (let resultIndex = index + 1; resultIndex < end; resultIndex += 1) {
        nativeResults.add(resultIndex);
      }
      index = end - 1;
      continue;
    }
    invalid.add(index);
    for (let resultIndex = index + 1; resultIndex < end; resultIndex += 1) {
      invalid.add(resultIndex);
    }
    index = end - 1;
  }
  for (let index = 0; index < messages.length; index += 1) {
    if (
      messages[index]!.role === "tool" &&
      !invalid.has(index) &&
      !nativeResults.has(index)
    ) {
      invalid.add(index);
    }
  }
  return invalid;
}

export function portableToolCallContent(
  message: ChatMessage,
  wireName: (name: string) => string = (name) => name,
): string {
  const calls = (message.toolCalls ?? [])
    .map(
      (call) =>
        `[Tool call: ${wireName(call.name)}]\n${call.rawArguments ?? JSON.stringify(call.args ?? {})}`,
    )
    .join("\n\n");
  return [message.content, calls].filter(Boolean).join("\n\n");
}

export function portableToolResultContent(
  message: ChatMessage,
  wireName: (name: string) => string = (name) => name,
): string {
  return `[Tool result${message.name ? `: ${wireName(message.name)}` : ""}]\n${message.content}`;
}
