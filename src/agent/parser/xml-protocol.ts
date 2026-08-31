import type { ToolCall } from "../../types.js";

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

export function lenientJsonParse(text: string): unknown | undefined {
  const candidates: string[] = [];
  const deSmart = text
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'");
  candidates.push(deSmart);
  candidates.push(replaceOutsideStrings(deSmart));
  const mixedRepaired = repairMixedQuotes(deSmart);
  candidates.push(mixedRepaired);
  candidates.push(replaceOutsideStrings(mixedRepaired));
  if (!deSmart.includes('"') && deSmart.includes("'")) {
    candidates.push(deSmart.replace(/'/g, '"'));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(preprocessJson(candidate).trim());
    } catch {
    }
  }
  return undefined;
}

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
              : "null";
      i += word.length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function tryParseCall(raw: string): ToolCall | undefined {
  let parsed: (Partial<ToolCall> & { arguments?: unknown }) | undefined;
  try {
    parsed = JSON.parse(preprocessJson(raw).trim()) as Partial<ToolCall> & {
      arguments?: unknown;
    };
  } catch {
    const repaired = lenientJsonParse(raw.trim());
    if (repaired && typeof repaired === "object" && !Array.isArray(repaired)) {
      parsed = repaired as Partial<ToolCall> & { arguments?: unknown };
    }
  }
  if (!parsed) return undefined;
  const anyParsed = parsed as Record<string, unknown>;
  const nameRaw =
    typeof parsed.name === "string"
      ? parsed.name
      : typeof anyParsed.tool_name === "string"
        ? (anyParsed.tool_name as string)
        : undefined;
  if (typeof nameRaw === "string" && nameRaw.length > 0) {
    const name = nameRaw.replace(/^functions\./, "");
    const argsSrc =
      pickObject(parsed.args) ??
      pickObject(parsed.arguments) ??
      pickObject(anyParsed.parameters) ??
      pickObject(anyParsed.input);
    if (argsSrc) {
      return { name, args: argsSrc };
    }
    if (parsed.args === null || parsed.arguments === null) {
      return { name, args: {} };
    }
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

const XML_BLOCK_OPENERS = /<tool_call>|<function_calls>|<invoke>|<ant:invoke>/i;

export function extractBalancedJson(text: string): string | undefined {
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

export function parseXmlToolCall(text: string): ToolCall | undefined {
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

  const openerMatch = XML_BLOCK_OPENERS.exec(text);
  if (openerMatch) {
    const after = text.slice(openerMatch.index + openerMatch[0].length);
    const json = extractBalancedJson(after);
    if (json) {
      const call = tryParseCall(json);
      if (call) return call;
    }
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

export const TOOL_ARG_KEYS = new Set([
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
