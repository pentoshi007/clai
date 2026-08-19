import type { ReasoningEffort } from "../types.js";
import { EFFORT_SCALE, nearestAcceptedEffort } from "./reasoning-controls.js";

const routeControlDialects = new Map<string, string>();
const negativeControlDialects = new Map<string, string>();

export function setRouteControlDialect(key: string, dialect: string): void {
  routeControlDialects.set(key, dialect);
}

export function routeControlDialect(key: string): string | undefined {
  return routeControlDialects.get(key);
}

export function setNegativeControlDialect(key: string, dialect: string): void {
  negativeControlDialects.set(key, dialect);
}

export function forgetNegativeControlDialect(key: string): void {
  negativeControlDialects.delete(key);
}

export function negativeLearnedUnderAnotherDialect(key: string): boolean {
  const learnedUnder = negativeControlDialects.get(key);
  const current = routeControlDialects.get(key);
  return (
    learnedUnder !== undefined && current !== undefined && learnedUnder !== current
  );
}

export function clearRouteDialectRegistry(): void {
  routeControlDialects.clear();
  negativeControlDialects.clear();
}

export function clampEffortToRoute(
  requested: ReasoningEffort,
  accepted: readonly string[] | undefined,
): ReasoningEffort {
  if (!accepted || accepted.length === 0) return requested;
  if (accepted.includes(requested)) return requested;
  const nearest = nearestAcceptedEffort(requested, accepted);
  return EFFORT_SCALE.find((value) => value === nearest) ?? requested;
}
