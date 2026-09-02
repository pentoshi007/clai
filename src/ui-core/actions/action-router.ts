
import type { ActionContext, ActionId } from "./action-id.js";
import {
  defaultKeymap,
  normalizeChord,
  validateKeymap,
  type KeyBinding,
} from "./keymap.js";

const TRAPPING_CONTEXTS: ReadonlySet<ActionContext> = new Set([
  "picker",
  "modal",
  "secret",
  "transcript-search",
  "pager",
  "jobs",
]);

export class ActionRouter {
  private readonly byContext = new Map<
    ActionContext,
    Map<string, ActionId>
  >();

  constructor(bindings: readonly KeyBinding[] = defaultKeymap) {
    const conflicts = validateKeymap(bindings);
    if (conflicts.length > 0) {
      const detail = conflicts
        .map((c) => `${c.context}:${c.chord} -> [${c.actions.join(", ")}]`)
        .join("; ");
      throw new Error(`keymap has conflicting bindings: ${detail}`);
    }
    for (const b of bindings) {
      const map = this.byContext.get(b.context) ?? new Map<string, ActionId>();
      map.set(b.chord, b.action);
      this.byContext.set(b.context, map);
    }
  }

  resolve(chord: string, context: ActionContext): ActionId | undefined {
    const normalized = normalizeChord(chord);
    const contextHit = this.byContext.get(context)?.get(normalized);
    if (contextHit) return contextHit;
    if (context === "global" || TRAPPING_CONTEXTS.has(context)) return undefined;
    return this.byContext.get("global")?.get(normalized);
  }

  chordsFor(action: ActionId): string[] {
    const chords: string[] = [];
    for (const map of this.byContext.values()) {
      for (const [chord, boundAction] of map) {
        if (boundAction === action) chords.push(chord);
      }
    }
    return chords;
  }
}
