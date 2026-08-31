import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../store/paths.js";
import { redactSecrets } from "../llm/provider.js";

export type OutcomeKind = "answer" | "build" | "bugfix" | "operation" | "pentest";
export type OutcomeStatus = "active" | "succeeded" | "partial" | "blocked" | "failed" | "aborted" | "paused_budget";
export type CriterionStatus = "unproven" | "supported" | "proven" | "refuted" | "waived";
export type EvidenceKind = "observation" | "automated-check" | "process-start" | "readiness" | "probe" | "reproduction" | "impact" | "artifact" | "scanner-lead";

export interface OutcomeCriterion {
  id: string;
  statement: string;
  required: boolean;
  status: CriterionStatus;
  evidenceIds: string[];
  revision: number;
  domain?: "general" | "feature" | "bugfix" | "server" | "pentest-finding" | undefined;
}

export interface OutcomeContract {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  userIntent: string;
  kind: OutcomeKind;
  criteria: OutcomeCriterion[];
  assumptions: string[];
  constraints: string[];
  status: OutcomeStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceRecord {
  schemaVersion: 1;
  id: string;
  outcomeId: string;
  criterionIds: string[];
  taskId?: string | undefined;
  source: { tool: string; callId: string; artifact?: string | undefined };
  kind: EvidenceKind;
  observedAt: string;
  freshness: "current" | "stale";
  strength: "supporting" | "decisive";
  observation: string;
  result: "pass" | "fail" | "inconclusive";
  environment?: Record<string, string> | undefined;
  outcomeRevision: number;
}

export interface CompletedOperation {
  signature: string;
  tool: string;
  summary: string;
  observation: string;
  ok?: boolean | undefined;
  exitCode?: number | undefined;
  observationDigest?: string | undefined;
  unchangedRepeats?: number | undefined;
  stateKey?: string | undefined;
  artifact?: string | undefined;
  observedAt: string;
}

export interface OutcomeEnvelope {
  schemaVersion: 1;
  outcome: OutcomeContract;
  evidence: EvidenceRecord[];
  failedHypotheses: Array<{ signature: string; premise: string; observedAt: string }>;
  completedOperations?: CompletedOperation[] | undefined;
}

const fileFor = (sessionId: string): string => join(getDataDir(), "outcomes", `${encodeURIComponent(sessionId)}.json`);

const outcomeSaveQueues = new Map<string, Promise<void>>();

function mergeOutcomeEnvelopes(
  existing: OutcomeEnvelope | undefined,
  incoming: OutcomeEnvelope,
): OutcomeEnvelope {
  if (!existing || existing.outcome.id !== incoming.outcome.id) {
    return incoming;
  }
  if (incoming.outcome.revision < existing.outcome.revision) {
    return existing;
  }
  if (incoming.outcome.revision > existing.outcome.revision) {
    return incoming;
  }
  const evidence = [
    ...new Map(
      [...existing.evidence, ...incoming.evidence].map((record) => [record.id, record]),
    ).values(),
  ];
  const failedHypotheses = [
    ...new Map(
      [...existing.failedHypotheses, ...incoming.failedHypotheses].map((item) => [
        `${item.signature}\u0000${item.premise}`,
        item,
      ]),
    ).values(),
  ];
  const completedOperations = [
    ...new Map(
      [...(existing.completedOperations ?? []), ...(incoming.completedOperations ?? [])]
        .map((operation) => [operation.signature, operation]),
    ).values(),
  ].slice(-40);
  const criteria = [
    ...new Map(
      [...existing.outcome.criteria, ...incoming.outcome.criteria].map((criterion) => [
        criterion.id,
        criterion,
      ]),
    ).values(),
  ].map((criterion) => {
    const prior = existing.outcome.criteria.find((item) => item.id === criterion.id);
    const evidenceIds = [...new Set([...(prior?.evidenceIds ?? []), ...criterion.evidenceIds])];
    const linked = evidence.filter(
      (record) =>
        evidenceIds.includes(record.id) &&
        record.criterionIds.includes(criterion.id) &&
        record.freshness === "current",
    );
    let status: CriterionStatus = "unproven";
    if (criterion.status === "waived" || prior?.status === "waived") {
      status = "waived";
    } else if (
      linked.some((record) => record.result === "pass" && record.strength === "decisive")
    ) {
      status = "proven";
    } else if (linked.some((record) => record.result === "fail")) {
      status = "refuted";
    } else if (linked.some((record) => record.result === "pass")) {
      status = "supported";
    }
    return {
      ...criterion,
      status,
      evidenceIds,
    };
  });
  const outcome: OutcomeContract = {
    ...existing.outcome,
    ...incoming.outcome,
    criteria,
    updatedAt:
      existing.outcome.updatedAt >= incoming.outcome.updatedAt
        ? existing.outcome.updatedAt
        : incoming.outcome.updatedAt,
  };
  outcome.status = deriveOutcomeStatus(outcome, evidence);
  return {
    schemaVersion: 1,
    outcome,
    evidence,
    failedHypotheses,
    completedOperations,
  };
}

export function createOutcome(input: {
  sessionId: string;
  userIntent: string;
  kind: OutcomeKind;
  criteria: Array<Pick<OutcomeCriterion, "statement" | "required" | "domain"> & { id?: string }>;
}): OutcomeContract {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    sessionId: input.sessionId,
    userIntent: input.userIntent,
    kind: input.kind,
    criteria: input.criteria.map((criterion) => ({
      id: criterion.id ?? randomUUID(),
      statement: criterion.statement,
      required: criterion.required,
      status: "unproven",
      evidenceIds: [],
      revision: 1,
      domain: criterion.domain,
    })),
    assumptions: [],
    constraints: [],
    status: "active",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function reviseOutcome(outcome: OutcomeContract, criteria: OutcomeContract["criteria"]): OutcomeContract {
  const revision = outcome.revision + 1;
  return {
    ...outcome,
    revision,
    status: "active",
    criteria: criteria.map((criterion) => ({ ...criterion, revision, status: criterion.status === "waived" ? "waived" : "unproven", evidenceIds: [] })),
    updatedAt: new Date().toISOString(),
  };
}

export function linkEvidence(outcome: OutcomeContract, evidence: EvidenceRecord): void {
  if (evidence.outcomeId !== outcome.id || evidence.outcomeRevision !== outcome.revision) {
    throw new Error("evidence belongs to a different outcome or revision");
  }
  if (evidence.freshness !== "current") throw new Error("stale evidence cannot prove a criterion");
  for (const criterionId of evidence.criterionIds) {
    const criterion = outcome.criteria.find((item) => item.id === criterionId);
    if (!criterion) throw new Error(`unknown criterion: ${criterionId}`);
    if (!criterion.evidenceIds.includes(evidence.id)) criterion.evidenceIds.push(evidence.id);
    if (evidence.result === "pass") criterion.status = evidence.strength === "decisive" ? "proven" : "supported";
    else if (evidence.result === "fail") criterion.status = "refuted";
  }
  outcome.updatedAt = new Date().toISOString();
}

export function validateCriterionEvidence(criterion: OutcomeCriterion, records: readonly EvidenceRecord[]): { ok: boolean; reason?: string } {
  const linked = records.filter((record) => criterion.evidenceIds.includes(record.id) && record.criterionIds.includes(criterion.id) && record.freshness === "current" && record.result === "pass");
  if (criterion.status === "waived") return { ok: true };
  if (criterion.status !== "proven" || linked.length === 0) return { ok: false, reason: "criterion lacks current decisive linked evidence" };
  if (criterion.domain === "bugfix" && criterion.id === "reproduction") {
    const allLinked = records.filter(
      (record) =>
        criterion.evidenceIds.includes(record.id) &&
        record.criterionIds.includes(criterion.id) &&
        record.freshness === "current",
    );
    if (!allLinked.some((record) => record.kind === "reproduction" && record.result === "fail")) {
      return { ok: false, reason: "bug criterion lacks failing before/reproduction evidence" };
    }
    if (!allLinked.some((record) => record.kind === "reproduction" && record.result === "pass")) {
      return { ok: false, reason: "bug criterion lacks passing after-fix reproduction evidence" };
    }
  }
  if (criterion.domain === "pentest-finding") {
    const kinds = new Set(linked.map((record) => record.kind));
    if (!kinds.has("reproduction") || !kinds.has("impact") || !kinds.has("artifact")) {
      return { ok: false, reason: "pentest finding lacks reproduction, impact, or artifact evidence" };
    }
    if (linked.every((record) => record.kind === "scanner-lead")) return { ok: false, reason: "scanner output is a lead, not a verified finding" };
  }
  return { ok: true };
}

export function deriveOutcomeStatus(outcome: OutcomeContract, records: readonly EvidenceRecord[]): OutcomeStatus {
  const required = outcome.criteria.filter((criterion) => criterion.required);
  return required.every((criterion) => validateCriterionEvidence(criterion, records).ok) ? "succeeded" : "partial";
}

export function saveOutcomeState(envelope: OutcomeEnvelope): Promise<void> {
  const sessionId = envelope.outcome.sessionId;
  const previous = outcomeSaveQueues.get(sessionId) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(async () => {
    const dir = join(getDataDir(), "outcomes");
    const path = fileFor(sessionId);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dir, { recursive: true });
    try {
      let existing: OutcomeEnvelope | undefined;
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as OutcomeEnvelope;
        if (parsed.schemaVersion === 1) existing = parsed;
      } catch {
      }
      const merged = mergeOutcomeEnvelopes(existing, envelope);
      const serialized = `${JSON.stringify(merged, null, 2)}\n`;
      await writeFile(temp, serialized, { mode: 0o600 });
      await rename(temp, path);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  });
  outcomeSaveQueues.set(sessionId, queued);
  void queued.finally(() => {
    if (outcomeSaveQueues.get(sessionId) === queued) {
      outcomeSaveQueues.delete(sessionId);
    }
  }).catch(() => undefined);
  return queued;
}

export async function loadOutcomeState(sessionId: string): Promise<OutcomeEnvelope | undefined> {
  try {
    const parsed = JSON.parse(await readFile(fileFor(sessionId), "utf8")) as Partial<OutcomeEnvelope>;
    if (parsed.schemaVersion !== 1 || !parsed.outcome || !Array.isArray(parsed.evidence)) return undefined;
    const outcome = { ...parsed.outcome };
    if (outcome.status === "succeeded" && deriveOutcomeStatus(outcome, parsed.evidence) !== "succeeded") outcome.status = "partial";
    return {
      schemaVersion: 1,
      outcome,
      evidence: parsed.evidence,
      failedHypotheses: parsed.failedHypotheses ?? [],
      completedOperations: parsed.completedOperations ?? [],
    };
  } catch {
    return undefined;
  }
}

export function createEvidence(input: Omit<EvidenceRecord, "schemaVersion" | "id" | "observedAt">): EvidenceRecord {
  return { schemaVersion: 1, id: randomUUID(), observedAt: new Date().toISOString(), ...input };
}

export function inferOutcomeKind(input: {
  userIntent: string;
  buildLike?: boolean;
  pentestLike?: boolean;
}): OutcomeKind {
  if (input.pentestLike) return "pentest";
  if (/\b(?:fix|bug|regression|broken|error|failure)\b/i.test(input.userIntent)) return "bugfix";
  if (input.buildLike) return "build";
  if (/\b(?:start|serve|deploy|run|operate)\b/i.test(input.userIntent)) return "operation";
  return "answer";
}

export function defaultOutcomeCriteria(
  kind: OutcomeKind,
  userIntent: string,
): Array<Pick<OutcomeCriterion, "id" | "statement" | "required" | "domain">> {
  if (kind === "build") {
    return [
      { id: "implementation", statement: `Requested change is implemented: ${userIntent}`, required: true, domain: "feature" },
      { id: "verification", statement: "Changed behavior passes an automated or direct behavioral check", required: true, domain: "feature" },
    ];
  }
  if (kind === "bugfix") {
    return [
      { id: "reproduction", statement: "The reported failure is reproduced or characterized", required: true, domain: "bugfix" },
      { id: "implementation", statement: "A targeted fix is implemented", required: true, domain: "bugfix" },
      { id: "verification", statement: "A current check demonstrates the failure is resolved", required: true, domain: "bugfix" },
    ];
  }
  if (kind === "operation") {
    return [{ id: "answer", statement: "The requested operation is performed and verified", required: true, domain: "general" }];
  }
  if (kind === "pentest") {
    return [
      { id: "assessment", statement: "Authorized assessment activity completed with retained evidence", required: true, domain: "general" },
      { id: "finding", statement: "Any reported finding is reproduced with impact and artifact evidence", required: false, domain: "pentest-finding" },
    ];
  }
  return [{ id: "answer", statement: "The response directly addresses the current user intent", required: true, domain: "general" }];
}

export async function openOutcomeState(input: {
  sessionId: string;
  userIntent: string;
  kind: OutcomeKind;
  continueExisting?: boolean;
}): Promise<OutcomeEnvelope> {
  const existing = await loadOutcomeState(input.sessionId);
  if (existing && input.continueExisting && existing.outcome.status !== "succeeded") return existing;
  return {
    schemaVersion: 1,
    outcome: createOutcome({
      sessionId: input.sessionId,
      userIntent: input.userIntent,
      kind: input.kind,
      criteria: defaultOutcomeCriteria(input.kind, input.userIntent),
    }),
    evidence: [],
    failedHypotheses: existing?.failedHypotheses ?? [],
    completedOperations: existing?.completedOperations ?? [],
  };
}

export function recordFailedHypothesis(
  envelope: OutcomeEnvelope,
  input: { signature: string; premise: string },
): void {
  const duplicate = envelope.failedHypotheses.some(
    (item) => item.signature === input.signature && item.premise === input.premise,
  );
  if (!duplicate) {
    envelope.failedHypotheses.push({ ...input, observedAt: new Date().toISOString() });
  }
}

function canonicalOperationValue(value: unknown, key = ""): unknown {
  if (/^(?:_?retryReason)$/i.test(key)) return undefined;
  if (/pass|secret|token|authorization|api.?key|cookie/i.test(key)) return "[redacted]";
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => canonicalOperationValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, item]) => [name, canonicalOperationValue(item, name)])
        .filter(([, item]) => item !== undefined),
    );
  }
  return value;
}

