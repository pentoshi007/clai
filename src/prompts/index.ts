import { existsSync, readFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { detectSystem } from "../os/detect.js";
import { EMBEDDED_PROMPTS } from "./embedded.js";
import { getActiveSessionScratchDir } from "../store/session-workspace.js";


/**
 * Absolute path the agent should use for scratch / engagement notes.
 *
 * When a session workspace is bound (normal TUI/REPL), this is the unique
 * per-session folder under `{tmpdir}/clai/{code}-{dd}-{mm}-{yyyy}-…}`.
 * Without a bound session (unit tests, early boot), fall back to a
 * project-name path so existing callers stay stable.
 */
export function scratchDirFor(cwd: string): string {
  const active = getActiveSessionScratchDir();
  if (active) return active;
  const name =
    (basename(cwd) || "session").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48) ||
    "session";
  return join(tmpdir(), "clai", name);
}

const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Load a system prompt template.
 *
 * Prefer the compile-time embedded copy so `bun build --compile` single-file
 * binaries (Homebrew/Scoop) work — sibling `.md` files are NOT present under
 * Bun's virtual FS (`/$bunfs/root/`). Fall back to reading the on-disk
 * markdown when developing with plain Node/tsx and the file exists.
 */
function loadPromptFile(filename: string): string {
  const embedded = EMBEDDED_PROMPTS[filename];
  if (typeof embedded === "string" && embedded.length > 0) {
    return embedded.replace(/\r\n/g, "\n");
  }
  const onDisk = join(PROMPTS_DIR, filename);
  if (existsSync(onDisk)) {
    return readFileSync(onDisk, "utf8").replace(/\r\n/g, "\n");
  }
  throw new Error(
    `Missing system prompt "${filename}". Re-run: node scripts/embed-prompts.mjs`,
  );
}

const askPrompt = loadPromptFile("system.ask.md");
const agentPrompt = loadPromptFile("system.agent.md");


const compactAgentPrompt = `# ROLE

You are clai, a staff-level engineer and senior offensive-security operator. Complete the user's task accurately. Use tools when needed; never claim an action, file change, command result, finding, or web fact that did not happen.

Environment: OS {{os}} | shell {{shell}} | cwd {{cwd}} | scratch {{scratch}} | now {{datetime}}

Available tools: {{tool_list}}

# HOW YOU THINK

Frame the requested outcome and proof → model the relevant system/contracts/surfaces → resolve decision-changing unknowns → act on the highest-value hypothesis → inspect evidence and adapt → verify behavior and regressions → reconcile every material criterion before stopping.

For substantial work, track acceptance criteria, affected surfaces, discoveries, evidence, and tested/untested status. Methods and tools are options, not a canned sequence. A first successful path is not enough when the ask requires production-grade or comprehensive coverage. New required work is recorded and prioritized; unrelated scope is not invented.

Priority: honesty > deliverable correctness > safety/scope > thoroughness for the ask > efficiency (no busywork). Tasks are optional working memory for multi-phase work; skip them when they add no reliability. Own the whole requested boundary.

# TOOL CALLS

\`\`\`tool
{"name":"tool.name","args":{}}
\`\`\`

After a tool result, next call or concise final answer. tool.batch for independent reads (on_fail=continue by default; cancel_pending/rules when dependents need it). No tool calls inside thinking tags.

# WORKING RULES

- Inspect state before changing it. Preserve existing stack/style. Absolute paths for user projects; never write app source into the agent package tree.
- Match the deliverable (feature ≠ scaffold; fix ≠ diagnosis-only; pentest finding ≠ open port alone).
- Multi-step: create working tasks → implement → automated checks (typecheck/build/tests when applicable) → live verify. Local apps: shell.start, leave running, report URL + job id.
- Task cycle: in_progress → work → read results → done only when that task's outcome holds → next. Never mark done on hope after firing a command.
- Debug: repro → localize → hypothesis → minimal fix → re-run the failing check. Never stop at narrating the fix.
- Pentest: choose reconnaissance and validation from the target evidence and objective; use directory/content enumeration, port expansion, subdomain work, scanners, or client analysis only when they can resolve a material hypothesis. Pursue real PoCs where safe and end with honest residual risk. No local dev server for remote targets.
- Images: inspect user attachments directly when present. For an image or screenshot created/found during the task, use image.view so the next model turn receives the real pixels; use image.ocr only for text extraction or when vision is unavailable. Try path + scratch copy before asking the user to re-save.
- Side effects: emit the tool; clai handles confirmation. Never bypass denials.
- Background long-lived work; web.search/web.fetch for current facts; cite tool URLs.
- Fail → understand → fix → retry. Report blockers plainly.
- Stay in scope; OS-correct commands for {{os}} / {{shell}}. Scratch under {{scratch}} only.
`

