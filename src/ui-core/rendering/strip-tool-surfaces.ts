import { extractBalancedJson } from "../../agent/parser/xml-protocol.js";

const COMPLETE_TOOL_FENCE =
  /```(?:tool|json\s*tool)\b[^\n]*\n[\s\S]*?```/gi;
const TRAILING_TOOL_FENCE = /```(?:tool|json\s*tool)\b[\s\S]*$/i;
const COMPLETE_TOOL_XML = /<tool_call\b(?!:)[^>]*>[\s\S]*?<\/tool_call>/gi;
const TRAILING_TOOL_XML = /<tool_call\b(?!:)[^>]*>[\s\S]*$/i;
const COMPLETE_TOOL_ID_SECTION =
  /<tool_calls:([A-Za-z0-9_-]+)>[\s\S]*?<\/tool_calls:\1>/gi;
const COMPLETE_TOOL_ID_CALL =
  /<tool_call:([A-Za-z0-9_-]+)>[\s\S]*?<\/tool_call:\1>/gi;
const TRAILING_TOOL_ID = /<tool_calls?:[A-Za-z0-9_-]+>[\s\S]*$/i;
const STRAY_TOOL_ID = /<\/?tool_calls?:[A-Za-z0-9_-]+>/gi;
const COMPLETE_TOOL_DSML =
  /<[|｜]+DSML[|｜]+tool_calls\b[^>]*>[\s\S]*?<\/[|｜]+DSML[|｜]+tool_calls>/gi;
const COMPLETE_TOOL_DSML_INVOKE =
  /<[|｜]+DSML[|｜]+invoke\b[^>]*>[\s\S]*?<\/[|｜]+DSML[|｜]+invoke>/gi;
const COMPLETE_TOOL_DSML_PARAMETER =
  /<[|｜]+DSML[|｜]+parameter\b[^>]*>[\s\S]*?<\/[|｜]+DSML[|｜]+parameter>/gi;
const TRAILING_TOOL_DSML =
  /<[|｜]+DSML[|｜]+(?:tool_calls|invoke|parameter)\b[\s\S]*$/i;
const STRAY_TOOL_DSML = /<\/?[|｜]+DSML[|｜]+[A-Za-z0-9_]*\b[^>]*>/gi;
const COMPLETE_TOOL_DEEPSEEK =
  /<[|｜]+tool[_▁]calls[_▁]begin[|｜]+>[\s\S]*?<[|｜]+tool[_▁]calls[_▁]end[|｜]+>/gi;
const COMPLETE_TOOL_DEEPSEEK_CALL =
  /<[|｜]+tool[_▁]call[_▁]begin[|｜]+>[\s\S]*?<[|｜]+tool[_▁]call[_▁]end[|｜]+>/gi;
const TRAILING_TOOL_DEEPSEEK =
  /<[|｜]+tool[_▁](?:calls?[_▁](?:begin|end)|sep)[\s\S]*$/i;
const STRAY_TOOL_DEEPSEEK =
  /<[|｜]+tool[_▁](?:calls?[_▁](?:begin|end)|sep)[|｜]+>/gi;
const COMPLETE_TOOL_KIMI_SECTION =
  /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/gi;
const COMPLETE_TOOL_KIMI_CALL =
  /<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/gi;
const TRAILING_TOOL_KIMI =
  /<\|(?:tool_calls_section_begin|tool_call_begin|tool_call_argument_begin)\|>[\s\S]*$/i;
const STRAY_TOOL_KIMI =
  /<\|tool_(?:calls_section|call|call_argument)_(?:begin|end)\|>/gi;
const COMPLETE_TOOL_OPEN_SEP =
  /<[|｜]+open[|｜]+>?tools\b[\s\S]*?<[|｜]+close[|｜]+>?tools(?:\s*>|(?=\s*(?:\n|$)))/gi;
const COMPLETE_TOOL_OPEN_SEP_CALL =
  /<[|｜]+open[|｜]+>?call\b[\s\S]*?<[|｜]+close[|｜]+>?call(?:\s*>|(?=\s*(?:\n|$)))/gi;
const TRAILING_TOOL_OPEN_SEP =
  /<[|｜]+open[|｜]+>?(?:tools|call|argument)\b[\s\S]*$/i;
const STRAY_TOOL_OPEN_SEP =
  /<[|｜]+(?:open|close)[|｜]+>?(?:tools|call|argument)\b[^<\n]*>?|<[|｜]+sep[|｜]+>/gi;
const COMPLETE_TOOL_FUNCTION =
  /(?:^|\n)\s*(?:tool_call|invoke_tool)\s*\([\s\S]*?\)\s*(?=\n|$)/gi;
const TRAILING_TOOL_FUNCTION =
  /(?:^|\n)\s*(?:tool_call|invoke_tool)\s*\([\s\S]*$/i;
const TRAILING_PARTIAL_TAG =
  /(?:<[|｜]+[A-Za-z0-9_|｜▁]*|<[|｜]+(?:open|close)[|｜]+>?[A-Za-z_]*|<\/?|<\/?t|<\/?to|<\/?too|<\/?tool[^>]*)$/i;

export function stripToolCallSurfaces(text: string): string {
  if (!text) return text;
  let s = text;
  s = s.replace(COMPLETE_TOOL_FENCE, "");
  s = s.replace(TRAILING_TOOL_FENCE, "");
  s = s.replace(COMPLETE_TOOL_XML, "");
  s = s.replace(TRAILING_TOOL_XML, "");
  s = s.replace(COMPLETE_TOOL_ID_SECTION, "");
  s = s.replace(COMPLETE_TOOL_ID_CALL, "");
  s = s.replace(TRAILING_TOOL_ID, "");
  s = s.replace(STRAY_TOOL_ID, "");
  s = s.replace(COMPLETE_TOOL_DSML, "");
  s = s.replace(COMPLETE_TOOL_DSML_INVOKE, "");
  s = s.replace(COMPLETE_TOOL_DSML_PARAMETER, "");
  s = s.replace(TRAILING_TOOL_DSML, "");
  s = s.replace(STRAY_TOOL_DSML, "");
  s = s.replace(COMPLETE_TOOL_DEEPSEEK, "");
  s = s.replace(COMPLETE_TOOL_DEEPSEEK_CALL, "");
  s = s.replace(TRAILING_TOOL_DEEPSEEK, "");
  s = s.replace(STRAY_TOOL_DEEPSEEK, "");
  s = s.replace(COMPLETE_TOOL_KIMI_SECTION, "");
  s = s.replace(COMPLETE_TOOL_KIMI_CALL, "");
  s = s.replace(TRAILING_TOOL_KIMI, "");
  s = s.replace(STRAY_TOOL_KIMI, "");
  s = s.replace(COMPLETE_TOOL_OPEN_SEP, "");
  s = s.replace(COMPLETE_TOOL_OPEN_SEP_CALL, "");
  s = s.replace(TRAILING_TOOL_OPEN_SEP, "");
  s = s.replace(STRAY_TOOL_OPEN_SEP, "");
  s = s.replace(COMPLETE_TOOL_FUNCTION, "\n");
  s = s.replace(TRAILING_TOOL_FUNCTION, "");
  s = s.replace(TRAILING_PARTIAL_TAG, "");
  s = stripBracketedToolCalls(s);
  s = stripToCodeToolCalls(s);
  s = stripBareJsonToolCalls(s);
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s;
}

const TRAILING_TOOL_BRACKETED =
  /\[(?:tool[ _]?call|toolcall|tool)\s*[:=][\s\S]*$/i;

function stripBracketedToolCalls(text: string): string {
  const re = /\[(?:tool[ _]?call|toolcall|tool)\s*[:=]\s*["']?[\w.]+?["']?\]/gi;
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out += text.slice(cursor, m.index);
    const after = text.slice(m.index + m[0].length);
    const braceIdx = after.indexOf("{");
    if (braceIdx >= 0) {
      const json = extractBalancedJson(after);
      if (json) {
        let end = m.index + m[0].length + braceIdx + json.length;
        const fenceCheck = text.slice(end).match(/^\s*```/);
        if (fenceCheck) end += fenceCheck[0].length;
        cursor = end;
        re.lastIndex = cursor;
        continue;
      }
    }
    cursor = m.index + m[0].length;
  }
  out += text.slice(cursor);
  return out.replace(TRAILING_TOOL_BRACKETED, "");
}

