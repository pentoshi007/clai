import type { ToolCall } from "../../types.js";
import { fromWireName } from "../../llm/tool-protocol.js";
import { extractBalancedJson, lenientJsonParse, preprocessJson, tryParseCall } from "./xml-protocol.js";
import { decodeDsmlText, dsmlAttribute, parseAllDsmlToolCalls, parseDsmlToolCall } from "./dsml.js";

export { parseAllDsmlToolCalls, parseDsmlToolCall };

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

const ID_TOOL_CALL_RE =
  /<tool_call:([A-Za-z0-9_-]+)>\s*([\w.-]+)\s*/gi;

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
      if (typeof obj.name === "string" && obj.args && typeof obj.args === "object") {
        return tryParseCall(json);
      }
      return { name, args: obj };
    }
    return undefined;
  }
  if (block.body.includes("{")) return undefined;
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
  }
  return undefined;
}

export const BRACKETED_TOOL_CALL_RE =
  /\[(?:tool[ _]?call|toolcall|tool)\s*[:=]\s*["']?([A-Za-z][\w.]*?)["']?\]/gi;

const BRACKETED_BLOCK_BOUNDARIES: RegExp[] = [
  /\[(?:tool[ _]?call|toolcall|tool)\s*[:=]/i,
  /```tool/i,
  /<tool_call/i,
  /<\|tool_call/i,
  /<\s*[|｜]+(?:tool[_▁]|open[|｜]|\s*DSML)/i,
];

function boundBracketedBlock(after: string): string {
  let end = after.length;
  for (const re of BRACKETED_BLOCK_BOUNDARIES) {
    const match = re.exec(after);
    if (match && match.index < end) end = match.index;
  }
  return after.slice(0, end);
}

function resolveBracketedToolName(raw: string): string {
  const stripped = raw.replace(/^functions\./, "");
  const canonical = fromWireName(stripped);
  if (canonical) return canonical;
  if (stripped.includes(".")) return stripped;
  return stripped.replace(/_/g, ".");
}

export function parseAllBracketedToolCalls(
  text: string,
): Array<{ index: number; call: ToolCall }> {
  const found: Array<{ index: number; call: ToolCall }> = [];
  const re = new RegExp(BRACKETED_TOOL_CALL_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = resolveBracketedToolName(m[1]!);
    const section = boundBracketedBlock(text.slice(m.index + m[0].length));
    const json = extractBalancedJson(section);
    if (json) {
      const parsed = tryJson(json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (typeof parsed.name === "string" && parsed.args && typeof parsed.args === "object") {
          const call = tryParseCall(json);
          if (call) found.push({ index: m.index, call });
        } else {
          found.push({ index: m.index, call: { name, args: parsed } });
        }
      }
    } else if (!section.includes("{")) {
      found.push({ index: m.index, call: { name, args: {} } });
    }
  }
  return found;
}

export function parseBracketedToolCall(text: string): ToolCall | undefined {
  return parseAllBracketedToolCalls(text)[0]?.call;
}

export const TO_CODE_TOOL_CALL_RE =
  /(?:^|\s)to\s*=\s*["']?(?:functions\.)?([A-Za-z][\w.]*?)["']?\s+code\s*:\s*/gi;

const TO_CODE_BLOCK_BOUNDARIES: RegExp[] = [
  /(?:^|\s)to\s*=\s*["']?(?:functions\.)?[A-Za-z][\w.]*?["']?\s+code\s*:/i,
  /\[(?:tool[ _]?call|toolcall|tool)\s*[:=]/i,
  /```tool/i,
  /<tool_call/i,
  /<\|tool_call/i,
  /<\s*[|｜]+(?:tool[_▁]|open[|｜]|\s*DSML)/i,
];

function boundToCodeBlock(after: string): string {
  let end = after.length;
  for (const re of TO_CODE_BLOCK_BOUNDARIES) {
    const match = re.exec(after);
    if (match && match.index < end) end = match.index;
  }
  return after.slice(0, end);
}

export function parseAllToCodeToolCalls(
  text: string,
): Array<{ index: number; call: ToolCall }> {
  const found: Array<{ index: number; call: ToolCall }> = [];
  const re = new RegExp(TO_CODE_TOOL_CALL_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = resolveBracketedToolName(m[1]!);
    const section = boundToCodeBlock(text.slice(m.index + m[0].length));
    const json = extractBalancedJson(section);
    if (json) {
      const parsed = tryJson(json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (typeof parsed.name === "string" && parsed.args && typeof parsed.args === "object") {
          const call = tryParseCall(json);
          if (call) found.push({ index: m.index, call });
        } else {
          found.push({ index: m.index, call: { name, args: parsed } });
        }
      }
    } else if (!section.includes("{")) {
      found.push({ index: m.index, call: { name, args: {} } });
    }
  }
  return found;
}

export function parseToCodeToolCall(text: string): ToolCall | undefined {
  return parseAllToCodeToolCalls(text)[0]?.call;
}