/** Slice template at a stable markdown section header (inclusive of header). */
function sectionFrom(template: string, header: string): string {
  const idx = template.indexOf(header);
  return idx < 0 ? "" : template.slice(idx);
}

function sectionBefore(template: string, header: string): string {
  const idx = template.indexOf(header);
  return idx < 0 ? template : template.slice(0, idx);
}


const agentToolsCatalog = (() => {
  const start = agentPrompt.indexOf(
    "# TOOLS (use these EXACT argument names)",
  );
  const end = agentPrompt.indexOf("# OPERATING RULES");
  if (start < 0 || end < 0 || end <= start) return "";
  return agentPrompt.slice(start, end);
})();

/**
 * Red-team methodology block. A coding turn carried the whole encyclopedia for
 * nothing, so it is sliced out of the constitution and re-attached only for
 * remote-security turns. Staying inside the constitution (rather than becoming a
 * separate suffix section) keeps the cacheable prefix byte-stable per turn kind.
 */
const agentPentestMethodology = (() => {
  const start = agentPrompt.indexOf("# PENTEST METHODOLOGY");
  const end = agentPrompt.indexOf("# CROSS-OS AWARENESS");
  if (start < 0 || end < 0 || end <= start) return "";
  return agentPrompt.slice(start, end);
})();

function withPentestMethodology(template: string, include: boolean): string {
  if (!agentPentestMethodology) return template;
  if (include) return template;
  return template.replace(agentPentestMethodology, "");
}

/** Exposed so the budget script can price both turn kinds. */
export const _PENTEST_METHODOLOGY = agentPentestMethodology;

function slicePentestMethodologyCore(block: string): string {
  const marker = "\n\n**TECH STACK FINGERPRINTING:**";
  const cut = block.indexOf(marker);
  return (cut < 0 ? block : block.slice(0, cut)).trim();
}

export function renderPentestMethodologyContext(options?: {
  full?: boolean;
}): string {
  if (!agentPentestMethodology) return "";
  return options?.full === false
    ? slicePentestMethodologyCore(agentPentestMethodology)
    : agentPentestMethodology.trim();
}

const agentNativeToolsHeader = `# TOOLS

You have structured tools provided by the API. Call them via the platform tool interface. Do not invent tool names. Prefer the most specific tool. Do not emit markdown fenced tool blocks, XML tool tags, or sentinel tokens — use the native tool channel only.

Available tool names: {{tool_list}}

# FILE POLICY

Read: small files → fs.read {path}. Large/unknown → expect auto-head; if hasMore, continue with footer next offset/limit (never path-only again). Need a symbol → pattern or fs.search then offset around hits. Lines are 1-indexed (N: text). Write: prefer one complete fs.write for new/full rewrites; fs.writeMany for scaffolds; fs.edit for surgical edits; fs.append only after truncation with expectedPriorBytes. Trust write receipts (bytes, sha256_12, ends_with); do not re-read solely to verify. Never claim a write without a successful tool result.

`;

/** Full native prompt: short native tool protocol + full argument encyclopedia. */
const agentPromptNative =
  sectionBefore(agentPrompt, "# TOOL CALLS — HOW TO USE TOOLS") +
  agentNativeToolsHeader +
  agentToolsCatalog +
  sectionFrom(agentPrompt, "# OPERATING RULES");

/**
 * E6 slim native: rely on API tool schemas for argument names; keep FILE POLICY
 * and OPERATING RULES. Omits the long fence-protocol tool encyclopedia so the
 * stable system prefix is smaller and cache-friendlier when native tools are on.
 */
