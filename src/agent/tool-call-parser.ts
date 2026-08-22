/**
 * Pure parsing and classification for model output: recovering tool calls
 * from the many shapes different models emit (fenced JSON, XML wrappers,
 * Kimi sentinel tokens, bare args objects), and text-pattern classifiers
 * (build/pentest task detection, narration detection) used
 * to steer the agent loop. Nothing here touches process state, the file
 * system, or any store — nothing here executes a tool call, either.
 */
import type { ChatMessage, ToolCall } from "../types.js";
import { isCompactionMemoryMessage } from "./context-manager.js";
import { isResponderResultLedgerMessage } from "./responder-context.js";
import { safeCwd } from "../os/cwd.js";

export function preprocessJson(raw: string): string {
  let inString = false;
  let escaped = false;
  let result = "";
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === '"' && !escaped) {
      inString = !inString;
      result += char;
    } else if (inString) {
      if (char === "\n") {
        result += "\\n";
      } else if (char === "\r") {
        result += "\\r";
      } else if (char === "\t") {
        result += "\\t";
      } else {
        result += char;
      }
    } else {
      if (char === "," && i + 1 < raw.length) {
        let nextNonWs = "";
        for (let j = i + 1; j < raw.length; j++) {
          if (!/\s/.test(raw[j]!)) {
            nextNonWs = raw[j]!;
            break;
          }
        }
        if (nextNonWs === "}" || nextNonWs === "]") {
          continue;
        }
      }
      result += char;
    }
    if (char === "\\" && inString) {
      escaped = !escaped;
    } else {
      escaped = false;
    }
  }
  return result;
}

/**
 * Last-resort lenient repair for tool-call JSON that strict JSON.parse
 * rejected. Models frequently emit "almost JSON": smart/curly quotes from a
 * copy-paste, Python-style True/False/None literals, or an object that is
 * wholly single-quoted. We only apply these transforms when a strict parse
 * has already failed, so well-formed JSON is never touched.
 */
function repairMixedQuotes(text: string): string {
  let inString: false | "double" | "single" = false;
  let escaped = false;
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString === "double") {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === "\\") {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else {
        out += ch;
      }
    } else if (inString === "single") {
      if (escaped) {
        if (ch === "'") {
          out += "'";
        } else {
          out += "\\" + ch;
        }
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "'") {
        out += '"';
        inString = false;
      } else if (ch === '"') {
        out += '\\"';
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') {
        out += ch;
        inString = "double";
      } else if (ch === "'") {
        out += '"';
        inString = "single";
      } else {
        out += ch;
      }
    }
  }
  return out;
}

