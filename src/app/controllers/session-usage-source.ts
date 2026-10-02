export interface SubagentUsageSource {
  readonly kind: "subagent";
  readonly id: string;
  readonly number: number;
}

export function normalizeUsageSource(value: unknown): SubagentUsageSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (
    source.kind !== "subagent" ||
    typeof source.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(source.id) ||
    typeof source.number !== "number" ||
    !Number.isSafeInteger(source.number) ||
    source.number < 1
  ) return undefined;
  return { kind: "subagent", id: source.id, number: source.number };
}

export function usageSourceLabel(source: SubagentUsageSource | undefined): string {
  return source ? `subagent-${source.number}` : "Main agent";
}

export class SessionUsageSources {
  private readonly sources = new Map<string, SubagentUsageSource>();
  private nextNumber = 1;

  subagent(id: string, preferredNumber?: number): SubagentUsageSource {
    const existing = this.sources.get(id);
    if (existing) return existing;
    const available = preferredNumber !== undefined &&
      ![...this.sources.values()].some((source) => source.number === preferredNumber);
    const number = available ? preferredNumber : this.nextNumber;
    const source = Object.freeze({ kind: "subagent" as const, id, number });
    this.nextNumber = Math.max(this.nextNumber, number + 1);
    this.sources.set(id, source);
    return source;
  }

  clear(): void {
    this.sources.clear();
    this.nextNumber = 1;
  }
}
