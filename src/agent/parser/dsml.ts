import type { ToolCall } from "../../types.js";
import { lenientJsonParse, tryParseCall } from "./xml-protocol.js";

// Shared DSML fragments: parsing, recovery and display stripping must agree on what counts as DSML.
const BAR = "[|\\uFF5C\\u2223\\u2502]";
const MARK = `${BAR}+\\s*DSML(?:\\s*${BAR}+|\\s+)\\s*`;

export const DSML_OPEN_SRC = `<\\s*${MARK}`;
export const DSML_CLOSE_SRC = `<\\s*(?:\\/\\s*${MARK}|${MARK}\\/\\s*)`;
export const DSML_ANY_SRC = `<\\s*\\/?\\s*${BAR}+\\s*DSML`;

export const DSML_CONTAINER = "(?:tool_calls|function_calls|tool_uses|calls)";
export const DSML_INVOKE = "(?:invoke|tool_call|function_call|tool_use|call)";
export const DSML_PARAMETER = "(?:parameter|param|argument|arg)";

export const DSML_CONTAINER_OPEN_SRC = `${DSML_OPEN_SRC}${DSML_CONTAINER}\\b[^>]*>?`;
export const DSML_CONTAINER_CLOSE_SRC = `${DSML_CLOSE_SRC}${DSML_CONTAINER}\\b\\s*>?`;
export const DSML_INVOKE_OPEN_SRC = `${DSML_OPEN_SRC}${DSML_INVOKE}\\b`;
export const DSML_INVOKE_CLOSE_SRC = `${DSML_CLOSE_SRC}${DSML_INVOKE}\\b\\s*>?`;
export const DSML_PARAMETER_OPEN_SRC = `${DSML_OPEN_SRC}${DSML_PARAMETER}\\b`;
export const DSML_PARAMETER_CLOSE_SRC = `${DSML_CLOSE_SRC}${DSML_PARAMETER}\\b\\s*>?`;

export const DSML_ANY_RE = new RegExp(DSML_ANY_SRC, "i");

export const DSML_CONTAINER_BLOCK_RE = new RegExp(
  `${DSML_CONTAINER_OPEN_SRC}[\\s\\S]*?(?:${DSML_CONTAINER_CLOSE_SRC}|$)`,
  "gi",
);
export const DSML_INVOKE_BLOCK_RE = new RegExp(
  `${DSML_INVOKE_OPEN_SRC}[^>]*>?[\\s\\S]*?(?:${DSML_INVOKE_CLOSE_SRC}|$)`,
  "gi",
);
export const DSML_PARAMETER_BLOCK_RE = new RegExp(
  `${DSML_PARAMETER_OPEN_SRC}[^>]*>?[\\s\\S]*?(?:${DSML_PARAMETER_CLOSE_SRC}|$)`,
  "gi",
);
export const DSML_COMPLETE_CONTAINER_SRC =
  `${DSML_OPEN_SRC}${DSML_CONTAINER}\\b[^>]*>[\\s\\S]*?${DSML_CLOSE_SRC}${DSML_CONTAINER}\\s*>`;
export const DSML_COMPLETE_INVOKE_SRC =
  `${DSML_INVOKE_OPEN_SRC}[^>]*>[\\s\\S]*?${DSML_CLOSE_SRC}${DSML_INVOKE}\\s*>`;
export const DSML_COMPLETE_PARAMETER_SRC =
  `${DSML_PARAMETER_OPEN_SRC}[^>]*>[\\s\\S]*?${DSML_CLOSE_SRC}${DSML_PARAMETER}\\s*>`;
export const DSML_TRAILING_RE = new RegExp(`<\\s*${BAR}+\\s*DSML[\\s\\S]*$`, "i");
export const DSML_STRAY_TAG_RE = new RegExp(
  `<\\s*\\/?\\s*${BAR}+\\s*DSML(?:\\s*${BAR}+)?\\s*\\/?\\s*[A-Za-z0-9_]*(?:\\s[^<>]*)?>?`,
  "gi",
);
export const DSML_PARTIAL_TAIL_RE = new RegExp(
  `<\\s*\\/?\\s*${BAR}+[\\s${BAR.slice(1, -1)}A-Za-z0-9_▁]*$`,
  "i",
);