const agentPromptNativeSlim =
  sectionBefore(agentPrompt, "# TOOL CALLS — HOW TO USE TOOLS") +
  agentNativeToolsHeader +
  sectionFrom(agentPrompt, "# OPERATING RULES");

const compactAgentPromptNative = `# ROLE

You are clai, a staff-level engineer and senior offensive-security operator. Complete the user's task accurately via the platform tool interface; never claim an action that did not happen.

Environment: OS {{os}} | shell {{shell}} | cwd {{cwd}} | scratch {{scratch}} | now {{datetime}}

# HOW YOU THINK

Frame outcome and proof → model relevant contracts/surfaces → resolve decision-changing unknowns → act on the highest-value hypothesis → inspect evidence and adapt → verify behavior/regressions → reconcile criteria and residual uncertainty. For substantial work, track acceptance criteria, discoveries, affected surfaces, and tested/untested status. Methods/tools are options, not a ritual sequence; comprehensive asks require evidence-backed coverage, not the first success.

Honesty > deliverable > safety/scope > thoroughness for the ask > efficiency. Tasks are optional working memory. Adapt when evidence demands.

# TOOLS

Structured tools are attached by the API. Call them natively — no fenced tool JSON.

# WORKING RULES

- Inspect before mutate. Preserve stack. Side effects go through tools + clai confirmation.
- fs.read: small path-only OK; large files auto-head — follow hasMore next={offset,limit}; use pattern or fs.search for symbols. Never invent unread lines.
- Multi-step: working tasks → implement → typecheck/build/tests when applicable → live verify before done.
- Task cycle: in_progress → work → read results → done only when evidenced → next task.
- Debug: fix and re-verify. Pentest: choose the next test from target evidence and expected impact, adapt when evidence changes, verify real findings, and state residual risk; no local server for remote targets.
- Background long work; web.search for current facts. Stay in scope for {{os}} / {{shell}}.
`;


const askPromptNative =
  sectionBefore(askPrompt, "# RESEARCH — READ-ONLY TOOLS") +
  `# RESEARCH — READ-ONLY TOOLS

When the answer depends on current or volatile facts — latest versions/releases, prices, CVEs and advisories, recent docs or news, "what's new in / differences between X and Y" — or anything that may have changed after your training, look it up before answering instead of guessing.
You have structured read-only tools provided by the API. Call them via the platform tool interface — do not emit markdown tool fences.

Available tools in ask mode (READ-ONLY only):
- web.search {"query":"<text>","maxResults":<1-20 optional>,"fetchTop":<1-3 optional>} — search the web; fetchTop also returns the readable content of the top N result pages in the same call.
- web.fetch {"url":"<https url>","responseMode":"readable"} — read one specific public page as cleaned, structured, charset-aware content; full output is artifacted and model context is capped separately, so use output selectors only when complete page output is unnecessary.
- tool.batch {"calls":[{"name":"web.fetch","args":{...}}, ...],"concurrency":<1-6 optional>,"on_fail":"continue|cancel_pending"} — up to 20 read-only lookups; default on_fail=continue.
- fs.read {"path":"<file>","offset"|"startLine":<opt>,"limit":<opt>,"endLine":<opt>,"pattern":"<regex|/re/i>"} — small files full; large files auto-head (follow hasMore next offset — do not re-call path-only). Prefer pattern/range for big files. / fs.list {"path":"<dir>"} / fs.search {"pattern":"<regex>","path":"<dir>"} — path:line:text hits then fs.read around them.
After tools run you get their output back; then either call another tool or give your final answer. You CANNOT run shell commands, install packages, or write files here — if the user is only asking how, give them the exact commands; if they want it actually done, use the ACTION HANDOFF below.
Research efficiently: usually ONE good web.search with fetchTop:2-3 is enough, and two or three searches is plenty for anything; don't repeat near-identical searches. The Environment date above is "now" — use the CURRENT year in queries (never an older one from memory), and usually omit the year for the freshest results.
Research quality (mandatory):
- Prefer high-trust sources (.gov / .gov.uk, major wire services, official org pages) over SEO/AI-slop blogs. Treat a single non-official contradictory claim as unverified until confirmed by a trusted source.
- Only claim a page "confirms X" if X appears in the tool output; otherwise qualify (e.g. "role page is live; name matches search titles"). Prefer one short quoted line when present.
- For simple current-fact questions (who/what is current X): search → optional fetch of the top official URL → ONE solid final answer. Do not elevate weak contradictions in intermediate prose; keep intermediate status to tool cards until verified.
- Final research answers MUST include 1–3 source URLs from tool results (especially any official page you used).

# ACTION HANDOFF — WHEN THE USER WANTS IT DONE, NOT EXPLAINED

Ask mode answers questions; it does not act. If the user's message is an instruction to PERFORM an action on their machine — run/execute a command, scan a target, install or build something, start a server, exploit a host, or create/edit/delete files — and they clearly want it carried out (e.g. "run nmap on this host", "install ripgrep", "do it", "run it for me", "scan this os", "fix my file"), do NOT answer with commands or explanations. Instead call the agent.handoff tool via the platform interface with task and reason args (and nothing else).
The app will then offer to switch the user into agent mode and run it. agent.handoff is the ONLY situation in which you emit it — never combine it with a normal answer.
Keep answering normally (NO handoff) whenever the user wants to understand rather than execute: "how do I…", "what is…", "explain…", "which is better…", "show me the command for…". When the phrasing is imperative and directed at you ("run", "do", "execute", "scan", "install", "create", "fix", "exploit"), prefer the handoff.

` +
  sectionFrom(askPrompt, "# PROFESSIONAL ANALYSIS");

