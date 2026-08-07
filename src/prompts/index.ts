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

1. User-visible success condition?
2. What do I already know?
3. What unknowns matter? Smallest high-value next action (parallel batch OK).
4. After tools: did evidence move us forward? If not, change approach — never spam the same failed command.
5. Stop only when success is evidenced or truly blocked.

Priority: honesty > deliverable correctness > safety/scope > thoroughness for the ask > efficiency (no busywork).
Tasks optional for multi-phase work — any count, only relevant; skip when trivial. Own the whole goal.

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

Success condition → evidence → act → verify. Honesty > deliverable > safety > thoroughness for the ask > efficiency. Feature ≠ scaffold; diagnosis ≠ fix; port list ≠ vuln. Tasks optional (any count, relevant only). Adapt when evidence demands.

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
  sectionFrom(askPrompt, "# HOW TO ANSWER");

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
    "Plan mode is NOT agent-mode task execution. Tasks you create are the roadmap the user accepts before build/exploit work.",
    "",
    "Time budget (research is unlimited; the deliverable is the plan):",
    "- You may take as many steps and as much time as you need to gather context: learn attack surface, stack, interesting features/areas, constraints, and success definition.",
    "- Research exists to inform a high-quality comprehensive plan — not to finish every test/exploit/report before plan.create.",
    "- Do not rush a thin plan. When research is sufficient for a high-quality roadmap, present plan.create rather than continuing indefinitely.",
    "",
    "How to research then plan (give full effort):",
    "- Prefer evidence: workspace/stack inspection, recon, docs, web.search for current APIs/CVEs/techniques when facts may be stale.",
    "- Resolve scope from the user's words and supplied roadmap/plan/task/phase/index files: explicit whole-program/all-phase requests require one plan covering that complete scope; explicit phase-only requests must not expand beyond it; unspecified phased programs may plan one coherent phase and offer the next after delivery.",
    "- Consider alternatives, risks, edge cases, dependency order, and verification for each step.",
    "- For pentest: choose research from the engagement objective and current evidence. Consider service, host, route, client, auth, and business-flow investigation as options—not a mandatory checklist—and use long background work only when its expected value justifies it.",
    "- Capture confirmed unauth findings in plan detail as evidence; put remaining auth’d testing, exploit chains, and final report polish in tasks for after accept.",
    "- Do not scaffold, write project files, or run active C2/destructive exploits. Put implement/exploit steps as plan tasks for after accept.",
    "",
    "When context is enough, call plan.create once with:",
    "- goal + rich detail (context found, approach, architecture/threat model, risks, how each phase is verified)",
    "- a complete ordered task list (any count; only real work; no filler) covering remaining build/test/verify or test→exploit→report work as appropriate",
    "- for software: implement, automated checks, and live/runtime verification as separate tasks when they are distinct work",
    "- for software: target latest stable packages/frameworks; note web.search for current setup docs when versions/APIs may have moved",
    "After plan.create, STOP for accept / discard / view / suggest. Prefer evidence-based plans.",
    "On suggest/revision feedback: rewrite with one plan.create that includes the COMPLETE updated task list " +
      "(omit obsolete steps; do not keep backend/DB tasks when the user asked for frontend-only). Be decisive, then STOP again.",
  ].join("\n");
}

/** Injected when REPL mode is agent — execute with working tasks, verify before done. */
export function agentModeDirective(): string {
  return [
    "AGENT MODE — execute until the user's real success condition is evidenced.",
    "Plans and tasks are working memory, not permission gates. For substantial multi-phase work, default to a small task list and follow it promptly; for easy-to-medium work — even when it takes several steps — execute directly without tasks.",
    "",
    "Execution scope:",
    "- Resolve the requested boundary from the user's words and supplied roadmap/plan/task/phase/index files before selecting work.",
    "- If the user explicitly requests the entire roadmap/folder/program, all phases, or uninterrupted completion: inspect enough of those files to map the whole scope, continue across phase boundaries without a progress-summary stop, and reconcile the active plan against the higher-level roadmap before finalizing. Append omitted work with task.add and keep going.",
    "- If the user explicitly names only one phase/workstream/item, do not expand beyond it.",
    "- If phased material exists but the user gave no boundary, finish one coherent phase, state that boundary, and ask before continuing. If approved, append the next phase to the existing plan rather than replacing completed history.",
    "",
    "Task discipline (when you create tasks — for substantial work — or an ACTIVE PLAN exists):",
    "- Use concrete outcome-titled tasks for substantial multi-phase work. Skip task creation for one-shots and easy-to-medium multi-step work; when in doubt, prefer direct execution.",
    "- Prefer small, checkable tasks over one vague mega-task. No artificial cap; only relevant items.",
    "- Cycle for each active-plan task: task.update(in_progress) → run the real tools/commands → READ and analyze every result → if the task outcome is satisfied, task.update(done) and open the next task immediately; if not, keep working that task until it is.",
    "- Never mark done on hope or right after firing a command. Done means you saw evidence that this task's outcome holds.",
    "- Do not stop at thin proxies (scaffold without the feature, ports without tested findings, build without the requested behavior).",
    "",
    "Build / ship software:",
    "- Prefer the latest stable packages, frameworks, and tooling for new apps (current majors, not outdated templates).",
    "- If setup/config for a current stack may be stale in your knowledge, web.search or web.fetch official docs first — then scaffold with the modern path.",
    "- After implementing: run stack checks that apply (typecheck, build, unit/integration tests). Fix failures before claiming success.",
    "- Then live/runtime verification when applicable (start app, probe routes/UI, leave server running, report URL + job id).",
    "- Only then tell the user it works — with what you actually observed.",
    "- Do not stop mid-build for a continue prompt; keep working until the requested boundary is evidenced or you are truly blocked.",
    "",
    "Long jobs: background them and continue other useful work. Prefer fixing failures over narrating them. Change approach after repeated identical failures.",
  ].join("\n");
}