export function isCompletedReadOperation(
  tool: string,
  args: Record<string, unknown> = {},
): boolean {
  if (/^(?:fs\.(?:read|list|search)|web\.(?:search|fetch)|shell\.(?:tail|jobs)|tool\.check|net\.context|pentest\.scanStatus|dns\.|whois\.)/.test(tool)) return true;
  if (tool === "http.fetch") return /^(?:GET|HEAD|OPTIONS)$/i.test(String(args.method ?? "GET"));
  if (tool !== "shell.exec") return false;
  const command = String(args.command ?? "");
  return /^\s*curl\b/i.test(command) &&
    !/(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)(?:-d|--data(?:-raw|-binary)?|-F|--form)(?:\s|=)/i.test(command);
}

export function normalizeOperationArgs(
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (tool !== "fs.read") return args;
  const normalized = { ...args };
  if (
    typeof normalized.startLine === "number" &&
    typeof normalized.offset !== "number"
  ) {
    normalized.offset = normalized.startLine;
  }
  delete normalized.startLine;
  if (normalized.offset === 0) normalized.offset = 1;
  if (
    typeof normalized.endLine === "number" &&
    typeof normalized.limit !== "number"
  ) {
    const start =
      typeof normalized.offset === "number" ? normalized.offset : 1;
    normalized.limit = normalized.endLine - start + 1;
    delete normalized.endLine;
  }
  return normalized;
}

