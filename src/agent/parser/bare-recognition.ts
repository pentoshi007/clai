import type { ToolCall } from "../../types.js";
import { TOOL_ARG_KEYS, tryParseCall } from "./xml-protocol.js";

export function inferToolFromArgs(
  obj: Record<string, unknown>,
): string | undefined {
  const has = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(obj, key);
  if (has("command") || has("cmd")) return undefined;
  if (has("files")) return "fs.writeMany";
  if (has("calls")) return "tool.batch";
  if (has("startLine") && has("endLine") && has("path")) return "fs.replaceLines";
  if (has("oldText") || has("newText")) return "fs.edit";
  if (has("position") && has("content") && has("path")) return "fs.append";
  if (has("content") && has("path")) return "fs.write";
  if (has("pattern")) return "fs.search";
  if (has("query")) return "web.search";
  if (has("tools")) return "tool.check";
  if (has("goal") && has("tasks")) return "plan.create";
  if (has("notificationId") || has("jobId")) return "job.read";
  if (
    has("taskId") &&
    (has("position") || has("beforeTaskId") || has("afterTaskId"))
  ) return "task.move";
  if (has("taskId") || has("state")) return "task.update";
  if (has("tool")) return "pkg.install";
  if (has("record") && has("target")) return "dns.lookup";
  if (has("ports") && has("target")) return "net.scan";
  if (has("url")) {
    return has("method") || has("body") ? "http.fetch" : "web.fetch";
  }
  return undefined;
}

function stripLoneFence(text: string): string {
  const fenced = text.trim().match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  return (fenced?.[1] ?? text).trim();
}

function tryRecognizeBareArgs(
  inner: string,
): { call?: ToolCall; argsOnly?: boolean } | undefined {
  const trimmed = inner.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  const direct = tryParseCall(trimmed);
  if (direct) return { call: direct };
  const keys = Object.keys(obj);
  if (keys.length === 0 || keys.length > 6) return undefined;
  const allKnown = keys.every((key) => TOOL_ARG_KEYS.has(key));
  if (!allKnown) return undefined;
  const inferred = inferToolFromArgs(obj);
  if (inferred) {
    return { call: { name: inferred, args: obj } };
  }
  return { argsOnly: true };
}

export function recognizeBareToolJson(
  text: string,
): { call?: ToolCall; argsOnly?: boolean } | undefined {
  const inner = stripLoneFence(text);
  const primary = tryRecognizeBareArgs(inner);
  if (primary) return primary;

  const embeddedFenceRe = /```([a-zA-Z]*)\s*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let lastFence: { lang: string; body: string; end: number } | undefined;
  while ((m = embeddedFenceRe.exec(text)) !== null) {
    lastFence = {
      lang: m[1] ?? "",
      body: (m[2] ?? "").trim(),
      end: m.index + m[0].length,
    };
  }
  if (lastFence && text.slice(lastFence.end).trim() === "") {
    const lang = lastFence.lang.toLowerCase();
    if (lang !== "tool") {
      const body = lastFence.body;
      if (body.startsWith("{") && body.endsWith("}")) {
        const result = tryRecognizeBareArgs(body);
        if (result) return result;
      }
    }
  }

  return undefined;
}
