import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ChatMessage,
  ChatImage,
  ProviderId,
  ToolCall,
  ToolResult,
} from "../types.js";
import { streamWithProvider } from "../llm/router.js";
import {
  currentDateTimeContext,
  renderAgentSystemPrompt,
} from "../prompts/index.js";
import { getConfig } from "../store/config.js";
import {
  classifyToolCall,
  isPentestToolCall,
  scopeHint,
  scopeTargetForToolCall,
} from "../safety/classifier.js";
import { availableToolNames, normalizeToolCall, runToolCall } from "../tools/registry.js";
import { looksInteractiveStdin } from "../tools/shell.js";
import { reduceToolOutput } from "../tools/policies/output-policy.js";
import { formatViewportHint, registerViewport } from "../ui/output-pane.js";
import { compactMessages, estimateMessagesTokens } from "./context-manager.js";
import { auditLog } from "../store/logs.js";
import { loadProjectContext } from "../store/project.js";
import { loadScope, isScopeActive, targetInScope } from "../store/scope.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import {
  createThinkingStreamParser,
  rememberThinkingFromText,
  renderThinkingSummary,
} from "../ui/thinking.js";
import { renderMarkdown, indentAndWrapText } from "../ui/markdown.js";
import { startThinkingSpinner, type ThinkingSpinner } from "../ui/spinner.js";
import { safeCwd } from "../os/cwd.js";
import { analyzeTask } from "./task-analyzer.js";
import { LoopGuard } from "./loop-guard.js";
import {
  createPlan,
  loadPlan,
  savePlan,
  markTask,
  type SessionPlan,
  type TaskState,
} from "../store/plan.js";
import { renderPlanChecklist, renderPlanSidePane } from "../ui/plan-pane.js";
import type { AgentEvent } from "./events.js";

/** Render the plan as a right-side pane on wide terminals, else inline. */
function renderPlanForTerminal(plan: SessionPlan): string {
  const cols = process.stdout.columns ?? 0;
  const side = process.stdout.isTTY
    ? renderPlanSidePane(plan, cols)
    : undefined;
  return side ?? renderPlanChecklist(plan);
}

export interface SessionPolicy {
  /** Tools the user authorized once during this REPL session. Not persisted. */
  allow: Set<string>;
  /** Mutable flag so the runner can flip pentest auth for this session only. */
  pentestAuthorized: { value: boolean };
  /** Stable id used to scope the session's plan/tasks in the plan store. */
  sessionId: string;
  /** When true, the agent must follow its approved plan (set by /implement). */
  planApproved: { value: boolean };
}

export function createSessionPolicy(): SessionPolicy {
  return {
    allow: new Set(),
    pentestAuthorized: { value: false },
    sessionId: `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    planApproved: { value: false },
  };
}

export interface ConfirmPort {
  confirmTool(call: ToolCall): Promise<boolean>;
  confirmPentest(): Promise<boolean>;
}

export interface AgentRunOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  autoConfirm?: boolean | undefined;
  maxSteps?: number | undefined;
  signal?: AbortSignal | undefined;
  images?: ChatImage[] | undefined;
  onToolStart?: ((call: ToolCall) => void) | undefined;
  onToolResult?: ((call: ToolCall, result: ToolResult) => void) | undefined;
  onEvent?: ((event: AgentEvent) => void) | undefined;
  confirm?: ConfirmPort | undefined;
  requestSecret?: ((request: { title: string; prompt: string }) => Promise<string | undefined>) | undefined;
  session?: SessionPolicy | undefined;
}

function tryParseCall(raw: string): ToolCall | undefined {
  try {
    const parsed = JSON.parse(raw.trim()) as Partial<ToolCall>;
    if (
      typeof parsed.name === "string" &&
      parsed.args &&
      typeof parsed.args === "object"
    ) {
      return {
        name: parsed.name,
        args: parsed.args as Record<string, unknown>,
      };
    }
  } catch {
    // not valid JSON
  }
  return undefined;
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

function tryJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
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
function stripSentinelTokens(text: string): string {
  return text
    .replace(
      /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/gi,
      "",
    )
    .replace(/<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/gi, "")
    .replace(/<\|tool_calls?(?:_section)?_(?:begin|end)\|>/gi, "")
    .replace(/<\|tool_call_argument_begin\|>/gi, "")
    .replace(/<\|tool_[a-z_]*\|>/gi, "")
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

  // 2. <tool_call>...</tool_call>
  const xml = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
  if (xml?.[1]) {
    const call = tryParseCall(xml[1]);
    if (call) return call;
  }

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
  if (has("oldText") || has("newText")) return "fs.edit";
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
 * When a model means to call a tool but emits ONLY a bare JSON object —
 * either a proper {"name","args"} that the strict matchers missed, or a bare
 * args object like {"path":"file.pdf"} with the wrapper/fence dropped — this
 * recognizes it. Returns:
 *   - { call } when the object is a complete {name, args} tool call, or
 *   - { argsOnly: true } when it looks like a bare args object (so the caller
 *     can nudge the model to re-emit a properly named, fenced tool call).
 * Returns undefined for anything that is plainly a normal prose/JSON answer.
 */
export function recognizeBareToolJson(
  text: string,
): { call?: ToolCall; argsOnly?: boolean } | undefined {
  const inner = stripLoneFence(text);
  // Must be a single JSON object spanning the whole (de-fenced) output.
  if (!inner.startsWith("{") || !inner.endsWith("}")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  // Complete {name, args} call the earlier matchers didn't catch (e.g. not
  // anchored to end-of-string). Recover it directly.
  const direct = tryParseCall(inner);
  if (direct) return { call: direct };
  // Bare args object: every key is a known tool-arg key, and it carries at
  // least one identifying arg. Don't treat huge/odd objects as tool args.
  const keys = Object.keys(obj);
  if (keys.length === 0 || keys.length > 6) return undefined;
  const allKnown = keys.every((key) => TOOL_ARG_KEYS.has(key));
  if (!allKnown) return undefined;
  // Try to infer the tool from the arg shape so an unambiguous bare object
  // (e.g. {"command":"…"}) runs immediately instead of forcing the user to
  // type "run". Ambiguous shapes fall back to a re-emit nudge.
  const inferred = inferToolFromArgs(obj);
  if (inferred) {
    return { call: { name: inferred, args: obj } };
  }
  return { argsOnly: true };
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
 * Parse EVERY explicitly-delimited tool call in a message, in document
 * order. Unlike parseToolCall (which returns only the first), this lets the
 * runner execute a batch the model emitted in one turn — e.g. the natural
 * "task.update in_progress → do the work → task.update done" sequence, or
 * several fs.write calls. Only the unambiguous, delimited formats are
 * collected (```tool fences, <tool_call> XML, and Kimi sentinel blocks) so a
 * worked example in prose is far less likely to be mistaken for a call.
 * The runner executes them sequentially and STOPS the batch on the first
 * failure so the model can react, mirroring how Claude Code batches reads
 * and edits but pauses when something breaks.
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
    const call = tryParseCall(m[1] ?? "");
    if (call) found.push({ index: m.index, call });
  }

  const kimiRe = new RegExp(KIMI_TOOL_CALL_RE.source, "gi");
  while ((m = kimiRe.exec(text)) !== null) {
    const call = tryParseCall(
      JSON.stringify({ name: m[1], args: tryJson(m[2] ?? "{}") ?? {} }),
    );
    if (call) found.push({ index: m.index, call });
  }

  found.sort((a, b) => a.index - b.index);
  return found.map((f) => f.call);
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
function textBeforeToolCall(text: string): string {
  const patterns = [
    /```tool\s*\n?[\s\S]*?```/i,
    /<tool_call>[\s\S]*?<\/tool_call>/i,
    // Kimi/Moonshot sentinel block — strip from the section opener
    // (or the first call opener if the section header is missing).
    /<\|tool_calls_section_begin\|>[\s\S]*$/i,
    /<\|tool_call_begin\|>[\s\S]*$/i,
    /#{1,3}\s*tool\s*\n\s*\{[\s\S]*\}/i,
    /\*\*tool\*\*\s*\n\s*\{[\s\S]*\}/i,
    /```\w*\s*\n?\{[\s\S]*?"name"[\s\S]*?\}[\s\S]*?```/,
    /\{"name"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\}\s*$/,
  ];
  for (const pattern of patterns) {
    const idx = text.search(pattern);
    if (idx >= 0) {
      return text.slice(0, idx).trim();
    }
  }
  return text.trim();
}

function formatToolArgs(call: ToolCall): string {
  if (call.name === "shell.exec") return String(call.args.command ?? "");
  if (call.name === "net.scan")
    return `${call.args.target ?? ""}${call.args.ports ? ` -p ${call.args.ports}` : ""}${call.args.flags ? ` ${call.args.flags}` : ""}`;
  if (call.name === "pentest.recon") return String(call.args.target ?? "");
  if (call.name === "dns.lookup")
    return `${call.args.target ?? ""}${call.args.record ? ` ${call.args.record}` : " A"}`;
  if (call.name === "whois.lookup") return String(call.args.target ?? "");
  if (call.name === "fs.read" || call.name === "fs.write")
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
  return JSON.stringify(call.args);
}

const VOLATILE_SIGNAL_RE =
  /\b(?:current(?:ly)?|latest|newest|today|now|right now|live|recent|breaking|news|release[sd]?|version|prices?|stocks?|market|rates?|weather|forecast|elections?|results?|rankings?|standings?|stats?|cve|advis(?:ory|ories)|vulnerabilit(?:y|ies))\b/i;

const VOLATILE_ROLE_QUERY_RE =
  /\b(?:who(?:\s+is|'s)?|whos|name|tell\s+me|what(?:\s+is|'s)?)\b[\s\S]{0,120}\b(?:cm|chief\s+minister|prime\s+minister|president|governor|mayor|ministers?|cabinet|leader|head\s+of|ceo|cto|cfo|coo|chair(?:man|woman|person)?|coach|captain)\b/i;

const ROLE_OF_ENTITY_RE =
  /\b(?:cm|chief\s+minister|prime\s+minister|president|governor|mayor|ministers?|ceo|cto|cfo|coo|chair(?:man|woman|person)?|coach|captain)\s+(?:of|for|in)\b/i;

const EXPLICIT_WEB_LOOKUP_RE =
  /\b(?:search\s+(?:the\s+)?(?:web|internet|online)|look\s*up|google|verify\s+(?:online|on\s+the\s+web)|check\s+(?:online|the\s+web|internet))\b/i;

const STATIC_DISAMBIGUATION_RE =
  /\b(?:stand\s+for|stands\s+for|meaning|definition|define|abbreviation|centimeters?|centimetres?)\b/i;