export function completedOperationSignature(
  tool: string,
  args: Record<string, unknown> = {},
): string | undefined {
  if (!isCompletedReadOperation(tool, args)) return undefined;
  const canonicalArgs = JSON.stringify(
    canonicalOperationValue(normalizeOperationArgs(tool, args)),
  );
  return createHash("sha256")
    .update(`${tool}\0${canonicalArgs}`)
    .digest("hex")
    .slice(0, 20);
}

function stableOperationOutput(tool: string, output: string): string {
  let stable = redactSecrets(output).replace(/\r\n/g, "\n").trim();
  stable = stable
    .replace(/^Full output saved to:.*$/gim, "")
    .replace(/Full artifact: \S+/g, "Full artifact: <artifact>")
    .replace(/\b(?:\/var\/folders|\/tmp|\/var\/tmp|%TEMP%)[\w/.-]*\/clai\/[\w/.-]+/g, "<artifact>");
  if (tool === "shell.jobs") {
    stable = stable
      .replace(/\b(elapsed|age)=?\s*<?\d+(?:\.\d+)?(?:ms|s|m|h)\b/gi, "$1=<elapsed>")
      .replace(/(?:<1s|\b\d+m\d+s|\b\d+(?:\.\d+)?(?:ms|s|m|h))(?=\s)/g, "<elapsed>");
  }
  if (tool === "http.fetch" || tool === "web.fetch") {
    stable = stable
      .replace(/^(?:date|x-request-id|x-trace-id|traceparent|server-timing):.*$/gim, "")
      .replace(/\b(elapsed|duration|latency)\s*[=:]\s*\d+(?:\.\d+)?\s*ms\b/gi, "$1=<elapsed>");
  }
  return stable.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
}