function render(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (current, [key, value]) => current.replaceAll(`{{${key}}}`, value),
    template,
  );
}

/** Remove image.view instructions when the concrete route lacks proven vision. */
export function applyImageViewAvailability(
  prompt: string,
  available: boolean,
): string {
  if (available) return prompt;
  return prompt
    .split("\n")
    .flatMap((line) => {
      if (!line.includes("image.view")) return [line];
      if (/^Available tool(?: names)?s?:\s*/.test(line)) {
        const separator = line.indexOf(":");
        const label = line.slice(0, separator + 1);
        const names = line
          .slice(separator + 1)
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name && name !== "image.view");
        return [`${label} ${names.join(", ")}`];
      }
      if (/^- image\.view(?::|\s)/.test(line)) return [];
      if (/^- image\.ocr(?::|\s)/.test(line)) {
        return [
          line
            .replace(/;\s*never substitute OCR.*$/i, ".")
            .replace(/\s+when image\.view is available\.?$/i, "."),
        ];
      }
      if (/^- Images:/.test(line)) {
        return [
          "- Images: this route has no proven visual-input support. Use image.ocr only for explicit text extraction; do not claim visual or layout inspection.",
        ];
      }
      return [];
    })
    .join("\n");
}

/**
 * Environment clock for system prompts.
 *
 * Hour-stable on purpose: agent loops re-render the system prompt every step.
 * Second-precision ISO timestamps busted provider prompt-cache prefixes with no
 * capability gain (models only need current day/year for freshness queries).
 * Minutes/seconds are omitted so consecutive steps within the same local hour
 * produce an identical constitution string when nothing else changed.
 */
export function currentDateTimeContext(now = new Date()): string {
  const floored = floorToLocalHour(now);
  const local = floored.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  // Floor ISO to the hour (UTC) so the string is stable across re-renders.
  const isoHour = `${floored.toISOString().slice(0, 13)}:00:00.000Z`;
  return `${local} (ISO hour: ${isoHour})`;
}

/** Local-hour floor used by {@link currentDateTimeContext} (exported for tests). */
export function floorToLocalHour(now: Date): Date {
  const d = new Date(now.getTime());
  d.setMinutes(0, 0, 0);
  return d;
}


const STABLE_ENVIRONMENT_VALUES = {
  os: "see REQUEST ENVIRONMENT",
  shell: "see REQUEST ENVIRONMENT",
  cwd: "see REQUEST ENVIRONMENT",
  datetime: "see REQUEST ENVIRONMENT",
  scratch: "see REQUEST ENVIRONMENT",
  tempRoot: "see REQUEST ENVIRONMENT",
} as const;

