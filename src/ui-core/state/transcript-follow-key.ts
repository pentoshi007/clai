import type { TranscriptState } from "./transcript-types.js";

export function transcriptFollowKey(
  state: TranscriptState,
  running: boolean,
): string {
  const parts: string[] = [
    String(state.order.length),
    state.runningStatus ?? "",
    running ? "1" : "0",
  ];
  const window = state.order.slice(-8);
  for (const id of window) {
    const item = state.byId.get(id);
    if (!item) continue;
    switch (item.kind) {
      case "assistant":
        parts.push(`a:${item.id}:${item.text.length}:${item.streaming ? 1 : 0}`);
        break;
      case "thinking":
        parts.push(`t:${item.id}:${item.content.length}:${item.streaming ? 1 : 0}`);
        break;
      case "user":
        parts.push(`u:${item.id}:${item.text.length}`);
        break;
      case "tool":
        parts.push(`o:${item.id}:${item.outputBytes}:${item.status}`);
        break;
      case "notice":
        parts.push(`n:${item.id}:${item.text.length}`);
        break;
      case "compacted":
        parts.push(
          `c:${item.id}:${item.summary.length}:${item.streaming ? 1 : 0}:${item.error?.length ?? 0}`,
        );
        break;
      default:
        parts.push(id);
    }
  }
  return parts.join("|");
}
