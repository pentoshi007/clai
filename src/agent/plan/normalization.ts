import { isBareTaskIdTitle } from "../../store/plan.js";
import type { SessionPlan } from "../../store/plan.js";

export function titlesMatchForPlan(a: string, b: string): boolean {
  const t1 = a.trim().toLowerCase();
  const t2 = b.trim().toLowerCase();
  return (
    t1 === t2 ||
    (t1.length > 8 && t2.length > 8 && (t1.includes(t2) || t2.includes(t1)))
  );
}

export function looksLikeRunOnlyGoal(goal: string, detail: string): boolean {
  const blob = `${goal} ${detail}`.toLowerCase();
  if (!/\b(run|start|launch|serve|dev\s*server|npm\s+run\s+dev)\b/.test(blob)) {
    return false;
  }
  if (/\b(scaffold|create|build|implement|add feature|from scratch|new app)\b/.test(blob)) {
    return false;
  }
  return /\b(existing|already|the app|dev server|server|verify|test it|open it)\b/.test(blob)
    || /^(run|start)\b/.test(blob.trim());
}

export function nextTaskId(existingIds: string[]): string {
  let max = 0;
  for (const id of existingIds) {
    const m = /^t(\d+)$/i.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `t${max + 1}`;
}

export function normalizePlanGoal(args: Record<string, unknown>): string {
  const raw = args.goal ?? args.objective ?? args.title ?? args.name;
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const k of ["title", "text", "goal", "name", "summary"]) {
      if (typeof o[k] === "string" && o[k]!.toString().trim()) {
        return String(o[k]).trim();
      }
    }
  }
  return "";
}

export function normalizePlanDetail(args: Record<string, unknown>): string {
  const raw = args.detail ?? args.description ?? args.approach ?? args.notes;
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      .join("\n")
      .trim();
  }
  return "";
}

export function normalizePlanKind(args: Record<string, unknown>): string {
  const raw = args.kind ?? args.type ?? args.category;
  if (typeof raw === "string" && raw.trim()) return raw.trim().toLowerCase();
  return "general";
}

export function normalizeTaskTitle(t: unknown): string {
  if (typeof t === "string") return t.trim();
  if (typeof t === "number" && Number.isFinite(t)) return String(t);
  if (t && typeof t === "object") {
    const o = t as Record<string, unknown>;
    for (const k of [
      "title",
      "task",
      "name",
      "text",
      "description",
      "label",
      "step",
      "summary",
    ]) {
      if (typeof o[k] === "string" && o[k]!.toString().trim()) {
        return String(o[k]).trim();
      }
    }
  }
  return "";
}

export function slugifyTaskId(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export interface NormalizedPlanTask {
  title: string;
  aliases: string[];
  dependencies: string[];
  dependenciesSpecified: boolean;
  resourceLocks: string[];
  acceptanceCriteria?: string | undefined;
}

export function normalizePlanTaskEntries(
  args: Record<string, unknown>,
): NormalizedPlanTask[] {
  const raw =
    args.tasks ?? args.steps ?? args.checklist ?? args.items ?? args.todos;
  if (typeof raw === "string") {
    return raw
      .split(/\n|;|(?:,\s*(?=[A-Z0-9\-]))/)
      .map((s) => s.replace(/^\s*[-*\d.)]+\s*/, "").trim())
      .filter(Boolean)
      .map((title) => ({
        title,
        aliases: [] as string[],
        dependencies: [] as string[],
        dependenciesSpecified: false,
        resourceLocks: [] as string[],
      }));
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t): NormalizedPlanTask | null => {
      const title = normalizeTaskTitle(t);
      if (!title || isBareTaskIdTitle(title)) return null;
      const aliases: string[] = [];
      if (t && typeof t === "object") {
        const o = t as Record<string, unknown>;
        for (const k of ["id", "taskId", "key", "slug"]) {
          if (typeof o[k] === "string" && o[k]!.toString().trim()) {
            aliases.push(String(o[k]).trim());
          }
        }
        if (
          typeof o.name === "string" &&
          o.name.trim() &&
          o.name.trim().toLowerCase() !== title.toLowerCase()
        ) {
          aliases.push(o.name.trim());
        }
      }
      const slug = slugifyTaskId(title);
      if (slug && !aliases.includes(slug)) aliases.push(slug);
      const object = t && typeof t === "object" ? (t as Record<string, unknown>) : {};
      const stringArray = (value: unknown): string[] =>
        Array.isArray(value)
          ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
          : [];
      const rawAcceptance =
        object.acceptance ??
        object.acceptanceCriteria ??
        object.successCriteria ??
        object.verify;
      const acceptanceCriteria =
        typeof rawAcceptance === "string"
          ? rawAcceptance.trim()
          : Array.isArray(rawAcceptance)
            ? rawAcceptance
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim())
                .filter(Boolean)
                .join("; ")
            : "";
      return {
        title,
        aliases: [...new Set(aliases)],
        dependencies: stringArray(object.dependencies ?? object.dependsOn),
        dependenciesSpecified:
          Object.prototype.hasOwnProperty.call(object, "dependencies") ||
          Object.prototype.hasOwnProperty.call(object, "dependsOn"),
        resourceLocks: stringArray(object.resourceLocks ?? object.resources),
        ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
      };
    })
    .filter((x): x is NormalizedPlanTask => Boolean(x));
}

export function resolvePlanTaskId(
  plan: SessionPlan,
  taskId: string,
): string | undefined {
  const raw = taskId.trim();
  if (!raw) return undefined;
  if (plan.tasks.some((t) => t.id === raw)) return raw;
  const lower = raw.toLowerCase();
  const slug = slugifyTaskId(raw);
  for (const t of plan.tasks) {
    if (t.aliases?.some((a) => a === raw || a.toLowerCase() === lower)) {
      return t.id;
    }
  }
  return undefined;
}
