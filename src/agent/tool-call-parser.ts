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
import { preprocessJson } from "./parser/xml-protocol.js";
import { salvageTruncatedWrite } from "./parser/salvage.js";
export { isMutatingToolName, looksLikeTruncatedToolCall, parseAllToolCalls, parseToolCall, sameToolCall } from "./parser/parse-entry.js";
export type { ParseToolCallOptions } from "./parser/parse-entry.js";
export { inferToolFromArgs, recognizeBareToolJson } from "./parser/bare-recognition.js";
export { formatFsReadLineRange, formatToolArgs } from "./parser/arg-formatting.js";
export { collapseRepeatedText } from "./parser/repetition.js";
export { salvageTruncatedWrite };
export type { SalvagedWrite } from "./parser/salvage.js";
export { preprocessJson };

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
    "BUILD FOCUS (specialization for software work — apply the professional loop, not a rigid scaffold script):",
    "This block is a soft classification. If the user is asking for explanation, review, comparison, or advice rather than directing a change, answer that question and do not mutate anything.",
    "ORIENT once: establish the actual project root, existing/new state, manifests/lockfile, conventions, and user boundary. A non-empty destination means continue the existing system; never re-scaffold over it. Do not repeatedly relist known parent directories.",
    "MODEL before edit: derive acceptance criteria and implicit invariants; trace touched contracts, callers, schemas, data/control flow, persistence, error states, and integration boundaries. Inspect only what resolves a decision-changing uncertainty.",
    "IMPLEMENT the complete behavior, not a thin proxy. A scaffold, generated file, successful compile, or happy path alone does not prove the requested feature. Preserve existing behavior outside the requested boundary.",
    "VERIFY proportionally: exercise relevant positive, negative, boundary, regression, and integration paths; run the stack's applicable checks and fix failures. For a local runtime deliverable, prove readiness/behavior, leave the server running, and report its URL/port/job id. Libraries and non-server artifacts use their own observable proof instead.",
    "On warnings or failures, interpret the evidence, revisit the causal model, and change layer or approach rather than repeating an identical command. Before finishing, reconcile changed files and affected surfaces against every acceptance criterion and disclose any residual gap.",
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
    "PENTEST FOCUS (security / pentest / VAPT specialization — pursue the objective with verified coverage, not activity theater):",
    "This is a soft classification. Derive each action from the authorized scope, attacker objective, observed system, current evidence, and expected impact. Reconnaissance, manual validation, content discovery, service expansion, client analysis, and scanners are options—not a mandatory checklist or sequence.",
    "Maintain a proportional attack-surface ledger across observed hosts, services, routes/parameters, identities/roles, assets, and trust boundaries. Mark material entries tested/untested with evidence. When a new surface or privilege boundary appears, branch it into task.add/reprioritization instead of ignoring it or erasing completed work.",
    "Develop and update hypotheses and a threat model from behavior. Prioritize high-impact authentication, authorization, business-flow, injection, and feature-specific paths only when the surface supports them; use safe controls to reject false positives and validate exploitability/impact with a reproducible PoC.",
    "A first finding or clean scanner run is not completion. Continue while an in-scope test can materially improve coverage, confidence, or impact; deepen and chain findings proportionally, but do not pad the engagement with equivalent tools or destructive proof.",
    "Use plan.create only when a durable outcome roadmap improves execution, and base it on evidence rather than a fixed recon gate. Record discoveries as outcome tasks, preserve completed evidence, and move reporting behind unresolved material work.",
    "Before closing, reconcile the ledger with scope and objective. Report severity, affected asset, evidence, reproduction, impact, remediation, and every material residual/untested surface with its reason. Never infer mature posture from untested classes. Flag out-of-scope assets; no local dev server for remote targets.",
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