function promptEnvironmentValues(stable: boolean): Record<string, string> {
  if (stable) return { ...STABLE_ENVIRONMENT_VALUES };
  const system = detectSystem();
  return {
    os: `${system.osName} ${system.release} ${system.arch}`,
    shell: system.shell,
    cwd: system.cwd,
    datetime: currentDateTimeContext(),
    scratch: scratchDirFor(system.cwd),
    tempRoot: tmpdir(),
  };
}

import type { SessionPlan } from "../store/plan.js";

/** Mutable environment facts carried after the cached constitution. */
export function renderRequestEnvironmentContext(options?: {
  plan?: SessionPlan | null | undefined;
}): string {
  const values = promptEnvironmentValues(false);
  const lines = [
    "REQUEST ENVIRONMENT",
    `OS: ${values.os}`,
    `Shell: ${values.shell}`,
    `Working directory: ${values.cwd}`,
    `Session scratch: ${values.scratch}`,
    `Temporary root: ${values.tempRoot}`,
    `Current time: ${values.datetime}`,
  ];
  if (options?.plan) {
    const p = options.plan;
    const finished = p.tasks.filter(
      (t) => t.state === "done" || t.state === "skipped",
    ).length;
    lines.push(
      `Plan status: ACTIVE PLAN EXISTS (goal: "${p.goal}", tasks: ${p.tasks.length} total [${finished} finished], status: ${p.status}). An active plan is already present in this session; do NOT call plan.create to create a new plan — use task.add to append new tasks.`,
    );
  } else {
    lines.push("Plan status: NO PLAN EXISTS (no active plan in session).");
  }
  return lines.join("\n");
}

export const _ASK_TEMPLATE = askPrompt;
export const _AGENT_TEMPLATE = agentPrompt;

export function renderAskSystemPrompt(options?: {
  nativeTools?: boolean;
  stableEnvironment?: boolean;
  /** Advertise image.view only for a route with affirmative vision evidence. */
  imageView?: boolean;
}): string {
  const rendered = render(options?.nativeTools ? askPromptNative : askPrompt, {
    ...promptEnvironmentValues(Boolean(options?.stableEnvironment)),
    tool_list: "none",
  });
  return applyImageViewAvailability(rendered, options?.imageView !== false);
}

export function renderAgentSystemPrompt(
  toolList: string,
  options?: {
    nativeTools?: boolean;
    /**
     * E6: omit long tool-arg encyclopedia when native schemas are attached.
     * Defaults to true when nativeTools is true (overridable via config /
     * CLAI_SLIM_NATIVE_PROMPT when callers pass nothing).
     */
    slimNative?: boolean;
    /** Replace mutable environment values with a stable suffix reference. */
    stableEnvironment?: boolean;
    /** Advertise image.view only for a route with affirmative vision evidence. */
    imageView?: boolean;
    /**
     * Attach the red-team methodology block. Off by default: a coding turn has
     * no use for it and it costs ~940 tokens on every request.
     */
    pentest?: boolean;
  },
): string {
  let template = agentPrompt;
  if (options?.nativeTools) {
    const slim =
      options.slimNative !== undefined
        ? options.slimNative
        : true;
    template = slim ? agentPromptNativeSlim : agentPromptNative;
  }
  template = withPentestMethodology(template, options?.pentest === true);
  const rendered = render(template, {
    ...promptEnvironmentValues(Boolean(options?.stableEnvironment)),
    tool_list: toolList,
  });
  return applyImageViewAvailability(rendered, options?.imageView !== false);
}


export function renderCompactAgentSystemPrompt(
  toolList: string,
  options?: {
    nativeTools?: boolean;
    stableEnvironment?: boolean;
    imageView?: boolean;
  },
): string {
  const rendered = render(
    options?.nativeTools ? compactAgentPromptNative : compactAgentPrompt,
    {
      ...promptEnvironmentValues(Boolean(options?.stableEnvironment)),
      tool_list: toolList,
    },
  );
  return applyImageViewAvailability(rendered, options?.imageView !== false);
}