export function completedOperationObservationDigest(
  tool: string,
  output: string,
): string {
  return createHash("sha256")
    .update(stableOperationOutput(tool, output))
    .digest("hex")
    .slice(0, 24);
}

export function recordCompletedOperation(
  envelope: OutcomeEnvelope,
  input: {
    tool: string;
    args?: Record<string, unknown>;
    output: string;
    ok?: boolean;
    exitCode?: number;
    artifact?: string;
    stateKey?: string;
  },
): CompletedOperation | undefined {
  const args = normalizeOperationArgs(input.tool, input.args ?? {});
  const signature = completedOperationSignature(input.tool, args);
  if (!signature) return undefined;
  const canonicalArgs = JSON.stringify(canonicalOperationValue(args));
  const digest = completedOperationObservationDigest(input.tool, input.output);
  const operations = envelope.completedOperations ?? (envelope.completedOperations = []);
  const existingIndex = operations.findIndex((item) => item.signature === signature);
  const existing = existingIndex >= 0 ? operations[existingIndex] : undefined;
  const unchanged =
    existing?.observationDigest === digest &&
    existing.stateKey === input.stateKey;
  const operation: CompletedOperation = {
    signature,
    tool: input.tool,
    summary: `${input.tool} ${canonicalArgs}`.slice(0, 240),
    observation: input.output.replace(/\s+/g, " ").trim().slice(0, 240),
    ok: input.ok !== false,
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    observationDigest: digest,
    unchangedRepeats: unchanged ? (existing.unchangedRepeats ?? 0) + 1 : 0,
    ...(input.stateKey ? { stateKey: input.stateKey } : {}),
    ...(input.artifact ? { artifact: input.artifact } : {}),
    observedAt: new Date().toISOString(),
  };
  if (existingIndex >= 0) operations.splice(existingIndex, 1);
  operations.push(operation);
  if (operations.length > 40) operations.splice(0, operations.length - 40);
  return operation;
}