const TRAILING_TOOL_TO_CODE =
  /(?:^|\s)to\s*=\s*["']?(?:functions\.)?[\w.]*?\s+code[\s\S]*$/i;

function stripToCodeToolCalls(text: string): string {
  const re = /(?:^|\s)to\s*=\s*["']?(?:functions\.)?([A-Za-z][\w.]*?)["']?\s+code\s*:\s*/gi;
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out += text.slice(cursor, m.index);
    const after = text.slice(m.index + m[0].length);
    const braceIdx = after.indexOf("{");
    if (braceIdx >= 0) {
      const json = extractBalancedJson(after.slice(braceIdx));
      if (json) {
        let end = m.index + m[0].length + braceIdx + json.length;
        const fenceCheck = text.slice(end).match(/^\s*```/);
        if (fenceCheck) end += fenceCheck[0].length;
        cursor = end;
        re.lastIndex = cursor;
        continue;
      }
    }
    cursor = m.index + m[0].length;
  }
  out += text.slice(cursor);
  return out.replace(TRAILING_TOOL_TO_CODE, "");
}

function stripBareJsonToolCalls(text: string): string {
  const re = /\{\s*"name"\s*:\s*"[A-Za-z][\w.]*"\s*,\s*"args"\s*:\s*\{/gi;
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out += text.slice(cursor, m.index);
    const json = extractBalancedJson(text.slice(m.index));
    if (json) {
      cursor = m.index + json.length;
      re.lastIndex = cursor;
      continue;
    }
    cursor = m.index + m[0].length;
  }
  out += text.slice(cursor);
  return out;
}

export function isToolFenceOnlyText(text: string): boolean {
  return stripToolCallSurfaces(text).trim().length === 0;
}
