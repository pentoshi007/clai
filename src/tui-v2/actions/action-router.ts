/**
 * Action router (V2-033).
 *
 * Resolves a normalized key chord to a semantic action given the active input
 * context. Context bindings win over `global`, so a picker can rebind Enter
 * without losing global cancel. Validates on construction so a conflicting
 * keymap fails fast instead of resolving nondeterministically.
 */

import type { ActionContext, ActionId } from "./action-id.js";
import {
  defaultKeymap,
  normalizeChord,
  validateKeymap,
  type KeyBinding,
} from "./keymap.js";

/**
 * Blocking-overlay contexts trap input (PICK-002): an unbound chord does
 * nothing rather than falling through to a global action like Ctrl+H. Base
 * regions (composer/transcript/plan) intentionally keep the global fallback
 * so app-wide shortcuts work no matter which region has focus.
 */
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

  /** Resolve a chord in `context`, then fall back to `global` unless `context` traps input. */
  resolve(chord: string, context: ActionContext): ActionId | undefined {
    const normalized = normalizeChord(chord);
    const contextHit = this.byContext.get(context)?.get(normalized);
    if (contextHit) return contextHit;
    if (context === "global" || TRAPPING_CONTEXTS.has(context)) return undefined;
    return this.byContext.get("global")?.get(normalized);
  }

  /** All chords bound to an action, for help/status display. */
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