const LOCAL_RUNTIME_RE =
  /\b(?:current\s+(?:directory|dir|cwd|working\s+directory|folder|path|user|shell|process(?:es)?|branch|git\s+branch|network|ip|interfaces?|working\s+tree)|pwd|whoami)\b/i;

// Signals that the current turn is (or continues) a coding / scaffolding
// task. These are intentionally broad — over-budgeting a build is cheap
// (the loop still stops as soon as the model gives a final answer) while
// under-budgeting silently truncates a half-built project.
const BUILD_TASK_RE =
  /\b(?:build|create|scaffold|generate|make|set\s*up|setup|bootstrap|init(?:ialize)?|implement|add|write|develop|code|refactor|migrate|convert|wire\s*up|integrate)\b[\s\S]{0,80}\b(?:app|application|project|site|website|web\s*app|server|api|service|component|page|module|feature|cli|script|library|package|frontend|backend|fullstack|game|bot|dashboard|form|endpoint|database|schema|test|tests|suite)\b/i;

const BUILD_STACK_RE =
  /\b(?:react|next(?:\.?js)?|vue|svelte|angular|vite|webpack|express|fastify|nest(?:js)?|django|flask|fastapi|rails|laravel|spring|node(?:\.?js)?|typescript|tailwind|redux|prisma|mongoose|graphql|docker|kubernetes)\b/i;

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
  /\b(?:compare|comparison|contrast|differ(?:ence|ences|s)?|pros\s+and\s+cons|trade-?offs?|versus|vs\.?|cheat\s*sheet|explain|describe|summari[sz]e|overview)\b/i;
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

// Matrix of action-verb narration: the model says it is *about to* do
// something but hasn't. Used to detect "narrate, don't act" stalls.
const ACTION_NARRATION_RE =
  /\b(?:let me|let's|i'?ll|i will|i'?m going to|i am going to|i need to|i should|i'?m about to|going to|now i'?ll|first[,]?\s*i'?ll)\s+(?:now\s+|first\s+|quickly\s+|just\s+|go\s+ahead\s+and\s+)?(?:explore|list|read|check|inspect|examine|look|create|run|start|write|build|add|scaffold|set\s*up|setup|install|initialize|init|generate|make|review|open|find|search|verify|update|edit|modify|fix|implement)\b/i;

/**
 * Detect a message that narrates an *upcoming* action ("let me explore the
 * directory", "I'll create the components") rather than an actual answer or
 * tool call. Used to catch models that describe intent but emit no tool call,
 * which would otherwise end the turn with nothing done. A real completion
 * summary (past tense, longer, or containing a code block) is NOT flagged.
 */
