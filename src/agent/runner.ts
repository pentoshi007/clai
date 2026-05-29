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
import { availableToolNames, runToolCall } from "../tools/registry.js";
import { looksInteractiveStdin } from "../tools/shell.js";
import { reduceToolOutput } from "../tools/policies/output-policy.js";
import { formatViewportHint, registerViewport } from "../ui/output-pane.js";
import { compactMessages, estimateMessagesTokens } from "./context-manager.js";
import { auditLog } from "../store/logs.js";
import { loadProjectContext } from "../store/project.js";
import { loadScope, isScopeActive, targetInScope } from "../store/scope.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import {
  rememberThinkingFromText,
  renderThinkingSummary,
} from "../ui/thinking.js";
import { renderMarkdown, indentAndWrapText } from "../ui/markdown.js";
import { startThinkingSpinner } from "../ui/spinner.js";
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
]);

/**
 * Strip a single wrapping ```json / ``` fence (if any) and return the inner
 * text trimmed. Leaves un-fenced text unchanged.
 */
function stripLoneFence(text: string): string {
  const fenced = text
    .trim()
    .match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
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
  if (allKnown) return { argsOnly: true };
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

/**
 * Decide whether this turn should get a generous step budget because it is
 * a multi-file build, a continuation of one, or a "it's not done yet" nudge.
 * Looks at the current prompt first, then falls back to the most recent
 * user/assistant turns so a terse follow-up inherits the build context.
 */
export function looksLikeBuildTask(
  prompt: string,
  history?: ChatMessage[] | undefined,
): boolean {
  const text = prompt.replace(/\s+/g, " ").trim();
  if (
    BUILD_TASK_RE.test(text) ||
    BUILD_STACK_RE.test(text) ||
    CONTINUATION_RE.test(text) ||
    INCOMPLETE_RE.test(text)
  ) {
    return true;
  }
  // Inspect recent history: if the conversation was already about building
  // something, treat a terse follow-up as part of that build.
  if (history && history.length > 0) {
    const recent = history.slice(-6);
    for (const msg of recent) {
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const h = msg.content.replace(/\s+/g, " ");
      if (BUILD_TASK_RE.test(h) || BUILD_STACK_RE.test(h)) return true;
    }
  }
  return false;
}

export function requiresFreshWebSearch(prompt: string): boolean {
  const text = prompt.replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (STATIC_DISAMBIGUATION_RE.test(text) || LOCAL_RUNTIME_RE.test(text)) {
    return false;
  }
  return (
    VOLATILE_SIGNAL_RE.test(text) ||
    VOLATILE_ROLE_QUERY_RE.test(text) ||
    ROLE_OF_ENTITY_RE.test(text) ||
    EXPLICIT_WEB_LOOKUP_RE.test(text)
  );
}

function freshnessGuardMessage(now = new Date()): string {
  return (
    `Freshness guard for this turn: the latest user prompt appears to ask for current, volatile, or externally verifiable information. The present moment is ${currentDateTimeContext(now)}. ` +
    "Before answering, call web.search FIRST with a concise query derived from the user prompt. " +
    "Shape the search query for the newest timeline by including current/latest or the current year/month when useful. " +
    "Use the search results to answer. If web.search fails or has no results, say that current information is unavailable instead of guessing from memory."
  );
}

export function shouldDimToolChatter(call: ToolCall): boolean {
  return call.name === "web.search";
}

function styleToolChatter(call: ToolCall, text: string): string {
  return shouldDimToolChatter(call) ? chalk.dim(text) : text;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    Boolean(signal?.aborted) ||
    (error instanceof Error && error.name === "AbortError")
  );
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

async function ensurePentestAuthorization(
  call: ToolCall,
  autoConfirm: boolean,
  session: SessionPolicy,
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

  const ok = await confirm({
    message: chalk.red(
      "clai only assists with security testing on systems you own or have written permission to test. Confirm for this session?",
    ),
    default: false,
  });
  if (!ok) return false;
  session.pentestAuthorized.value = true;
  return true;
}

async function confirmToolExecution(
  call: ToolCall,
  autoConfirm: boolean,
  session: SessionPolicy,
): Promise<boolean> {
  const config = getConfig();
  if (autoConfirm) return true;
  if (session.allow.has(call.name)) return true;
  // Persistent allowlist kept for backwards compat with users who set it
  // through `clai config` directly, but `/allow` only mutates the session
  // set so authorizations never leak across processes.
  if (config.allowAlwaysTools.includes(call.name)) return true;

  return confirm({
    message: chalk.yellow(`  run ${call.name}: ${formatToolArgs(call)}?`),
    default: true,
  });
}

interface PlanToolResult {
  handled: boolean;
  ok: boolean;
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
    lines.push(
      "The user APPROVED this plan. Execute it task by task NOW: before starting a task call " +
        'task.update with {"taskId":"<id>","state":"in_progress"}, do the work with real tool calls, ' +
        'then call task.update {"taskId":"<id>","state":"done"} (or "failed"/"skipped" with a note). ' +
        "Actually run installs and start servers — never claim something ran without a successful tool call. " +
        "When all tasks are done, verify and give a final summary.",
    );
  } else {
    lines.push(
      "This plan is NOT yet approved. If the user is refining it, update it with plan.create again. " +
        "Do NOT execute tasks until the user runs /implement.",
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
        "  ✦ plan created — press Ctrl+P to view it, or type /implement to approve and run it\n",
      );
    return {
      handled: true,
      ok: true,
      display,
      modelNote:
        `Plan saved with ${plan.tasks.length} task(s). STOP here and wait. ` +
        "Do NOT start executing tasks until the user approves with /implement. " +
        "When approved you will receive a message telling you to begin; then work task by task, " +
        "calling task.update to mark each in_progress before and done after you finish it.",
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
  const config = getConfig();
  const maxSteps = options.maxSteps ?? 30;
  const projectContext = await loadProjectContext();
  const toolNames = availableToolNames();
  const freshWebSearchRequired =
    toolNames.includes("web.search") && requiresFreshWebSearch(prompt);
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

  // For volatile live-info prompts, make one corrective pass if a model
  // ignores the freshness guard and tries to answer from stale memory.
  let sawFreshWebSearch = false;
  let freshnessRetryUsed = false;

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
  const buildLike = looksLikeBuildTask(prompt, options.history);
  let stepBudget =
    analysis.complexity === "simple"
      ? 15
      : analysis.complexity === "standard"
        ? 30
        : maxSteps;
  if (buildLike) {
    // Scaffolding / multi-file work needs room: many file writes plus a
    // verify/build step. Continuation prompts ("do it") inherit this too.
    stepBudget = Math.max(stepBudget, maxSteps);
  } else if (hasHistory) {
    // A follow-up to an ongoing task should never be capped tighter than a
    // standard one-shot, even if it's only a couple of words.
    stepBudget = Math.max(stepBudget, 30);
  }
  // Hard ceiling on total loop iterations (productive + recovery) so a model
  // stuck emitting only thinking or malformed calls can't loop indefinitely.
  const maxIterations = stepBudget * 3;

  let productiveSteps = 0;
  let step = -1;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    // `step` is the productive-step index (used for display + audit). It only
    // advances when the previous iteration actually executed a tool.
    step = productiveSteps;
    if (productiveSteps >= stepBudget) break;
    options.signal?.throwIfAborted();
    // Buffer LLM output so tool JSON and hidden thinking are not printed raw.
    // Status messages (rate-limit retries, fallback hints) still surface live.
    // A spinner gives the user feedback during long thinking phases on
    // models like glm-5.1 / deepseek-v4-flash that stream reasoning first.
    const spinner = startThinkingSpinner(
      step === 0 ? "waiting for model" : `step ${step + 1}`,
      options.signal,
    );
    let sawReasoning = false;
    let inThinking = false;
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
          // enough for a multi-file fs.writeMany payload — a truncated
          // tool-call JSON fails to parse and used to leak a broken
          // ```tool block to the screen with no files written.
          maxTokens: config.thinking?.enabled ? 16_384 : 8_192,
          signal: options.signal,
          thinking: config.thinking,
        },
        (token) => {
          // Heuristic: <think>… markers and reasoning_content tokens flow
          // through onToken. Surface activity in the spinner so the screen
          // is never empty for minutes.
          if (!sawReasoning && /<think/i.test(token)) {
            sawReasoning = true;
            inThinking = true;
            spinner.setLabel("thinking");
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
          process.stdout.write(chalk.dim(status));
        },
      );
    } finally {
      // Always clear the spinner — abort, network error, or success.
      spinner.stop();
    }
    provider = completion.provider;
    model = completion.model;

    const assistantText = rememberThinkingFromText(completion.text);

    // ── Thinking-only recovery ────────────────────────────────────────
    // Some models (eg gpt-oss-20b on NVIDIA NIM) occasionally spend their
    // entire budget on hidden <think> reasoning and emit no visible text
    // or tool call. Without this guard the agent silently returns an empty
    // answer and the user has to re-submit the same prompt.
    if (!assistantText.visible.trim() && assistantText.hasThinking) {
      emptyVisibleRetries += 1;
      if (emptyVisibleRetries <= 2) {
        process.stdout.write(
          `${renderThinkingSummary(assistantText.thinkContent)}\n`,
        );
        process.stdout.write(
          chalk.yellow(
            "  ⚠ model produced only thinking — nudging it to take action\n",
          ),
        );
        messages.push({ role: "assistant", content: completion.text });
        messages.push(
          recoveryUserMessage(
            "You only produced internal reasoning with no visible answer or tool call. " +
              "You MUST either call a tool using the ```tool format or provide your final answer. " +
              "If images are attached, inspect them directly for visual details (text, colors, layout, spacing, style) instead of using OCR unless explicitly needed. " +
              "Do NOT just think — take action NOW.",
          ),
        );
        continue;
      }
      // Exhausted retries — fall through to the normal empty-answer path
      // which will print a warning and return.
    } else {
      // Reset the counter on any successful visible output.
      emptyVisibleRetries = 0;
    }

    let call = parseToolCall(assistantText.visible, {
      strict: getConfig().parserStrict,
    });
    // Recovery: the model meant to call a tool but emitted a bare JSON object
    // with no ```tool fence — either a complete {name,args} the strict
    // matchers missed (recover it directly), or just an args object like
    // {"path":"file.pdf"} with the wrapper dropped (nudge a retry below so
    // the requested action runs instead of the JSON leaking as the answer).
    let bareArgsOnly = false;
    let recoveredFromBareJson = false;
    if (!call) {
      const bare = recognizeBareToolJson(assistantText.visible);
      if (bare?.call) {
        call = bare.call;
        recoveredFromBareJson = true;
        process.stdout.write(
          chalk.dim("  ℹ recovered an unfenced tool call from bare JSON\n"),
        );
      } else if (bare?.argsOnly) {
        bareArgsOnly = true;
      }
    }
    if (!call) {
      if (bareArgsOnly) {
        bareToolJsonRetries += 1;
        if (bareToolJsonRetries <= 3) {
          process.stdout.write(
            chalk.yellow(
              "  ⚠ tool call missing its name/fence — asking the model to re-emit a proper ```tool block\n",
            ),
          );
          messages.push({ role: "assistant", content: assistantText.visible });
          messages.push(
            recoveryUserMessage(
              "Your previous message was a bare JSON args object with no tool name and no ```tool fence, so NOTHING ran. " +
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
        process.stdout.write(
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
          process.stdout.write(
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
      // Normal final-answer path: strip any stray sentinel tokens that
      // somehow leaked into prose so the answer renders cleanly.
      const cleaned = stripSentinelTokens(assistantText.visible);
      if (freshWebSearchRequired && !sawFreshWebSearch && !freshnessRetryUsed) {
        freshnessRetryUsed = true;
        process.stdout.write(
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
      if (cleaned) {
        process.stdout.write(renderMarkdown(cleaned));
        if (!cleaned.endsWith("\n")) process.stdout.write("\n");
      }
      if (assistantText.hasThinking) {
        process.stdout.write(
          `${renderThinkingSummary(assistantText.thinkContent)}\n`,
        );
      }
      await auditLog("agent.final", { provider, model, steps: step + 1 });
      lastAnswer = cleaned;
      return lastAnswer;
    }

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
      process.stdout.write(
        chalk.yellow(
          `  ⚠ ${call.name} was already called with the same arguments — ${isWrite ? "moving on" : "forcing summary"}\n`,
        ),
      );
      messages.push({ role: "assistant", content: assistantText.visible });
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
      process.stdout.write(chalk.dim(`  ℹ ${loopCheck.reason}\n`));
    }

    // Print only non-thinking text before the tool call. When the call was
    // recovered from a bare JSON object (the whole message WAS the call),
    // there is no prose to show — skip it so we don't echo the raw JSON.
    const beforeTool = recoveredFromBareJson
      ? ""
      : textBeforeToolCall(assistantText.visible);
    if (beforeTool) {
      process.stdout.write(renderMarkdown(beforeTool) + "\n");
    }
    if (assistantText.hasThinking) {
      process.stdout.write(
        `${renderThinkingSummary(assistantText.thinkContent)}\n`,
      );
    }

    messages.push({ role: "assistant", content: assistantText.visible });

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
        process.stdout.write(planResult.display);
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

    if (call.name === "web.search") {
      sawFreshWebSearch = true;
    }

    // Show tool call
    const toolCallLine =
      chalk.cyan(`  ▶ ${call.name}`) + chalk.gray(` ${formatToolArgs(call)}`);
    process.stdout.write(styleToolChatter(call, toolCallLine) + "\n");

    const scopeTarget = scopeTargetForToolCall(call);
    if (
      scopeTarget &&
      (!isScopeActive(scope) || !targetInScope(scopeTarget, scope))
    ) {
      process.stdout.write(
        chalk.dim(`  scope optional: ${scopeHint(scopeTarget)}\n`),
      );
    }

    if (decision.level === "block") {
      process.stdout.write(chalk.red(`  ✗ blocked: ${decision.reason}`) + "\n");
      lastAnswer = `Blocked: ${call.name} — ${decision.reason}`;
      return lastAnswer;
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
    );
    // inquirer's confirm() creates its own readline interface which resets
    // raw mode when it finishes. Re-assert raw mode so the outer keypress
    // handler (ESC/Ctrl+C abort, Ctrl+O output pane) keeps working during
    // the next streaming phase.
    if (
      process.stdin.isTTY &&
      !(process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw
    ) {
      try {
        process.stdin.setRawMode(true);
      } catch {
        /* ignore */
      }
    }
    if (!authorized) {
      lastAnswer = "Pentest authorization not confirmed.";
      process.stdout.write(chalk.red(`  ✗ ${lastAnswer}`) + "\n");
      return lastAnswer;
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
      );
      // Re-assert raw mode after inquirer's confirm() (see comment above).
      if (
        process.stdin.isTTY &&
        !(process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw
      ) {
        try {
          process.stdin.setRawMode(true);
        } catch {
          /* ignore */
        }
      }
      if (!ok) {
        lastAnswer = "Cancelled.";
        process.stdout.write(chalk.yellow(`  ✗ cancelled`) + "\n");
        return lastAnswer;
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
      call.name === "shell.exec" &&
      typeof call.args.command === "string" &&
      looksInteractiveStdin(call.args.command);
    if (interactiveCommand && process.stdin.isTTY) {
      process.stdout.write(
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
          process.stdout.write(
            chalk.dim("\n  … live preview truncated, full output saved\n"),
          );
          process.stdout.write(
            chalk.dim("  (tool still running — ESC or Ctrl+C to abort)\n"),
          );
          lastProgressAt = Date.now();
        }
        // After truncation, show a dot every 5 seconds so the user knows
        // the tool is still running and the terminal isn't frozen.
        const now = Date.now();
        if (now - lastProgressAt > 5_000) {
          lastProgressAt = now;
          process.stdout.write(chalk.dim("."));
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
      process.stdout.write(shouldDimLive ? chalk.dim(body) : body);
    };

    try {
      result = await runToolCall(call, {
        signal: options.signal,
        onOutput: (chunk) => {
          if (options.signal?.aborted) return;
          printLive(chunk);
        },
      });
      // Newline separator if live output or progress dots didn't already end with one.
      if (liveBytes > 0 || liveTruncatedNotified) process.stdout.write("\n");
    } catch (toolError) {
      if (isAbortError(toolError, options.signal)) {
        lastAnswer = "Aborted.";
        process.stdout.write(chalk.yellow("  ⏹ Aborted.\n"));
        return lastAnswer;
      }
      const errMsg =
        toolError instanceof Error ? toolError.message : String(toolError);
      result = { ok: false, output: `Tool error: ${errMsg}`, exitCode: 1 };
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
        process.stdout.write(
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
      process.stdout.write(
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
    process.stdout.write(statusIcon + "\n");
    if (output) {
      const displaySummary = summarizeOutput(output, displayMax);
      const displayText = displaySummary.truncated
        ? `${displaySummary.text}${savedOutputPath ? chalk.dim(`\n  ... full output saved to ${savedOutputPath}`) : chalk.dim("\n  ... output truncated")}`
        : displaySummary.text;
      // If we already streamed live output for this call, skip re-printing
      // the same bytes. Just note where the full output lives if it was saved.
      if (liveBytes > 0) {
        if (savedOutputPath) {
          process.stdout.write(
            chalk.dim(`  full output saved to ${savedOutputPath}\n`),
          );
        }
      } else {
        const renderedOutput = indentAndWrapText(displayText);
        process.stdout.write(styleToolChatter(call, renderedOutput) + "\n");
      }
    }
    if (isAbortError(undefined, options.signal)) {
      lastAnswer = "Aborted.";
      process.stdout.write(chalk.yellow("  ⏹ Aborted.\n"));
      return lastAnswer;
    }

    const contextOutput = formatToolContext(call, resultWithArtifact);

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
        process.stdout.write(`${formatViewportHint(viewport)}\n`);
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
  process.stdout.write("  " + chalk.yellow(lastAnswer) + "\n");
  return lastAnswer;
}