export function recordToolEvidence(
  envelope: OutcomeEnvelope,
  input: {
    tool: string;
    callId: string;
    ok: boolean;
    exitCode?: number | undefined;
    output: string;
    artifact?: string | undefined;
    taskId?: string | undefined;
    args?: Record<string, unknown> | undefined;
    stateKey?: string | undefined;
  },
): EvidenceRecord[] {
  const ids = new Set(envelope.outcome.criteria.map((criterion) => criterion.id));
  const command = typeof input.args?.command === "string" ? input.args.command : "";
  const url = typeof input.args?.url === "string" ? input.args.url : "";
  recordCompletedOperation(envelope, {
    tool: input.tool,
    output: input.output,
    ok: input.ok,
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.args ? { args: input.args } : {}),
    ...(input.artifact ? { artifact: input.artifact } : {}),
    ...(input.stateKey ? { stateKey: input.stateKey } : {}),
  });
  const records: EvidenceRecord[] = [];
  const add = (
    criterionIds: string[],
    kind: EvidenceKind,
    strength: EvidenceRecord["strength"],
  ): void => {
    const linked = criterionIds.filter((id) => ids.has(id));
    if (linked.length === 0) return;
    const evidence = createEvidence({
      outcomeId: envelope.outcome.id,
      outcomeRevision: envelope.outcome.revision,
      criterionIds: linked,
      taskId: input.taskId,
      source: { tool: input.tool, callId: input.callId, artifact: input.artifact },
      kind,
      freshness: "current",
      strength,
      observation: input.output.slice(0, 4_000),
      result: input.ok ? "pass" : "fail",
    });
    envelope.evidence.push(evidence);
    linkEvidence(envelope.outcome, evidence);
    records.push(evidence);
  };

  const isWrite = /^(?:fs\.(?:write|writeMany|edit|replaceLines|append))$/.test(input.tool);
  const isCheck = input.tool === "shell.exec" && /\b(?:test|vitest|jest|pytest|typecheck|lint|build|check)\b/i.test(command);
  const isProbe = input.tool === "http.fetch" || (input.tool === "shell.exec" && /\bcurl\b/i.test(command));
  const isStart = input.tool === "shell.start";
  const isReady = input.tool === "shell.tail" && /\b(?:ready|listening|started|localhost|127\.0\.0\.1)\b/i.test(input.output);
  const isScanner = input.tool === "net.scan" || input.tool === "pentest.recon" || /\b(?:nmap|nikto|nuclei|ffuf|gobuster)\b/i.test(command);
  const isActiveSecurity = input.tool === "http.fetch" && !/^(?:GET|HEAD|OPTIONS)?$/i.test(String(input.args?.method ?? "GET"));

  if (isWrite) add(["implementation"], "artifact", "supporting");
  if (isCheck) add(["verification", "implementation"], "automated-check", "decisive");
  if (isCheck && envelope.outcome.kind === "bugfix") add(["reproduction"], "reproduction", "decisive");
  if (isStart) add(["server"], "process-start", "decisive");
  if (isReady) add(["server"], "readiness", "decisive");
  if (isProbe) add(["server"], "probe", "decisive");
  if (isScanner) add(["assessment", "finding"], "scanner-lead", "supporting");
  if (isActiveSecurity) add(["assessment"], "reproduction", "decisive");
  if (envelope.outcome.kind === "pentest" && input.artifact && input.ok) add(["assessment"], "artifact", "decisive");
  if (input.tool === "web.search" || input.tool === "web.fetch" || input.tool === "fs.read") {
    add(["answer", "reproduction"], "observation", "supporting");
  }
  envelope.outcome.status = deriveOutcomeStatus(envelope.outcome, envelope.evidence);
  return records;
}

export function recordAnswerEvidence(
  envelope: OutcomeEnvelope,
  answer: string,
): EvidenceRecord | undefined {
  const criterion = envelope.outcome.criteria.find((item) => item.id === "answer");
  if (!criterion || !answer.trim()) return undefined;
  const evidence = createEvidence({
    outcomeId: envelope.outcome.id,
    outcomeRevision: envelope.outcome.revision,
    criterionIds: [criterion.id],
    source: { tool: "assistant.final", callId: `final-${envelope.outcome.revision}` },
    kind: "observation",
    freshness: "current",
    strength: "decisive",
    observation: answer.slice(0, 4_000),
    result: "pass",
  });
  envelope.evidence.push(evidence);
  linkEvidence(envelope.outcome, evidence);
  envelope.outcome.status = deriveOutcomeStatus(envelope.outcome, envelope.evidence);
  return evidence;
}
