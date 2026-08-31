import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "./paths.js";
import type { EngagementScope } from "./scope.js";

export type FindingState =
  | "suspected"
  | "reproduced"
  | "verified"
  | "reported"
  | "remediated"
  | "retested"
  | "rejected"
  | "inconclusive";
export type CoverageState = "applicable" | "covered" | "inconclusive" | "excluded";

export interface EngagementFinding {
  id: string;
  title: string;
  targetId: string;
  state: FindingState;
  reproduction?: string | undefined;
  impact?: string | undefined;
  remediation?: string | undefined;
  evidenceIds: string[];
  severity?: string | undefined;
  updatedAt: string;
}

export interface EngagementEvidence {
  id: string;
  targetId: string;
  testCaseId?: string | undefined;
  artifactPath?: string | undefined;
  artifactHash?: string | undefined;
  observation: string;
  observedAt: string;
}

export interface EngagementCheckpoint {
  id: string;
  actionId: string;
  jobId: string;
  status: string;
  artifactPath: string;
  offset: number;
  observation: string;
  recordedAt: string;
}

export interface EngagementActionRecord {
  id: string;
  targetId: string;
  testCaseId: string;
  tool: string;
  phase: string;
  capability: string;
  authorized: boolean;
  authorizationReason: string;
  status: "blocked" | "running" | "passed" | "failed" | "inconclusive";
  evidenceId?: string | undefined;
  recordedAt: string;
}

export interface EngagementGraph {
  schemaVersion: 1;
  id: string;
  name: string;
  scope: EngagementScope;
  assets: Array<{ id: string; value: string; addresses: string[]; services: string[]; endpoints: string[] }>;
  principals: Array<{ id: string; label: string; roles: string[] }>;
  testCases: Array<{ id: string; targetId: string; phase: string; capability: string; status: "planned" | "running" | "passed" | "failed" | "inconclusive" }>;
  actions: EngagementActionRecord[];
  checkpoints: EngagementCheckpoint[];
  evidence: EngagementEvidence[];
  findings: EngagementFinding[];
  coverage: Array<{ dimension: string; state: CoverageState; rationale: string }>;
  residualRisk: string[];
  createdAt: string;
  updatedAt: string;
}

const pathFor = (id: string): string => join(getDataDir(), "engagements", `${encodeURIComponent(id)}.json`);
const engagementSaveQueues = new Map<string, Promise<void>>();

function mergeById<T extends { id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
  choose: (current: T, next: T) => T = (_current, next) => next,
): T[] {
  const merged = new Map(existing.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    const current = merged.get(entry.id);
    merged.set(entry.id, current ? choose(current, entry) : entry);
  }
  return [...merged.values()];
}

const terminalProgress = (status: string): number =>
  status === "running" || status === "planned" ? 0 : 1;

function mergeEngagementGraphs(
  existing: EngagementGraph | undefined,
  incoming: EngagementGraph,
): EngagementGraph {
  if (!existing || existing.id !== incoming.id) return incoming;
  return {
    ...existing,
    ...incoming,
    assets: mergeById(existing.assets, incoming.assets, (current, next) => ({
      ...current,
      ...next,
      addresses: [...new Set([...current.addresses, ...next.addresses])],
      services: [...new Set([...current.services, ...next.services])],
      endpoints: [...new Set([...current.endpoints, ...next.endpoints])],
    })),
    principals: mergeById(existing.principals, incoming.principals, (current, next) => ({
      ...current,
      ...next,
      roles: [...new Set([...current.roles, ...next.roles])],
    })),
    testCases: mergeById(existing.testCases, incoming.testCases, (current, next) =>
      terminalProgress(next.status) >= terminalProgress(current.status) ? next : current,
    ),
    actions: mergeById(existing.actions, incoming.actions, (current, next) =>
      terminalProgress(next.status) >= terminalProgress(current.status) ? next : current,
    ),
    checkpoints: mergeById(existing.checkpoints, incoming.checkpoints),
    evidence: mergeById(existing.evidence, incoming.evidence),
    findings: mergeById(existing.findings, incoming.findings, (current, next) =>
      next.updatedAt >= current.updatedAt ? next : current,
    ),
    coverage: [
      ...new Map(
        [...existing.coverage, ...incoming.coverage].map((entry) => [entry.dimension, entry]),
      ).values(),
    ],
    residualRisk: [...new Set([...existing.residualRisk, ...incoming.residualRisk])],
    createdAt: existing.createdAt <= incoming.createdAt ? existing.createdAt : incoming.createdAt,
  };
}