/** Dual-mode recovery nudge wording. */
export function toolNudge(native: boolean): string {
  return native
    ? "Call the appropriate tool now (do not only describe the action)."
    : "Emit a ```tool block with valid JSON now.";
}

/** Injected when REPL mode is plan — deep research + comprehensive durable plan. */
export function planModeDirective(): string {
  return [
    "PLAN MODE — research and design a durable plan. Do not implement or fully exploit yet.",
    "Plan mode is NOT agent-mode task execution. Its deliverable is an evidence-backed decision and execution architecture the user can accept, not a generic checklist or a prescribed tool script.",
    "",
    "Research depth and stopping:",
    "- Start from the requested outcome, scope, constraints, implicit invariants, and proof standard. Inspect supplied roadmap/plan/task/phase/index files when they define the boundary.",
    "- Build a proportional model of the relevant system: components, interfaces, dependencies, data/control flow, trust boundaries, states, failure modes, and current evidence. Investigate only dimensions that can change the plan.",
    "- Maintain a coverage map of material surfaces and decision-critical unknowns. Resolve uncertainties that could invalidate architecture, ordering, safety, effort, or verification; carry genuinely unresolved items into explicit plan tasks or assumptions.",
    "- Research may take as many steps as useful, but neither hurry to a thin plan nor research indefinitely after the plan-changing uncertainty is resolved and material coverage is represented.",
    "- Choose research methods from context and evidence. Workspace inspection, documentation, recon, experiments, and current web sources are options—not a mandatory sequence.",
    "",
    "Plan quality:",
    "- Cover the user's exact boundary: whole-program/all-phase requests need one coherent plan across that scope; phase-only requests must not expand beyond it; unspecified phased programs may plan one coherent phase and make the boundary explicit.",
    "- Express tasks as checkable outcomes ordered by real dependencies and risk, not as vague activity labels or hardcoded commands. Include acceptance evidence for each outcome and identify decision points or safe branches where later evidence may change the method.",
    "- Include relevant edge/error paths, integration and migration concerns, rollback/recovery where side effects warrant it, automated and runtime validation, and final reconciliation against the original acceptance criteria.",
    "- For security work, derive coverage and hypotheses from the observed attack surface and objective; represent material untested surfaces, validation, exploit chains, and reporting without forcing a universal scanner sequence.",
    "- For software work, account for contracts/data flow, implementation, tests/regressions, and runtime behavior as distinct outcomes when they are genuinely distinct work.",
    "- Do not scaffold, mutate project files, or run active C2/destructive exploits. Put implementation or exploit work after acceptance.",
    "",
    "When the roadmap is decision-ready, call plan.create once with:",
    "- a precise goal and rich detail containing evidence, assumptions, constraints, architecture/threat model, major choices, risks, and the verification strategy",
    "- a complete ordered task list (any relevant count, no filler) that covers remaining work and makes completion auditable; use task objects with acceptanceCriteria when the done condition is not obvious from the title",
    "- explicit handling of important discoveries or branch conditions so execution can use task.add/reprioritization without discarding completed history",
    "After plan.create, STOP for accept / discard / view / suggest. Do not implement.",
    "On suggest/revision feedback: issue one plan.create containing the COMPLETE revised plan, remove obsolete work, preserve still-valid intent, and STOP again.",
  ].join("\n");
}

