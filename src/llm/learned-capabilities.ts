import {
  getConfig,
  updateConfig,
  type LearnedRouteEntry,
  type LearnedVisionEntry,
} from "../store/config.js";

export const UNATTRIBUTED_CONTROL_DIALECT = "unattributed";

export const NEGATIVE_CAPABILITY_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_LEARNED_CAPABILITIES = 400;

export function routeCapabilityKey(provider: string, model: string): string {
  return `${provider}:${model.trim().toLowerCase()}`;
}

export function negativeIsStale(at: number, now = Date.now()): boolean {
  return now - at > NEGATIVE_CAPABILITY_TTL_MS;
}

export function readLearnedVisionEntry(
  entry: LearnedVisionEntry | undefined,
): { vision: boolean; at: number } | undefined {
  if (typeof entry === "boolean") return { vision: entry, at: 0 };
  if (!entry || typeof entry.vision !== "boolean") return undefined;
  const at = typeof entry.at === "string" ? Date.parse(entry.at) : Number.NaN;
  return { vision: entry.vision, at: Number.isFinite(at) ? at : 0 };
}

export function learnedRouteAt(entry: LearnedRouteEntry): number {
  const parsed = Date.parse(entry.at);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function learnedVisionCapabilities(): Record<string, LearnedVisionEntry> {
  try {
    return getConfig().learnedVisionCapabilities ?? {};
  } catch {
    return {};
  }
}

export function learnedRouteCapabilities(): Record<string, LearnedRouteEntry> {
  try {
    return getConfig().learnedRouteCapabilities ?? {};
  } catch {
    return {};
  }
}

export function readLearnedRoute(key: string): LearnedRouteEntry | undefined {
  return learnedRouteCapabilities()[key];
}

function learnedRouteIsLive(entry: LearnedRouteEntry): boolean {
  if (!negativeIsStale(learnedRouteAt(entry))) return true;
  return (
    entry.vision === true ||
    entry.reasoning === true ||
    Boolean(entry.acceptedEfforts?.length) ||
    entry.contextTokens !== undefined ||
    entry.maxOutputTokens !== undefined
  );
}

export function pruneLearnedRoutes(
  routes: Record<string, LearnedRouteEntry>,
): Record<string, LearnedRouteEntry> {
  const live: Record<string, LearnedRouteEntry> = {};
  for (const [key, entry] of Object.entries(routes)) {
    if (!entry || typeof entry.at !== "string") continue;
    if (!learnedRouteIsLive(entry)) continue;
    live[key] = entry;
  }
  const keys = Object.keys(live);
  if (keys.length <= MAX_LEARNED_CAPABILITIES) return live;
  const trimmed: Record<string, LearnedRouteEntry> = {};
  for (const key of keys.slice(keys.length - MAX_LEARNED_CAPABILITIES)) {
    trimmed[key] = live[key]!;
  }
  return trimmed;
}

function sanitizeLearnedRouteEntry(
  entry: Omit<LearnedRouteEntry, "at"> & { at: string },
): LearnedRouteEntry {
  const {
    controlDialect: _controlDialect,
    rejectedFields: _rejectedFields,
    ...rest
  } = entry;
  if (rest.reasoning === false) {
    const { reasoning: _reasoning, ...positive } = rest;
    return positive;
  }
  return rest;
}

export function persistLearnedRoute(
  key: string,
  update: Omit<LearnedRouteEntry, "at">,
): void {
  try {
    const routes = { ...learnedRouteCapabilities() };
    routes[key] = sanitizeLearnedRouteEntry({
      ...(routes[key] ?? {}),
      ...update,
      at: new Date().toISOString(),
    });
    updateConfig({ learnedRouteCapabilities: pruneLearnedRoutes(routes) });
  } catch {
  }
}

const sessionRejectedFields = new Map<string, readonly string[]>();

export function learnSessionRejectedField(key: string, field: string): void {
  const name = field.trim().toLowerCase();
  if (!name) return;
  const existing = sessionRejectedFields.get(key) ?? [];
  if (existing.includes(name)) return;
  sessionRejectedFields.set(key, [...existing, name]);
}

export function clearSessionRejectedFields(): void {
  sessionRejectedFields.clear();
}

export function pruneLearnedVision(
  learned: Record<string, LearnedVisionEntry>,
): Record<string, LearnedVisionEntry> {
  const live: Record<string, LearnedVisionEntry> = {};
  for (const [key, raw] of Object.entries(learned)) {
    const entry = readLearnedVisionEntry(raw);
    if (!entry) continue;
    if (!entry.vision && negativeIsStale(entry.at)) continue;
    live[key] = raw;
  }
  const keys = Object.keys(live);
  if (keys.length <= MAX_LEARNED_CAPABILITIES) return live;
  const trimmed: Record<string, LearnedVisionEntry> = {};
  for (const key of keys.slice(keys.length - MAX_LEARNED_CAPABILITIES)) {
    trimmed[key] = live[key]!;
  }
  return trimmed;
}

export function persistLearnedVision(
  key: string,
  vision: boolean,
): void {
  try {
    const learned = { ...learnedVisionCapabilities() };
    const current = readLearnedVisionEntry(learned[key]);
    if (current?.vision === vision && (vision || !negativeIsStale(current.at))) {
      return;
    }
    learned[key] = { vision, at: new Date().toISOString() };
    updateConfig({ learnedVisionCapabilities: pruneLearnedVision(learned) });
  } catch {
  }
}

export function clearPersistedLearnedVision(): void {
  try {
    updateConfig({ learnedVisionCapabilities: {} });
  } catch {
  }
}

export function clearPersistedLearnedRouteReasoning(key: string): void {
  try {
    const routes = { ...learnedRouteCapabilities() };
    const entry = routes[key];
    if (!entry) return;
    const {
      reasoning: _reasoning,
      controlDialect: _controlDialect,
      rejectedFields: _rejectedFields,
      ...rest
    } = entry;
    routes[key] = { ...rest, at: entry.at };
    updateConfig({ learnedRouteCapabilities: routes });
  } catch {
  }
}

export function clearPersistedLearnedRoutes(): void {
  try {
    updateConfig({ learnedRouteCapabilities: {} });
  } catch {
  }
}

export function learnedRouteRejectedFields(
  provider: string,
  model: string,
): readonly string[] {
  return sessionRejectedFields.get(routeCapabilityKey(provider, model)) ?? [];
}