export function looksLikeActionNarration(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 600) return false;
  if (t.includes("```")) return false;
  return ACTION_NARRATION_RE.test(t);
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
  if (STATIC_DISAMBIGUATION_RE.test(text) || LOCAL_RUNTIME_RE.test(text)) {
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
    EXPLICIT_WEB_LOOKUP_RE.test(text)
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

function freshnessGuardMessage(now = new Date()): string {
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
function buildWorkflowDirective(): string {
  return [
    "BUILD WORKFLOW (this is a build/scaffold/feature task — follow this order EXACTLY; deviation is a failure):",
    "1. EXPLORE: fs.list the working directory (and key subdirs) to see what already exists. Use tool.batch to parallelize reads.",
    "2. UNDERSTAND: fs.read the files that matter (like package.json for js related and same for other languages too, config, entry points, existing components). Detect the existing stack/tooling and MATCH it. If the dir is empty or only has a stub, start fresh with a sensible modern default and say so.",
    "3. PLAN: call plan.create with a COMPREHENSIVE plan — a detailed `detail` (stack chosen and WHY, architecture, how you'll verify) and 4-8 SEPARATE, ordered, high-quality tasks. The FIRST task initializes the project (scaffolder); the MIDDLE tasks MUST implement the ACTUAL FEATURE the user asked for by REPLACING the scaffolder's boilerplate (e.g. rewrite src/App.jsx into the real todo/blog/etc. UI, add components, state, styles); the LAST task verifies with a build. Scaffolding + install + run ALONE is NOT acceptable — that just leaves the Vite starter page. Each task is one distinct, verifiable action. Then STOP and wait for the user to /implement.",
    "4. IMPLEMENT: once approved, work task by task in STRICT ORDER. For each task: call task.update {taskId, state:'in_progress'} → do the real work → VERIFY it actually succeeded (read a file you wrote, check the command's exit/output) → call task.update {taskId, state:'done'}, then move to the NEXT task. You MAY emit several tool calls in one message and they run in order, top to bottom (the batch STOPS if one fails). A clean rhythm is: task.update in_progress + the work + task.update done together. Keep going until EVERY task is done. Do NOT claim work you didn't actually run.",
    "",
    "INITIALIZE WITH THE OFFICIAL SCAFFOLDER FIRST (do NOT hand-write build configs):",
    "- React/Vue/Svelte/vanilla → `npm create vite@latest <appname> -- --template react` (templates: react, react-ts, vue, vue-ts, svelte, vanilla). Next.js → `npx --yes create-next-app@latest <appname> --yes --eslint --no-tailwind --app --src-dir --import-alias \"@/*\"`. Node API → `npm init -y`.",
    "- GET THE TEMPLATE FLAG RIGHT. With `npm create vite@latest NAME -- --template react` the `--` IS required (it forwards --template to create-vite). With `npx create-vite@latest NAME --template react` do NOT add `--` (npx passes args straight through, so `-- --template react` makes npx DROP the flag and you silently get the WRONG, vanilla template). Pick ONE form and keep the template flag attached. After scaffolding, fs.read the generated index.html / src entry to CONFIRM you got React (a src/main.jsx + App.jsx, not a vanilla main.js/counter.js). If it's the wrong template, delete the folder and re-run with the correct command.",
    "- RUN SCAFFOLDERS NON-INTERACTIVELY and into a NEW SUBFOLDER (`<appname>`). Scaffolders REFUSE to run in a non-empty directory and then print 'Operation cancelled' — and the current dir frequently already has a file like .DS_Store. So scaffold into a subfolder (always works). `--yes` does NOT fix the non-empty-dir cancel; a subfolder does. NEVER background a scaffolder with `&` or pipe `yes |` into it.",
    "- If a scaffolder cannot be driven non-interactively or keeps failing, FALL BACK to hand-writing a minimal Vite setup (package.json with \"type\":\"module\", @vitejs/plugin-react, index.html that loads /src/main.jsx, src/main.jsx, src/App.jsx) then `npm install`. That never prompts and you control every file.",
    "- VERIFY the init actually worked before marking the task done: fs.read package.json (it must now exist AND list react + react-dom) and fs.read index.html (it must reference your jsx entry). 'Operation cancelled' / non-zero exit means the task FAILED — do not proceed as if it succeeded.",
    "",
    "CRITICAL RULES during IMPLEMENTATION:",
    "- You may batch tool calls: emit one or several ```tool blocks in a message and they run in order, top to bottom. If any call fails, the rest of that batch is cancelled so you can react — so order dependent steps correctly and keep batches focused. A good batch is task.update(in_progress) + the work + task.update(done) for ONE task.",
    "- Do NOT re-explore. Step 1 (EXPLORE) was already completed during planning. Start executing the first pending task immediately.",
    "- ONE task at a time, in ORDER. Do NOT skip ahead to task 3 before task 2 is done.",
    "- KEEP EACH FILE SMALL ENOUGH TO WRITE IN ONE CALL. If a fs.write is reported as 'cut off (output too long)', the file was NOT fully written and is likely broken/invalid — re-write it, splitting a large component into smaller files if needed. NEVER leave a half-written file and move on.",
    "- VERIFY each step before marking it done: after writing files, fs.read the file back and confirm it is COMPLETE and syntactically valid (balanced braces/parens/JSX tags); after an install, check it exited 0. Marking a task done without a successful, verified tool call is the worst failure.",
    "- VERIFY THE BUILD, not just the dev server. `vite` / `npm run dev` reports 'ready' even when your App.jsx has syntax errors (the error only shows in the browser). To actually confirm the app works, run `npm run build` (it fails on real syntax/JSX errors) and check it exits 0. Seeing 'VITE ready' is NOT proof the app renders.",
    "- If a tool call FAILS (error output, non-zero exit, file missing), the task is NOT done. Mark it 'failed', diagnose WHY, fix it, and retry until it succeeds.",
    "- NEVER claim a task is done, files were created, a dependency is installed, or a server is running unless the tool call ACTUALLY succeeded and you saw the success output. If you have not run it, say so.",
    "- Start a dev server with shell.start (background job), NOT `npm run dev &` via shell.exec.",
    "- THE DELIVERABLE IS THE WORKING FEATURE, NOT THE SCAFFOLD. After scaffolding you MUST replace the starter boilerplate (Vite's default App.jsx counter, Next's starter page, etc.) with the actual app the user asked for. If the user asked for a todo app, src/App.jsx must contain a real todo UI with state — finishing with the untouched Vite starter page is a FAILURE even if the build passes.",
    "",
    "FORBIDDEN before plan approval (/implement): you MUST NOT use fs.write, fs.writeMany, fs.edit, shell.exec, shell.start, pkg.install, or pkg.uninstall. The ONLY tool allowed before approval is plan.create (and the read/list tools for exploration). If you are nudged to 'take action' before a plan exists, your action MUST be plan.create.",
    "If the task is genuinely trivial (a single tiny file), you may skip the plan — but for an app/feature, ALWAYS plan first.",
  ].join("\n");
}

export function shouldDimToolChatter(call: ToolCall): boolean {
  return call.name === "web.search";
}

/**
 * Re-assert raw mode AND resume stdin after an inquirer prompt
 * (confirm/password). inquirer's readline interface pauses stdin and
 * switches it to cooked mode when it closes; if we only flip raw mode back
 * on but leave stdin paused, no `keypress`/`data` events flow to the REPL's
 * ESC/Ctrl+C abort handler — so a long-running tool launched right after a
 * confirmation can no longer be aborted (the user had to kill the terminal).
 * Calling resume() restores the event flow.
 */
function restoreInteractiveStdin(): void {
  if (!process.stdin.isTTY) return;
  try {
    if (!(process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
  } catch {
    /* ignore */
  }
}

/**
 * Tools allowed while an UN-approved plan is active. Before the user runs
 * /implement, the agent may only (re)create the plan and do read-only
 * exploration to refine it — never execute. Everything else is blocked by
 * the plan-awaiting-approval gate so a stray/recovered tool call can't start
 * running the plan, and so free-text after a plan is treated as a revision.
 */
const PRE_APPROVAL_ALLOWED_TOOLS = new Set<string>([
  "plan.create",
  "task.update",
  "fs.read",
  "fs.list",
  "fs.search",
  "sysinfo",
  "tool.batch",
  "net.context",
]);

export function isPreApprovalAllowedTool(name: string): boolean {
  return PRE_APPROVAL_ALLOWED_TOOLS.has(name);
}

export function styleToolChatter(call: ToolCall, text: string): string {
  return shouldDimToolChatter(call) ? chalk.dim(text) : text;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    Boolean(signal?.aborted) ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/** OCR is opt-in when real image pixels are already attached to the model. */
export function shouldEnableImageOcr(
  prompt: string,
  hasAttachedImages: boolean,
): boolean {
  if (!hasAttachedImages) return true;
  return /\b(?:ocr|optical character recognition|tesseract)\b/i.test(prompt);
}

function safeArtifactName(name: string): string {
  return (
    name.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") ||
    "tool-output"
  );
}

async function saveToolOutput(
  call: ToolCall,
  output: string,
): Promise<string | undefined> {
  if (!output.trim()) return undefined;
  const dir = join(homedir(), ".clai", "outputs");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}-${safeArtifactName(call.name)}.txt`);
  await writeFile(path, `${output}\n`, "utf8");
  return path;
}

function summarizeOutput(
  output: string,
  maxChars = 8_000,
): { text: string; truncated: boolean } {
  if (output.length <= maxChars) return { text: output, truncated: false };

  const lines = output.split(/\r?\n/);
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  const half = Math.floor(maxChars / 2);

  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > half) break;
    head.push(line);
    used += cost;
  }

  used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = line.length + 1;
    if (used + cost > half) break;
    tail.unshift(line);
    used += cost;
  }

  return {
    text: [
      ...head,
      `... (${lines.length.toLocaleString()} output lines truncated) ...`,
      ...tail,
    ].join("\n"),
    truncated: true,
  };
}

function formatToolContext(call: ToolCall, result: ToolResult): string {
  const output = result.output.trim();
  if (!output) return "";
  let reduced: string | undefined;
  try {
    const command =
      call.name === "shell.exec" ? String(call.args.command ?? "") : call.name;
    const policy = reduceToolOutput(output, {
      toolName: call.name,
      command,
    });
    reduced = policy.summary.trim();
  } catch {
    reduced = undefined;
  }
  // Hard cap on the reduced text — reducers should already be small, but
  // never let one accidentally explode model context.
  const base = reduced && reduced.length > 0 ? reduced : output;
  const summary = summarizeOutput(base, 8_000);
  const saved = result.outputPath
    ? `\nFull output saved to: ${result.outputPath}`
    : "";
  return `${summary.text}${saved}`.trim();
}

const inquirerConfirmPort: ConfirmPort = {
  async confirmTool(call: ToolCall): Promise<boolean> {
    return confirm({
      message: chalk.yellow(`  run ${call.name}: ${formatToolArgs(call)}?`),
      default: true,
    });
  },
  async confirmPentest(): Promise<boolean> {
    return confirm({
      message: chalk.red(
        "clai only assists with security testing on systems you own or have written permission to test. Confirm for this session?",
      ),
      default: false,
    });
  },
};

async function ensurePentestAuthorization(
  call: ToolCall,
  autoConfirm: boolean,
  session: SessionPolicy,
  confirmPort: ConfirmPort,
): Promise<boolean> {
  if (!isPentestToolCall(call)) return true;
  // Persistent auth (via `clai authorize-pentest AGREE`) wins.
  if (getConfig().pentestAuthorized) return true;
  // Session auth flipped earlier in this session — no re-prompt.
  if (session.pentestAuthorized.value) return true;

  if (autoConfirm) {
    // -y is session-scoped only. We do NOT touch the persistent config so
    // a one-shot `-y` cannot silently authorize later interactive runs.
    session.pentestAuthorized.value = true;
    return true;
  }

  const ok = await confirmPort.confirmPentest();
  if (!ok) return false;
  session.pentestAuthorized.value = true;
  return true;
}

async function confirmToolExecution(
  call: ToolCall,
  autoConfirm: boolean,
  session: SessionPolicy,
  confirmPort: ConfirmPort,
): Promise<boolean> {
  const config = getConfig();
  if (autoConfirm) return true;
  if (session.allow.has(call.name)) return true;
  // Persistent allowlist kept for backwards compat with users who set it
  // through `clai config` directly, but `/allow` only mutates the session
  // set so authorizations never leak across processes.
  if (config.allowAlwaysTools.includes(call.name)) return true;

  return confirmPort.confirmTool(call);
}

interface PlanToolResult {
  handled: boolean;
  ok: boolean;
  plan?: SessionPlan | undefined;
  /** What to print to the user's terminal. */
  display: string;
  /** What to feed back to the model as the tool result. */
  modelNote: string;
}

/** Build the system-context block describing the session's active plan. */
function planContextMessage(plan: SessionPlan, approved: boolean): string {
  const lines: string[] = [];
  lines.push(
    `ACTIVE PLAN for this session (goal: ${plan.goal}, status: ${plan.status}):`,
  );
  if (plan.detail.trim()) lines.push(plan.detail.trim());
  lines.push("Tasks:");
  plan.tasks.forEach((t, i) => {
    lines.push(`  ${i + 1}. [${t.id}] (${t.state}) ${t.title}`);
  });
  if (approved) {
    const firstPending = plan.tasks.find((t) => t.state === "pending");
    lines.push("The user APPROVED this plan. Execute it task by task NOW.");
    if (firstPending) {
      lines.push(
        `START WITH TASK ${firstPending.id} (${firstPending.title}). ` +
          "Do NOT re-do tasks already marked done, and do NOT skip ahead to later tasks.",
      );
    }
    lines.push(
      "STRICT ORDER: call task.update {taskId, state:'in_progress'} → do the real work → " +
        "call task.update {taskId, state:'done'} ONLY after the tool calls actually succeed. " +
        "If a tool fails, mark the task 'failed' with a note, fix the problem, then retry. " +
        "Do NOT mark a task done when its commands error out. " +
        "Never claim something ran without a successful tool call.",
    );
  } else {
    lines.push(
      "This plan is NOT yet approved, so you MUST NOT execute any of its tasks yet. " +
        "Any new free-text message from the user right now is a PLAN REVISION, not approval — even if it " +
        "sounds like an instruction (e.g. 'do not install new tools', 'use only X', 'also add Y', 'skip task 2'). " +
        "Treat it as feedback: call plan.create AGAIN with the revised goal/detail/tasks to produce an updated " +
        "plan, then STOP and wait. Do NOT call shell.exec, pkg.install, net.scan, tool.check, fs.write, or any " +
        "other execution tool. The user will APPROVE with /implement, or CANCEL with /discard. Only after " +
        "/implement may you begin executing.",
    );
  }
  return lines.join("\n");
}

/**
 * Handle plan.create / task.update inline. These are session-scoped and
 * persisted via the plan store so the user can view the plan (Ctrl+P) and
 * the agent keeps it in context across the whole session.
 */
async function handlePlanTool(
  call: ToolCall,
  session: SessionPolicy,
  ctx: { loopGuard: LoopGuard; step: number },
): Promise<PlanToolResult> {
  void ctx;
  if (call.name === "plan.create") {
    const goal = typeof call.args.goal === "string" ? call.args.goal : "";
    const detail = typeof call.args.detail === "string" ? call.args.detail : "";
    const kind =
      typeof call.args.kind === "string" ? call.args.kind : "general";
    const rawTasks = Array.isArray(call.args.tasks) ? call.args.tasks : [];
    const taskTitles = rawTasks
      .map((t) => (typeof t === "string" ? t : ""))
      .filter(Boolean);
    if (!goal || taskTitles.length === 0) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          "  ✗ plan.create needs a non-empty goal and at least one task title\n",
        ),
        modelNote:
          "plan.create failed: provide a string goal and a non-empty tasks array of step titles.",
      };
    }
    // Reject a low-quality "everything in one step" plan. A single task that
    // itself enumerates many files/actions (commas, "and", slashes) is a sign
    // the model lumped the whole build into one checkbox — split it so the
    // user gets a real, trackable checklist and the executor works step by step.
    if (isLumpedSingleTask(taskTitles)) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          "  ✗ plan.create: that single task lumps the whole build into one step\n",
        ),
        modelNote:
          "plan.create rejected: you put everything into ONE task. Break it into 3-8 SEPARATE, " +
          "ordered tasks — each a distinct action, e.g. 'scaffold package.json + vite config', " +
          "'create index.html + entry (main.jsx)', 'build App + Post components', 'add posts data + styles', " +
          "'install deps and run dev server to verify'. Call plan.create again with that tasks array.",
      };
    }
    const plan = createPlan({
      sessionId: session.sessionId,
      goal,
      detail,
      taskTitles,
      kind,
    });
    await savePlan(plan).catch(() => undefined);
    // A freshly (re)created plan resets approval — the user must /implement.
    session.planApproved.value = false;
    const checklist = renderPlanForTerminal(plan);
    const display =
      chalk.cyan("  ● planning\n") +
      checklist +
      "\n" +
      chalk.dim(
        "  ✦ plan created — press Ctrl+P to view it, /implement to approve and run it,\n" +
          "    or /discard to cancel it. Any other message refines this plan.\n",
      );
    return {
      handled: true,
      ok: true,
      plan,
      display,
      modelNote:
        `Plan saved with ${plan.tasks.length} task(s). STOP here and wait — produce NO other tool calls now. ` +
        "Do NOT start executing tasks until the user approves with /implement. " +
        "If the user's next message gives feedback instead of /implement, that is a REVISION: call plan.create " +
        "again with the updated plan and STOP again. The user may cancel the whole plan with /discard. " +
        "Only after /implement do you begin, working task by task, calling task.update to mark each " +
        "in_progress before and done after you finish it.",
    };
  }

  // task.update
  const plan = await loadPlan(session.sessionId).catch(() => undefined);
  if (!plan) {
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        "  ✗ task.update: no active plan — call plan.create first\n",
      ),
      modelNote:
        "task.update failed: there is no active plan. Call plan.create first.",
    };
  }
  const taskId = typeof call.args.taskId === "string" ? call.args.taskId : "";
  const stateRaw = typeof call.args.state === "string" ? call.args.state : "";
  const note = typeof call.args.note === "string" ? call.args.note : undefined;
  const validStates: TaskState[] = [
    "pending",
    "in_progress",
    "done",
    "failed",
    "skipped",
  ];
  if (!validStates.includes(stateRaw as TaskState)) {
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        `  ✗ task.update: state must be one of ${validStates.join(", ")}\n`,
      ),
      modelNote: `task.update failed: state must be one of ${validStates.join(", ")}.`,
    };
  }
  const ok = markTask(plan, taskId, stateRaw as TaskState, note);
  if (!ok) {
    const ids = plan.tasks.map((t) => t.id).join(", ");
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        `  ✗ task.update: unknown taskId "${taskId}" (have: ${ids})\n`,
      ),
      modelNote: `task.update failed: unknown taskId. Valid ids: ${ids}.`,
    };
  }
  if (plan.status === "draft" || plan.status === "approved") {
    plan.status = "in_progress";
  }
  const allDone = plan.tasks.every(
    (t) => t.state === "done" || t.state === "skipped" || t.state === "failed",
  );
  if (allDone) plan.status = "completed";
  await savePlan(plan).catch(() => undefined);
  const checklist = renderPlanForTerminal(plan);
  return {
    handled: true,
    ok: true,
    plan,
    display: checklist + "\n",
    modelNote: allDone
      ? "Task updated. ALL tasks are now finished. Verify the result and give your final summary."
      : "Task updated. Continue with the next pending task.",
  };
}

export async function runAgentLoop(
  prompt: string,
  options: AgentRunOptions = {},
): Promise<string> {
  const writesDirectly = !options.onEvent;
  const emit = (event: AgentEvent): void => options.onEvent?.(event);
  const noopSpinner: ThinkingSpinner = {
    setLabel: () => {},
    bumpReasoning: () => {},
    pushPreview: () => {},
    stop: () => {},
  };
  const writeStatus = (text: string, rendered = chalk.dim(text)): void => {
    emit({ type: "status", text });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writeNotice = (
    level: "info" | "warn",
    text: string,
    rendered: string,
  ): void => {
    emit({ type: "notice", level, text });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writeAssistantMessage = (text: string): void => {
    emit({ type: "assistant-message", text });
    const rendered = renderMarkdown(text);
    if (writesDirectly) {
      process.stdout.write(text.endsWith("\n") ? rendered : `${rendered}\n`);
    }
  };
  const writeThinkingBlock = (content: string): void => {
    emit({ type: "thinking-block", content });
    if (writesDirectly) process.stdout.write(`${renderThinkingSummary(content)}\n`);
  };
  const writeToolOutput = (
    id: string,
    chunk: string,
    rendered: string,
  ): void => {
    emit({ type: "tool-output", id, chunk });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writeToolCall = (id: string, call: ToolCall, rendered: string): void => {
    emit({
      type: "tool-call",
      id,
      name: call.name,
      argsDisplay: formatToolArgs(call),
    });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writePlanUpdate = (plan: SessionPlan, rendered: string): void => {
    emit({ type: "plan-update", plan });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writeToolBlocked = (
    id: string,
    name: string,
    reason: string,
    rendered: string,
  ): void => {
    emit({ type: "tool-blocked", id, name, reason });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writeAbort = (): void => {
    emit({ type: "turn-aborted" });
    if (writesDirectly) process.stdout.write(chalk.yellow("  ⏹ Aborted.\n"));
  };
  const emitToolResult = (
    id: string,
    result: ToolResult,
    summary: string,
    artifactPath?: string,
  ): void => {
    const event: Extract<AgentEvent, { type: "tool-result" }> = {
      type: "tool-result",
      id,
      ok: result.ok,
      summary,
    };
    if (typeof result.exitCode === "number") {
      event.exitCode = result.exitCode;
    }
    if (artifactPath) {
      event.artifactPath = artifactPath;
    }
    emit(event);
  };
  const finishTurn = (answer: string, steps: number): string => {
    emit({ type: "turn-end", finalAnswer: answer, steps });
    return answer;
  };

  try {
    emit({ type: "turn-start", prompt });
    const config = getConfig();
  const maxSteps = options.maxSteps ?? 70;
  const confirmPort = options.confirm ?? inquirerConfirmPort;
  const projectContext = await loadProjectContext();
  const hasAttachedImages = Boolean(options.images?.length);
  const imageOcrEnabled = shouldEnableImageOcr(prompt, hasAttachedImages);
  // A vision-capable request already carries the actual image bytes. Hiding
  // image.ocr from the model prevents it from replacing visual inspection
  // with a lossy Tesseract pass (which produced fabricated screenshot text).
  const toolNames = availableToolNames().filter(
    (name) => name !== "image.ocr" || imageOcrEnabled,
  );
  // Build / scaffold / continuation turns must NEVER be diverted into a
  // web.search for "current info". The /implement directive ("Execute it
  // now…") and prompts like "create a react app" contain words such as
  // "now"/"latest" that trip the volatile-info regex; without this guard the
  // agent burns its turn searching the date instead of writing files.
  const buildLikeTurn = looksLikeBuildTask(prompt, options.history);
  const freshWebSearchRequired =
    !buildLikeTurn &&
    toolNames.includes("web.search") &&
    requiresFreshWebSearch(prompt);
  const systemSections = [renderAgentSystemPrompt(toolNames.join(", "))];
  if (projectContext) {
    systemSections.push(
      `Project context from .clai/context.md:\n${projectContext}`,
    );
  }
  if (freshWebSearchRequired) {
    systemSections.push(freshnessGuardMessage());
  }

  let provider = options.provider ?? config.defaultProvider;
  await ensureProviderConfigured(provider);
  let model = options.model ?? config.defaultModel;
  let lastAnswer = "";
  const session: SessionPolicy = options.session ?? createSessionPolicy();

  // ── Active plan context ────────────────────────────────────────────
  // If this session already has a plan, inject it so the model keeps it in
  // context. When the user has approved it (via /implement) we instruct the
  // agent to execute task by task; otherwise the agent should refine/wait.
  const activePlan = await loadPlan(session.sessionId).catch(() => undefined);
  if (activePlan) {
    systemSections.push(
      planContextMessage(activePlan, session.planApproved.value),
    );
  }

  // For build/scaffold turns with no active plan yet, inject an explicit
  // workflow so the agent does NOT rush to write files in one shot. It must
  // explore the directory, read the relevant existing files to understand
  // what's already there, create a comprehensive multi-task plan, then
  // implement task by task until the goal is met. This mirrors how a careful
  // coding agent (Claude Code) operates.
  if (buildLikeTurn && !activePlan) {
    systemSections.push(buildWorkflowDirective());
  }

  const fullSystemPrompt = systemSections.join("\n\n");
  const userMessage: ChatMessage = { role: "user", content: prompt };
  if (options.images && options.images.length > 0) {
    userMessage.images = options.images;
  }
  const messages: ChatMessage[] = [
    { role: "system", content: fullSystemPrompt },
    ...(options.history ?? []),
    userMessage,
  ];
  const recoveryUserMessage = (content: string): ChatMessage => {
    const message: ChatMessage = { role: "user", content };
    if (options.images && options.images.length > 0) {
      // Some OpenAI-compatible gateways/models attend most strongly to the
      // latest user turn. Keep the image attached on recovery nudges so a
      // thinking-only retry does not degrade into OCR/tool guessing.
      message.images = options.images;
    }
    return message;
  };

  // Track recent tool calls to detect models stuck in a loop calling the
  // same tool with the same arguments over and over (e.g. pentest.recon
  // called 3× on the same target without summarizing).
  const loopGuard = new LoopGuard();

  // Track consecutive thinking-only responses so we can nudge the model
  // to actually act instead of silently returning an empty answer.
  let emptyVisibleRetries = 0;

  // Track tool calls truncated by the token limit so we can ask the model
  // to retry in smaller pieces instead of leaking broken JSON as an answer.
  let truncatedToolRetries = 0;

  // Track bare-args JSON tool calls (missing the {name,args} wrapper / fence)
  // so we can nudge the model to re-emit a proper fenced call a few times
  // before giving up, instead of leaking the JSON as a final answer.
  let bareToolJsonRetries = 0;

  // Track a ```tool fence that is present but whose JSON could not be parsed
  // (e.g. malformed extra/missing braces that are NOT simple truncation). We
  // retry instead of leaking the raw block as the final answer.
  let malformedFenceRetries = 0;

  // For volatile live-info prompts, make one corrective pass if a model
  // ignores the freshness guard and tries to answer from stale memory.
  let sawFreshWebSearch = false;
  let freshnessRetryUsed = false;

  // Guard against a model that declares an approved plan "complete" while
  // tasks are still pending and it never ran the work. We nudge it back to
  // executing the next task a bounded number of times before giving up.
  let prematureCompletionRetries = 0;

  // Guard against a model that NARRATES intent ("let me explore the
  // directory…") but emits no tool call, so nothing runs and the turn ends
  // prematurely. On build/scaffold/plan turns where nothing has executed yet,
  // we nudge it to emit a real tool call instead of accepting the narration
  // as a final answer. Bounded so a model that truly can't emit the format
  // still terminates.
  let actionIntentRetries = 0;

  // ── Multi-tool execution queue ─────────────────────────────────────
  // Models naturally emit several tool calls in one message — e.g. the
  // plan-execution rhythm "task.update in_progress → do the work →
  // task.update done", or a batch of fs.write calls. Rather than running
  // only the first and discarding the rest (which made models believe work
  // ran when it didn't, and broke plan execution), we parse ALL calls in a
  // message, run the first this iteration, and queue the rest here to run on
  // subsequent iterations WITHOUT another model round-trip. The queue is
  // cleared whenever a call fails, is blocked, or needs the model to react,
  // so the model always sees errors and stays in control.
  let pendingCalls: ToolCall[] = [];

  // ── Step budget ───────────────────────────────────────────────────
  // The budget governs how many *productive* steps (a tool execution or a
  // final answer) the agent may take. Recovery iterations — nudging a model
  // that only produced thinking, asking it to re-emit a malformed tool call,
  // a freshness retry, or a loop-guard summary — do NOT consume this budget;
  // they get a separate hard ceiling so a wedged model can't spin forever.
  //
  // Complexity is a coarse signal from prompt length, but short follow-up
  // prompts ("do it", "build fully on your own", "app is not complete") in
  // the middle of a multi-file build must NOT be capped like a one-shot
  // lookup — that was the reason a React scaffold stopped half-built after
  // 10 steps. We bump the budget when the prompt (or recent history) looks
  // like a build/scaffold or a continuation of one.
  const analysis = analyzeTask(prompt);
  const hasHistory = (options.history?.length ?? 0) > 0;
  const buildLike = buildLikeTurn;
  let stepBudget =
    analysis.complexity === "simple"
      ? 20
      : analysis.complexity === "standard"
        ? 40
        : maxSteps;
  if (buildLike) {
    // Scaffolding / multi-file work needs room: many file writes plus a
    // verify/build step. Continuation prompts ("do it") inherit this too.
    stepBudget = Math.max(stepBudget, maxSteps);
  } else if (hasHistory) {
    // A follow-up to an ongoing task should never be capped tighter than a
    // standard one-shot, even if it's only a couple of words.
    stepBudget = Math.max(stepBudget, 40);
  }
  // Hard ceiling on total loop iterations (productive + recovery) so a model
  // stuck emitting only thinking or malformed calls can't loop indefinitely.
  const maxIterations = stepBudget * 3;

  let productiveSteps = 0;
  let step = -1;
  let nextToolEventId = 0;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    // `step` is the productive-step index (used for display + audit). It only
    // advances when the previous iteration actually executed a tool.
    step = productiveSteps;
    if (productiveSteps >= stepBudget) break;
    options.signal?.throwIfAborted();

    // `call` and `assistantText` are shared by both paths below: a fresh
    // model round-trip, or draining a previously-queued tool call.
    let call: ToolCall | undefined;
    let assistantText: { visible: string; thinkContent: string; hasThinking: boolean };
    let recoveredFromBareJson = false;

    if (pendingCalls.length > 0) {
      // Drain the next queued call from the previous model message — no new
      // round-trip. The assistant message and any prose were already shown
      // when the batch was parsed.
      call = pendingCalls.shift()!;
      assistantText = { visible: "", thinkContent: "", hasThinking: false };
      const batchStatus = `  ↳ continuing batch (${pendingCalls.length} more queued)\n`;
      writeStatus(
        batchStatus,
        chalk.dim(batchStatus),
      );
    } else {
    // Buffer LLM output so tool JSON and hidden thinking are not printed raw.
    // Status messages (rate-limit retries, fallback hints) still surface live.
    // A spinner gives the user feedback during long thinking phases on
    // models like glm-5.1 / deepseek-v4-flash that stream reasoning first.
    const streamLabel = step === 0 ? "waiting for model" : `step ${step + 1}`;
    const spinner = writesDirectly
      ? startThinkingSpinner(streamLabel, options.signal)
      : noopSpinner;
    if (!writesDirectly) {
      emit({ type: "status", text: streamLabel });
    }
    let sawReasoning = false;
    let inThinking = false;
    let emittedThinkingStatus = false;
    const deltaParser = writesDirectly
      ? undefined
      : createThinkingStreamParser(
          (text) => emit({ type: "assistant-delta", text }),
          (text) => {
            if (!emittedThinkingStatus) {
              emittedThinkingStatus = true;
              emit({ type: "status", text: "thinking" });
            }
            emit({ type: "thinking-delta", text });
          },
        );
    let completion;
    try {
      completion = await streamWithProvider(
        {
          provider,
          model,
          messages,
          temperature: 0.2,
          // Reasoning models can spend a lot on hidden thinking; give
          // them headroom so the visible answer / tool call isn't
          // truncated to silence. The non-thinking budget must be large
          // enough for a single-file fs.write / multi-file fs.writeMany
          // payload — a truncated tool-call JSON fails to parse and leaks a
          // broken (and syntactically invalid) file. 8k was too small for a
          // full component, so allow more room for the visible tool call.
          maxTokens: config.thinking?.enabled ? 16_384 : 12_288,
          signal: options.signal,
          thinking: config.thinking,
        },
        (token) => {
          deltaParser?.push(token);
          // Heuristic: <think>… markers and reasoning_content tokens flow
          // through onToken. Surface activity in the spinner so the screen
          // is never empty for minutes.
          if (!sawReasoning && /<think/i.test(token)) {
            sawReasoning = true;
            inThinking = true;
            spinner.setLabel("thinking");
            if (!writesDirectly) emit({ type: "status", text: "thinking" });
          }
          if (/<\/think>/i.test(token)) {
            inThinking = false;
          }
          // Only push reasoning tokens to the spinner preview. Visible
          // answer / tool-call tokens should NOT go through the dim
          // spinner preview — doing so makes the final answer appear
          // "diluted" in light font when the spinner's last render
          // briefly shows the answer text before being erased.
          if (inThinking) {
            const cleaned = token.replace(/<\/?think[^>]*>/gi, "");
            if (cleaned) {
              spinner.pushPreview(cleaned);
              const approx = cleaned.split(/\s+/).filter(Boolean).length;
              if (approx > 0) spinner.bumpReasoning(approx);
            }
          }
        },
        (status) => {
          spinner.stop();
          writeStatus(status, chalk.dim(status));
        },
      );
    } finally {
      // Always clear the spinner — abort, network error, or success.
      spinner.stop();
    }
    provider = completion.provider;
    model = completion.model;
    deltaParser?.finish();

    const assistantTextResult = rememberThinkingFromText(completion.text);
    assistantText = assistantTextResult;

    // Try visible text first, then thinking content — some models (e.g. glm-5.1)
    // wrap tool calls inside  considering tags, so stripThinking removes them
    // into thinkContent and visible becomes empty. Recovering from thinkContent
    // prevents an endless nudge loop where the model keeps hiding the call.
    call = parseToolCall(assistantText.visible, {
      strict: getConfig().parserStrict,
    });
    if (!call && assistantText.hasThinking) {
      call = parseToolCall(assistantText.thinkContent, {
        strict: getConfig().parserStrict,
      });
      if (call) {
        writeNotice(
          "info",
          "recovered tool call from thinking content",
          chalk.dim("  ℹ recovered tool call from thinking content\n"),
        );
      }
    }

    // ── Thinking-only recovery ────────────────────────────────────────
    // Some models (eg gpt-oss-20b on NVIDIA NIM) occasionally spend their
    // entire budget on hidden <think> reasoning and emit no visible text
    // or tool call. Without this guard the agent silently returns an empty
    // answer and the user has to re-submit the same prompt.
    if (!assistantText.visible.trim() && !call && assistantText.hasThinking) {
      emptyVisibleRetries += 1;
      if (emptyVisibleRetries <= 2) {
        writeThinkingBlock(assistantText.thinkContent);
        writeNotice(
          "warn",
          "model produced only thinking — nudging it to take action",
          chalk.yellow(
            "  ⚠ model produced only thinking — nudging it to take action\n",
          ),
        );
        messages.push({
          role: "assistant",
          content: collapseRepeatedText(completion.text),
        });
        const buildNudge =
          buildLikeTurn && !activePlan
            ? "You only produced internal reasoning with no visible answer or tool call. " +
              "This is a BUILD/SCAFFOLD task with NO plan yet. " +
              "You MUST call plan.create using the ```tool format to create a comprehensive plan BEFORE writing any files or running any commands. " +
              "Do NOT use fs.write, fs.writeMany, fs.edit, shell.exec, shell.start, or pkg.install yet. " +
              "Your ONLY allowed action right now is plan.create (or read/list for exploration)."
            : "You only produced internal reasoning with no visible answer or tool call. " +
              "You MUST either call a tool using the ```tool format or provide your final answer. " +
              "Do NOT wrap your tool call inside  considering or reasoning tags — put it in the VISIBLE response, not hidden. " +
              "If images are attached, inspect them directly for visual details (text, colors, layout, spacing, style) instead of using OCR unless explicitly needed. " +
              "Do NOT just think — take action NOW.";
        messages.push(recoveryUserMessage(buildNudge));
        continue;
      }
      // Exhausted retries — fall through to the normal empty-answer path
      // which will print a warning and return.
    } else {
      // Reset the counter on any successful visible output or recovered call.
      emptyVisibleRetries = 0;
    }

    // `call` was already extracted above (from visible text or thinking content).
    // Recovery: the model meant to call a tool but emitted a bare JSON object
    // with no ```tool fence — either a complete {name,args} the strict
    // matchers missed (recover it directly), or just an args object like
    // {"path":"file.pdf"} with the wrapper dropped (nudge a retry below so
    // the requested action runs instead of the JSON leaking as the answer).
    let bareArgsOnly = false;
    recoveredFromBareJson = false;
    if (!call) {
      const bare = recognizeBareToolJson(assistantText.visible);
      if (bare?.call) {
        call = bare.call;
        recoveredFromBareJson = true;
        writeNotice(
          "info",
          "recovered an unfenced tool call from bare JSON",
          chalk.dim("  ℹ recovered an unfenced tool call from bare JSON\n"),
        );
      } else if (bare?.argsOnly) {
        bareArgsOnly = true;
      }
    }
    // Also check thinking content for bare JSON calls.
    if (!call && assistantText.hasThinking) {
      const bareThink = recognizeBareToolJson(assistantText.thinkContent);
      if (bareThink?.call) {
        call = bareThink.call;
        recoveredFromBareJson = true;
        writeNotice(
          "info",
          "recovered an unfenced tool call from thinking content",
          chalk.dim(
            "  ℹ recovered an unfenced tool call from thinking content\n",
          ),
        );
      } else if (bareThink?.argsOnly) {
        bareArgsOnly = true;
      }
    }
    if (!call) {
      if (bareArgsOnly) {
        bareToolJsonRetries += 1;
        if (bareToolJsonRetries <= 3) {
          writeNotice(
            "warn",
            "tool call missing its name/fence — asking the model to re-emit a proper ```tool block",
            chalk.yellow(
              "  ⚠ tool call missing its name/fence — asking the model to re-emit a proper ```tool block\n",
            ),
          );
          messages.push({ role: "assistant", content: assistantText.visible });
          messages.push(
            recoveryUserMessage(
              buildLikeTurn && !activePlan
                ? "Your previous message was a bare JSON args object with no tool name and no ```tool fence, so NOTHING ran. " +
                    "This is a BUILD/SCAFFOLD task with NO plan yet. " +
                    "You MUST call plan.create using a proper ```tool block. For example:\n" +
                    '```tool\n{"name":"plan.create","args":{"goal":"scaffold todo app","detail":"...","tasks":["...","..."],"kind":"coding"}}\n```\n' +
                    "Do NOT use fs.write, fs.writeMany, shell.exec, or pkg.install yet."
                : "Your previous message was a bare JSON args object with no tool name and no ```tool fence, so NOTHING ran. " +
                    "Reply with ONLY a fenced ```tool block of the form " +
                    '`{"name": "<tool>", "args": { ... }}`. For example, to read a PDF:\n' +
                    '```tool\n{"name":"pdf.read","args":{"path":"/abs/file.pdf"}}\n```\n' +
                    "Choose the correct tool name for the task and include those args.",
            ),
          );
          continue;
        }
        // Exhausted retries — fall through to the normal answer path.
      }
      // Detect the case where the model emitted sentinel-style tool-call
      // markers but the body was malformed or truncated. Printing those
      // raw tokens looks like a crash to the user — instead, ask the
      // model to retry the tool call in a clean JSON format.
      if (
        /<\|tool_call(?:s_section)?_begin\|>|<\|tool_call_argument_begin\|>/i.test(
          assistantText.visible,
        )
      ) {
        writeNotice(
          "warn",
          "tool call was malformed or cut off — asking the model to retry in JSON form",
          chalk.yellow(
            "  ⚠ tool call was malformed or cut off — asking the model to retry in JSON form\n",
          ),
        );
        messages.push({ role: "assistant", content: assistantText.visible });
        messages.push(
          recoveryUserMessage(
            "Your previous tool call was malformed or truncated. " +
              "Reply with ONLY a fenced ```tool block containing valid JSON " +
              'of the form `{"name": "<tool>", "args": { ... }}`. ' +
              "Do not use <|tool_call_begin|> markers.",
          ),
        );
        continue;
      }
      // Detect a tool call that opened but was cut off by the token limit
      // (most common with a large multi-file fs.writeMany). Retrying with a
      // nudge to split the work is far better than rendering broken JSON as
      // a final answer and leaving the project half-created.
      if (looksLikeTruncatedToolCall(assistantText.visible)) {
        truncatedToolRetries += 1;
        if (truncatedToolRetries <= 3) {
          writeNotice(
            "warn",
            "tool call was cut off (output too long) — asking the model to retry in smaller pieces",
            chalk.yellow(
              "  ⚠ tool call was cut off (output too long) — asking the model to retry in smaller pieces\n",
            ),
          );
          messages.push({ role: "assistant", content: assistantText.visible });
          messages.push({
            role: "user",
            content:
              "Your previous tool call was cut off before it finished — the JSON was incomplete, so NOTHING ran. " +
              "Retry now with a COMPLETE, valid ```tool block. " +
              "If it was a large fs.writeMany, split it into SMALLER batches (3-5 files per call, and keep each file's content concise) " +
              "so the whole JSON fits in one response. Do NOT claim any file was written until a tool call actually succeeds.",
          });
          continue;
        }
        // Exhausted retries — fall through so we don't loop forever, but the
        // user at least sees the (broken) output and the stop notice.
      }
      // Detect a ```tool fence whose JSON could NOT be parsed for any other
      // reason (malformed braces, trailing junk, a stray `}` — NOT plain
      // truncation, which is handled above). Without this, the raw block
      // leaks to the screen as a code fence and the requested action (often
      // a whole fs.writeMany scaffold) silently never runs — exactly the
      // "fs.writeMany printed but nothing created" failure. Require the fence
      // to actually look like an intended call (mentions name/args) so a
      // genuine ```tool code example in prose isn't mistaken for one.
      const hasFencedCallShape =
        countToolFences(assistantText.visible) > 0 &&
        /```tool\s*\n[\s\S]*?"(?:name|args)"\s*:/i.test(assistantText.visible);
      if (hasFencedCallShape) {
        malformedFenceRetries += 1;
        if (malformedFenceRetries <= 3) {
          writeNotice(
            "warn",
            "tool block present but its JSON didn't parse — asking the model to re-emit valid JSON",
            chalk.yellow(
              "  ⚠ tool block present but its JSON didn't parse — asking the model to re-emit valid JSON\n",
            ),
          );
          messages.push({ role: "assistant", content: assistantText.visible });
          messages.push({
            role: "user",
            content:
              "Your previous message contained a ```tool block, but its JSON was INVALID, so NOTHING ran. " +
              "Common causes: an extra or missing `}` / `]`, a trailing brace after the closing `}`, or unescaped quotes/newlines inside a string value. " +
              'Re-emit ONE valid ```tool block of the exact form {"name":"<tool>","args":{...}} with balanced braces. ' +
              "If it was a large fs.writeMany, split it into SMALLER batches (3-5 files) so the JSON is easy to keep valid. " +
              "Do NOT claim any file was written until a tool call actually succeeds.",
          });
          continue;
        }
        // Exhausted retries — fall through to the normal path.
      }
      // Normal final-answer path: strip any stray sentinel tokens that
      // somehow leaked into prose so the answer renders cleanly.
      const cleaned = stripSentinelTokens(assistantText.visible);

      // ── Act, don't narrate ────────────────────────────────────────────
      // Build/scaffold/plan turns must DO something. If the model returns
      // prose with NO tool call, it is narrating intent ("Let me first
      // explore the directory…") or writing a PLAN as prose ("Goal: … Tasks:
      // … please approve") instead of calling a tool — accepting it as a
      // final answer ends the turn with nothing done and no real plan saved.
      // Nudge it to emit a real tool call, with a concrete example.
      const wantsAction =
        buildLikeTurn || (activePlan && session.planApproved.value);
      const planNarrated =
        buildLikeTurn && !activePlan && looksLikePlanNarration(cleaned);
      if (
        wantsAction &&
        cleaned.trim().length > 0 &&
        actionIntentRetries < 3 &&
        (productiveSteps === 0 ||
          planNarrated ||
          looksLikeActionNarration(cleaned))
      ) {
        actionIntentRetries += 1;
        let nudge: string;
        if (activePlan && session.planApproved.value) {
          nudge =
            "You wrote a message but emitted NO ```tool block, so NOTHING ran. Do NOT narrate what you will do — DO it. Emit the next tool call now (task.update / fs.writeMany / shell.exec) in a single ```tool block.";
          writeNotice(
            "warn",
            "described an action but emitted no tool call — nudging it to run one",
            chalk.yellow(
              "  ⚠ described an action but emitted no tool call — nudging it to run one\n",
            ),
          );
        } else if (planNarrated || productiveSteps > 0) {
          // It explored and/or wrote a plan as prose but never called
          // plan.create — emit the plan as a real tool call so the user gets
          // a checklist and the /implement gate.
          nudge =
            "You wrote the plan as PROSE but did NOT call plan.create, so no plan was saved and the user cannot /implement it. Emit it as a real tool call NOW — exactly one ```tool block:\n" +
            '```tool\n{"name":"plan.create","args":{"goal":"<short goal>","detail":"<stack/approach and how you\'ll verify>","tasks":["task 1","task 2","task 3"],"kind":"coding"}}\n```\n' +
            "Do not describe the plan again in prose — just emit the plan.create tool block.";
          writeNotice(
            "warn",
            "plan was written as text, not created — nudging it to call plan.create",
            chalk.yellow(
              "  ⚠ plan was written as text, not created — nudging it to call plan.create\n",
            ),
          );
        } else {
          nudge =
            "You described what you will do but emitted NO ```tool block, so NOTHING actually happened — narration is not action. Emit a real tool call NOW. For this build task, explore first like this:\n" +
            '```tool\n{"name":"fs.list","args":{"path":"."}}\n```\n' +
            "Then read key files, and once you understand the directory, call plan.create. Every turn MUST contain a ```tool block until the task is done.";
          writeNotice(
            "warn",
            "described an action but emitted no tool call — nudging it to run one",
            chalk.yellow(
              "  ⚠ described an action but emitted no tool call — nudging it to run one\n",
            ),
          );
        }
        messages.push({ role: "assistant", content: assistantText.visible });
        messages.push(recoveryUserMessage(nudge));
        continue;
      }

      if (freshWebSearchRequired && !sawFreshWebSearch && !freshnessRetryUsed) {
        freshnessRetryUsed = true;
        writeNotice(
          "info",
          "current-info question detected — searching the web before answering",
          chalk.dim(
            "  ℹ current-info question detected — searching the web before answering\n",
          ),
        );
        messages.push({ role: "assistant", content: assistantText.visible });
        messages.push({
          role: "user",
          content:
            freshnessGuardMessage() +
            " Reply with ONLY a fenced ```tool block for web.search now.",
        });
        continue;
      }
      // ── Premature-completion guard (approved plan still has work) ──────
      // If the user approved a plan and the model now gives a final answer
      // while tasks are still pending/in_progress — without having run the
      // work — it is fabricating completion (the exact "all tasks completed,
      // running at localhost:5173" failure). Force it back to executing the
      // next real task instead of accepting the false claim.
      if (session.planApproved.value && prematureCompletionRetries < 3) {
        const livePlan = await loadPlan(session.sessionId).catch(
          () => undefined,
        );
        const unfinished = livePlan?.tasks.filter(
          (t) => t.state === "pending" || t.state === "in_progress",
        );
        if (livePlan && unfinished && unfinished.length > 0) {
          prematureCompletionRetries += 1;
          const next = unfinished[0]!;
          writeNotice(
            "warn",
            `${unfinished.length} plan task(s) still unfinished — not accepting a "done" claim; resuming execution`,
            chalk.yellow(
              `  ⚠ ${unfinished.length} plan task(s) still unfinished — not accepting a "done" claim; resuming execution\n`,
            ),
          );
          messages.push({ role: "assistant", content: assistantText.visible });
          messages.push({
            role: "user",
            content:
              `You have NOT finished the approved plan: ${unfinished.length} task(s) remain ` +
              `(${unfinished.map((t) => `[${t.id}] ${t.title}`).join("; ")}). ` +
              `Do NOT claim the work is complete, that files were created, or that a server is running ` +
              `unless a tool call actually succeeded and you saw the output. ` +
              `Resume now with the NEXT task ${next.id} ("${next.title}"): call task.update {taskId:"${next.id}", state:"in_progress"}, ` +
              `then do the real work with a tool call (fs.writeMany / shell.exec / shell.start), VERIFY it, and mark it done. ` +
              `Continue task by task until EVERY task is actually finished.`,
          });
          continue;
        }
      }
      // If we still print a final answer while an approved plan has unfinished
      // tasks (retries exhausted), do NOT let a fabricated "it's done" stand
      // unchallenged — append an explicit, honest status so the user knows the
      // build did not actually complete.
      let completionWarning = "";
      let completionWarningText = "";
      if (session.planApproved.value) {
        const livePlan = await loadPlan(session.sessionId).catch(
          () => undefined,
        );
        const unfinished = livePlan?.tasks.filter(
          (t) => t.state === "pending" || t.state === "in_progress",
        );
        if (livePlan && unfinished && unfinished.length > 0) {
          completionWarningText =
            `${unfinished.length} of ${livePlan.tasks.length} plan task(s) are NOT actually complete. ` +
            "The summary above may overstate progress.";
          completionWarning =
            chalk.yellow(
              `\n  ⚠ ${unfinished.length} of ${livePlan.tasks.length} plan task(s) are NOT actually complete:\n`,
            ) +
            unfinished
              .map((t) => chalk.yellow(`    • [${t.id}] ${t.title}`))
              .join("\n") +
            chalk.dim(
              "\n  The summary above may overstate progress. Re-run with /implement, or ask clai to finish the remaining tasks.\n",
            );
        }
      }
      if (cleaned) {
        writeAssistantMessage(cleaned);
      }
      if (completionWarning) {
        writeNotice("warn", completionWarningText, completionWarning);
      }
      if (assistantText.hasThinking) {
        writeThinkingBlock(assistantText.thinkContent);
      }
      await auditLog("agent.final", { provider, model, steps: step + 1 });
      lastAnswer = cleaned;
      return finishTurn(lastAnswer, step + 1);
    }

      // A valid primary tool call exists for this fresh model turn. Show any
      // prose / thinking that preceded it, record the assistant message ONCE,
      // then queue any additional tool calls from the same message so they
      // run in order on the next iterations (no extra round-trip).
      const beforeTool = recoveredFromBareJson
        ? ""
        : textBeforeToolCall(assistantText.visible);
      if (beforeTool) {
        writeAssistantMessage(beforeTool);
      }
      if (assistantText.hasThinking) {
        writeThinkingBlock(assistantText.thinkContent);
      }
      messages.push({
        role: "assistant",
        content: collapseRepeatedText(assistantText.visible),
      });
      if (!recoveredFromBareJson && call) {
        const allCalls = parseAllToolCalls(assistantText.visible);
        if (
          allCalls.length > 1 &&
          allCalls[0] &&
          sameToolCall(allCalls[0], call)
        ) {
          pendingCalls = allCalls.slice(1);
          writeNotice(
            "info",
            `${allCalls.length} tool calls in this message — running them in order`,
            chalk.dim(
              `  ℹ ${allCalls.length} tool calls in this message — running them in order\n`,
            ),
          );
        }
      }
    }

    // Type guard: every path above either set `call` or returned/continued.
    if (!call) continue;

    // Models often emit a bare CLI name as the tool (e.g. {"name":"sed",...})
    // instead of wrapping it in shell.exec. Rewrite such unknown, un-namespaced
    // names into a shell.exec call BEFORE classification so the command both
    // runs and is safety-classified as the shell command it really is —
    // instead of dead-ending on "Unknown tool: sed".
    call = normalizeToolCall(call);

    if (call.name === "image.ocr" && !imageOcrEnabled) {
      pendingCalls = pendingCalls.filter((queued) => queued.name !== "image.ocr");
      writeNotice(
        "info",
        "skipped OCR because the original image is attached to the vision model",
        chalk.dim("  ℹ skipped OCR — inspecting the attached image directly\n"),
      );
      messages.push(
        recoveryUserMessage(
          "The original image is attached to this message and you can inspect it directly. " +
            "Do not call image.ocr or infer text from OCR. Answer the user's question from the actual image pixels now.",
        ),
      );
      continue;
    }
    const toolEventId = `tool-${++nextToolEventId}`;

    // ── Duplicate-call detection ──────────────────────────────────────────
    // If the model calls the exact same tool with the exact same args
    // repeatedly, it's stuck in a loop. Inject a corrective message
    // telling it to summarize the results it already has.
    const loopCheck = loopGuard.shouldBlock(call.name, call.args);
    if (loopCheck.block) {
      const isWrite =
        call.name === "fs.write" ||
        call.name === "fs.writeMany" ||
        call.name === "fs.edit";
      const reason = `${call.name} was already called with the same arguments — ${isWrite ? "moving on" : "forcing summary"}`;
      writeNotice(
        "warn",
        reason,
        chalk.yellow(
          `  ⚠ ${call.name} was already called with the same arguments — ${isWrite ? "moving on" : "forcing summary"}\n`,
        ),
      );
      // A repeat means this batch went off the rails — drop any queued calls
      // and let the model react. The assistant message was already recorded.
      pendingCalls = [];
      messages.push({
        role: "user",
        content: isWrite
          ? `You already wrote that exact file with ${call.name}. It is saved. ` +
            "Do NOT write it again. Move on to the NEXT file or step. If every file is written, " +
            "verify the project (list the tree, run the build/install command) and give your final answer."
          : `You already called ${call.name} with the same arguments and received results. ` +
            "Do NOT call it again. Summarize the findings you already have and give your final answer NOW.",
      });
      continue;
    }
    if (loopCheck.reason) {
      writeNotice("info", loopCheck.reason, chalk.dim(`  ℹ ${loopCheck.reason}\n`));
    }

    // ── Plan / task tools (session-scoped, handled inline) ─────────────
    // These don't go through the generic registry because they need the
    // session id and mutate the live plan that the user can view (Ctrl+P).
    if (call.name === "plan.create" || call.name === "task.update") {
      const planResult = await handlePlanTool(call, session, {
        loopGuard,
        step,
      });
      if (planResult.handled) {
        productiveSteps += 1;
        loopGuard.recordAttempt(step, call.name, call.args, planResult.ok, 0);
        if (planResult.plan) {
          writePlanUpdate(planResult.plan, planResult.display);
        }
        // plan.create means "STOP and wait for /implement" — abandon any
        // other calls the model batched alongside it.
        if (call.name === "plan.create") pendingCalls = [];
        messages.push({
          role: "tool",
          content: `Tool ${call.name} result (ok=${planResult.ok}):\n${planResult.modelNote}`,
        });
        continue;
      }
    }

    const scope = await loadScope();
    const decision = classifyToolCall(call, { scope });
    await auditLog("tool.classified", {
      call,
      decision,
      scope: isScopeActive(scope) ? (scope.name ?? "(unnamed)") : "(none)",
    });

    // ── Plan-awaiting-approval gate ────────────────────────────────────
    // When an active plan exists but the user has NOT approved it with
    // /implement, the agent must NOT execute the plan. Any free-text the
    // user typed after the plan was shown is a PLAN REVISION, not a "go"
    // signal — the agent should re-plan (plan.create) and wait again. We
    // hard-block execution tools here so a model that ignores the prompt
    // directive (or recovers a stray tool call) can't start running the
    // plan. Read-only exploration is still allowed so it can refine the
    // plan intelligently.
    if (
      activePlan &&
      !session.planApproved.value &&
      !isPreApprovalAllowedTool(call.name)
    ) {
      const reason = `plan awaiting approval — ${call.name} is blocked until you /implement (or /discard)`;
      writeNotice(
        "warn",
        reason,
        chalk.yellow(
          `  ⚠ plan awaiting approval — ${call.name} is blocked until you /implement (or /discard)\n`,
        ),
      );
      pendingCalls = [];
      messages.push({
        role: "user",
        content:
          `There is an ACTIVE PLAN that has NOT been approved yet, so you must NOT execute it — ` +
          `you tried to call ${call.name}, which is blocked. The user's latest message is a PLAN REVISION, ` +
          `not approval. Update the plan to incorporate their feedback by calling plan.create again with the ` +
          `revised goal/detail/tasks, then STOP and wait. The user approves with /implement or cancels with /discard. ` +
          `Do NOT run any execution tool (shell.exec, pkg.install, fs.write, net.scan, tool.check, etc.) until they /implement.`,
      });
      continue;
    }

    if (call.name === "web.search") {
      sawFreshWebSearch = true;
    }

    // Show tool call
    const toolCallLine =
      chalk.cyan(`  ▶ ${call.name}`) + chalk.gray(` ${formatToolArgs(call)}`);
    writeToolCall(
      toolEventId,
      call,
      styleToolChatter(call, toolCallLine) + "\n",
    );

    const scopeTarget = scopeTargetForToolCall(call);
    if (
      scopeTarget &&
      (!isScopeActive(scope) || !targetInScope(scopeTarget, scope))
    ) {
      writeNotice(
        "info",
        `scope optional: ${scopeHint(scopeTarget)}`,
        chalk.dim(`  scope optional: ${scopeHint(scopeTarget)}\n`),
      );
    }

    if (decision.level === "block") {
      writeToolBlocked(
        toolEventId,
        call.name,
        decision.reason,
        chalk.red(`  ✗ blocked: ${decision.reason}`) + "\n",
      );
      lastAnswer = `Blocked: ${call.name} — ${decision.reason}`;
      return finishTurn(lastAnswer, productiveSteps);
    }

    // Pentest authorization — if user confirms this, skip the per-tool confirm
    let pentestJustConfirmed = false;
    const needsPentestAuth =
      isPentestToolCall(call) &&
      !getConfig().pentestAuthorized &&
      !session.pentestAuthorized.value;
    const authorized = await ensurePentestAuthorization(
      call,
      Boolean(options.autoConfirm),
      session,
      confirmPort,
    );
    // inquirer's confirm() creates its own readline interface which resets
    // raw mode AND pauses stdin when it finishes. Re-assert raw mode and
    // resume stdin so the outer keypress handler (ESC/Ctrl+C abort, Ctrl+O
    // output pane) keeps working during the next streaming/tool phase.
    restoreInteractiveStdin();
    if (!authorized) {
      lastAnswer = "Pentest authorization not confirmed.";
      writeToolBlocked(
        toolEventId,
        call.name,
        lastAnswer,
        chalk.red(`  ✗ ${lastAnswer}`) + "\n",
      );
      return finishTurn(lastAnswer, productiveSteps);
    }
    if (needsPentestAuth) {
      pentestJustConfirmed = true;
    }

    // Confirm if needed (safe tools auto-execute, pentest-auth'd tools skip)
    // fs.delete and shell deletions NEVER auto-confirm even with -y flag.
    const forceManualConfirm = call.name === "fs.delete";
    if (decision.level === "confirm" && !pentestJustConfirmed) {
      const ok = await confirmToolExecution(
        call,
        forceManualConfirm ? false : Boolean(options.autoConfirm),
        session,
        confirmPort,
      );
      // Re-assert raw mode and resume stdin after inquirer's confirm()
      // (see restoreInteractiveStdin / the comment above).
      restoreInteractiveStdin();
      if (!ok) {
        lastAnswer = "Cancelled.";
        writeNotice("warn", "cancelled", chalk.yellow(`  ✗ cancelled`) + "\n");
        return finishTurn(lastAnswer, productiveSteps);
      }
    }

    // Execute tool
    options.signal?.throwIfAborted();
    options.onToolStart?.(call);

    // Heads-up when the command is about to run something that may pause
    // for a password prompt (sudo, ssh, gpg, ...). The shell tool already
    // routes such commands through inherited stdin so the user can type
    // directly into the controlling TTY; we just warn them to expect it.
    const interactiveCommand =
      (call.name === "shell.exec" &&
        typeof call.args.command === "string" &&
        looksInteractiveStdin(call.args.command)) ||
      call.name === "net.scan" ||
      call.name === "pentest.recon";
    if (interactiveCommand && process.stdin.isTTY) {
      writeNotice(
        "warn",
        "this command may prompt for a password — type it when asked",
        chalk.yellow(
          "  ⚠ this command may prompt for a password — type it when asked\n",
        ),
      );
    }
    let result: ToolResult;
    let liveBytes = 0;
    const liveCap = 16_000; // Stop streaming after this many bytes to avoid flooding the terminal.
    let liveTruncatedNotified = false;
    let lastProgressAt = 0;
    // When the underlying command may pause for a password prompt
    // (sudo / ssh / etc.) we stream the live preview *without* the dim
    // attribute so the prompt is fully readable. Otherwise we keep the
    // dim styling that makes ordinary tool chatter visually distinct
    // from the model's prose.
    const shouldDimLive = !interactiveCommand;
    const printLive = (chunk: string): void => {
      // Suppress live preview for fs.read / fs.list — those are read-only
      // and the final summary is already concise. Stream shell-style tools
      // (shell.exec, net.scan, pentest.recon, pkg.install).
      if (
        call.name === "fs.read" ||
        call.name === "fs.list" ||
        call.name === "fs.search"
      )
        return;
      if (liveBytes >= liveCap) {
        if (!liveTruncatedNotified) {
          liveTruncatedNotified = true;
          writeNotice(
            "info",
            "live preview truncated, full output saved",
            chalk.dim("\n  … live preview truncated, full output saved\n"),
          );
          writeNotice(
            "info",
            "tool still running — ESC or Ctrl+C to abort",
            chalk.dim("  (tool still running — ESC or Ctrl+C to abort)\n"),
          );
          lastProgressAt = Date.now();
        }
        // After truncation, show a dot every 5 seconds so the user knows
        // the tool is still running and the terminal isn't frozen.
        const now = Date.now();
        if (now - lastProgressAt > 5_000) {
          lastProgressAt = now;
          writeToolOutput(toolEventId, ".", chalk.dim("."));
        }
        return;
      }
      const remaining = liveCap - liveBytes;
      const slice =
        chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      liveBytes += slice.length;
      // Indent each line so live output lines up under the tool call.
      const indented = slice.replace(/\r/g, "").replace(/\n(?!$)/g, "\n  ");
      const body = indented.startsWith("\n") ? indented : `  ${indented}`;
      // Skip the dim wrapper for interactive commands so a sudo password
      // prompt is rendered at full brightness; everything else stays dim
      // so tool chatter is visually distinct from the model's prose.
      writeToolOutput(toolEventId, slice, shouldDimLive ? chalk.dim(body) : body);
    };

    try {
      result = await runToolCall(call, {
        signal: options.signal,
        requestSecret: options.requestSecret,
        onOutput: (chunk) => {
          if (options.signal?.aborted) return;
          printLive(chunk);
        },
      });
      // Newline separator if live output or progress dots didn't already end with one.
      if (liveBytes > 0 || liveTruncatedNotified) {
        writeToolOutput(toolEventId, "\n", "\n");
      }
    } catch (toolError) {
      if (isAbortError(toolError, options.signal)) {
        lastAnswer = "Aborted.";
        writeAbort();
        return lastAnswer;
      }
      const errMsg =
        toolError instanceof Error ? toolError.message : String(toolError);
      result = { ok: false, output: `Tool error: ${errMsg}`, exitCode: 1 };
    }
    // Stop-on-error: if this call failed, abandon any remaining queued calls
    // from the same message so the model sees the failure and decides what to
    // do next instead of blindly running steps that depended on it.
    if (!result.ok && pendingCalls.length > 0) {
      const cancelledQueuedStatus = `  ↳ ${pendingCalls.length} queued call(s) cancelled because this step failed\n`;
      writeStatus(
        cancelledQueuedStatus,
        chalk.dim(cancelledQueuedStatus),
      );
      pendingCalls = [];
    }
    const output = result.output.trim();
    const displayMax = 6_000;
    // If the tool already produced an artifact (shell.exec now streams to one
    // as it runs), respect that path. Otherwise, fall back to the post-hoc
    // save for tools that return their full output in memory.
    const savedOutputPath =
      result.outputPath ??
      (output.length > displayMax
        ? await saveToolOutput(call, output)
        : undefined);
    const resultWithArtifact: ToolResult = {
      ...result,
      outputPath: savedOutputPath,
      truncated: result.truncated ?? Boolean(savedOutputPath),
    };
    const contextOutput = formatToolContext(call, resultWithArtifact);
    emitToolResult(toolEventId, resultWithArtifact, contextOutput, savedOutputPath);
    options.onToolResult?.(call, resultWithArtifact);
    await auditLog("tool.result", {
      call,
      ok: result.ok,
      exitCode: result.exitCode,
      output: result.output.slice(0, 4_000),
    });

    // Record the attempt in the loop guard for dedup tracking.
    loopGuard.recordAttempt(
      step,
      call.name,
      call.args,
      result.ok,
      result.exitCode,
    );
    // A tool actually executed this iteration — count it against the
    // productive-step budget. Recovery iterations (thinking-only nudges,
    // malformed-call retries, freshness/loop-guard prompts) reach `continue`
    // before this point and therefore never consume the budget.
    productiveSteps += 1;

    // ── Auto-retry on "command not found" ──────────────────────────
    // Detect missing tools and instruct the model to install + retry.
    const NOT_FOUND_RE = /command not found|ENOENT.*spawn|is not recognized/i;
    if (!result.ok && NOT_FOUND_RE.test(output)) {
      const cmdName =
        call.name === "shell.exec"
          ? String(call.args.command ?? "").split(/\s+/)[0]
          : call.name === "net.scan"
            ? "nmap"
            : call.name === "image.ocr"
              ? "tesseract"
              : undefined;
      if (cmdName) {
        writeNotice(
          "warn",
          `${cmdName} not found — asking model to install and retry`,
          chalk.yellow(
            `  ⚠ ${cmdName} not found — asking model to install and retry\n`,
          ),
        );
        messages.push({
          role: "tool",
          content:
            `Tool failed: "${cmdName}" is not installed.\n` +
            `You MUST: 1) use pkg.install to install "${cmdName}", ` +
            `2) then RETRY the original command. Do NOT stop or give up.`,
        });
        continue;
      }
    }

    // ── Auto-retry on "a terminal is required" sudo error ──────────────
    // Older Node versions and some non-TTY contexts can still surface the
    // canonical sudo "a terminal is required" or "no askpass program"
    // failure. Tell the model to retry through plain `sudo …` (which the
    // shell tool now inherits stdin for) instead of getting clever with
    // -S / askpass / piping a password.
    const SUDO_NEEDS_TTY_RE =
      /sudo:\s+a terminal is required to read the password|sudo:\s+a password is required|no askpass program|sudo: \d+ incorrect password attempts|sudo:\s+(?:no tty present|sorry, you must have a tty)/i;
    if (!result.ok && SUDO_NEEDS_TTY_RE.test(output)) {
      writeNotice(
        "warn",
        "sudo needs an interactive terminal — asking the model to retry without -S/askpass",
        chalk.yellow(
          "  ⚠ sudo needs an interactive terminal — asking the model to retry without -S/askpass\n",
        ),
      );
      messages.push({
        role: "tool",
        content:
          "Tool failed: sudo could not read a password.\n" +
          "On the next attempt: call shell.exec with `sudo <command>` directly. " +
          "clai inherits stdin from the user's terminal, so the user can type the password live. " +
          'DO NOT use `echo "<pwd>" | sudo -S`, DO NOT use SUDO_ASKPASS, DO NOT ask the user for the password in chat. ' +
          "Just run `sudo <command>` and the password prompt will be visible.",
      });
      continue;
    }

    // Print tool result
    const statusIcon = result.ok ? chalk.green("  ✓") : chalk.red("  ✗");
    writeToolOutput(toolEventId, result.ok ? "ok\n" : "failed\n", statusIcon + "\n");
    if (output) {
      const displaySummary = summarizeOutput(output, displayMax);
      const displayText = displaySummary.truncated
        ? `${displaySummary.text}${savedOutputPath ? chalk.dim(`\n  ... full output saved to ${savedOutputPath}`) : chalk.dim("\n  ... output truncated")}`
        : displaySummary.text;
      // If we already streamed live output for this call, skip re-printing
      // the same bytes. Just note where the full output lives if it was saved.
      if (liveBytes > 0) {
        if (savedOutputPath) {
          writeNotice(
            "info",
            `full output saved to ${savedOutputPath}`,
            chalk.dim(`  full output saved to ${savedOutputPath}\n`),
          );
        }
      } else {
        const renderedOutput = indentAndWrapText(displayText);
        writeToolOutput(
          toolEventId,
          displayText,
          styleToolChatter(call, renderedOutput) + "\n",
        );
      }
    }
    if (isAbortError(undefined, options.signal)) {
      lastAnswer = "Aborted.";
      writeAbort();
      return lastAnswer;
    }

    // Register a collapse/expand viewport so the user can pull the full raw
    // output back with Ctrl+O or `/output last` after the AI summary lands.
    if (output) {
      const viewport = registerViewport({
        toolName: call.name,
        argsDisplay: formatToolArgs(call),
        artifactPath: savedOutputPath,
        summary: contextOutput,
      });
      // Only print the Ctrl+O hint when there's a real artifact file
      // (large output saved to disk). Avoid spamming the hint for
      // every tiny tool call — the user can always use /output last.
      if (savedOutputPath) {
        const viewportHint = `${formatViewportHint(viewport)}\n`;
        writeStatus(viewportHint, viewportHint);
      }
    }
    messages.push({
      role: "tool",
      content: `Tool ${call.name} result (exit=${result.exitCode ?? 0}, ok=${result.ok}):\n${contextOutput}`,
    });
    // Compact older messages when the running estimate exceeds budget so
    // free-tier context windows are not blown by long pentest sessions.
    if (estimateMessagesTokens(messages) > 24_000) {
      const compacted = compactMessages(messages);
      if (compacted.length < messages.length) {
        messages.splice(0, messages.length, ...compacted);
        await auditLog("agent.compact", {
          newLength: messages.length,
          estimatedTokens: estimateMessagesTokens(messages),
        });
      }
    }
  }

    lastAnswer = `Stopped after ${productiveSteps} steps.`;
    writeNotice("warn", lastAnswer, "  " + chalk.yellow(lastAnswer) + "\n");
    return finishTurn(lastAnswer, productiveSteps);
  } catch (error) {
    if (isAbortError(error, options.signal)) {
      writeAbort();
      return "Aborted.";
    }
    emit({
      type: "turn-error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
