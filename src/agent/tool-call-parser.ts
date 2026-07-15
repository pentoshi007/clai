/**
 * Pure parsing and classification for model output: recovering tool calls
 * from the many shapes different models emit (fenced JSON, XML wrappers,
 * Kimi sentinel tokens, bare args objects), and text-pattern classifiers
 * (build/pentest task detection, freshness guard, narration detection) used
 * to steer the agent loop. Nothing here touches process state, the file
 * system, or any store — nothing here executes a tool call, either.
 */
import type { ChatMessage, ToolCall } from "../types.js";
import { currentDateTimeContext } from "../prompts/index.js";
import { isCompactionMemoryMessage } from "./context-manager.js";
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

function parseIdTaggedToolCall(text: string): ToolCall | undefined {
  const match = /<tool_call:([A-Za-z0-9_-]+)>\s*([\w.-]+)\s*/i.exec(text);
  if (!match) return undefined;
  const name = match[2]!;
  const after = text.slice(match.index + match[0].length);
  const json = extractBalancedJson(after);
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
  }
  // No-args tool (e.g. net.context / sysinfo)
  if (/^[\s\n]*(?:<\/tool_call|$)/i.test(after) || after.trim() === "") {
    return { name, args: {} };
  }
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
    // GLM/Tencent id-tagged blocks (and bare openers left after a partial strip).
    .replace(/<tool_calls:[A-Za-z0-9_-]+>[\s\S]*?(?:<\/tool_calls:[A-Za-z0-9_-]+>|$)/gi, "")
    .replace(/<tool_call:[A-Za-z0-9_-]+>[\s\S]*?(?:<\/tool_call:[A-Za-z0-9_-]+>|$)/gi, "")
    .replace(/<\/?tool_calls?:[A-Za-z0-9_-]+>/gi, "")
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

  // 3. Kimi/Moonshot sentinel format (used by kimi-k2 family on NIM).
  const kimi = parseKimiToolCall(text);
  if (kimi) return kimi;

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
  "state",
  "method",
  "body",
  "headers",
  "maxBytes",
  "maxResults",
  "cwd",
  "name",
  "concurrency",
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
  if (has("command")) return "shell.exec";
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

  // Secondary path: scan for any fenced block embedded in the text
  // This catches models that prepend prose before emitting a bare-args fence,
  // e.g. "Let me fetch it.\n\n```web\n{\"url\":\"https://...\"}\n```"
  // We skip ```tool fences — those are handled by parseToolCall already.
  const embeddedFenceRe = /```([a-zA-Z]*)\s*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = embeddedFenceRe.exec(text)) !== null) {
    const lang = m[1] ?? "";
    const body = (m[2] ?? "").trim();
    // Skip ```tool blocks — parseToolCall owns those.
    if (lang.toLowerCase() === "tool") continue;
    // Skip empty or multi-line JSON that spans more than a simple object.
    if (!body.startsWith("{") || !body.endsWith("}")) continue;
    const result = tryRecognizeBareArgs(body);
    if (result) return result;
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
  return false;
}

/**
 * Attempt to extract usable content from a truncated fs.write / fs.append /
 * fs.writeMany tool call. When the model's output is cut off mid-JSON, the
 * tool call fails to parse — but typically a large chunk of the intended file
 * content is already present in the raw text. This function extracts:
 *   - path: the target file path
 *   - content: the partial file content (up to the truncation point)
 *   - lastLine: the last complete line (for telling the model where to resume)
 *
 * Returns undefined if the text doesn't look like a salvageable write call.
 */
