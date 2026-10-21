const DEEP_SURFACES = new Set(["official-proxy", "enhanced"]);
const BLOCKED_REASONS = new Set(["provider_missing", "provider_unavailable"]);
const MAX_REASON_CHARS = 160;

export interface ReaEngine {
  readonly id: string;
  readonly name: string;
  readonly ready: boolean;
  readonly code: string | undefined;
  readonly reason: string | undefined;
  readonly failed: readonly string[];
  readonly java: string | undefined;
}

export interface ReaBlockedGroup {
  readonly tools: readonly string[];
  readonly remediation: string;
}

export interface ReaAvailability {
  readonly engines: readonly ReaEngine[];
  readonly open: ReadonlySet<string>;
  readonly deep: ReadonlySet<string>;
  readonly blocked: ReadonlySet<string>;
  readonly blockedGroups: readonly ReaBlockedGroup[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function compact(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text;
}

function engine(candidate: unknown): ReaEngine | undefined {
  if (!isRecord(candidate) || !isRecord(candidate.provider)) return undefined;
  const { id, name } = candidate.provider;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(id)) return undefined;
  const availability = isRecord(candidate.availability) ? candidate.availability : {};
  const diagnostics = isRecord(availability.diagnostics) ? availability.diagnostics : {};
  const checks = Array.isArray(diagnostics.checks) ? diagnostics.checks.filter(isRecord) : [];
  const java = diagnostics.java_version;
  return {
    id,
    name: typeof name === "string" && name.length <= 64 ? name : id,
    ready: availability.status === "available",
    code: typeof availability.code === "string" ? availability.code : undefined,
    reason: compact(availability.reason),
    failed: checks.filter((check) => check.ok === false && typeof check.name === "string").map((check) => String(check.name)).slice(0, 12),
    java: typeof java === "string" && /^[0-9A-Za-z._+-]{1,24}$/.test(java) ? java : undefined,
  };
}

export function parseReaAvailability(text: string): ReaAvailability | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const session = isRecord(parsed) && isRecord(parsed.result) ? parsed.result : parsed;
  if (!isRecord(session) || !Array.isArray(session.analysis_provider_candidates)) return undefined;
  const engines = session.analysis_provider_candidates.flatMap((candidate) => engine(candidate) ?? []);
  const groups = isRecord(session.tool_availability) && Array.isArray(session.tool_availability.groups)
    ? session.tool_availability.groups.filter(isRecord)
    : [];
  const open = new Set<string>();
  const deep = new Set<string>();
  const blocked = new Set<string>();
  const blockedGroups: ReaBlockedGroup[] = [];
  for (const group of groups) {
    const names = strings(group.names);
    if (typeof group.surface === "string" && DEEP_SURFACES.has(group.surface)) {
      for (const name of names) deep.add(name);
    }
    if (group.available === true) continue;
    if (group.reason === "target_required") {
      for (const name of names) open.add(name);
    } else if (typeof group.reason === "string" && BLOCKED_REASONS.has(group.reason)) {
      for (const name of names) blocked.add(name);
      blockedGroups.push({ tools: names, remediation: compact(group.remediation) ?? "a prerequisite is missing" });
    }
  }
  if (engines.length === 0 && open.size === 0 && deep.size === 0 && blocked.size === 0) return undefined;
  return { engines, open, deep, blocked, blockedGroups };
}

export function readyEngines(availability: ReaAvailability | undefined): readonly ReaEngine[] {
  return availability?.engines.filter((entry) => entry.ready) ?? [];
}
