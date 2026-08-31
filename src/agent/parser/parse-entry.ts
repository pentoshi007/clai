import type { ToolCall } from "../../types.js";
import { DEEPSEEK_TOOL_CALL_RE, KIMI_TOOL_CALL_RE, parseAllDsmlToolCalls, parseAllIdTaggedToolCalls, parseAllOpenSepToolCalls, parseDeepseekToolCall, parseDsmlToolCall, parseIdTaggedToolCall, parseKimiToolCall, parseOpenSepToolCall, tryJson } from "./vendor-protocols.js";
import { parseXmlToolCall, tryParseCall } from "./xml-protocol.js";

export interface ParseToolCallOptions {
  /**
   * When true, only formats that are explicitly tool-call delimited are
   * accepted: ```tool fenced JSON, <tool_call> XML, and the Kimi sentinel
   * token format. Loose formats (any fenced block, heading-prefix, trailing
   * JSON) are dropped — useful when models routinely emit JSON examples in
   * prose. Default is `false` so existing free-tier models keep working.
   */
  strict?: boolean | undefined;
}

export function parseToolCall(
  text: string,
  options: ParseToolCallOptions = {},
): ToolCall | undefined {
  // 1. ```tool ... ``` (standard format)
  const fenced = text.match(/```tool\s*\n?([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const call = tryParseCall(fenced[1]);
    if (call) return call;
  }

  // 2. <tool_call>...</tool_call> (XML formats)
  const xmlCall = parseXmlToolCall(text);
  if (xmlCall) return xmlCall;

  // 2b. <tool_call:id>name\n{args} (GLM / Tencent / some gateways)
  const idTagged = parseIdTaggedToolCall(text);
  if (idTagged) return idTagged;

  const dsml = parseDsmlToolCall(text);
  if (dsml) return dsml;

  const openSep = parseOpenSepToolCall(text);
  if (openSep) return openSep;

  // 3. Kimi/Moonshot sentinel format (used by kimi-k2 family on NIM).
  const kimi = parseKimiToolCall(text);
  if (kimi) return kimi;

  const deepseek = parseDeepseekToolCall(text);
  if (deepseek) return deepseek;

  // In strict mode, stop here. Headings, generic fenced blocks, and trailing
  // JSON are too easy to accidentally trigger when the model is showing a
  // worked example.
  if (options.strict) return undefined;

  // 4. ### tool / ## tool / # tool heading + JSON
  const heading = text.match(/#{1,3}\s*tool\s*\n\s*(\{[\s\S]*\})/i);
  if (heading?.[1]) {
    const call = tryParseCall(heading[1]);
    if (call) return call;
  }

  // 5. **tool** heading + JSON
  const bold = text.match(/\*\*tool\*\*\s*\n\s*(\{[\s\S]*\})/i);
  if (bold?.[1]) {
    const call = tryParseCall(bold[1]);
    if (call) return call;
  }

  // 6. Any fenced block (```json, ```, etc.) containing name+args
  const anyFenced = text.match(/```\w*\s*\n?([\s\S]*?)```/);
  if (anyFenced?.[1]) {
    const call = tryParseCall(anyFenced[1]);
    if (call) return call;
  }

  // 7. Trailing JSON object with "name" and "args"
  const trailingJson = text.match(
    /(\{"name"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\})\s*$/,
  );
  if (trailingJson?.[1]) {
    const call = tryParseCall(trailingJson[1]);
    if (call) return call;
  }

  return undefined;
}

/**
 * Detect an opened-but-unparseable tool call. This happens when the model's
 * output is truncated by the token limit mid-JSON: we see the ```tool fence
 * (or a bare {"name":"...","args" prefix) open, but parseToolCall returns
 * undefined because the JSON never closed. Without this, the broken block
 * leaks to the screen as a "final answer" and the requested action (e.g. a
 * multi-file fs.writeMany scaffold) silently never runs.
 */
export function looksLikeTruncatedToolCall(text: string): boolean {
  // An opened ```tool fence with no closing fence.
  const openFence = /```tool\s*\n?/i.test(text);
  const closeFence = /```tool[\s\S]*?```/i.test(text);
  if (openFence && !closeFence) return true;
  // A tool-call JSON object that started but whose braces never balanced.
  const jsonStart = text.search(
    /\{\s*"name"\s*:\s*"[A-Za-z][\w.]*"\s*,\s*"args"/,
  );
  if (jsonStart >= 0) {
    const slice = text.slice(jsonStart);
    let depth = 0;
    let inString = false;
    let escaped = false;
    let balanced = false;
    for (const ch of slice) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          balanced = true;
          break;
        }
      }
    }
    if (!balanced) return true;
  }
  // An id-tagged block (GLM / Kimi-style wire) left open. Its arguments are
  // only trusted once the block closes, so a cut stream must retry rather than
  // leak the opener as prose. Later openers win: earlier blocks that closed
  // were already parsed and returned by parseAllToolCalls.
  const idOpeners = [...text.matchAll(/<tool_call:[A-Za-z0-9_-]+>/gi)];
  const lastOpener = idOpeners[idOpeners.length - 1];
  if (lastOpener?.index !== undefined) {
    const after = text.slice(lastOpener.index + lastOpener[0].length);
    if (!/<\/tool_call\b/i.test(after)) return true;
  }
  return false;
}

/**
 * Parse every explicitly-delimited tool call in a message (```tool fences,
 * <tool_call> XML, Kimi sentinel blocks), in document order, so the runner
 * can execute a batch emitted in one turn instead of only the first call.
 */
export function parseAllToolCalls(text: string): ToolCall[] {
  const found: Array<{ index: number; call: ToolCall }> = [];
  let m: RegExpExecArray | null;

  const fenceRe = /```tool\s*\n?([\s\S]*?)```/gi;
  while ((m = fenceRe.exec(text)) !== null) {
    const call = tryParseCall(m[1] ?? "");
    if (call) found.push({ index: m.index, call });
  }

  const xmlRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  while ((m = xmlRe.exec(text)) !== null) {
    const call = parseXmlToolCall(m[0]);
    if (call) found.push({ index: m.index, call });
  }

  for (const entry of parseAllIdTaggedToolCalls(text)) {
    found.push(entry);
  }

  for (const entry of parseAllDsmlToolCalls(text)) {
    found.push(entry);
  }

  for (const entry of parseAllOpenSepToolCalls(text)) {
    found.push(entry);
  }

  const kimiRe = new RegExp(KIMI_TOOL_CALL_RE.source, "gi");
  while ((m = kimiRe.exec(text)) !== null) {
    const call = tryParseCall(
      JSON.stringify({ name: m[1], args: tryJson(m[2] ?? "{}") ?? {} }),
    );
    if (call) found.push({ index: m.index, call });
  }

  const deepseekRe = new RegExp(DEEPSEEK_TOOL_CALL_RE.source, "gi");
  while ((m = deepseekRe.exec(text)) !== null) {
    const call = tryParseCall(
      JSON.stringify({ name: m[1], args: tryJson(m[2] ?? "{}") ?? {} }),
    );
    if (call) found.push({ index: m.index, call });
  }

  // Bare <function=name>…</function> blocks (no <tool_call> wrapper) — some
  // models emit one or several of these. Route each through parseXmlToolCall
  // so the <parameter=…> args are decoded. Skip any that overlap a
  // <tool_call> block already captured above (avoid double-counting).
  const fnRe = /<function=[\w.]+?>[\s\S]*?<\/function>/gi;
  while ((m = fnRe.exec(text)) !== null) {
    const alreadyCaptured = found.some(
      (f) => m!.index >= f.index && m!.index < f.index + 12,
    );
    const overlapsToolCall = /<tool_call>/i.test(
      text.slice(Math.max(0, m.index - 24), m.index),
    );
    if (alreadyCaptured || overlapsToolCall) continue;
    const call = parseXmlToolCall(m[0]);
    if (call) found.push({ index: m.index, call });
  }

  found.sort((a, b) => a.index - b.index);
  const deduped: Array<{ index: number; call: ToolCall }> = [];
  for (const entry of found) {
    const mutating = isMutatingToolName(entry.call.name);
    if (
      deduped.some(
        (d) =>
          sameToolCall(d.call, entry.call) &&
          (mutating || Math.abs(d.index - entry.index) < 64),
      )
    ) {
      continue;
    }
    deduped.push(entry);
  }
  const MAX_PER_TOOL = 5;
  const toolCounts = new Map<string, number>();
  const capped: ToolCall[] = [];
  for (const entry of deduped) {
    const count = toolCounts.get(entry.call.name) ?? 0;
    if (count >= MAX_PER_TOOL) continue;
    toolCounts.set(entry.call.name, count + 1);
    capped.push(entry.call);
  }
  return capped;
}

/**
 * Tools whose duplicate execution changes state (files, packages, processes,
 * remote resources). Duplicate identical calls to these are collapsed across
 * a whole message rather than only within a 64-character window.
 */
const MUTATING_TOOL_NAMES = new Set([
  "fs.write",
  "fs.writeMany",
  "fs.append",
  "fs.edit",
  "fs.replaceLines",
  "fs.delete",
  "shell.exec",
  "shell.start",
  "shell.stop",
  "pkg.install",
  "http.fetch",
  "tool.batch",
]);

export function isMutatingToolName(name: string): boolean {
  return MUTATING_TOOL_NAMES.has(name.trim());
}

/** Structural equality for two tool calls (name + canonical args JSON). */
export function sameToolCall(a: ToolCall, b: ToolCall): boolean {  if (a.name !== b.name) return false;
  try {
    return JSON.stringify(a.args) === JSON.stringify(b.args);
  } catch {
    return false;
  }
}