export function salvageTruncatedWrite(text: string): {
  path: string;
  content: string;
  lastLine: string;
} | undefined {
  // Match fs.write or fs.append: {"name":"fs.write","args":{"path":"...","content":"...
  // Also handle "fs.append" and cases where content comes before path.
  // Try both orderings: path before content, and content before path.
  // Use a simpler approach: find the tool name, then extract path and content separately.
  const toolNameMatch = text.match(
    /\{\s*"name"\s*:\s*"fs\.(?:write|append)"\s*,\s*"args"\s*:\s*\{/,
  );
  if (toolNameMatch) {
    const argsStart = text.indexOf(toolNameMatch[0]) + toolNameMatch[0].length;
    const afterArgs = text.slice(argsStart);

    // Extract path value
    const pathMatch = afterArgs.match(/"path"\s*:\s*"([^"]+)"/);
    if (!pathMatch?.[1]) return undefined;
    const path = pathMatch[1];

    // Find where "content":" starts and extract everything after its opening quote
    const contentKeyMatch = afterArgs.match(/"content"\s*:\s*"/);
    if (!contentKeyMatch) return undefined;
    const contentStart = argsStart + afterArgs.indexOf(contentKeyMatch[0]) + contentKeyMatch[0].length;
    let raw = text.slice(contentStart);

    // The content is JSON-encoded (escaped). Unescape what we can.
    // Remove any trailing incomplete escape sequence or quote.
    raw = raw.replace(/\\?$/, "");

    // Unescape JSON string escapes
    try {
      // Add closing quote to make it parseable, but don't rely on JSON.parse
      // for the whole thing since it may be truncated mid-escape.
      const unescaped = raw
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");

      // Trim to the last complete line
      const lastNewline = unescaped.lastIndexOf("\n");
      const content =
        lastNewline > 0 ? unescaped.slice(0, lastNewline + 1) : unescaped;

      if (content.trim().length < 50) return undefined; // Too little to salvage

      const lines = content.trimEnd().split("\n");
      const lastLine =
        lines[lines.length - 1]?.trim().slice(0, 80) ?? "(unknown)";

      return { path, content, lastLine };
    } catch {
      return undefined;
    }
  }

  // Match fs.writeMany: look for the first file entry
  const writeManyMatch = text.match(
    /\{\s*"name"\s*:\s*"fs\.writeMany"\s*,\s*"args"\s*:\s*\{\s*"files"\s*:\s*\[/,
  );
  if (writeManyMatch) {
    // Extract the first file's path and content
    const firstFile = text.match(
      /\{\s*"path"\s*:\s*"([^"]+)"\s*,\s*"content"\s*:\s*"/,
    );
    if (firstFile?.[1]) {
      const path = firstFile[1];
      const contentStart =
        text.indexOf(firstFile[0]) + firstFile[0].length;
      let raw = text.slice(contentStart);
      // Find the end of this file's content (closing quote + })
      const endQuote = raw.indexOf('"}');
      if (endQuote > 0) {
        raw = raw.slice(0, endQuote);
      }
      raw = raw.replace(/\\?$/, "");
      try {
        const unescaped = raw
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
        const lastNewline = unescaped.lastIndexOf("\n");
        const content =
          lastNewline > 0 ? unescaped.slice(0, lastNewline + 1) : unescaped;
        if (content.trim().length < 50) return undefined;
        const lines = content.trimEnd().split("\n");
        const lastLine =
          lines[lines.length - 1]?.trim().slice(0, 80) ?? "(unknown)";
        return { path, content, lastLine };
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
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

  const kimiRe = new RegExp(KIMI_TOOL_CALL_RE.source, "gi");
  while ((m = kimiRe.exec(text)) !== null) {
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
  // De-duplicate calls that two different matchers picked up at (nearly) the
  // same spot so a single XML call isn't executed twice.
  const deduped: Array<{ index: number; call: ToolCall }> = [];
  for (const entry of found) {
    if (
      deduped.some(
        (d) =>
          sameToolCall(d.call, entry.call) &&
          Math.abs(d.index - entry.index) < 64,
      )
    ) {
      continue;
    }
    deduped.push(entry);
  }
  return deduped.map((f) => f.call);
}

/** Structural equality for two tool calls (name + canonical args JSON). */
export function sameToolCall(a: ToolCall, b: ToolCall): boolean {
  if (a.name !== b.name) return false;
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
    (m) => m.role !== "system" || isCompactionMemoryMessage(m),
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
    // Kimi/Moonshot sentinel block — strip from the section opener
    // (or the first call opener if the section header is missing).
    /<\|tool_calls_section_begin\|>[\s\S]*$/i,
    /<\|tool_call_begin\|>[\s\S]*$/i,
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

export function formatToolArgs(call: ToolCall): string {
  if (call.name === "shell.exec") return String(call.args.command ?? "");
  if (call.name === "net.scan")
    return `${call.args.target ?? ""}${call.args.ports ? ` -p ${call.args.ports}` : ""}${call.args.flags ? ` ${call.args.flags}` : ""}`;
  if (call.name === "pentest.recon") return String(call.args.target ?? "");
  if (call.name === "dns.lookup")
    return `${call.args.target ?? ""}${call.args.record ? ` ${call.args.record}` : " A"}`;
  if (call.name === "whois.lookup") return String(call.args.target ?? "");
  if (call.name === "fs.read" || call.name === "fs.write" || call.name === "fs.append")
    return String(call.args.path ?? "");
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

const VOLATILE_SIGNAL_RE =
  /\b(?:current(?:ly)?|latest|newest|today|now|right now|live|recent|breaking|news|release[sd]?|version|prices?|stocks?|market|rates?|weather|forecast|elections?|results?|rankings?|standings?|stats?|cve|advis(?:ory|ories)|vulnerabilit(?:y|ies))\b/i;

const VOLATILE_ROLE_QUERY_RE =
  /\b(?:who(?:\s+is|'s)?|whos|name|tell\s+me|what(?:\s+is|'s)?)\b[\s\S]{0,120}\b(?:cm|chief\s+minister|prime\s+minister|president|governor|mayor|ministers?|cabinet|leader|head\s+of|ceo|cto|cfo|coo|chair(?:man|woman|person)?|coach|captain)\b/i;

// A dated schedule (exam, application, event, release, etc.) is not stable
// knowledge even when the user does not say "latest". In particular, terse
// prompts such as "when is SSC CGL 2026" must be checked rather than guessed.
const DATED_SCHEDULE_QUERY_RE =
  /\bwhen\s+(?:is|are|does|will|do)\b[\s\S]{0,120}\b20\d{2}\b|\b(?:exam|test|application|admission|registration|notification|recruitment|event|match|release|launch)\b[\s\S]{0,80}\b(?:date|schedule|calendar|20\d{2})\b/i;

const ROLE_OF_ENTITY_RE =
  /\b(?:cm|chief\s+minister|prime\s+minister|president|governor|mayor|ministers?|ceo|cto|cfo|coo|chair(?:man|woman|person)?|coach|captain)\s+(?:of|for|in)\b/i;

const EXPLICIT_WEB_LOOKUP_RE =
  /\b(?:search\s+(?:the\s+)?(?:web|internet|online)|look\s*up|google|verify\s+(?:online|on\s+the\s+web)|check\s+(?:online|the\s+web|internet))\b/i;

const STATIC_DISAMBIGUATION_RE =
  /\b(?:stand\s+for|stands\s+for|meaning|definition|define|abbreviation|centimeters?|centimetres?)\b/i;

const LOCAL_RUNTIME_RE =
  /\b(?:current\s+(?:directory|dir|cwd|working\s+directory|folder|path|user|shell|process(?:es)?|branch|git\s+branch|network|ip|interfaces?|working\s+tree|project|repo(?:sitory)?|codebase|code|app|application|stack|setup|config|implementation|architecture|state|status|file|files|tree)|pwd|whoami|server|jobs?|process(?:es)?|ports?|localhost|git)\b/i;

// Session-retrospective / in-conversation questions. Words like "now" or
// "current" appear, but the user wants local context — not a web search.
const SESSION_CONTEXT_RE =
  /\b(?:so\s+far|till\s+now|until\s+now|up\s+to\s+now|what\s+do\s+(?:you|u)\s+know|what\s+have\s+you\s+(?:done|found|learned|checked)|in\s+this\s+(?:session|conversation|chat|project|repo|codebase)|this\s+(?:session|conversation|chat))\b/i;

// Capability / identity questions about the agent itself.
const SELF_CAPABILITY_RE =
  /\b(?:what\s+can\s+you\s+do|what\s+do\s+you\s+do|your\s+capabilities|how\s+can\s+you\s+help|who\s+are\s+you|what\s+are\s+you)\b/i;

// Pure social / idle turns — never force tools or freshness retries.
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
// count as a build/continuation turn — it contains the word "now", which
// would otherwise trip the volatile-info freshness guard and divert the run
// into a pointless web.search instead of executing the plan.
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
  /\b(?:let me|let's|i'?ll|i will|i'?m going to|i am going to|i need to|i should|i'?m about to|going to|now i'?ll|first[,]?\s*i'?ll)\s+(?:now\s+|first\s+|quickly\s+|just\s+|go\s+ahead\s+and\s+)?(?:explore|list|read|fetch|browse|check|inspect|examine|look|create|run|start|write|build|add|scaffold|set\s*up|setup|install|initialize|init|generate|make|review|open|find|search|verify|update|edit|modify|fix|implement|gather|assess|scan|audit)\b/i;

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
 * These must never force tool use, plan workflows, or freshness retries.
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
    /\b(?:approve|approval|once approved|request changes|await(?:ing)?\s+(?:your\s+)?approval)\b/i.test(
      t,
    );
  const goal = /\bgoal\b/i.test(t);
  const tasks =
    /\b(?:tasks?|steps?)\b/i.test(t) ||
    /(?:^|\n)\s*(?:t?1[.)]|step\s*1)\b/im.test(t);
  return approval || (goal && tasks);
}

export function requiresFreshWebSearch(prompt: string): boolean {
  const text = prompt.replace(/\s+/g, " ").trim();
  if (!text) return false;
  // Social / idle prompts never need the web.
  if (looksLikeIdleOrSocialPrompt(text)) {
    return false;
  }
  if (EXPLICIT_WEB_LOOKUP_RE.test(text)) {
    return true;
  }
  if (
    STATIC_DISAMBIGUATION_RE.test(text) ||
    LOCAL_RUNTIME_RE.test(text) ||
    SESSION_CONTEXT_RE.test(text) ||
    SELF_CAPABILITY_RE.test(text)
  ) {
    return false;
  }
  // Plan-execution and terse continuation turns are never "fetch current
  // info" turns, even when they contain words like "now". (We intentionally
  // do NOT exclude on build-stack keywords here — "latest vite version" is a
  // legitimate version lookup. The runAgentLoop caller additionally gates the
  // guard on looksLikeBuildTask so a real scaffold turn never searches.)
  if (PLAN_EXECUTION_RE.test(text) || CONTINUATION_RE.test(text)) {
    return false;
  }
  return (
    VOLATILE_SIGNAL_RE.test(text) ||
    VOLATILE_ROLE_QUERY_RE.test(text) ||
    ROLE_OF_ENTITY_RE.test(text) ||
    DATED_SCHEDULE_QUERY_RE.test(text)
  );
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

export function freshnessGuardMessage(now = new Date()): string {
  return (
    `Freshness guard for this turn: the latest user prompt appears to ask for current, volatile, or externally verifiable information. The present moment is ${currentDateTimeContext(now)}. ` +
    "Before answering, call web.search FIRST with a concise query derived from the user prompt. " +
    "Shape the search query for the newest timeline by including current/latest or the current year/month when useful. " +
    "Do not answer from the snippets alone when detail matters — set fetchTop (e.g. fetchTop:2) to read the top result pages, or follow up with web.fetch on the most relevant URL, then answer from what the pages actually say and cite them. " +
    "If web.search fails or has no results, say that current information is unavailable instead of guessing from memory."
  );
}

/**
 * Directive injected for build/scaffold turns. Forces the careful
 * explore → understand → plan → implement loop instead of a one-shot dump,
 * and forbids stopping before the goal is reached.
 */
export function buildWorkflowDirective(): string {
  return [
    "BUILD WORKFLOW (this is a build/scaffold/feature task — follow this order EXACTLY; deviation is a failure):",
    "1. EXPLORE: fs.list the working directory (and key subdirs) to see what already exists. Use tool.batch to parallelize reads.",
    "2. UNDERSTAND: fs.read the files that matter (like package.json for js related and same for other languages too, config, entry points, existing components). Detect the existing stack/tooling and MATCH it. If the dir is empty or only has a stub, start fresh with a sensible modern default and say so.",
    "3. PLAN: call plan.create with a COMPREHENSIVE plan — a detailed `detail` (stack chosen and WHY, architecture, how you'll verify) and 4-8 SEPARATE, ordered, high-quality tasks. The FIRST task initializes the project (scaffolder); the MIDDLE tasks MUST implement the ACTUAL FEATURE the user asked for by REPLACING the scaffolder's boilerplate (e.g. rewrite src/App.jsx into the real todo/blog/etc. UI, add components, state, styles); the LAST task verifies with a build. Scaffolding + install + run ALONE is NOT acceptable — that just leaves the Vite starter page. Each task is one distinct, verifiable action. Then STOP and wait for the user to /implement.",
    "4. IMPLEMENT: once approved, work task by task in STRICT ORDER. For each task: call task.update {taskId, state:'in_progress'} → do the real work → VERIFY it actually succeeded (read a file you wrote, check the command's exit/output) → call task.update {taskId, state:'done'}, then move to the NEXT task. You MAY emit several tool calls in one message; they run in document order (independent read-only lookups run in parallel, while task.update and any write/command runs one at a time), and the batch STOPS if one fails. Keep every batch scoped to ONE task. A clean rhythm is: task.update in_progress + the work + task.update done together. Keep going until EVERY task is done. Do NOT claim work you didn't actually run.",
    "",
    "INITIALIZE WITH THE OFFICIAL SCAFFOLDER FIRST (do NOT hand-write build configs):",
    "- DESTINATION PATHS ARE LITERAL. If the user names an absolute destination such as `/Users/alice/Desktop`, use that exact absolute path as the shell cwd and file prefix. Never remove its leading slash or recreate it under the current project (for example, `Users/alice/Desktop` would incorrectly become `<cwd>/Users/alice/Desktop`). Resolve and state the final absolute project directory before scaffolding, create directly there, and do not scaffold in cwd then move it. If the destination is outside the approved write roots, request confirmation instead of silently falling back to cwd. Clean up only empty directories that your failed attempt created.",
    '- React/Vue/Svelte/vanilla → `npm create vite@latest <appname> -- --template react` (templates: react, react-ts, vue, vue-ts, svelte, vanilla). Next.js → `npx --yes create-next-app@latest <appname> --yes --eslint --no-tailwind --app --src-dir --import-alias "@/*"`. Node API → `npm init -y`.',
    "- GET THE TEMPLATE FLAG RIGHT. With `npm create vite@latest NAME -- --template react` the `--` IS required (it forwards --template to create-vite). With `npx create-vite@latest NAME --template react` do NOT add `--` (npx passes args straight through, so `-- --template react` makes npx DROP the flag and you silently get the WRONG, vanilla template). Pick ONE form and keep the template flag attached. After scaffolding, fs.read the generated index.html / src entry to CONFIRM you got React (a src/main.jsx + App.jsx, not a vanilla main.js/counter.js). If it's the wrong template, delete the folder and re-run with the correct command.",
    "- RUN SCAFFOLDERS NON-INTERACTIVELY and into a NEW SUBFOLDER (`<appname>`). Scaffolders REFUSE to run in a non-empty directory and then print 'Operation cancelled' — and the current dir frequently already has a file like .DS_Store. So scaffold into a subfolder (always works). `--yes` does NOT fix the non-empty-dir cancel; a subfolder does. NEVER background a scaffolder with `&` or pipe `yes |` into it.",
    '- If a scaffolder cannot be driven non-interactively or keeps failing, FALL BACK to hand-writing a minimal Vite setup (package.json with "type":"module", @vitejs/plugin-react, index.html that loads /src/main.jsx, src/main.jsx, src/App.jsx) then `npm install`. That never prompts and you control every file.',
    "- VERIFY the init actually worked before marking the task done: fs.read package.json (it must now exist AND list react + react-dom) and fs.read index.html (it must reference your jsx entry). 'Operation cancelled' / non-zero exit means the task FAILED — do not proceed as if it succeeded.",
    "",
    "CRITICAL RULES during IMPLEMENTATION:",
    "- You may batch tool calls: emit one or several ```tool blocks in a message. They run in document order — independent READ-ONLY lookups (fs.read/list/search, dns/whois, http.fetch GET, web.search/fetch, sysinfo) run in parallel, while task.update and any write/command (fs.write*, shell.exec, pkg.install, net.scan) run one at a time. If any call fails, the rest of that batch is cancelled so you can react — so order dependent steps correctly and keep every batch scoped to ONE task. A good batch is task.update(in_progress) + the work + task.update(done) for ONE task.",
    "- Do NOT re-explore. Step 1 (EXPLORE) was already completed during planning. Start executing the first pending task immediately.",
    "- ONE task at a time, in ORDER. Do NOT skip ahead to task 3 before task 2 is done.",
    "- Write complete, production-quality files; never shorten code merely to fit a tool call. Prefer fs.writeMany for several normal files, fs.write for one large/new file, fs.edit for exact-text atomic changes, and fs.replaceLines only after fs.read has established precise line coordinates. If fs.writeMany is cut off, split only the FILE LIST into smaller batches. If one fs.write is cut off, retry that file alone and split the component into cohesive modules only when that improves the design. A truncated call never ran, so never move on until a complete write succeeds.",
    "- VERIFY each step before marking it done: you MUST NOT mark a task 'done' in advance or assume it is complete. You must first verify and have full, absolute knowledge that all commands, operations, and file changes scoped to that task have been successfully executed and are correct. After writing/editing files, you MUST call fs.read to verify that the file contents are complete, syntactically correct (braces, tags, parens are balanced), and exactly what you intended. After running commands or packages, confirm they completed with exit code 0. Only when you have verified all work for a task should you call task.update to mark it 'done' and move on to the next task. Marking a task done without a successful, verified tool call is the worst failure.",
    "- VERIFY THE BUILD, not just the dev server. `vite` / `npm run dev` reports 'ready' even when your App.jsx has syntax errors (the error only shows in the browser). To actually confirm the app works, run `npm run build` (it fails on real syntax/JSX errors) and check it exits 0. Seeing 'VITE ready' is NOT proof the app renders.",
    "- If a tool call FAILS (error output, non-zero exit, file missing), the task is NOT done. Mark it 'failed', diagnose WHY, fix it, and retry until it succeeds.",
    "- ERROR ANALYSIS: If an error is given (build failure, compilation error, or runtime crash), do NOT jump directly into editing. You must first analyze which file has the error, what is causing it, and what needs to change. Make sure to read the relevant file context if you don't already have it.",
    "- ATOMIC AND PRECISE EDITS: You must perform precise, atomic edits instead of replacing or regenerating entire files. Use fs.edit, fs.replaceLines, or fs.append to modify only the specific lines of code that need fixing. Keep your changes focused and precise so that the existing code remains intact and the editing process is perfectly reliable.",
    "- NEVER claim a task is done, files were created, a dependency is installed, or a server is running unless the tool call ACTUALLY succeeded and you saw the success output. If you have not run it, say so.",
    "- After the production build passes, start the dev server / app with shell.start (background job) so it keeps running, NOT `npm run dev &` via shell.exec. Check readiness with shell.tail AND make one bounded local HTTP request (curl with a short timeout or http.fetch). A build passing does not prove a server is running. Never print a localhost link or say `running` unless shell.start returned a live job and the HTTP probe succeeded. Keep the server running so the user can interact with the live application, and print the localhost link. Do not spend time polling repeatedly.",
    "- THE DELIVERABLE IS THE WORKING FEATURE, NOT THE SCAFFOLD. After scaffolding you MUST replace the starter boilerplate (Vite's default App.jsx counter, Next's starter page, etc.) with the actual app the user asked for. If the user asked for a todo app, src/App.jsx must contain a real todo UI with state — finishing with the untouched Vite starter page is a FAILURE even if the build passes.",
    "- REVISING PLANS FOR NEW USER REQUESTS: If the user asks for new features, modifications, or additions after a plan has already been created/implemented, you MUST update/revise the plan. Call plan.create to create/overwrite the plan. In the revised plan, preserve all previously completed tasks (retaining their order and descriptions) and append the new tasks needed for the new features/modifications at the end of the task list. Do NOT skip plan revision or start implementing new features directly in existing completed tasks. After calling plan.create, STOP and wait for user approval. Once approved, resume execution of the revised plan from the first new/uncompleted task; do NOT execute completed tasks again.",
    "",
    "FORBIDDEN before plan approval (/implement): you MUST NOT use fs.write, fs.writeMany, fs.edit, fs.append, shell.exec, shell.start, pkg.install, or pkg.uninstall. The ONLY tool allowed before approval is plan.create (and the read/list tools for exploration). If you are nudged to 'take action' before a plan exists, your action MUST be plan.create.",
    "If the task is genuinely trivial (a single tiny file), you may skip the plan — but for an app/feature, ALWAYS plan first.",
  ].join("\n");
}

/**
 * Directive injected for pentest / security engagements when no plan exists
 * yet. A pentest has a different shape than a coding build: you do NOT have
 * a clear scope, stack, or feature list up front. The plan must be BUILT
 * FROM recon findings, not invented in advance. This directive tells the
 * agent that recon is allowed before a plan exists, that the first plan
 * comes after real findings, that incremental task additions are expected
 * as new attack surface appears, and that any out-of-scope discovery must
 * be flagged to the user rather than acted on.
 */
export function pentestWorkflowDirective(): string {
  return [
    "PENTEST WORKFLOW (this is a security / pentest engagement — follow this order EXACTLY; deviation is a failure):",
    "1. RECON FIRST, NO PLAN YET. For pentest engagements, run reconnaissance and discovery DIRECTLY before creating a plan. Read-only recon (whois.lookup, dns.lookup, net.context, http.fetch GET, tool.batch of read-only lookups, net.scan, pentest.recon) is allowed BEFORE any plan exists — these calls do not require an active plan or an in-progress task, because recon is what the plan is built FROM. Batch independent lookups with tool.batch to parallelize. Do NOT skip recon to 'get the plan started'.",
    "2. FINGERPRINT THE TECH STACK. After initial recon, identify the target's technology stack FROM REAL EVIDENCE (http.fetch output includes a 'Tech Stack Detected' summary with Server, Framework, Frontend, CDN, Languages, Security Headers). Read this summary carefully. Once identified, ALL subsequent enumeration and exploitation MUST target that specific stack. Do NOT throw PHP wordlists at a Next.js target, .aspx payloads at a Python app, or Java exploits at a Node.js service. If the stack is unclear, probe a few discriminating endpoints (/_next/data, /wp-login.php, /api/, /elmah.axd) to confirm before committing.",
    "3. PLAN FROM REAL FINDINGS. Call plan.create ONLY after you have real findings — open ports, services and versions, endpoints, technologies (identified stack), weaknesses, exposed surfaces. A pentest plan without findings is a guess. Use these exact response shapes: (A) RECON RESPONSE = one or more gathering calls only; NEVER include plan.create. (B) ANALYSIS + PLAN RESPONSE = reason from the returned tool output, then emit EXACTLY ONE standalone plan.create call; NEVER attach recon, exploitation, task.update, or any follow-on call. (C) AFTER PLAN RESPONSE = stop and wait for /implement approval. A plan based on proposed calls rather than returned evidence is invalid. The plan should reference the identified tech stack and scope tool/wordlist/payload choices to it.",
    "4. INCREMENTAL PLAN UPDATES AS ATTACK SURFACE GROWS. A pentest is inherently open-ended — every new open port, service, endpoint, or weakness uncovers more attack surface. Call plan.create again with a REVISED tasks array that includes ALL previously completed tasks (preserved by id and order) followed by the new tasks at the end. The system merges and preserves the completed state of the old tasks. Do NOT delete done work to add new tasks; do NOT restart from scratch.",
    "5. STAY INSIDE THE ENGAGEMENT SCOPE. The engagement scope is the hard boundary. Do NOT scan, probe, fuzz, or attack hosts / domains / ports that are out of scope. If a recon result exposes something clearly out of scope (a discovered subdomain, an adjacent service, an unrelated host, a port on a different network), STOP and FLAG it to the user in plain prose — do NOT act on it automatically. Out-of-scope targets require explicit user confirmation before any active testing.",
    "6. ENUMERATE WITH STACK-TARGETED TOOLS. Most findings come from thorough, STACK-TARGETED enumeration — not from blindly fuzzing with every extension (.php, .asp, .aspx, .jsp, .cgi). Once you know the stack from step 2, use the right wordlists, extensions, and payloads for THAT stack ONLY. Once you have a vector, carry exploitation through with tools (build / adapt a PoC, generate the payload, run the attack, verify the result) — but pick the vector FROM the findings, not from a hunch.",
    "7. DISCOVERY HYGIENE AND SIGNAL CONTROL. Do not guess dozens of directories/endpoints or wordlist paths and send speculative fetches. Derive candidates from returned links, robots.txt, sitemap, assets, banners, and the identified stack; use a dedicated, bounded discovery tool when one is warranted. For directory/content discovery, select an appropriate fuzzer (ffuf, gobuster, feroxbuster, dirsearch, or dirb) only after stack fingerprinting and a verified wordlist. Before using a non-standard binary call tool.check; if missing and appropriate, install only that needed tool via pkg.install and verify it before use. Before wordlist-driven discovery call wordlist.find. Configure scanners for quiet/structured output, include only candidate hits or relevant status codes, and filter known negative/wildcard responses at the scanner. Return successes and unusual findings; retain one representative failure only when there are no findings. Never spend model context on progress bars, verbose banners, or thousands of repeated failures.",
    "",

    "WHAT REQUIRES A PLAN vs. WHAT DOES NOT (read this carefully):",
    "- Read-only recon (whois.lookup, dns.lookup, net.context, http.fetch GET, tool.batch of read-only lookups, net.scan, pentest.recon) DOES NOT require an active plan or an in-progress task. These calls gather the findings the plan is built on; they are allowed before plan.create and outside the task-update gate.",
    "- Active / exploit calls (http.fetch with a non-GET method or a body, custom payloads, brute-force, sqlmap / hydra / msfconsole, listener / callback setup, shellcode execution, anything that mutates the target or generates side-effects) DO require an active plan AND an in-progress task AND a one-time pentest authorization prompt. Run them inside a plan task and update the task as you go (in_progress → work → done).",
    "",

    "CRITICAL RULES during a pentest engagement:",
    "- TECH STACK AWARENESS: Every enumeration/exploit tool call MUST be relevant to the identified tech stack. If you detected Next.js, do NOT fuzz for .php, .asp, or .jsp files — focus on /_next/data, /api/ routes, .env, client-side JS analysis, SSR endpoints. If you detected WordPress, focus on wp-admin, wp-content, xmlrpc.php, plugin/theme enumeration. Wrong-stack tool calls waste context tokens and produce zero findings.",
    "- VERIFY every claim from real tool output: an open port, a service version, an exploit success, a captured credential, a shell. Never fabricate findings. A reported 'vulnerability' without evidence is worse than no report.",
    "- EVIDENCE: capture the exact command run and its real output for every finding. Long recon / scan transcripts are saved as artifacts you can reference; cite the artifact path in your report.",
    "- NON-DESTRUCTIVE BY DEFAULT: prove a vulnerability with the least-invasive evidence (a benign PoC, a marker file, a reflected value, whoami / id after a shell). Do not destroy data, DoS the target, or exfiltrate real sensitive data unless the user explicitly asks for that impact.",
    "- SCOPE BOUNDARY: if a recon call returns something clearly out of the engagement scope, do NOT keep exploring it. Flag it to the user in plain prose and ask whether to add it to scope. Do not silently expand scope.",
    "- NO-SCOPE FALLBACK: if no engagement scope is configured, treat the explicitly-named target(s) in the user's request as the scope and flag everything else (subdomains, adjacent IPs, unrelated services) before touching it.",
    "- REPORTING: each finding = TITLE, SEVERITY (critical / high / medium / low / info), AFFECTED asset or endpoint, EVIDENCE (command + key output), REPRODUCTION steps, IMPACT, concrete REMEDIATION.",
    "- CTF / BOXES: the goal is the flag or the foothold — enumerate, get a shell, escalate, read the flag. Iterate quickly across likely vectors instead of exhausting one, and move on the moment you have what the objective needs.",
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
