import type { ToolDefinition } from "../../types.js";
import { MIN_MAX_BYTES, MAX_MAX_BYTES, DEFAULT_MAX_BYTES } from "../web/types.js";

export const CONCISE_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  "fs.read": 'Read one text file/list one directory with {path,...options}; single-file is preferred when sufficient. For several known relevant files together use {files:[{path,...options},...]} (1–10 entries). Choose exactly one of path/files; each files entry requires path and owns all filters, never top-level filters. No filler files. Example: {"files":[{"path":"src/app.ts","offset":1,"limit":80},{"path":"src/config.ts","pattern":"export","context":2}]}. Small path-only files return fully; large ones auto-head. hasMore=true or clipping is incomplete: continue that file using footer offset/limit or narrower filters, never repeat path-only for more. Known range: offset+limit OR startLine+endLine (1-indexed inclusive); symbol: pattern with optional context. Discover unknown paths with shell.exec rg first. Range/pattern lines use N: text. Batch results are ordered/path-labeled with per-file status; successful reads survive sibling failure. Retry only needed failed/unfinished entries.',
  "http.fetch": 'Raw-by-default evidence for pentest/protocol/private targets: status, all redirect response headers, final headers/cookies, decoded source body and captured-body SHA-256. Full artifact and model-context cap are separate. Cross-origin credentials stripped unless explicitly overridden; no status retries by default (retries enables transient 5xx/429). insecureTls=true supports https://IP/self-signed labs and records verification off. TLS fingerprint: web.fetch includeTls. Public-page prose: prefer web.fetch.',
  "shell.exec": 'Run foreground by default; never heuristic backgrounding. Choose mode and sufficient foreground timeoutMs in milliseconds (default 60000). background:"always" starts a durable pollable job: shell.wait for finite work; for servers/watchers/listeners provide name, use shell.tail plus readiness probe, shell.stop for cleanup. responder:true delegates finite work with terminal delivery: do independent work, no polling, analyze receipt then job.read. background:"never" overrides responder. Background/Responder ignore timeoutMs, not authorization expiry. Pass cwd instead of cd.',
  "subagent.start": 'Start independent read-only context gathering only with ORCHESTRATION: ON (default on). Never delegate a single issue/task and wait: inspect it yourself. Requires >=2 unrelated issues, not simple work gatherable in 2–3 calls. Brief deliverable, owned surfaces/non-goals, depth/technicality and expected evidence, not a fixed procedure/gate. Name ownership; do not inspect delegated surfaces while running. Send task-relevant facts/constraints only, never whole conversation or system/project boilerplate. Launch independent sibling assignments together in one response. Results: safe boundaries, subagent.wait/read. Children cannot modify/delete files or delegate.',
});

const planKind = 'Required: choose the most specific concise lowercase activity (usually one word, rarely two), never a generic default. Examples: build/frontend/api/refactor/testing/perf/devops/docs; data/research/analysis; security/pentest/recon/osint/exploit/audit/hardening/forensics. Custom specific labels allowed. Use "general" only for work spanning categories with no dominant activity.';

function property(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Candidate property schema is missing");
  return Object.fromEntries(Object.entries(value));
}

export function conciseToolDefinitions(definitions: readonly ToolDefinition[]): ToolDefinition[] {
  return definitions.map((source) => {
    const definition = structuredClone(source);
    definition.description = CONCISE_DESCRIPTIONS[definition.name] ?? definition.description;
    const properties = definition.parameters.properties;
    if (definition.name === "plan.create") properties.kind = { ...property(properties.kind), description: planKind };
    if (definition.name === "web.fetch") properties.maxBytes = { ...property(properties.maxBytes), minimum: MIN_MAX_BYTES, maximum: MAX_MAX_BYTES,
      description: `Captured wire-body bytes (default ${DEFAULT_MAX_BYTES}); raise on truncated=true within these bounds.` };
    return definition;
  });
}