const normalizedScopeIdentity = (scope: EngagementScope): string => JSON.stringify({
  name: scope.name ?? "",
  authorizedTargets: [...scope.authorizedTargets].sort(),
  excludedTargets: [...(scope.excludedTargets ?? [])].sort(),
  createdAt: scope.createdAt ?? "",
});

export function engagementIdForScope(scope: EngagementScope): string {
  return createHash("sha256").update(normalizedScopeIdentity(scope)).digest("hex").slice(0, 32);
}

export function createEngagement(scope: EngagementScope): EngagementGraph {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: engagementIdForScope(scope),
    name: scope.name ?? "authorized engagement",
    scope,
    assets: scope.authorizedTargets.map((value) => ({ id: randomUUID(), value, addresses: [], services: [], endpoints: [] })),
    principals: [],
    testCases: [],
    actions: [],
    checkpoints: [],
    evidence: [],
    findings: [],
    coverage: [],
    residualRisk: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function saveEngagement(graph: EngagementGraph): Promise<void> {
  const previous = engagementSaveQueues.get(graph.id) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(async () => {
    const dir = join(getDataDir(), "engagements");
    const path = pathFor(graph.id);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dir, { recursive: true });
    try {
      let existing: EngagementGraph | undefined;
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as EngagementGraph;
        if (parsed.schemaVersion === 1) existing = parsed;
      } catch {
      }
      const merged = mergeEngagementGraphs(existing, graph);
      merged.updatedAt = new Date().toISOString();
      await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, path);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  });
  engagementSaveQueues.set(graph.id, queued);
  void queued.finally(() => {
    if (engagementSaveQueues.get(graph.id) === queued) {
      engagementSaveQueues.delete(graph.id);
    }
  }).catch(() => undefined);
  return queued;
}

export async function loadEngagement(id: string): Promise<EngagementGraph | undefined> {
  try {
    const parsed = JSON.parse(await readFile(pathFor(id), "utf8")) as EngagementGraph;
    if (parsed.schemaVersion !== 1) return undefined;
    parsed.actions ??= [];
    parsed.checkpoints ??= [];
    return parsed;
  } catch {
    return undefined;
  }
}

export async function openEngagement(scope: EngagementScope): Promise<EngagementGraph> {
  const id = engagementIdForScope(scope);
  const existing = await loadEngagement(id);
  if (existing) {
    existing.scope = scope;
    return existing;
  }
  const created = createEngagement(scope);
  await saveEngagement(created);
  return created;
}

function assetFor(graph: EngagementGraph, target: string): { id: string; value: string; addresses: string[]; services: string[]; endpoints: string[] } {
  const existing = graph.assets.find((asset) => asset.value === target);
  if (existing) return existing;
  const asset = { id: randomUUID(), value: target, addresses: [], services: [], endpoints: [] };
  graph.assets.push(asset);
  return asset;
}

export function beginEngagementAction(
  graph: EngagementGraph,
  input: { tool: string; target: string; phase: string; capability: string; authorized: boolean; reason: string },
): EngagementActionRecord {
  const target = assetFor(graph, input.target);
  const testCase = {
    id: randomUUID(),
    targetId: target.id,
    phase: input.phase,
    capability: input.capability,
    status: (input.authorized ? "running" : "failed") as "running" | "failed",
  };
  graph.testCases.push(testCase);
  const action: EngagementActionRecord = {
    id: randomUUID(),
    targetId: target.id,
    testCaseId: testCase.id,
    tool: input.tool,
    phase: input.phase,
    capability: input.capability,
    authorized: input.authorized,
    authorizationReason: input.reason,
    status: input.authorized ? "running" : "blocked",
    recordedAt: new Date().toISOString(),
  };
  graph.actions.push(action);
  return action;
}

export function recordEngagementCheckpoint(
  graph: EngagementGraph,
  input: Omit<EngagementCheckpoint, "id" | "recordedAt">,
): EngagementCheckpoint {
  const action = graph.actions.find((entry) => entry.id === input.actionId);
  if (!action) throw new Error(`Unknown engagement action: ${input.actionId}`);
  const checkpoint: EngagementCheckpoint = {
    id: randomUUID(),
    ...input,
    recordedAt: new Date().toISOString(),
  };
  graph.checkpoints.push(checkpoint);
  action.status = ["exited", "failed", "killed", "lost"].includes(input.status)
    ? input.status === "exited" ? "inconclusive" : "failed"
    : "running";
  return checkpoint;
}