function lenientJsonParse(text: string): unknown | undefined {
  const candidates: string[] = [];
  // 1. Normalize unicode/smart quotes to ASCII quotes.
  const deSmart = text
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'");
  candidates.push(deSmart);
  // 2. Python/JS literals → JSON literals (outside of double-quoted strings).
  candidates.push(replaceOutsideStrings(deSmart));
  // 3. Mixed quotes repair (convert '...' strings to "..." strings)
  const mixedRepaired = repairMixedQuotes(deSmart);
  candidates.push(mixedRepaired);
  candidates.push(replaceOutsideStrings(mixedRepaired));
  // 4. Single-quoted object → double-quoted (only when there are no double
  //    quotes already, so we don't corrupt strings that contain apostrophes).
  if (!deSmart.includes('"') && deSmart.includes("'")) {
    candidates.push(deSmart.replace(/'/g, '"'));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(preprocessJson(candidate).trim());
    } catch {
      // try the next repair
    }
  }
  return undefined;
}

/** Replace bare Python/JS literals (True/False/None/NaN) with JSON equivalents,
 *  skipping anything inside a double-quoted string. */
function replaceOutsideStrings(text: string): string {
  let inString = false;
  let escaped = false;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    const rest = text.slice(i);
    const m = /^(True|False|None|NaN|undefined)\b/.exec(rest);
    if (m) {
      const word = m[1]!;
      out +=
        word === "True"
          ? "true"
          : word === "False"
            ? "false"
            : word === "NaN"
              ? "0"
              : "null"; // None / undefined
      i += word.length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function tryParseCall(raw: string): ToolCall | undefined {
  let parsed: (Partial<ToolCall> & { arguments?: unknown }) | undefined;
  try {
    parsed = JSON.parse(preprocessJson(raw).trim()) as Partial<ToolCall> & {
      arguments?: unknown;
    };
  } catch {
    // Strict parse failed — try lenient repairs before giving up so a model
    // that emits smart quotes / single quotes / Python literals still works.
    const repaired = lenientJsonParse(raw.trim());
    if (repaired && typeof repaired === "object" && !Array.isArray(repaired)) {
      parsed = repaired as Partial<ToolCall> & { arguments?: unknown };
    }
  }
  if (!parsed) return undefined;
  const anyParsed = parsed as Record<string, unknown>;
  // Accept name under several keys models commonly use.
  const nameRaw =
    typeof parsed.name === "string"
      ? parsed.name
      : typeof anyParsed.tool_name === "string"
        ? (anyParsed.tool_name as string)
        : undefined;
  if (typeof nameRaw === "string" && nameRaw.length > 0) {
    // Strip a leading "functions." namespace some models add.
    const name = nameRaw.replace(/^functions\./, "");
    // Many OpenAI/Hermes/Qwen-trained models emit {"name","arguments"}
    // (or "parameters"/"input") instead of {"name","args"} — accept any.
    const argsSrc =
      pickObject(parsed.args) ??
      pickObject(parsed.arguments) ??
      pickObject(anyParsed.parameters) ??
      pickObject(anyParsed.input);
    if (argsSrc) {
      return { name, args: argsSrc };
    }
    // Allow an empty args object explicitly written as {} or null (common for
    // sysinfo), but do NOT invent args for objects that merely happen to
    // contain a "name" key (e.g. {"name":"shell.exec"} with no command).
    if (parsed.args === null || parsed.arguments === null) {
      return { name, args: {} };
    }
    // Flattened form: the args are emitted as SIBLINGS of `name` rather than
    // nested (e.g. {"name":"web.fetch","url":"…","responseMode":"raw"}). Treat
    // the non-reserved keys as args, but only when at least one is a known
    // tool-arg key so plain data objects carrying a `name` are not misread.
    const flat: Record<string, unknown> = {};
    for (const key of Object.keys(anyParsed)) {
      if (!FLATTENED_RESERVED_KEYS.has(key)) flat[key] = anyParsed[key];
    }
    const flatKeys = Object.keys(flat);
    if (flatKeys.length > 0 && flatKeys.some((k) => TOOL_ARG_KEYS.has(k))) {
      return { name, args: flat };
    }
  }
  return undefined;
}

// Keys that name the tool or wrap its arguments — excluded when recovering a
// flattened tool call whose args sit alongside `name`.
const FLATTENED_RESERVED_KEYS = new Set([
  "name",
  "tool_name",
  "args",
  "arguments",
  "parameters",
  "input",
]);

function pickObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Kimi K2 / Moonshot models on NVIDIA NIM emit tool calls using a
// sentinel-token format that looks like:
//   <|tool_calls_section_begin|>
//     <|tool_call_begin|>functions.shell.exec:0<|tool_call_argument_begin|>
//     {"command":"ls"}
//     <|tool_call_end|>
//   <|tool_calls_section_end|>
// The `functions.` prefix is optional, the trailing `:N` index is optional,
// and the surrounding section markers may be absent on truncated streams.
const KIMI_TOOL_CALL_RE =
  /<\|tool_call_begin\|>\s*(?:functions\.)?([A-Za-z][\w.]*?)(?::\d+)?\s*<\|tool_call_argument_begin\|>\s*(\{[\s\S]*?\})\s*<\|tool_call_end\|>/i;

function parseKimiToolCall(text: string): ToolCall | undefined {
  const match = text.match(KIMI_TOOL_CALL_RE);
  if (!match) return undefined;
  const name = match[1]!;
  return tryParseCall(JSON.stringify({ name, args: tryJson(match[2]!) ?? {} }));
}

const DEEPSEEK_TOOL_CALL_RE =
  /<[|｜]+tool[_▁]call[_▁]begin[|｜]+>\s*(?:[A-Za-z]+\s*)?<[|｜]+tool[_▁]sep[|｜]+>\s*(?:functions\.)?([A-Za-z][\w.]*?)(?::\d+)?\s*(?:\n|\s)*(?:```(?:json)?\s*)?(\{[\s\S]*?\})\s*(?:```)?\s*(?:<[|｜]+tool[_▁]call[_▁]end[|｜]+>|$)/i;

function parseDeepseekToolCall(text: string): ToolCall | undefined {
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

function parseAllDsmlToolCalls(text: string): Array<{ index: number; call: ToolCall }> {
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

function parseDsmlToolCall(text: string): ToolCall | undefined {
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

function parseAllOpenSepToolCalls(
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

function parseOpenSepToolCall(text: string): ToolCall | undefined {
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

function parseIdTaggedToolCall(text: string): ToolCall | undefined {
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

function parseAllIdTaggedToolCalls(
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

// Recognized XML-ish tool-call wrappers some models emit (with or without a
// matching close tag). Used so we can recover a call even when the model
// forgot the closing tag, while plain prose never matches.
const XML_BLOCK_OPENERS = /<tool_call>|<function_calls>|<invoke>|<ant:invoke>/i;

/**
 * Scan `text` starting at the index of the first `{`, returning the balanced
 * JSON substring (respecting strings) or undefined if braces never balance.
 * Lets us recover a tool-call JSON object the model emitted without a closing
 * wrapper tag, where a non-greedy regex would stop at the first inner brace.
 */
function extractBalancedJson(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function parseXmlToolCall(text: string): ToolCall | undefined {
  // Pattern 1d (GLM arg_key / arg_value format):
  // <tool_call>tool.name<arg_key>key</arg_key><arg_value>value</arg_value></tool_call>
  const glmMatch = text.match(/<tool_call>\s*([\w.-]+)\s*([\s\S]*?)(?:<\/tool_call>|$)/i);
  if (glmMatch && glmMatch[1] !== undefined && glmMatch[2] !== undefined) {
    const toolName = glmMatch[1];
    const rest = glmMatch[2].trim();
    if (rest.includes("<arg_key>") && rest.includes("<arg_value>")) {
      const args: Record<string, unknown> = {};
      const keyValRegex = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
      let match;
      let hasArgs = false;
      while ((match = keyValRegex.exec(rest)) !== null) {
        const key = match[1];
        const rawVal = match[2];
        if (key === undefined || rawVal === undefined) continue;
        const keyTrimmed = key.trim();
        const rawValTrimmed = rawVal.trim();
        let val: any = rawValTrimmed;
        try {
          val = JSON.parse(preprocessJson(rawValTrimmed));
        } catch {
          // Keep as string
        }
        args[keyTrimmed] = val;
        hasArgs = true;
      }
      if (hasArgs) {
        return { name: toolName, args };
      }
    } else if (rest === "") {
      return { name: toolName, args: {} };
    }
  }

  // Pattern 1 (name + args/arguments/parameters JSON):
  //  <tool_call>
  // <name>tool.name</name>
  // <args>{...}</args>   (or <arguments> / <parameters>)
  //  <tool_call>
  const xmlNameArgs = text.match(
    /<tool_call>[\s\S]*?<name>\s*([\w.]+?)\s*<\/name>\s*<(?:args|arguments|parameters)>\s*(\{[\s\S]*?\})\s*<\/(?:args|arguments|parameters)>[\s\S]*?<\/tool_call>/i,
  );
  if (xmlNameArgs?.[1] && xmlNameArgs?.[2]) {
    try {
      const args = JSON.parse(preprocessJson(xmlNameArgs[2]));
      return {
        name: xmlNameArgs[1],
        args: args as Record<string, unknown>,
      };
    } catch {}
  }

  // Pattern 1b (MiMo alternative):
  //  <tool_call>
  // <tool_name>tool.name</tool_name>
  // <parameters>{...}</parameters>   (or <arguments> / <args>)
  //  <tool_call>
  const xmlToolNameParams = text.match(
    /<tool_call>[\s\S]*?<tool_name>\s*([\w.]+?)\s*<\/tool_name>\s*<(?:parameters|arguments|args)>\s*(\{[\s\S]*?\})\s*<\/(?:parameters|arguments|args)>[\s\S]*?<\/tool_call>/i,
  );
  if (xmlToolNameParams?.[1] && xmlToolNameParams?.[2]) {
    try {
      const args = JSON.parse(preprocessJson(xmlToolNameParams[2]));
      return {
        name: xmlToolNameParams[1],
        args: args as Record<string, unknown>,
      };
    } catch {}
  }

  // Pattern 1c (MiMo function/parameter format), with or WITHOUT a
  // surrounding <tool_call> wrapper (some models emit the bare function block):
  // <function=tool.name>
  // <parameter=name>value</parameter>
  // </function>
  const xmlFunctionBlock = text.match(
    /<function=([\w.]+?)>([\s\S]*?)<\/function>/i,
  );
  if (xmlFunctionBlock?.[1] && xmlFunctionBlock?.[2]) {
    const name = xmlFunctionBlock[1];
    const inner = xmlFunctionBlock[2];
    const args: Record<string, unknown> = {};
    const paramRegex = /<parameter=([\w.]+?)>([\s\S]*?)<\/parameter>/gi;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(inner)) !== null) {
      const paramName = paramMatch[1]!;
      const paramValueStr = paramMatch[2]!.trim();
      let paramValue: any = paramValueStr;
      try {
        if (/^(?:\[|\{|true|false|null|\d+(\.\d+)?$)/i.test(paramValueStr)) {
          paramValue = JSON.parse(preprocessJson(paramValueStr));
        }
      } catch {}
      args[paramName] = paramValue;
    }
    return { name, args };
  }

  // Pattern 2: JSON object inside a recognized wrapper (closed). The wrapper
  // may be the tool_call sentinel, <function_calls>, or <invoke>/<ant:invoke>.
  // Backtracking off the closing tag handles nested {} in the args.
  const wrappers = [
    "<tool_call>",
    "<function_calls>",
    "<invoke>",
    "<ant:invoke>",
  ];
  for (const open of wrappers) {
    const close =
      open === "<function_calls>"
        ? "</function_calls>"
        : open === "<invoke>"
          ? "</invoke>"
          : open === "<ant:invoke>"
            ? "</ant:invoke>"
            : "</tool_call>";
    const re = new RegExp(
      open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "[\\s\\S]*?(?:<tool>)?\\s*(\\{[\\s\\S]*?\\})\\s*" +
        close.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );
    const match = text.match(re);
    if (match?.[1]) {
      const call = tryParseCall(match[1]);
      if (call) return call;
    }
  }

  // Pattern 3: a recognized opener is present but there is no matching close
  // (model forgot it, or the stream was cut). Use a balanced brace scan from
  // the first `{` after the opener so nested args survive, then try to parse.
  const openerMatch = XML_BLOCK_OPENERS.exec(text);
  if (openerMatch) {
    const after = text.slice(openerMatch.index + openerMatch[0].length);
    const json = extractBalancedJson(after);
    if (json) {
      const call = tryParseCall(json);
      if (call) return call;
    }
    // Also try the <name>...</name><arguments>{...}</arguments> tag shape
    // without a closing wrapper (Hermes/Qwen often omit it).
    const tagShape = after.match(
      /<name>\s*([\w.]+?)\s*<\/name>\s*<(?:args|arguments|parameters)>\s*(\{[\s\S]*?\})\s*<\/(?:args|arguments|parameters)>/i,
    );
    if (tagShape?.[1] && tagShape?.[2]) {
      try {
        const args = JSON.parse(preprocessJson(tagShape[2]));
        return { name: tagShape[1], args: args as Record<string, unknown> };
      } catch {}
    }
  }

  return undefined;
}

function tryJson(raw: string): Record<string, unknown> | undefined {
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

const STRAY_DSML_TAG_RE = /<\/?[|｜]+DSML[|｜]+[A-Za-z0-9_]*\b[^>]*>/gi;

/** Strip any leftover Kimi/Moonshot sentinel tokens from final answers
 *  so a model that mixes prose and tool-call markers never bleeds raw
 *  `<|tool_call_begin|>` strings to the terminal. */
export function stripSentinelTokens(text: string): string {
  return text
    .replace(
      /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/gi,
      "",
    )
    .replace(/<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/gi, "")
    .replace(/<\|tool_calls?(?:_section)?_(?:begin|end)\|>/gi, "")
    .replace(/<\|tool_call_argument_begin\|>/gi, "")
    .replace(/<\|tool_[a-z_]*\|>/gi, "")
    .replace(
      /<[|｜]+tool[_▁]calls[_▁]begin[|｜]+>[\s\S]*?(?:<[|｜]+tool[_▁]calls[_▁]end[|｜]+>|$)/gi,
      "",
    )
    .replace(
      /<[|｜]+tool[_▁]call[_▁]begin[|｜]+>[\s\S]*?(?:<[|｜]+tool[_▁]call[_▁]end[|｜]+>|$)/gi,
      "",
    )
    .replace(/<[|｜]+tool[_▁](?:calls?[_▁](?:begin|end)|sep)[|｜]+>/gi, "")
    // GLM/Tencent id-tagged blocks (and bare openers left after a partial strip).
    .replace(/<tool_calls:[A-Za-z0-9_-]+>[\s\S]*?(?:<\/tool_calls:[A-Za-z0-9_-]+>|$)/gi, "")
    .replace(/<tool_call:[A-Za-z0-9_-]+>[\s\S]*?(?:<\/tool_call:[A-Za-z0-9_-]+>|$)/gi, "")
    .replace(/<\/?tool_calls?:[A-Za-z0-9_-]+>/gi, "")
    .replace(/<[|｜]+DSML[|｜]+tool_calls\b[^>]*>[\s\S]*?(?:<\/[|｜]+DSML[|｜]+tool_calls>|$)/gi, "")
    .replace(/<[|｜]+DSML[|｜]+invoke\b[^>]*>[\s\S]*?(?:<\/[|｜]+DSML[|｜]+invoke>|$)/gi, "")
    .replace(/<[|｜]+DSML[|｜]+parameter\b[^>]*>[\s\S]*?(?:<\/[|｜]+DSML[|｜]+parameter>|$)/gi, "")
    .replace(STRAY_DSML_TAG_RE, "")
    .replace(/<[|｜]+open[|｜]+>?tools\b[\s\S]*?(?:<[|｜]+close[|｜]+>?tools\s*>?|$)/gi, "")
    .replace(/<[|｜]+(?:open|close)[|｜]+>?[A-Za-z][\w-]*[^>|<]*>?/gi, "")
    .replace(/<[|｜]+sep[|｜]+>/gi, "")
    .trim();
}

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

// Argument keys that the built-in tools accept. Used to recognize when a
// model emitted a bare args object (e.g. {"path":"file.pdf"}) — intending a
// tool call but forgetting the {"name","args"} wrapper and the ```tool fence.
const TOOL_ARG_KEYS = new Set([
  "command",
  "path",
  "paths",
  "url",
  "query",
  "target",
  "pattern",
  "tool",
  "tools",
  "files",
  "content",
  "calls",
  "record",
  "ports",
  "profile",
  "id",
  "lang",
  "dpi",
  "psm",
  "recursive",
  "oldText",
  "newText",
  "expectedReplacements",
  "goal",
  "tasks",
  "taskId",
  "notificationId",
  "jobId",
  "state",
  "method",
  "body",
  "headers",
  "maxBytes",
  "maxResults",
  "cwd",
  "name",
  "concurrency",
  "on_fail",
  "onFail",
  "fail_policy",
  "failPolicy",
  "id",
  "cancel_on_fail",
  "cancelOnFail",
  // Extra optional keys that commonly ride along with a bare args object so
  // it is still recognized (and its tool inferred) instead of leaking to the
  // screen — e.g. shell.exec with {"command":"…","timeoutMs":300000}.
  "timeoutMs",
  "flags",
  "iOwnThis",
  "own",
  "note",
  "kind",
  "detail",
  "maxEntries",
  "checkBinary",
  "scanType",
  "whois",
  "dns",
  "nmap",
  "bytes",
  "responseMode",
  "includeHeaders",
  "includeTls",
  "includeTiming",
  "includeRedirectChain",
  "redactSensitive",
]);

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
 * Attempt to extract usable content from a truncated fs.write / fs.append
 * tool call. When the model's output is cut off mid-JSON, the tool call fails
 * to parse — but typically a large chunk of the intended file content is
 * already present in the raw text. This function extracts:
 *   - operation: which mutation the model actually asked for
 *   - path: the target file path
 *   - content: the partial file content (up to the truncation point)
 *   - lastLine: the last complete line (for telling the model where to resume)
 *   - expectedPriorBytes: the append precondition when the model supplied one
 *
 * Returns undefined when the text does not look like an unambiguous single
 * write/append call. `fs.writeMany` is never salvaged: a truncated multi-file
 * payload cannot be attributed to one file safely.
 */
/**
 * Single-pass JSON string unescape for salvaged (possibly truncated) content.
 * Order matters: a chained `.replace` sequence turns the escaped Windows path
 * `C:\\new` into `C:` + newline + `ew`. Unknown escapes are kept verbatim, and
 * a trailing incomplete escape is dropped.
 */
function unescapeJsonStringPrefix(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    switch (next) {
      case "n":
        out += "\n";
        i += 1;
        break;
      case "r":
        out += "\r";
        i += 1;
        break;
      case "t":
        out += "\t";
        i += 1;
        break;
      case "b":
        out += "\b";
        i += 1;
        break;
      case "f":
        out += "\f";
        i += 1;
        break;
      case '"':
        out += '"';
        i += 1;
        break;
      case "/":
        out += "/";
        i += 1;
        break;
      case "\\":
        out += "\\";
        i += 1;
        break;
      case "u": {
        const hex = raw.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 5;
        } else {
          // Truncated \uXXXX at the cut point — drop it.
          i = raw.length;
        }
        break;
      }
      default:
        out += `\\${next}`;
        i += 1;
        break;
    }
  }
  return out;
}

export interface SalvagedWrite {
  operation: "write" | "append";
  path: string;
  content: string;
  lastLine: string;
  expectedPriorBytes?: number | undefined;
}

export function salvageTruncatedWrite(text: string): SalvagedWrite | undefined {
  // Match fs.write or fs.append: {"name":"fs.write","args":{"path":"...","content":"...
  // Also handle "fs.append" and cases where content comes before path.
  const toolNameMatch = text.match(
    /\{\s*"name"\s*:\s*"fs\.(write|append)"\s*,\s*"args"\s*:\s*\{/,
  );
  if (toolNameMatch) {
    const operation: "write" | "append" =
      toolNameMatch[1] === "append" ? "append" : "write";
    const argsStart = text.indexOf(toolNameMatch[0]) + toolNameMatch[0].length;
    const afterArgs = text.slice(argsStart);

    // Extract path value
    const pathMatch = afterArgs.match(/"path"\s*:\s*"([^"]+)"/);
    if (!pathMatch?.[1]) return undefined;
    const path = pathMatch[1];

    const priorMatch = afterArgs.match(
      /"expectedPriorBytes"\s*:\s*(\d{1,15})(?!\d)/,
    );
    const expectedPriorBytes = priorMatch?.[1]
      ? Number(priorMatch[1])
      : undefined;

    // Find where "content":" starts and extract everything after its opening quote
    const contentKeyMatch = afterArgs.match(/"content"\s*:\s*"/);
    if (!contentKeyMatch) return undefined;
    const contentStart = argsStart + afterArgs.indexOf(contentKeyMatch[0]) + contentKeyMatch[0].length;
    let raw = text.slice(contentStart);

    // The content is JSON-encoded (escaped). Unescape in one pass so a
    // literal backslash sequence is not re-interpreted.
    raw = raw.replace(/\\?$/, "");

    try {
      const unescaped = unescapeJsonStringPrefix(raw);

      // Trim to the last complete line
      const lastNewline = unescaped.lastIndexOf("\n");
      const content =
        lastNewline > 0 ? unescaped.slice(0, lastNewline + 1) : unescaped;

      if (content.trim().length < 50) return undefined; // Too little to salvage

      const lines = content.trimEnd().split("\n");
      const lastLine =
        lines[lines.length - 1]?.trim().slice(0, 80) ?? "(unknown)";

      return { operation, path, content, lastLine, expectedPriorBytes };
    } catch {
      return undefined;
    }
  }

  // fs.writeMany is intentionally NOT salvaged: a truncated multi-file payload
  // is ambiguous about which files were meant to be written, and guessing the
  // first entry can silently overwrite a different file than intended.
  return undefined;
}

const NATIVE_WRITE_TOOLS = new Set(["fs.write", "fs.append"]);

/**
 * Salvage partial file content from a native tool call's raw argument JSON
 * (streaming cut off / finish_reason length / _parseError). Reuses the
 * text-path salvage by reconstructing a minimal {"name","args"} shape.
 */
export function salvageTruncatedWriteFromNative(
  name: string,
  rawArguments: string | undefined,
): ReturnType<typeof salvageTruncatedWrite> {
  if (!NATIVE_WRITE_TOOLS.has(name) || !rawArguments?.trim()) return undefined;
  const raw = rawArguments.trim();
  // raw is usually the args object JSON only; wrap for salvageTruncatedWrite.
  const synthetic = raw.includes(`"name"`)
    ? raw
    : `{"name":${JSON.stringify(name)},"args":${raw.startsWith("{") ? raw : `{}`}`;
  return salvageTruncatedWrite(synthetic);
}

/**
 * Count the number of ```tool fenced blocks in a message. Models sometimes
 * emit MULTIPLE tool calls in one response (e.g. fs.writeMany + npm install +
 * npm run dev). Only the FIRST is parsed and executed; the rest are silently
 * dropped and leak to the screen as code fences, while the model believes it
 * ran all of them — a major cause of "everything is done" fabrications. We
 * detect this so the runner can run the first and explicitly tell the model
 * the others did NOT run and must be re-sent one at a time.
 */
export function countToolFences(text: string): number {
  const matches = text.match(/```tool\s*\n[\s\S]*?```/gi);
  return matches ? matches.length : 0;
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

/**
 * Partition a batch of tool calls (in document order) into execution groups.
 * A run of consecutive parallel-safe calls forms one group to be run
 * concurrently (bounded by maxGroupSize); every non-parallel-safe call is its
 * own single-element group, i.e. a sequential barrier. Because plan updates
 * and side-effecting tools are never parallel-safe, they always split the
 * batch — which keeps parallelism scoped within a single task and prevents
 * plan-state races and overlapping writes.
 */
export function groupToolCallsForExecution(
  calls: ToolCall[],
  isParallelSafe: (call: ToolCall) => boolean,
  maxGroupSize = 4,
): ToolCall[][] {
  const groups: ToolCall[][] = [];
  let cursor = 0;
  while (cursor < calls.length) {
    const group: ToolCall[] = [calls[cursor]!];
    if (isParallelSafe(calls[cursor]!)) {
      let j = cursor + 1;
      while (
        j < calls.length &&
        group.length < maxGroupSize &&
        isParallelSafe(calls[j]!)
      ) {
        group.push(calls[j]!);
        j += 1;
      }
    }
    groups.push(group);
    cursor += group.length;
  }
  return groups;
}

/**
 * Build the conversation to hand back to the caller at turn end. Strips system
 * prompts (they're re-added each turn) but keeps the user turn plus every
 * assistant tool-call and tool result, then appends the final answer if it
 * isn't already the last message. Persisting this is what lets a resumed
 * session give the model back what it actually did — commands, outputs, and
 * results — instead of only its prose answers.
 */
export function buildTurnHistory(
  messages: ChatMessage[],
  answer: string,
): ChatMessage[] {
  // Drop system messages (the main prompt, plan context, and reflections are
  // all re-injected each turn) EXCEPT compacted session memory, which is the
  // only record of summarized older turns and must survive a resume.
  const convo = messages.filter(
    (m) =>
      m.role !== "system" ||
      isCompactionMemoryMessage(m) ||
      isResponderResultLedgerMessage(m),
  );
  const last = convo[convo.length - 1];
  if (
    answer &&
    !(last && last.role === "assistant" && last.content === answer)
  ) {
    convo.push({ role: "assistant", content: answer });
  }
  return convo;
}

/**
 * Collapse pathological repetition before a message is stored in history.
 * Some models degenerate into emitting the same short phrase hundreds of
 * times ("We need to wait.We need to wait.…"), which otherwise bloats the
 * context window and wastes tokens on every subsequent turn. We keep a few
 * copies and note the collapse so the meaning is preserved without the bulk.
 */
export function collapseRepeatedText(text: string): string {
  if (!text || text.length < 1500) return text;
  try {
    return text.replace(
      /(.{3,80}?)\1{6,}/gs,
      (match: string, unit: string) =>
        `${unit.repeat(3)} …[repeated ~${Math.round(
          match.length / Math.max(1, unit.length),
        )}× — collapsed]`,
    );
  } catch {
    return text;
  }
}

/** Extract the text before the tool call block for display purposes */
export function textBeforeToolCall(text: string): string {
  const patterns = [
    /```tool\s*\n?[\s\S]*$/i,
    /<tool_call>[\s\S]*$/i,
    // GLM/Tencent id-tagged tool blocks — never show raw XML as ◆ Response.
    /<tool_calls:[A-Za-z0-9_-]+>[\s\S]*$/i,
    /<tool_call:[A-Za-z0-9_-]+>[\s\S]*$/i,
    /<[|｜]+DSML[|｜]+tool_calls\b[\s\S]*$/i,
    /<[|｜]+DSML[|｜]+invoke\b[\s\S]*$/i,
    /<[|｜]+DSML[|｜]+parameter\b[\s\S]*$/i,
    /<[|｜]+open[|｜]+>?tools\b[\s\S]*$/i,
    /<[|｜]+open[|｜]+>?call\b[\s\S]*$/i,
    // Kimi/Moonshot sentinel block — strip from the section opener
    // (or the first call opener if the section header is missing).
    /<[|｜]+tool[_▁]calls[_▁]begin[|｜]+>[\s\S]*$/i,
    /<\|tool_calls_section_begin\|>[\s\S]*$/i,
    /<[|｜]+tool[_▁]call[_▁]begin[|｜]+>[\s\S]*$/i,
    /<\|tool_call_begin\|>[\s\S]*$/i,
    /<[|｜]+tool[_▁]sep[|｜]+>[\s\S]*$/i,
    /#{1,3}\s*tool\s*\n\s*\{[\s\S]*$/i,
    /\*\*tool\*\*\s*\n\s*\{[\s\S]*$/i,
    /```\w*\s*\n?\{[\s\S]*?"name"[\s\S]*$/i,
    /\{"name"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*$/i,
  ];
  for (const pattern of patterns) {
    const idx = text.search(pattern);
    if (idx >= 0) {
      return text.slice(0, idx).trim();
    }
  }
  return text.trim();
}

/** Compact line window for fs.read card headers, e.g. "11–20" or "1–10". */
export function formatFsReadLineRange(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;
  const startRaw =
    typeof args.startLine === "number"
      ? args.startLine
      : typeof args.offset === "number"
        ? args.offset
        : undefined;
  const endRaw = typeof args.endLine === "number" ? args.endLine : undefined;
  const limitRaw = typeof args.limit === "number" ? args.limit : undefined;
  const start =
    typeof startRaw === "number" && Number.isFinite(startRaw)
      ? Math.max(1, Math.floor(startRaw) || 1)
      : undefined;
  const end =
    typeof endRaw === "number" && Number.isFinite(endRaw)
      ? Math.floor(endRaw)
      : undefined;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : undefined;

  if (start !== undefined && end !== undefined && end >= start) {
    return start === end ? `${start}` : `${start}–${end}`;
  }
  if (start !== undefined && limit !== undefined) {
    const last = start + limit - 1;
    return start === last ? `${start}` : `${start}–${last}`;
  }
  if (start !== undefined) return `${start}+`;
  if (end !== undefined && end >= 1) return `1–${end}`;
  if (limit !== undefined) return `1–${limit}`;
  return undefined;
}

export function formatToolArgs(call: ToolCall): string {
  if (call.name === "terminal.send") {
    return `id=${String(call.args.id ?? "")} kind=${String(call.args.kind ?? "")}`;
  }
  if (call.name === "shell.exec") return String(call.args.command ?? "");
  if (call.name === "net.scan")
    return `${call.args.target ?? ""}${call.args.ports ? ` -p ${call.args.ports}` : ""}${call.args.flags ? ` ${call.args.flags}` : ""}`;
  if (call.name === "pentest.recon") return String(call.args.target ?? "");
  if (call.name === "dns.lookup")
    return `${call.args.target ?? ""}${call.args.record ? ` ${call.args.record}` : " A"}`;
  if (call.name === "whois.lookup") return String(call.args.target ?? "");
  if (call.name === "fs.read") {
    const path = String(call.args.path ?? "");
    const range = formatFsReadLineRange(call.args);
    return range ? `${path}  lines ${range}` : path;
  }
  if (
    call.name === "fs.write" ||
    call.name === "fs.append" ||
    call.name === "fs.edit" ||
    call.name === "fs.replaceLines" ||
    call.name === "fs.delete"
  ) {
    return String(call.args.path ?? "");
  }
  if (call.name === "fs.writeMany") {
    const files = Array.isArray(call.args.files) ? call.args.files : [];
    const names = files
      .map((f) =>
        f && typeof f === "object"
          ? String((f as { path?: unknown }).path ?? "")
          : "",
      )
      .filter(Boolean);
    const preview = names.slice(0, 4).join(", ");
    return `${names.length} file(s)${preview ? `: ${preview}${names.length > 4 ? ", …" : ""}` : ""}`;
  }
  if (call.name === "fs.search") return String(call.args.pattern ?? "");
  if (call.name === "image.ocr" || call.name === "pdf.read")
    return String(call.args.path ?? "");
  if (call.name === "http.fetch" || call.name === "web.fetch")
    return String(call.args.url ?? "");
  if (call.name === "web.search") return String(call.args.query ?? "");
  if (call.name === "pkg.install") return String(call.args.tool ?? "");
  if (call.name === "fs.list") return String(call.args.path ?? safeCwd());
  if (call.name === "tool.batch") {
    // Compact summary — never dump the full nested JSON into the card header.
    const raw = call.args.calls;
    const list = Array.isArray(raw) ? raw : [];
    const names = list
      .map((entry) =>
        entry && typeof entry === "object"
          ? String((entry as { name?: unknown }).name ?? "")
          : "",
      )
      .filter(Boolean);
    if (names.length === 0) return `${list.length || 0} call(s)`;
    const preview = names.slice(0, 4).join(", ");
    return `${names.length} call(s): ${preview}${names.length > 4 ? ", …" : ""}`;
  }
  return JSON.stringify(call.args);
}

// Pure social / idle turns — never force tools.
const SOCIAL_OR_IDLE_PROMPT_RE =
  /^(?:hi|hii+|hello|hey(?:\s+there)?|yo|sup|howdy|hiya|good\s+(?:morning|afternoon|evening|night)|thanks?(?:\s+you)?|thx|ty|ok(?:ay)?|cool|great|nice|awesome|perfect|bye|goodbye|see\s+ya|cheers|gm|gn|how\s+are\s+you(?:\s+doing)?|what'?s\s+up|wassup)(?:\s*[!.?]*)?$/i;

// Signals that the current turn is (or continues) a coding / scaffolding
// task. These are intentionally broad — over-budgeting a build is cheap
// (the loop still stops as soon as the model gives a final answer) while
// under-budgeting silently truncates a half-built project.
const BUILD_TASK_RE =
  /\b(?:build|create|scaffold|generate|make|set\s*up|setup|bootstrap|init(?:ialize)?|implement|add|write|develop|code|refactor|migrate|convert|wire\s*up|integrate)\b[\s\S]{0,80}\b(?:app|application|project|site|website|web\s*app|server|api|service|component|page|module|feature|cli|script|library|package|frontend|backend|fullstack|game|bot|dashboard|form|endpoint|database|schema|test|tests|suite|auth|authentication|authorization|login|signup|middleware|route|routes|routing|handler|controller|model|view)\b/i;

const BUILD_STACK_RE =
  /\b(?:react|next(?:\.?js)?|vue|svelte|angular|vite|webpack|express|fastify|nest(?:js)?|django|flask|fastapi|rails|laravel|spring|node(?:\.?js)?|typescript|tailwind|redux|prisma|mongoose|graphql|docker|kubernetes)\b/i;

// Pentest / security keywords — these tasks are inherently multi-step and
// always deserve the full step budget, just like build tasks.
const PENTEST_TASK_RE =
  /\b(?:pentest|pen[\s-]?test|penetration|security\s*(?:test|audit|scan|assess(?:ment)?)|csrf|xss|sqli|sql[\s-]?inject|rce|lfi|rfi|ssrf|idor|xxe|brute[\s-]?force|enumerat\w*|exploit\w*|vulnerabilit\w*|recon\w*|bug[\s-]?bounty|ctf|capture[\s-]?the[\s-]?flag|red[\s-]?team|offensive|nmap|nikto|nuclei|ffuf|gobuster|sqlmap|hydra|metasploit)\b/i;

/**
 * Detect pentest/security tasks that need the full step budget.
 * Mirrors looksLikeBuildTask but for security work.
 */
export function looksLikePentestTask(
  prompt: string,
  history?: ChatMessage[] | undefined,
): boolean {
  if (PENTEST_TASK_RE.test(prompt)) return true;
  if (history && history.length > 0) {
    const recent = history.slice(-6);
    for (const msg of recent) {
      if (msg.role === "user" && PENTEST_TASK_RE.test(msg.content)) return true;
    }
  }
  return false;
}

// Short continuation prompts that, on their own, carry no build signal but
// clearly mean "keep going with what we were doing".
const CONTINUATION_RE =
  /^(?:do\s+it|build\s+it|build\s+fully|build\s+it\s+fully|go\s+ahead|continue|proceed|keep\s+going|finish(?:\s+it)?|complete(?:\s+it)?|yes|ok(?:ay)?|make\s+it|run\s+it|next|on\s+your\s+own|build\s+(?:fully\s+)?on\s+your\s+own)\b/i;

const INCOMPLETE_RE =
  /\b(?:not\s+complete|incomplete|isn'?t\s+(?:done|complete|working|finished)|doesn'?t\s+work|still\s+(?:broken|missing|failing)|missing\s+(?:files?|parts?)|finish\s+(?:the|it)|complete\s+(?:the|it))\b/i;

// The synthetic message injected when the user runs /implement to approve a
// plan ("I approve the plan. Execute it now, task by task…"). It must always
// count as a build/continuation turn.
const PLAN_EXECUTION_RE =
  /\b(?:approve the plan|execute it (?:now|task by task)|task by task|execute the plan|implement the plan)\b/i;

// Informational / comparison / explanation intent. These questions want an
// ANSWER, not a build — even when they mention a framework or an install
// step (e.g. "compare installation steps in react vite", "how do I set up
// tailwind", "tailwind 3 vs 4"). They must NOT trigger the explore→plan
// build workflow.
const INFORMATIONAL_SIGNAL_RE =
  /\b(?:compare|comparison|contrast|differ(?:ence|ences|s)?|pros\s+and\s+cons|trade-?offs?|versus|vs\.?|cheat\s*sheet|explain|describe|summari[sz]e|overview|tell\s+me)\b/i;
const INTERROGATIVE_LEAD_RE =
  /^(?:what|which|why|how|when|who|where|is|are|do|does|did|can|could|should|would|will)\b/i;

/**
 * Does a single message imply an actual build/scaffold task (as opposed to a
 * question about one)? Comparison/explanation signals and plain questions are
 * treated as informational and return false even when they name a stack.
 */
function messageImpliesBuild(text: string): boolean {
  if (!text) return false;
  if (INFORMATIONAL_SIGNAL_RE.test(text)) return false;
  // Explicit "build/create/scaffold … <thing>" is always a build.
  if (BUILD_TASK_RE.test(text)) return true;
  // A bare question (interrogative lead or trailing "?") that merely mentions
  // a stack is informational, not a build.
  if (text.endsWith("?") || INTERROGATIVE_LEAD_RE.test(text)) return false;
  return BUILD_STACK_RE.test(text);
}

/**
 * Decide whether this turn should get the build workflow (explore → plan →
 * implement) and a generous step budget. Looks at the current prompt first,
 * then falls back to recent USER turns so a terse follow-up inherits an
 * ongoing build — but NOT the agent's own (possibly mistaken) plan narration.
 */
export function looksLikeBuildTask(
  prompt: string,
  history?: ChatMessage[] | undefined,
): boolean {
  const text = prompt.replace(/\s+/g, " ").trim();
  // Continuation / "not done yet" / plan-execution always count as build.
  if (
    CONTINUATION_RE.test(text) ||
    INCOMPLETE_RE.test(text) ||
    PLAN_EXECUTION_RE.test(text)
  ) {
    return true;
  }
  if (messageImpliesBuild(text)) {
    return true;
  }
  // Inspect recent USER turns only: if the user was already building
  // something, treat a terse follow-up as part of that build. (Assistant
  // turns are excluded so a misfired plan can't keep re-triggering build.)
  if (history && history.length > 0) {
    const recent = history.slice(-6);
    for (const msg of recent) {
      if (msg.role !== "user") continue;
      if (messageImpliesBuild(msg.content.replace(/\s+/g, " ").trim())) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Is THIS prompt a plain informational question (as opposed to a request to
 * do work)? Used to stop a resumed/continuing build or pentest session from
 * forcing "act, don't narrate" behavior — and the explore→plan build
 * workflow — onto a question like "what do you know so far", "what did you
 * find", or "summarize the results". A follow-up question in a work session
 * should be ANSWERED from context, not treated as a signal to start executing
 * or to invent a brand-new plan.
 *
 * Explicit build/continuation/plan-execution phrasing is NOT informational,
 * even when it opens with a question word (e.g. "can you build the api",
 * "should I add auth" → those still want work).
 */
export function looksLikeInformationalQuery(prompt: string): boolean {
  const text = prompt.replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (
    BUILD_TASK_RE.test(text) ||
    CONTINUATION_RE.test(text) ||
    INCOMPLETE_RE.test(text) ||
    PLAN_EXECUTION_RE.test(text)
  ) {
    return false;
  }
  return (
    text.endsWith("?") ||
    INTERROGATIVE_LEAD_RE.test(text) ||
    INFORMATIONAL_SIGNAL_RE.test(text)
  );
}

// Matrix of action-verb narration: the model says it is *about to* do
// something but hasn't. Used to detect "narrate, don't act" stalls.
const ACTION_NARRATION_RE =
  /\b(?:let me|let's|i'?ll|i will|i'?m going to|i am going to|i need to|i should|i'?m about to|going to|now i'?ll|first[,]?\s*i'?ll|we need to|we should|we'?ll|we will|we'?re going to)\s+(?:now\s+|first\s+|quickly\s+|just\s+|go\s+ahead\s+and\s+)?(?:explore|list|read|fetch|browse|check|inspect|examine|look|create|run|start|write|build|add|scaffold|set\s*up|setup|install|initialize|init|generate|make|review|open|find|search|verify|update|edit|modify|fix|implement|gather|assess|scan|audit|retry|restart)\b/i;

/**
 * Past-tense / verification language: the model already applied a fix and is
 * summarizing. Must NOT re-trigger "error diagnosed but not fixed".
 */
const ERROR_FIX_ALREADY_DONE_RE =
  /\b(?:i(?:'?ve| have)\s+(?:already\s+)?(?:fixed|applied|added|patched|updated|changed|edited)|(?:already|now)\s+(?:fixed|applied|working)|fix(?:ed)?\s+(?:is\s+)?(?:in\s+place|applied|verified|complete)|(?:is\s+)?now\s+fixed|no longer (?:errors?|fails?|broken)|should now work|hmr (?:update|applied|reloaded)|build (?:successful|passed|succeeded)|verification complete|fix verified|successfully (?:fixed|applied|patched)|the (?:app|page|site) (?:should )?(?:now )?(?:work|load)s?)\b/i;

/**
 * Model diagnosed a concrete failure (build/runtime/HTTP) and implies a fix
 * but has not yet applied it — must not end the turn on diagnosis alone.
 * Returns false for post-fix summaries ("I've fixed…", "build passed").
 */
export function looksLikeErrorDiagnosisWithFixIntent(text: string): boolean {
  const t = text.trim();
  if (t.length < 20 || t.length > 2_000) return false;
  if (t.includes("```tool")) return false;
  // Already applied / verified — do not force another tool loop.
  if (ERROR_FIX_ALREADY_DONE_RE.test(t)) return false;
  const sawError =
    /\b(?:error|exception|failed|failure|crash(?:ed)?|500|502|503|404|ECONNREFUSED|cannot\s+find|is\s+not\s+defined|use client|server component|module not found|syntaxerror|typeerror|build failed|internal server error)\b/i.test(
      t,
    );
  if (!sawError) return false;
  const fixIntent =
    /\b(?:need to|needs? to|should|must|have to|let'?s|i'?ll|we'?ll|going to|fix|edit|add|patch|rewrite|change|update|retry|restart)\b/i.test(
      t,
    );
  return fixIntent;
}

/** True when tool output is a local HTTP probe that did not return 2xx. */
export function localHttpProbeIsFailure(output: string): boolean {
  const head = output.slice(0, 400);
  // http.fetch first line: "500 Internal Server Error http://localhost:3000/"
  if (/^(?:[45]\d\d)\b/.test(head.trim()) || /\n(?:[45]\d\d)\s+\w+/.test(head)) {
    return true;
  }
  if (/\b(?:[45]\d\d)\s+(?:Internal Server Error|Not Found|Bad Request|Unauthorized|Forbidden)\b/i.test(head)) {
    return true;
  }
  if (/\bECONNREFUSED\b|\bconnect\s+ECONNREFUSED\b/i.test(head)) return true;
  return false;
}

/** True when tool output shows a successful 2xx local probe. */
export function localHttpProbeIsSuccess(output: string): boolean {
  if (localHttpProbeIsFailure(output)) return false;
  const head = output.slice(0, 200);
  if (/^(?:[23]\d\d)\b/.test(head.trim())) return true;
  if (/\b(?:200|201|204)\s+(?:OK|Created|No Content)\b/i.test(head)) return true;
  // curl -sI / plain HTML with no status — treat as soft success only if no error signals
  if (/<!doctype html|<html[\s>]/i.test(output) && !/\berror\b/i.test(head)) {
    return true;
  }
  return false;
}

// Web-specific upcoming action (used to pick the right recovery nudge).
const WEB_ACTION_NARRATION_RE =
  /\b(?:let me|let's|i'?ll|i will|i'?m going to|i am going to|i need to|i should|i'?m about to|going to|now i'?ll|first[,]?\s*i'?ll)\s+(?:now\s+|first\s+|quickly\s+|just\s+|go\s+ahead\s+and\s+)?(?:fetch|browse|search(?:\s+(?:the\s+)?(?:web|internet|online))?|look\s*up|google|open\s+(?:the\s+)?(?:page|url|site|link)|read\s+(?:the\s+)?(?:page|url|site|article|blog|docs?))\b/i;

// Capability menus / offers: the model is inviting the user to pick a task,
// not stalling mid-work. Must not trigger "act, don't narrate" recovery.
const CAPABILITY_OFFER_RE =
  /\b(?:what\s+do\s+you\s+(?:want|need)|what\s+would\s+you\s+(?:like|actually\s+like)|how\s+can\s+i\s+help|just\s+tell\s+me|tell\s+me\s+the\s+task|when\s+you(?:'re|\s+are)\s+ready|if\s+you\s+(?:want|need|like|have|give)|a\s+few\s+things\s+i\s+can|here'?s\s+what\s+i\s+can|i\s+can\s+(?:help|jump|assist|build|scan|investigate|research|look)|ready\s+(?:when|whenever)\s+you|what\s+would\s+you\s+(?:actually\s+)?like\s+me\s+to|i'?m\s+ready\s+to)\b/i;

// After a bad recovery nudge the model often clarifies there is no real task.
// Accept that as a final answer instead of looping more web.search nudges.
const DENIES_PENDING_WORK_RE =
  /\b(?:didn'?t\s+(?:actually\s+)?(?:promise|claim|make\s+any)|haven'?t\s+made\s+any|no\s+(?:pending|real)\s+(?:task|browse|research|fetch|job)|non-existent\s+(?:job|task)|there'?s\s+no\s+pending|no\s+tool\s+call\s+for\s+a\s+non)\b/i;

// Soft generic offers without a concrete work object ("I'll start executing",
// "I'll help you") — common in greetings, not mid-task stalls.
const GENERIC_OFFER_NARRATION_RE =
  /\b(?:i'?ll|i will|i'?m going to)\s+(?:start\s+executing|start\s+working|help(?:\s+you)?|jump\s+in|get\s+started|wait\s+for|be\s+here|stand\s+by)\b/i;

// Educational framing ("I'll start with the basics", "I'll start by explaining")
// is not a tool-call stall.
const EDUCATIONAL_START_RE =
  /\b(?:i'?ll|i will|i'?m going to|let me)\s+start\s+(?:with|by)\b/i;

/**
 * Detect a pure social / idle user prompt (greetings, thanks, short acks).
 * These must never force tool use or plan workflows.
 */
export function looksLikeIdleOrSocialPrompt(prompt: string): boolean {
  const text = prompt.replace(/\s+/g, " ").trim();
  if (!text) return true;
  return SOCIAL_OR_IDLE_PROMPT_RE.test(text);
}

/**
 * True when the assistant message is a capability menu / "what do you want"
 * invitation rather than a mid-task action stall.
 */
function looksLikeCapabilityMenu(text: string): boolean {
  const bullets = (text.match(/(?:^|\n)\s*[•\-\*]|\n\s*\d+[.)]\s+/g) || [])
    .length;
  const asksUser =
    /\?\s*$/m.test(text) ||
    /\bwhat\s+(?:do|would|can)\s+you\b/i.test(text) ||
    /\btell\s+me\s+(?:the\s+)?(?:task|what)\b/i.test(text);
  return bullets >= 2 && asksUser;
}

/**
 * Detect a message that narrates an *upcoming* action ("let me explore the
 * directory", "I'll create the components") rather than an actual answer or
 * tool call. Used to catch models that describe intent but emit no tool call,
 * which would otherwise end the turn with nothing done. A real completion
 * summary (past tense, longer, or containing a code block) is NOT flagged.
 *
 * Capability offers, greetings, educational framing, and explicit denials of
 * pending work are intentionally NOT flagged — those false positives used to
 * burn recovery turns (and tokens) on web.search nudges after a simple "hi".
 */
export function looksLikeActionNarration(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 600) return false;
  if (t.includes("```")) return false;
  if (CAPABILITY_OFFER_RE.test(t)) return false;
  if (DENIES_PENDING_WORK_RE.test(t)) return false;
  if (looksLikeCapabilityMenu(t)) return false;
  if (EDUCATIONAL_START_RE.test(t) && !WEB_ACTION_NARRATION_RE.test(t)) {
    // "I'll start with bubble sort" is teaching, not a tool stall — unless
    // the same message also claims a concrete web fetch/search.
    // Still allow other non-start action verbs in the same message.
    const withoutEducational = t.replace(EDUCATIONAL_START_RE, " ");
    if (!ACTION_NARRATION_RE.test(withoutEducational)) return false;
  }
  if (GENERIC_OFFER_NARRATION_RE.test(t)) {
    // Generic offer alone is not a stall; a separate concrete action verb is.
    const withoutOffer = t.replace(GENERIC_OFFER_NARRATION_RE, " ");
    if (!ACTION_NARRATION_RE.test(withoutOffer)) return false;
  }
  return ACTION_NARRATION_RE.test(t);
}

/**
 * Narration specifically about an upcoming web/browse/search action. Used to
 * choose the web-oriented recovery nudge instead of treating every non-build
 * stall as a web action.
 */
export function looksLikeWebActionNarration(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 600) return false;
  if (t.includes("```")) return false;
  if (CAPABILITY_OFFER_RE.test(t) || DENIES_PENDING_WORK_RE.test(t)) {
    return false;
  }
  if (looksLikeCapabilityMenu(t)) return false;
  return WEB_ACTION_NARRATION_RE.test(t);
}

/**
 * Detect a message that narrates a PLAN as prose ("Goal: … Tasks: 1. … Please
 * approve the plan") instead of calling plan.create. Such a turn leaves no
 * real plan, so the user can't /implement it — we nudge the model to emit the
 * plan.create tool call instead.
 */
export function looksLikePlanNarration(text: string): boolean {
  const t = text.trim();
  if (t.length < 40) return false;
  const approval =
    /(?:please\s+approve|approve\s+(?:the|this|my)\s+(?:plan|approach|proposal)|await(?:ing)?\s+(?:your\s+)?approval|your\s+approval|once\s+(?:you\s+)?approv(?:e|ed)|approval\s+to\s+(?:proceed|begin|start)|request\s+changes)/i.test(
      t,
    );
  const goal = /\bgoal\b/i.test(t);
  const tasks =
    /\b(?:tasks?|steps?)\b/i.test(t) ||
    /(?:^|\n)\s*(?:t?1[.)]|step\s*1)\b/im.test(t);
  return approval || (goal && tasks);
}

/**
 * Detect a low-quality "everything in one step" plan task. A single task that
 * itself enumerates many files/actions (multiple commas, an "and", several
 * slashes, or an overlong title) means the model lumped the whole build into
 * one checkbox instead of producing a real ordered checklist.
 */
export function isLumpedSingleTask(taskTitles: string[]): boolean {
  if (taskTitles.length !== 1) return false;
  const only = taskTitles[0]!;
  return (
    (only.match(/,/g)?.length ?? 0) >= 2 ||
    /\band\b/i.test(only) ||
    (only.match(/\//g)?.length ?? 0) >= 2 ||
    only.length > 90
  );
}

/**
 * Compact build inject — reinforces judgment defaults without restating the
 * full system playbook. Stack-agnostic.
 */
export function buildWorkflowDirective(): string {
  return [
    "BUILD FOCUS (guidance for build/scaffold/feature work — use judgment, not a rigid script):",
    "This block was attached because the wording of this turn resembled build work. That guess can be wrong: if the user is actually asking a question, raising a doubt, or asking you to explain, review, or advise, ignore everything below and answer them instead — attaching this block is not permission to start building.",
    "EXPLORE once: read WORKSPACE STATUS; list the user destination and candidate project only as needed. After a project root is known, work there — do NOT repeatedly relist the parent destination. Non-empty dirs → CONTINUE an existing project / existing stack (NEVER re-scaffold). 'Operation cancelled' = failure.",
    "UNDERSTAND: match existing stack from manifests/lockfiles (package manager from lockfile). Empty path → pick a modern default and say so. Stack-agnostic scaffolding only into NEW EMPTY folders.",
    "Scaffold destination is the new subfolder (e.g. Desktop/app), not the parent. Feature apps: replace starter boilerplate — scaffold alone is a failure. Use plan/tasks only when a durable checklist materially helps; direct execution is valid, and an existing active plan must be preserved.",
    "Local apps end with shell.start + probe; LEAVE the server running; report URL/port/job id. Absolute paths; never write the user app into the agent package tree.",
    "On tool WARN/error: change approach — never retry the identical failing command. Debug by root cause; never stop at diagnosis without fix+re-verify.",
  ].join("\n");
}

export function narrowNmapOperationDirective(): string {
  return [
    "NARROW NMAP OPERATION (the user requested one bounded scan, not a broader pentest):",
    "- Call net.scan exactly once with the requested target, ports, scan type, and timing/profile semantics.",
    "- Do NOT call plan.create or task.update. Do NOT add WHOIS, DNS, HTTP fetching, crawling, vulnerability checks, reconnaissance, or attack-surface analysis unless the user explicitly requested them.",
    "- A delivered background result must still be acknowledged with job.read; this receipt operation does not create or require a plan.",
    "- If the scan needs administrator access, let net.scan open the secure password prompt. Never retry through shell.exec or place a password in command text.",
    "- For a background result, use only backgroundJob.id as the shell.tail id. Report the canonical job ID and current/terminal status; do not mistake the artifact filename for the ID.",
    "- Stop after reporting this scan's result or durable job receipt. Ask before broadening the operation.",
  ].join("\n");
}

/**
 * Compact pentest inject — objective-first red team / VAPT defaults.
 */
export function pentestWorkflowDirective(): string {
  return [
    "PENTEST FOCUS (security / pentest / VAPT engagement — pursue the real objective with verified evidence, not activity theater):",
    "Choose each next action from the target, scope, current evidence, and expected impact. Reconnaissance, manual validation, directory/content discovery, service expansion, client analysis, and automated scanners are options rather than a mandatory checklist or sequence. Use only what can resolve a meaningful hypothesis, and pivot when evidence changes.",
    "When you choose a long self-completing operation, the Responder can run it durably while you continue independent useful work. Do not poll or relaunch a Responder-owned job; analyze its delivered evidence once and acknowledge it with job.read when satisfied.",
    "Develop a threat model from observed behavior, focus on high-value vectors supported by the surface, and confirm findings with safe PoC evidence. Keep going while an in-scope action can materially improve confidence or impact; never pad work with equivalent tools.",
    "Use plan.create when a durable roadmap improves the engagement, based on returned tool evidence rather than a fixed recon gate. Add follow-up tasks only for discoveries that require real work. Report findings with severity, evidence, reproduction, impact, remediation, and explicit residual or untested risk.",
    "Never claim mature posture when material uncertainty remains. Stay in engagement scope; FLAG out-of-scope hosts. Non-destructive default. No local dev server for remote targets.",
  ].join("\n");
}

/**
 * Always-on reminder when the session is already a remote/security engagement
 * (plan kind=pentest or pentest-like turn), including after tasks complete.
 */
export function pentestNoLocalServerDirective(): string {
  return [
    "REMOTE / PENTEST SESSION RULE (always on for this engagement):",
    "- Target is remote (or remote-style). After findings/report delivery, STOP.",
    "- Do not shell.start / npm|bun|pnpm|yarn run dev / vite / next dev / python -m http.server unless the user explicitly asked for a local app.",
    "- Do not explore the clai workspace or package.json to invent a local server task.",
    "- If assessment is complete, answer in prose with evidence — no local-server follow-up.",
  ].join("\n");
}

export function shouldDimToolChatter(call: ToolCall): boolean {
  return call.name === "web.search";
}

/**
 * Distinctive section headings and phrases that appear only in our system
 * prompts. If the model's output contains several of these, it is almost
 * certainly regurgitating its instructions in response to a prompt-injection
 * attack like "repeat your instructions verbatim". Any tool-call syntax
 * inside such a leak is an EXAMPLE from the prompt, not a real request, and
 * must not be executed.
 */
const PROMPT_LEAK_MARKERS = [
  /# SECURITY POSTURE/i,
  /# RESEARCH — READ-ONLY TOOLS/i,
  /# ACTION HANDOFF/i,
  /# PROMPT CONFIDENTIALITY/i,
  /# TOOL CALLS — HOW TO USE TOOLS/i,
  /# OPERATING RULES/i,
  /# PENTEST METHODOLOGY/i,
  /# HOW TO ANSWER/i,
  /\bbuilt by Aniket Pandey\b/i,
  /\bpentoshi007 on GitHub\b/i,
  /\bagent\.handoff\b.*\btask\b.*\breason\b/i,
];

/** Minimum number of markers that must match to consider it a prompt leak. */
const PROMPT_LEAK_THRESHOLD = 3;

/**
 * Returns true when the model's output looks like it is repeating the system
 * prompt rather than giving a genuine answer. Used to suppress execution of
 * tool-call examples embedded in the regurgitated instructions.
 */
export function looksLikePromptLeak(text: string): boolean {
  let hits = 0;
  for (const marker of PROMPT_LEAK_MARKERS) {
    if (marker.test(text)) {
      hits += 1;
      if (hits >= PROMPT_LEAK_THRESHOLD) return true;
    }
  }
  return false;
}