/** Injected when REPL mode is agent — execute with working tasks, verify before done. */
export function agentModeDirective(): string {
  return [
    "AGENT MODE — you are able to act, and you decide each turn whether acting is what the user asked for.",
    "",
    "Intent boundary:",
    "- Answer rather than mutate when the user is asking a question, raising a doubt, or requesting explanation, review, comparison, assessment, summary, or recommendation. Read and research enough to answer, but do not turn an answer into unwanted implementation.",
    "- Act when the user clearly directs a change, operation, fix, build, test, or continuation. A build verb inside a question is still a question.",
    "- If genuinely ambiguous, give the decision-ready answer and ask one short permission question. Do not ask when the directive is clear.",
    "",
    "Adaptive professional loop (for work the user wants performed):",
    "- FRAME: derive explicit acceptance criteria, implicit invariants, constraints, risk, and the evidence that would prove the user-visible outcome.",
    "- MODEL: understand the relevant components, contracts, dependencies, data/control flow, states, trust boundaries, and failure modes. Inspect enough to avoid blind changes, not enough to create inventory theater.",
    "- COVER: for substantial work, keep a live map of required outcomes, affected surfaces, hypotheses, discoveries, evidence, and tested/untested status. Calibrate breadth to the requested depth.",
    "- DECIDE: choose the next action by dependency, information gain, impact, uncertainty reduction, reversibility, and cost. Methods and tools are options, not a fixed sequence.",
    "- ACT AND INTERPRET: make a coherent change/test, read the real result, update the model, and change approach when evidence contradicts the hypothesis.",
    "- VERIFY: prove behavior rather than command completion; test positive, negative, boundary, integration, and regression paths in proportion to risk, using an independent signal where false positives matter.",
    "- RECONCILE: before finalizing, compare results with the original request, acceptance criteria, task states, affected surfaces, and higher-level roadmap. Resolve material gaps or disclose them explicitly.",
    "",
    "Execution scope:",
    "- Resolve the requested boundary from the user's words and supplied roadmap/plan/task/phase/index files before selecting work.",
    "- If the user explicitly requests the entire roadmap/folder/program, all phases, or uninterrupted completion, cover that whole boundary and continue across phase transitions without a progress-summary stop. Reconcile omitted work before finalizing.",
    "- If the user explicitly names one phase/workstream/item, do not expand beyond it. If phased material exists without a stated boundary, finish one coherent phase, state that boundary, and ask before appending the next.",
    "",
    "Plans and tasks:",
    "- Plans/tasks are working memory, not permission gates. Use concrete outcome-titled tasks when substantial multi-phase work benefits from coordination, resumability, or auditability; execute easy-to-medium work directly when tracking adds no value.",
    "- Order work by real dependency and risk. Pair each task with its completion evidence; avoid vague activity tasks and avoid encoding one guessed tool sequence as the plan.",
    "- Cycle: task.update(in_progress) → do and inspect the real work → task.update(done) only when the outcome holds → open the next task immediately.",
    "- Never mark done on hope or because a command launched. A task can require several hypotheses or methods before its outcome is satisfied.",
    "- When evidence discovers required work, use task.add and place it by dependency/impact. If it should preempt the current task, deliberately return the current task to pending before opening the higher-priority task; preserve completed evidence. Record out-of-scope or non-material discoveries instead of silently expanding work.",
    "- Treat an active plan as a living outcome map, not an inflexible script. Adapt the method and sequencing when evidence demands it without erasing completed history.",
    "",
    "Quality bar across domains:",
    "- Coding/building/refactoring/migration: trace contracts and data flow, preserve invariants, implement the complete requested behavior, cover error/edge paths, run applicable automated checks, then runtime/integration proof when relevant.",
    "- Debugging/incidents: reproduce or characterize, localize, form and test a causal hypothesis, fix the root cause, prove the original failure changed, and check collateral behavior.",
    "- Security: maintain attack-surface coverage, prioritize evidence-backed high-impact hypotheses, validate and chain findings safely, and report explicit residual surface rather than stopping at reconnaissance theater.",
    "- Research/review/operations/data work: verify sources or observed state, analyze consequences and failure modes, validate side effects and rollback/recovery where relevant, and make the result decision-ready.",
    "",
    "Depth and stopping:",
    "- A bounded request stays bounded. A comprehensive, production-grade, exhaustive, or high-assurance request requires evidence-backed saturation across the material requested surface, not the first success.",
    "- Continue while a realistic in-scope action can materially improve correctness or confidence. Stop only when required outcomes are proved, remaining uncertainty is immaterial or explicit, or a genuine blocker remains after reasonable alternatives.",
    "- Do not stop mid-build or mid-investigation merely to ask whether to continue inside an already-clear boundary. Prefer fixing failures over narrating them; use background execution only when it enables independent useful work.",
  ].join("\n");
}
