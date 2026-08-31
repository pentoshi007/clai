import type { ToolCall } from "../../types.js";
import { TOOL_ARG_KEYS, tryParseCall } from "./xml-protocol.js";

/**
 * When a model emits a bare args object with no {"name", "args"} wrapper and
 * no ```tool fence, infer which tool it MEANT from the argument keys so we
 * can run it directly instead of nudging the model to re-emit (the user
 * should not have to type "run"). Only unambiguous key signatures map to a
 * tool; genuinely ambiguous shapes (a lone `path` could be fs.read / fs.list
 * / pdf.read / image.ocr; a lone `target` could be whois / dns / scan) return
 * undefined so the caller falls back to a re-emit nudge. Inferred calls still
 * pass through the normal safety classifier + confirmation, so inference can
 * never bypass a confirm/block gate.
 */
export function inferToolFromArgs(
  obj: Record<string, unknown>,
): string | undefined {
  const has = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(obj, key);
  // `command` is deliberately NOT inferred: a fenced JSON object containing a
  // "command" key routinely appears in material the model quotes from a
  // README, web page, or config sample. Inferring shell.exec from it turns
  // fetched content into an execution path, so the caller nudges for an
  // explicit re-emit instead.
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
    // A url with an explicit method/body is a raw HTTP request (http.fetch);
    // a lone url is a content read (web.fetch).
    return has("method") || has("body") ? "http.fetch" : "web.fetch";
  }
  return undefined;
}

/**
 * Strip a single wrapping ```json / ``` fence (if any) and return the inner
 * text trimmed. Leaves un-fenced text unchanged.
 */
function stripLoneFence(text: string): string {
  const fenced = text.trim().match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  return (fenced?.[1] ?? text).trim();
}

/**
 * Try to recover a bare-args tool call from a single candidate text snippet.
 * Returns the recognized result or undefined if the text isn't a recoverable
 * tool call. Used by both the whole-text path and the embedded-fence path.
 */
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
  // Complete {name, args} call the earlier matchers didn't catch.
  const direct = tryParseCall(trimmed);
  if (direct) return { call: direct };
  // Bare args object: every key is a known tool-arg key.
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

/**
 * When a model means to call a tool but emits ONLY a bare JSON object —
 * either a proper {"name","args"} that the strict matchers missed, or a bare
 * args object like {"path":"file.pdf"} with the wrapper/fence dropped — this
 * recognizes it. Returns:
 *   - { call } when the object is a complete {name, args} tool call, or
 *   - { argsOnly: true } when it looks like a bare args object (so the caller
 *     can nudge the model to re-emit a properly named, fenced tool call).
 * Returns undefined for anything that is plainly a normal prose/JSON answer.
 *
 * Also handles the case where a model emits prose followed by a non-`tool`
 * fenced code block (e.g. ```web\n{"url":"..."}\n```) that contains a bare
 * args object — the fence is scanned even when it's not the sole content.
 */
export function recognizeBareToolJson(
  text: string,
): { call?: ToolCall; argsOnly?: boolean } | undefined {
  // Primary path: the whole (de-fenced) text is a bare JSON object
  const inner = stripLoneFence(text);
  const primary = tryRecognizeBareArgs(inner);
  if (primary) return primary;

  // Secondary path: scan for a fenced block that is the model's OWN trailing
  // content (the last fence in the message, with nothing but whitespace after
  // it). Quoted material in the middle of an answer is never treated as a
  // call, which keeps fetched README/web content out of the execution path.
  // We skip ```tool fences — those are handled by parseToolCall already.
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
