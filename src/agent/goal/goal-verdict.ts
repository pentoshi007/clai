export type GoalVerdictKind = "met" | "not_met" | "blocked" | "impossible";

export interface GoalVerdict {
  readonly kind: GoalVerdictKind;
  readonly reason: string;
  readonly nextStep?: string | undefined;
}

const MAX_REASON_CHARS = 600;

const VERDICT_ALIASES: ReadonlyMap<string, GoalVerdictKind> = new Map([
  ["met", "met"],
  ["done", "met"],
  ["complete", "met"],
  ["completed", "met"],
  ["achieved", "met"],
  ["yes", "met"],
  ["not_met", "not_met"],
  ["notmet", "not_met"],
  ["not_yet_met", "not_met"],
  ["continue", "not_met"],
  ["in_progress", "not_met"],
  ["incomplete", "not_met"],
  ["no", "not_met"],
  ["blocked", "blocked"],
  ["paused", "blocked"],
  ["needs_user", "blocked"],
  ["impossible", "impossible"],
  ["failed", "impossible"],
  ["unachievable", "impossible"],
]);

function verdictKind(value: unknown): GoalVerdictKind | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return VERDICT_ALIASES.get(key);
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text;
}

function jsonObjects(text: string): string[] {
  const found: string[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          found.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return found;
}

function visibleText(text: string): string {
  return text
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, " ")
    .replace(/```(?:json)?/gi, " ");
}

export function parseGoalVerdict(text: string): GoalVerdict | undefined {
  const candidates = jsonObjects(visibleText(text)).reverse();
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const kind = verdictKind(record.verdict ?? record.status ?? record.decision);
    if (!kind) continue;
    const nextStep = cleanText(record.next_step ?? record.nextStep);
    return {
      kind,
      reason: cleanText(record.reason) ?? (kind === "met" ? "The evaluator found the condition satisfied." : "The evaluator gave no reason."),
      ...(kind === "not_met" && nextStep ? { nextStep } : {}),
    };
  }
  return undefined;
}
