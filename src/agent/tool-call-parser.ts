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

export function salvageTruncatedWriteFromNative(
  name: string,
  rawArguments: string | undefined,
): ReturnType<typeof salvageTruncatedWrite> {
  if (!NATIVE_WRITE_TOOLS.has(name) || !rawArguments?.trim()) return undefined;
  const raw = rawArguments.trim();
  const synthetic = raw.includes(`"name"`)
    ? raw
    : `{"name":${JSON.stringify(name)},"args":${raw.startsWith("{") ? raw : `{}`}`;
  return salvageTruncatedWrite(synthetic);
}

export function countToolFences(text: string): number {
  const matches = text.match(/```tool\s*\n[\s\S]*?```/gi);
  return matches ? matches.length : 0;
}

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

export function buildTurnHistory(
  messages: ChatMessage[],
  answer: string,
): ChatMessage[] {
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

export function textBeforeToolCall(text: string): string {
  const patterns = [
    /```tool\s*\n?[\s\S]*$/i,
    /<tool_call>[\s\S]*$/i,
    /<tool_calls:[A-Za-z0-9_-]+>[\s\S]*$/i,
    /<tool_call:[A-Za-z0-9_-]+>[\s\S]*$/i,
    /<[|｜]+DSML[|｜]+tool_calls\b[\s\S]*$/i,
    /<[|｜]+DSML[|｜]+invoke\b[\s\S]*$/i,
    /<[|｜]+DSML[|｜]+parameter\b[\s\S]*$/i,
    /<[|｜]+open[|｜]+>?tools\b[\s\S]*$/i,
    /<[|｜]+open[|｜]+>?call\b[\s\S]*$/i,
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

const SOCIAL_OR_IDLE_PROMPT_RE =
  /^(?:hi|hii+|hello|hey(?:\s+there)?|yo|sup|howdy|hiya|good\s+(?:morning|afternoon|evening|night)|thanks?(?:\s+you)?|thx|ty|ok(?:ay)?|cool|great|nice|awesome|perfect|bye|goodbye|see\s+ya|cheers|gm|gn|how\s+are\s+you(?:\s+doing)?|what'?s\s+up|wassup)(?:\s*[!.?]*)?$/i;

const BUILD_TASK_RE =
  /\b(?:build|create|scaffold|generate|make|set\s*up|setup|bootstrap|init(?:ialize)?|implement|add|write|develop|code|refactor|migrate|convert|wire\s*up|integrate)\b[\s\S]{0,80}\b(?:app|application|project|site|website|web\s*app|server|api|service|component|page|module|feature|cli|script|library|package|frontend|backend|fullstack|game|bot|dashboard|form|endpoint|database|schema|test|tests|suite|auth|authentication|authorization|login|signup|middleware|route|routes|routing|handler|controller|model|view)\b/i;

const BUILD_STACK_RE =
  /\b(?:react|next(?:\.?js)?|vue|svelte|angular|vite|webpack|express|fastify|nest(?:js)?|django|flask|fastapi|rails|laravel|spring|node(?:\.?js)?|typescript|tailwind|redux|prisma|mongoose|graphql|docker|kubernetes)\b/i;

const PENTEST_TASK_RE =
  /\b(?:pentest|pen[\s-]?test|penetration|security\s*(?:test|audit|scan|assess(?:ment)?)|csrf|xss|sqli|sql[\s-]?inject|rce|lfi|rfi|ssrf|idor|xxe|brute[\s-]?force|enumerat\w*|exploit\w*|vulnerabilit\w*|recon\w*|bug[\s-]?bounty|ctf|capture[\s-]?the[\s-]?flag|red[\s-]?team|offensive|nmap|nikto|nuclei|ffuf|gobuster|sqlmap|hydra|metasploit)\b/i;

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

const CONTINUATION_RE =
  /^(?:do\s+it|build\s+it|build\s+fully|build\s+it\s+fully|go\s+ahead|continue|proceed|keep\s+going|finish(?:\s+it)?|complete(?:\s+it)?|yes|ok(?:ay)?|make\s+it|run\s+it|next|on\s+your\s+own|build\s+(?:fully\s+)?on\s+your\s+own)\b/i;

const INCOMPLETE_RE =
  /\b(?:not\s+complete|incomplete|isn'?t\s+(?:done|complete|working|finished)|doesn'?t\s+work|still\s+(?:broken|missing|failing)|missing\s+(?:files?|parts?)|finish\s+(?:the|it)|complete\s+(?:the|it))\b/i;

const PLAN_EXECUTION_RE =
  /\b(?:approve the plan|execute it (?:now|task by task)|task by task|execute the plan|implement the plan)\b/i;

const INFORMATIONAL_SIGNAL_RE =
  /\b(?:compare|comparison|contrast|differ(?:ence|ences|s)?|pros\s+and\s+cons|trade-?offs?|versus|vs\.?|cheat\s*sheet|explain|describe|summari[sz]e|overview|tell\s+me)\b/i;
const INTERROGATIVE_LEAD_RE =
  /^(?:what|which|why|how|when|who|where|is|are|do|does|did|can|could|should|would|will)\b/i;

function messageImpliesBuild(text: string): boolean {
  if (!text) return false;
  if (INFORMATIONAL_SIGNAL_RE.test(text)) return false;
  if (BUILD_TASK_RE.test(text)) return true;
  if (text.endsWith("?") || INTERROGATIVE_LEAD_RE.test(text)) return false;
  return BUILD_STACK_RE.test(text);
}

export function looksLikeBuildTask(
  prompt: string,
  history?: ChatMessage[] | undefined,
): boolean {
  const text = prompt.replace(/\s+/g, " ").trim();
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

const ACTION_NARRATION_RE =
  /\b(?:let me|let's|i'?ll|i will|i'?m going to|i am going to|i need to|i should|i'?m about to|going to|now i'?ll|first[,]?\s*i'?ll|we need to|we should|we'?ll|we will|we'?re going to)\s+(?:now\s+|first\s+|quickly\s+|just\s+|go\s+ahead\s+and\s+)?(?:explore|list|read|fetch|browse|check|inspect|examine|look|create|run|start|write|build|add|scaffold|set\s*up|setup|install|initialize|init|generate|make|review|open|find|search|verify|update|edit|modify|fix|implement|gather|assess|scan|audit|retry|restart)\b/i;

const ERROR_FIX_ALREADY_DONE_RE =
  /\b(?:i(?:'?ve| have)\s+(?:already\s+)?(?:fixed|applied|added|patched|updated|changed|edited)|(?:already|now)\s+(?:fixed|applied|working)|fix(?:ed)?\s+(?:is\s+)?(?:in\s+place|applied|verified|complete)|(?:is\s+)?now\s+fixed|no longer (?:errors?|fails?|broken)|should now work|hmr (?:update|applied|reloaded)|build (?:successful|passed|succeeded)|verification complete|fix verified|successfully (?:fixed|applied|patched)|the (?:app|page|site) (?:should )?(?:now )?(?:work|load)s?)\b/i;

export function looksLikeErrorDiagnosisWithFixIntent(text: string): boolean {
  const t = text.trim();
  if (t.length < 20 || t.length > 2_000) return false;
  if (t.includes("```tool")) return false;
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

export function localHttpProbeIsFailure(output: string): boolean {
  const head = output.slice(0, 400);
  if (/^(?:[45]\d\d)\b/.test(head.trim()) || /\n(?:[45]\d\d)\s+\w+/.test(head)) {
    return true;
  }
  if (/\b(?:[45]\d\d)\s+(?:Internal Server Error|Not Found|Bad Request|Unauthorized|Forbidden)\b/i.test(head)) {
    return true;
  }
  if (/\bECONNREFUSED\b|\bconnect\s+ECONNREFUSED\b/i.test(head)) return true;
  return false;
}

export function localHttpProbeIsSuccess(output: string): boolean {
  if (localHttpProbeIsFailure(output)) return false;
  const head = output.slice(0, 200);
  if (/^(?:[23]\d\d)\b/.test(head.trim())) return true;
  if (/\b(?:200|201|204)\s+(?:OK|Created|No Content)\b/i.test(head)) return true;
  if (/<!doctype html|<html[\s>]/i.test(output) && !/\berror\b/i.test(head)) {
    return true;
  }
  return false;
}

const WEB_ACTION_NARRATION_RE =
  /\b(?:let me|let's|i'?ll|i will|i'?m going to|i am going to|i need to|i should|i'?m about to|going to|now i'?ll|first[,]?\s*i'?ll)\s+(?:now\s+|first\s+|quickly\s+|just\s+|go\s+ahead\s+and\s+)?(?:fetch|browse|search(?:\s+(?:the\s+)?(?:web|internet|online))?|look\s*up|google|open\s+(?:the\s+)?(?:page|url|site|link)|read\s+(?:the\s+)?(?:page|url|site|article|blog|docs?))\b/i;

const CAPABILITY_OFFER_RE =
  /\b(?:what\s+do\s+you\s+(?:want|need)|what\s+would\s+you\s+(?:like|actually\s+like)|how\s+can\s+i\s+help|just\s+tell\s+me|tell\s+me\s+the\s+task|when\s+you(?:'re|\s+are)\s+ready|if\s+you\s+(?:want|need|like|have|give)|a\s+few\s+things\s+i\s+can|here'?s\s+what\s+i\s+can|i\s+can\s+(?:help|jump|assist|build|scan|investigate|research|look)|ready\s+(?:when|whenever)\s+you|what\s+would\s+you\s+(?:actually\s+)?like\s+me\s+to|i'?m\s+ready\s+to)\b/i;

const DENIES_PENDING_WORK_RE =
  /\b(?:didn'?t\s+(?:actually\s+)?(?:promise|claim|make\s+any)|haven'?t\s+made\s+any|no\s+(?:pending|real)\s+(?:task|browse|research|fetch|job)|non-existent\s+(?:job|task)|there'?s\s+no\s+pending|no\s+tool\s+call\s+for\s+a\s+non)\b/i;

const GENERIC_OFFER_NARRATION_RE =
  /\b(?:i'?ll|i will|i'?m going to)\s+(?:start\s+executing|start\s+working|help(?:\s+you)?|jump\s+in|get\s+started|wait\s+for|be\s+here|stand\s+by)\b/i;

const EDUCATIONAL_START_RE =
  /\b(?:i'?ll|i will|i'?m going to|let me)\s+start\s+(?:with|by)\b/i;

export function looksLikeIdleOrSocialPrompt(prompt: string): boolean {
  const text = prompt.replace(/\s+/g, " ").trim();
  if (!text) return true;
  return SOCIAL_OR_IDLE_PROMPT_RE.test(text);
}

function looksLikeCapabilityMenu(text: string): boolean {
  const bullets = (text.match(/(?:^|\n)\s*[•\-\*]|\n\s*\d+[.)]\s+/g) || [])
    .length;
  const asksUser =
    /\?\s*$/m.test(text) ||
    /\bwhat\s+(?:do|would|can)\s+you\b/i.test(text) ||
    /\btell\s+me\s+(?:the\s+)?(?:task|what)\b/i.test(text);
  return bullets >= 2 && asksUser;
}

export function looksLikeActionNarration(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 600) return false;
  if (t.includes("```")) return false;
  if (CAPABILITY_OFFER_RE.test(t)) return false;
  if (DENIES_PENDING_WORK_RE.test(t)) return false;
  if (looksLikeCapabilityMenu(t)) return false;
  if (EDUCATIONAL_START_RE.test(t) && !WEB_ACTION_NARRATION_RE.test(t)) {
    const withoutEducational = t.replace(EDUCATIONAL_START_RE, " ");
    if (!ACTION_NARRATION_RE.test(withoutEducational)) return false;
  }
  if (GENERIC_OFFER_NARRATION_RE.test(t)) {
    const withoutOffer = t.replace(GENERIC_OFFER_NARRATION_RE, " ");
    if (!ACTION_NARRATION_RE.test(withoutOffer)) return false;
  }
  return ACTION_NARRATION_RE.test(t);
}

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

const PROMPT_LEAK_THRESHOLD = 3;

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