const INVOKE_END_RES: RegExp[] = [
  new RegExp(DSML_INVOKE_CLOSE_SRC, "i"),
  new RegExp(DSML_INVOKE_OPEN_SRC, "i"),
  new RegExp(`${DSML_CLOSE_SRC}${DSML_CONTAINER}\\b`, "i"),
  new RegExp(`${DSML_OPEN_SRC}${DSML_CONTAINER}\\b`, "i"),
];

const PARAMETER_END_RES: RegExp[] = [
  new RegExp(DSML_PARAMETER_CLOSE_SRC, "i"),
  new RegExp(DSML_PARAMETER_OPEN_SRC, "i"),
];

interface Bounded {
  readonly body: string;
  readonly terminated: boolean;
  readonly closerLength: number;
}

function boundBlock(after: string, boundaries: RegExp[]): Bounded {
  let end = -1;
  let closerLength = 0;
  boundaries.forEach((re, i) => {
    const match = re.exec(after);
    if (match && (end < 0 || match.index < end)) {
      end = match.index;
      closerLength = i === 0 ? match[0].length : 0;
    }
  });
  return end < 0
    ? { body: after, terminated: false, closerLength: 0 }
    : { body: after.slice(0, end), terminated: true, closerLength };
}

export function dsmlAttribute(attrs: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>/]+))`,
    "i",
  ).exec(attrs);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function decodeCodePoint(raw: string, radix: number, original: string): string {
  const value = Number.parseInt(raw, radix);
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : original;
}

export function decodeDsmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (original: string, hex: string) => decodeCodePoint(hex, 16, original))
    .replace(/&#(\d+);/g, (original: string, decimal: string) => decodeCodePoint(decimal, 10, original))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

interface ParsedTag {
  readonly attrs: Record<string, string>;
  readonly end: number;
  readonly selfClosing: boolean;
  readonly wellFormed: boolean;
}

const ATTRIBUTE_RE = /\s*([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>/]+))/y;
const TAG_END_RE = /\s*(\/)?\s*>/y;

function readTag(text: string, from: number): ParsedTag {
  const attrs: Record<string, string> = {};
  let pos = from;
  for (;;) {
    ATTRIBUTE_RE.lastIndex = pos;
    const attr = ATTRIBUTE_RE.exec(text);
    if (!attr) break;
    attrs[attr[1]!.toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? "";
    pos = ATTRIBUTE_RE.lastIndex;
  }
  TAG_END_RE.lastIndex = pos;
  const close = TAG_END_RE.exec(text);
  if (!close) return { attrs, end: pos, selfClosing: false, wellFormed: false };
  return { attrs, end: TAG_END_RE.lastIndex, selfClosing: Boolean(close[1]), wellFormed: true };
}

function typedValue(attrs: Record<string, string>, raw: string): unknown {
  const value = decodeDsmlText(raw.trim());
  const type = attrs.type?.toLowerCase();
  if (attrs.string?.toLowerCase() === "true" || type === "string") return value;
  if (attrs.boolean?.toLowerCase() === "true" || type === "boolean" || type === "bool") {
    return value.toLowerCase() === "true";
  }
  if (attrs.number?.toLowerCase() === "true" || type === "number" || type === "integer") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  const parsed = lenientJsonParse(value);
  return parsed === undefined ? value : parsed;
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  const parsed = lenientJsonParse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

// Undefined means unrecoverable, so the caller asks the model to retry instead of guessing args.
function recoverMalformedParameter(region: string): Record<string, unknown> | undefined {
  const raw = region.trim().replace(/\s*>\s*$/, "");
  if (!raw) return undefined;
  if (raw.startsWith("{")) return parseObject(raw);
  const rest = raw.replace(/^(?:name|key)\s*=\s*/i, "");
  if (rest === raw) return undefined;
  if (/^["'][^"'\n]+["']\s*:/.test(rest)) {
    const body = rest.replace(/[\s>]+$/, "");
    return parseObject(`{${body}${body.endsWith("}") ? "" : "}"}`);
  }
  const keyed = /^["']([^"'\n]+)["']\s*(?:[>=]\s*)?([\s\S]*)$/.exec(rest);
  if (!keyed) return undefined;
  const value = keyed[2]!.trim();
  if (!value) return undefined;
  const unquoted = /^"([\s\S]*)"$/.exec(value)?.[1] ?? /^'([\s\S]*)'$/.exec(value)?.[1];
  return { [keyed[1]!.trim()]: unquoted !== undefined ? decodeDsmlText(unquoted) : typedValue({}, value) };
}

function parseInvokeArgs(body: string): { args: Record<string, unknown>; name?: string } | undefined {
  const args: Record<string, unknown> = {};
  const parameterRe = new RegExp(DSML_PARAMETER_OPEN_SRC, "gi");
  let sawParameter = false;
  let parameter: RegExpExecArray | null;
  while ((parameter = parameterRe.exec(body)) !== null) {
    sawParameter = true;
    const afterKeyword = parameter.index + parameter[0].length;
    const tag = readTag(body, afterKeyword);
    const key = (tag.attrs.name ?? tag.attrs.key)?.trim();
    if (tag.wellFormed) {
      if (tag.selfClosing) {
        if (key && tag.attrs.value !== undefined) args[key] = typedValue(tag.attrs, tag.attrs.value);
        parameterRe.lastIndex = tag.end;
        continue;
      }
      // The invoke is already bounded, so the end of its body also ends the last parameter.
      const value = boundBlock(body.slice(tag.end), PARAMETER_END_RES);
      if (key) {
        args[key] = typedValue(tag.attrs, value.body);
      } else {
        const recovered = parseObject(decodeDsmlText(value.body.trim()));
        if (!recovered) return undefined;
        Object.assign(args, recovered);
      }
      parameterRe.lastIndex = tag.end + value.body.length + value.closerLength;
      continue;
    }
    const region = boundBlock(body.slice(afterKeyword), PARAMETER_END_RES);
    const recovered = recoverMalformedParameter(region.body);
    if (!recovered) return undefined;
    Object.assign(args, recovered);
    parameterRe.lastIndex = afterKeyword + region.body.length + region.closerLength;
  }
  if (sawParameter) return { args };
  const trimmed = decodeDsmlText(body.trim());
  if (!trimmed) return { args };
  if (!trimmed.startsWith("{")) {
    // Prose or stray markup inside an invoke: no arguments were supplied.
    return /[{}]/.test(trimmed) ? undefined : { args };
  }
  const obj = parseObject(trimmed);
  if (!obj) return undefined;
  if (typeof obj.name === "string") {
    const call = tryParseCall(trimmed);
    if (call) return { args: call.args, name: call.name };
  }
  return { args: obj };
}

export function parseAllDsmlToolCalls(text: string): Array<{ index: number; call: ToolCall }> {
  const found: Array<{ index: number; call: ToolCall }> = [];
  if (!DSML_ANY_RE.test(text)) return found;
  const invokeRe = new RegExp(DSML_INVOKE_OPEN_SRC, "gi");
  let invoke: RegExpExecArray | null;
  while ((invoke = invokeRe.exec(text)) !== null) {
    const afterKeyword = invoke.index + invoke[0].length;
    let tag = readTag(text, afterKeyword);
    let name = (tag.attrs.name ?? tag.attrs.tool ?? tag.attrs.function)?.trim();
    if (!tag.wellFormed) {
      const loose = /^([^>]*)>/.exec(text.slice(afterKeyword));
      if (!loose) continue;
      const attrs = loose[1]!;
      name ??= dsmlAttribute(attrs, "name")?.trim() ?? /^\s*([A-Za-z][\w.-]*)\s*$/.exec(attrs)?.[1];
      tag = { attrs: tag.attrs, end: afterKeyword + loose[0].length, selfClosing: /\/\s*$/.test(attrs), wellFormed: false };
    }
    let body: Bounded;
    if (tag.selfClosing) {
      body = { body: "", terminated: true, closerLength: 0 };
    } else {
      body = boundBlock(text.slice(tag.end), INVOKE_END_RES);
      // Unterminated means the stream was cut off: never execute a partial call.
      if (!body.terminated) continue;
    }
    const parsed = parseInvokeArgs(body.body);
    if (!parsed) continue;
    const finalName = (name ?? parsed.name)?.replace(/^functions\./, "").trim();
    if (!finalName) continue;
    found.push({ index: invoke.index, call: { name: finalName, args: parsed.args } });
  }
  return found;
}

export function parseDsmlToolCall(text: string): ToolCall | undefined {
  return parseAllDsmlToolCalls(text)[0]?.call;
}
