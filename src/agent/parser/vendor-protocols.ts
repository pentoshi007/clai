import type { ToolCall } from "../../types.js";
import { extractBalancedJson, lenientJsonParse, preprocessJson, tryParseCall } from "./xml-protocol.js";

// Kimi K2 / Moonshot models on NVIDIA NIM emit tool calls using a
// sentinel-token format that looks like:
//   <|tool_calls_section_begin|>
//     <|tool_call_begin|>functions.shell.exec:0<|tool_call_argument_begin|>
//     {"command":"ls"}
//     <|tool_call_end|>
//   <|tool_calls_section_end|>
// The `functions.` prefix is optional, the trailing `:N` index is optional,
// and the surrounding section markers may be absent on truncated streams.
export const KIMI_TOOL_CALL_RE =
  /<\|tool_call_begin\|>\s*(?:functions\.)?([A-Za-z][\w.]*?)(?::\d+)?\s*<\|tool_call_argument_begin\|>\s*(\{[\s\S]*?\})\s*<\|tool_call_end\|>/i;

export function parseKimiToolCall(text: string): ToolCall | undefined {
  const match = text.match(KIMI_TOOL_CALL_RE);
  if (!match) return undefined;
  const name = match[1]!;
  return tryParseCall(JSON.stringify({ name, args: tryJson(match[2]!) ?? {} }));
}

export const DEEPSEEK_TOOL_CALL_RE =
  /<[|｜]+tool[_▁]call[_▁]begin[|｜]+>\s*(?:[A-Za-z]+\s*)?<[|｜]+tool[_▁]sep[|｜]+>\s*(?:functions\.)?([A-Za-z][\w.]*?)(?::\d+)?\s*(?:\n|\s)*(?:```(?:json)?\s*)?(\{[\s\S]*?\})\s*(?:```)?\s*(?:<[|｜]+tool[_▁]call[_▁]end[|｜]+>|$)/i;

export function parseDeepseekToolCall(text: string): ToolCall | undefined {
  const match = text.match(DEEPSEEK_TOOL_CALL_RE);
  if (!match) return undefined;
  return tryParseCall(
    JSON.stringify({ name: match[1]!, args: tryJson(match[2]!) ?? {} }),
  );
}

const DSML_INVOKE_OPEN_RE = /<[|｜]+DSML[|｜]+invoke\b([^>]*)>/gi;

const DSML_PARAMETER_OPEN_RE = /<[|｜]+DSML[|｜]+parameter\b([^>]*)>/gi;

const DSML_INVOKE_END_RES: RegExp[] = [
  /<\/[|｜]+DSML[|｜]+invoke>/i,
  /<[|｜]+DSML[|｜]+invoke\b/i,
  /<\/[|｜]+DSML[|｜]+tool_calls>/i,
];

const DSML_PARAMETER_END_RES: RegExp[] = [
  /<\/[|｜]+DSML[|｜]+parameter>/i,
  /<[|｜]+DSML[|｜]+parameter\b/i,
  /<\/[|｜]+DSML[|｜]+invoke>/i,
  /<\/[|｜]+DSML[|｜]+tool_calls>/i,
];

function boundDsmlBlock(
  after: string,
  boundaries: RegExp[],
): { body: string; terminated: boolean } {
  let end = -1;
  for (const re of boundaries) {
    const match = re.exec(after);
    if (match && (end < 0 || match.index < end)) end = match.index;
  }
  return end < 0
    ? { body: after, terminated: false }
    : { body: after.slice(0, end), terminated: true };
}

function dsmlAttribute(attrs: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return match?.[1] ?? match?.[2];
}

function decodeDsmlCodePoint(raw: string, radix: number, original: string): string {
  const value = Number.parseInt(raw, radix);
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : original;
}

function decodeDsmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (original: string, hex: string) => decodeDsmlCodePoint(hex, 16, original))
    .replace(/&#(\d+);/g, (original: string, decimal: string) => decodeDsmlCodePoint(decimal, 10, original))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function dsmlParameterValue(attrs: string, raw: string): unknown {
  const value = decodeDsmlText(raw.trim());
  if (/\bstring\s*=\s*["']true["']/i.test(attrs)) return value;
  if (/\bboolean\s*=\s*["']true["']/i.test(attrs)) return value.toLowerCase() === "true";
  if (/\bnumber\s*=\s*["']true["']/i.test(attrs)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  const parsed = lenientJsonParse(value);
  return parsed === undefined ? value : parsed;
}

export function parseAllDsmlToolCalls(text: string): Array<{ index: number; call: ToolCall }> {
  const found: Array<{ index: number; call: ToolCall }> = [];
  const invokeRe = new RegExp(DSML_INVOKE_OPEN_RE.source, "gi");
  let invoke: RegExpExecArray | null;
  while ((invoke = invokeRe.exec(text)) !== null) {
    const name = dsmlAttribute(invoke[1] ?? "", "name")?.replace(/^functions\./, "").trim();
    const body = boundDsmlBlock(
      text.slice(invoke.index + invoke[0].length),
      DSML_INVOKE_END_RES,
    );
    if (!name || !body.terminated) continue;
    const args: Record<string, unknown> = {};
    const parameterRe = new RegExp(DSML_PARAMETER_OPEN_RE.source, "gi");
    let parameter: RegExpExecArray | null;
    let truncated = false;
    while ((parameter = parameterRe.exec(body.body)) !== null) {
      const parameterName = dsmlAttribute(parameter[1] ?? "", "name")?.trim();
      const value = boundDsmlBlock(
        body.body.slice(parameter.index + parameter[0].length),
        DSML_PARAMETER_END_RES,
      );
      if (!value.terminated) {
        truncated = true;
        break;
      }
      if (!parameterName) continue;
      args[parameterName] = dsmlParameterValue(parameter[1] ?? "", value.body);
    }
    if (truncated) continue;
    found.push({ index: invoke.index, call: { name, args } });
  }
  return found;
}

export function parseDsmlToolCall(text: string): ToolCall | undefined {
  return parseAllDsmlToolCalls(text)[0]?.call;
}

const OPEN_SEP_OPEN_RE = /<[|｜]+open[|｜]+>?([A-Za-z][\w-]*)\b/gi;

const OPEN_SEP_SEP_RE = /<[|｜]+sep[|｜]+>/gi;

function scanOpenSepElement(
  text: string,
  from: number,
): { tag: string; attrs: string; body: string; end: number } | undefined {
  OPEN_SEP_OPEN_RE.lastIndex = from;
  const open = OPEN_SEP_OPEN_RE.exec(text);
  if (!open) return undefined;
  const tag = open[1]!;
  const afterOpen = open.index + open[0].length;
  OPEN_SEP_SEP_RE.lastIndex = afterOpen;
  const sep = OPEN_SEP_SEP_RE.exec(text);
  if (!sep) return undefined;
  const attrs = text.slice(afterOpen, sep.index);
  const closeRe = new RegExp(
    `<[|｜]+close[|｜]+>?${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*>?`,
    "i",
  );
  const close = closeRe.exec(text.slice(sep.index + sep[0].length));
  const bodyEnd = close
    ? sep.index + sep[0].length + close.index
    : text.length;
  return {
    tag,
    attrs,
    body: text.slice(sep.index + sep[0].length, bodyEnd),
    end: close ? bodyEnd + close[0].length : text.length,
  };
}

function openSepValue(attrs: string, raw: string): unknown {
  const value = decodeDsmlText(raw.trim());
  const type = dsmlAttribute(attrs, "type")?.toLowerCase();
  if (type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (type === "boolean" || type === "bool") return value.toLowerCase() === "true";
  if (type === "string") return value;
  const parsed = lenientJsonParse(value);
  return parsed === undefined ? value : parsed;
}

export function parseAllOpenSepToolCalls(
  text: string,
): Array<{ index: number; call: ToolCall }> {
  const found: Array<{ index: number; call: ToolCall }> = [];
  if (!/<[|｜]+open[|｜]+/i.test(text)) return found;
  let cursor = 0;
  while (cursor < text.length) {
    const openIdx = text.slice(cursor).search(OPEN_SEP_OPEN_RE);
    if (openIdx < 0) break;
    const element = scanOpenSepElement(text, cursor + openIdx);
    if (!element) {
      cursor = cursor + openIdx + 1;
      continue;
    }
    if (element.tag !== "call") {
      cursor = cursor + openIdx + 1;
      continue;
    }
    {
      const rawName =
        dsmlAttribute(element.attrs, "tool") ?? dsmlAttribute(element.attrs, "name");
      const name = rawName?.replace(/^functions\./, "").trim();
      if (name) {
        const args: Record<string, unknown> = {};
        let inner = 0;
        while (inner < element.body.length) {
          const nextOpen = element.body.slice(inner).search(OPEN_SEP_OPEN_RE);
          if (nextOpen < 0) break;
          const arg = scanOpenSepElement(element.body, inner + nextOpen);
          if (!arg) break;
          if (arg.tag === "argument") {
            const key =
              dsmlAttribute(arg.attrs, "key") ?? dsmlAttribute(arg.attrs, "name");
            if (key) args[key] = openSepValue(arg.attrs, arg.body);
          }
          inner = arg.end;
        }
        found.push({ index: cursor + openIdx, call: { name, args } });
      }
    }
    cursor = element.end > cursor + openIdx ? element.end : cursor + openIdx + 1;
  }
  return found;
}

export function parseOpenSepToolCall(text: string): ToolCall | undefined {
  return parseAllOpenSepToolCalls(text)[0]?.call;
}

/**
 * GLM / Tencent / some OpenAI-compat gateways emit:
 *   <tool_calls:6124c78e>
 *   <tool_call:6124c78e>web.search
 *   {"query":"…"}
 *   </tool_call:6124c78e>
 *   </tool_calls:6124c78e>
 * Closing tags and the outer wrapper are optional on truncated streams.
 * Name may sit on the same line as the opener or the next line; args are a
 * balanced JSON object (bare args, not necessarily {"name","args"} wrapper).
 */
const ID_TOOL_CALL_RE =
  /<tool_call:([A-Za-z0-9_-]+)>\s*([\w.-]+)\s*/gi;

/**
 * Boundaries that end one id-tagged block. Argument JSON must be found before
 * the first of these, so a block whose own JSON is missing or truncated can
 * Never adopt the arguments of a LATER block: a `fs.delete` opener
 * must not pair with the next call's `{"path":...}`.
 */
const ID_BLOCK_BOUNDARY_RES: RegExp[] = [
  /<\/tool_call\b/i,
  /<\/tool_calls\b/i,
  /<tool_call:/i,
  /<tool_call>/i,
  /<tool_calls:/i,
  /<\|tool_call_begin\|>/i,
  /<\|tool_calls_section_end\|>/i,
];

function boundIdTaggedBlock(after: string): {
  body: string;
  terminated: boolean;
} {
  let end = -1;
  for (const re of ID_BLOCK_BOUNDARY_RES) {
    const match = re.exec(after);
    if (match && (end < 0 || match.index < end)) end = match.index;
  }
  return end < 0
    ? { body: after, terminated: false }
    : { body: after.slice(0, end), terminated: true };
}

export function parseIdTaggedToolCall(text: string): ToolCall | undefined {
  const match = /<tool_call:([A-Za-z0-9_-]+)>\s*([\w.-]+)\s*/i.exec(text);
  if (!match) return undefined;
  const name = match[2]!;
  const block = boundIdTaggedBlock(
    text.slice(match.index + match[0].length),
  );
  const json = extractBalancedJson(block.body);
  if (json) {
    const parsed = tryJson(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      // Full {"name","args"} form inside the block.
      if (typeof obj.name === "string" && obj.args && typeof obj.args === "object") {
        return tryParseCall(json);
      }
      // Bare args object: {"query":"…"}
      return { name, args: obj };
    }
    return undefined;
  }
  // An unbalanced/undecodable `{` inside this block means the arguments are
  // truncated. Never fall through to an empty-args call — that would run a
  // mutating tool with a different meaning than the model intended.
  if (block.body.includes("{")) return undefined;
  // Still-open block: the argument JSON (or the rest of the tool name) has not
  // streamed in yet. Reporting an empty-args call here is what froze live tool
  // cards with a blank input, and a half-arrived name would be assembled into
  // a shell command. Only a closed block is a real zero-argument call.
  if (!block.terminated) return undefined;
  return { name, args: {} };
}

export function parseAllIdTaggedToolCalls(
  text: string,
): Array<{ index: number; call: ToolCall }> {
  const found: Array<{ index: number; call: ToolCall }> = [];
  const re = new RegExp(ID_TOOL_CALL_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const slice = text.slice(m.index);
    const call = parseIdTaggedToolCall(slice);
    if (call) found.push({ index: m.index, call });
  }
  return found;
}

export function tryJson(raw: string): Record<string, unknown> | undefined {
  try {
    const preprocessed = preprocessJson(raw);
    const parsed = JSON.parse(preprocessed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return undefined;
}