export function reconcileEngagementJob(
  graph: EngagementGraph,
  input: { jobId: string; status: string; artifactPath: string; offset: number; observation: string },
): EngagementCheckpoint | undefined {
  const prior = [...graph.checkpoints].reverse().find((entry) => entry.jobId === input.jobId);
  if (!prior) return undefined;
  const checkpoint = recordEngagementCheckpoint(graph, {
    actionId: prior.actionId,
    ...input,
  });
  if (["exited", "failed", "killed", "lost"].includes(input.status)) {
    const action = graph.actions.find((entry) => entry.id === prior.actionId);
    const testCase = action ? graph.testCases.find((entry) => entry.id === action.testCaseId) : undefined;
    const terminalStatus: "inconclusive" | "failed" = input.status === "exited" ? "inconclusive" : "failed";
    if (action) action.status = terminalStatus;
    if (testCase) testCase.status = terminalStatus;
  }
  return checkpoint;
}

export function finishEngagementAction(
  graph: EngagementGraph,
  actionId: string,
  result: { ok: boolean; observation: string; artifactPath?: string | undefined; scannerLead?: boolean | undefined },
): EngagementEvidence {
  const action = graph.actions.find((entry) => entry.id === actionId);
  if (!action) throw new Error(`Unknown engagement action: ${actionId}`);
  const evidence: EngagementEvidence = {
    id: randomUUID(),
    targetId: action.targetId,
    testCaseId: action.testCaseId,
    ...(result.artifactPath ? { artifactPath: result.artifactPath } : {}),
    observation: result.observation,
    observedAt: new Date().toISOString(),
  };
  graph.evidence.push(evidence);
  action.evidenceId = evidence.id;
  action.status = result.scannerLead ? "inconclusive" : result.ok ? "passed" : "failed";
  const testCase = graph.testCases.find((entry) => entry.id === action.testCaseId);
  if (testCase) testCase.status = action.status;
  return evidence;
}

const validTransitions: Record<FindingState, FindingState[]> = {
  suspected: ["reproduced", "rejected", "inconclusive"],
  reproduced: ["verified", "rejected", "inconclusive"],
  verified: ["reported", "rejected"],
  reported: ["remediated"],
  remediated: ["retested"],
  retested: [],
  rejected: [],
  inconclusive: ["suspected", "rejected"],
};

export function transitionFinding(
  graph: EngagementGraph,
  findingId: string,
  state: FindingState,
  patch: Partial<Pick<EngagementFinding, "reproduction" | "impact" | "remediation" | "severity" | "evidenceIds">> = {},
): EngagementFinding {
  const finding = graph.findings.find((entry) => entry.id === findingId);
  if (!finding) throw new Error(`Unknown finding: ${findingId}`);
  if (finding.state !== state && !validTransitions[finding.state].includes(state)) {
    throw new Error(`Invalid finding transition: ${finding.state} -> ${state}`);
  }
  Object.assign(finding, patch);
  if (state === "verified") {
    if (!finding.reproduction?.trim() || !finding.impact?.trim() || finding.evidenceIds.length === 0) {
      throw new Error("Verified findings require reproduction, impact, and linked evidence");
    }
    const linked = new Set(graph.evidence.map((entry) => entry.id));
    if (finding.evidenceIds.some((id) => !linked.has(id))) throw new Error("Verified finding references unknown evidence");
  }
  finding.state = state;
  finding.updatedAt = new Date().toISOString();
  return finding;
}

export function createFinding(
  graph: EngagementGraph,
  input: Pick<EngagementFinding, "title" | "targetId"> & Partial<Pick<EngagementFinding, "severity" | "evidenceIds">>,
): EngagementFinding {
  const finding: EngagementFinding = {
    id: randomUUID(),
    title: input.title,
    targetId: input.targetId,
    state: "suspected",
    evidenceIds: input.evidenceIds ?? [],
    ...(input.severity ? { severity: input.severity } : {}),
    updatedAt: new Date().toISOString(),
  };
  graph.findings.push(finding);
  return finding;
}

export function renderEngagementReport(graph: EngagementGraph): string {
  const verified = graph.findings.filter((finding) => ["verified", "reported", "remediated", "retested"].includes(finding.state));
  const leads = graph.findings.filter((finding) => ["suspected", "reproduced", "inconclusive"].includes(finding.state));
  const exclusions = graph.scope.excludedTargets ?? [];
  const section = (title: string, lines: string[]): string => `${title}\n${lines.length ? lines.map((line) => `- ${line}`).join("\n") : "- None"}`;
  return [
    section("Verified findings", verified.map((finding) => `${finding.title} (${finding.state})`)),
    section("Inconclusive leads", leads.map((finding) => `${finding.title} (${finding.state})`)),
    section("Coverage", graph.coverage.map((item) => `${item.dimension}: ${item.state} — ${item.rationale}`)),
    section("Exclusions", exclusions),
    section("Residual risk", graph.residualRisk),
  ].join("\n\n");
}
