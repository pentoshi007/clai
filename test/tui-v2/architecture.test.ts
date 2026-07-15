import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const tuiV2Root = join(here, "..", "..", "src", "tui-v2");

/**
 * The renderer-independent core of the v2 UI (layout, actions, capabilities,
 * lifecycle, composition root, ui-selection, transcript/plan store/reducer)
 * must not import the renderer framework — only the shell (`app/**`), the
 * composer/transcript/picker/modal/pager/jobs/plan/overlay renderable
 * adapters, and the React store bindings may. This keeps the application/
 * controller/reducer logic testable under Node and swappable behind the same
 * ports if the adapter ever changes. `pager-export.ts` is a deliberate,
 * narrow exception to the raw-terminal-write rule: exporting pager content to
 * real scrollback/`$EDITOR` needs the actual stdout, gated behind the
 * `RendererSuspendPort` it's injected rather than importing `@opentui/*`.
 */
const RENDERER_ALLOWED = new Set<string>([
  join(tuiV2Root, "app", "App.tsx"),
  join(tuiV2Root, "app", "providers.tsx"),
  join(tuiV2Root, "bootstrap", "start-tui-v2.ts"),
  join(tuiV2Root, "bootstrap", "disable-native-selection.ts"),
  join(tuiV2Root, "bootstrap", "pager-export.ts"),
  join(tuiV2Root, "components", "transcript", "use-native-selection-copy.ts"),
  join(tuiV2Root, "components", "transcript", "use-click-without-drag.ts"),
  join(tuiV2Root, "components", "toast", "toast-host.tsx"),
  join(tuiV2Root, "state", "use-toast.ts"),
  join(tuiV2Root, "composer", "composer-editor.tsx"),
  join(tuiV2Root, "rendering", "ansi-to-styled.ts"),
  join(tuiV2Root, "state", "use-transcript-store.ts"),
  join(tuiV2Root, "state", "use-plan.ts"),
  join(tuiV2Root, "state", "use-overlay.ts"),
  join(tuiV2Root, "state", "use-session-state.ts"),
  join(tuiV2Root, "components", "transcript", "user-message.tsx"),
  join(tuiV2Root, "components", "transcript", "assistant-message.tsx"),
  join(tuiV2Root, "components", "transcript", "thinking-block.tsx"),
  join(tuiV2Root, "components", "transcript", "tool-card.tsx"),
  join(tuiV2Root, "components", "transcript", "notice-row.tsx"),
  join(tuiV2Root, "components", "transcript", "compacted-row.tsx"),
  join(tuiV2Root, "components", "transcript", "transcript-row.tsx"),
  join(tuiV2Root, "components", "transcript", "search-bar.tsx"),
  join(tuiV2Root, "components", "transcript", "transcript-view.tsx"),
  join(tuiV2Root, "components", "transcript", "linkable-text.tsx"),
  join(tuiV2Root, "components", "transcript", "use-transcript-selection.ts"),
  join(tuiV2Root, "components", "transcript", "intro-card.tsx"),
  join(tuiV2Root, "components", "completion", "completion-menu.tsx"),
  join(tuiV2Root, "components", "status", "status-line.tsx"),
  join(tuiV2Root, "components", "queue", "queue-panel.tsx"),
  join(tuiV2Root, "components", "picker", "picker.tsx"),
  join(tuiV2Root, "components", "modal", "confirm-modal.tsx"),
  join(tuiV2Root, "components", "modal", "secret-modal.tsx"),
  join(tuiV2Root, "components", "modal", "prompt-actions-modal.tsx"),
  join(tuiV2Root, "components", "pager", "pager.tsx"),
  join(tuiV2Root, "components", "jobs", "jobs-panel.tsx"),
  join(tuiV2Root, "components", "plan", "plan-view.tsx"),
  join(tuiV2Root, "components", "overlay", "overlay-host.tsx"),
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("src/tui-v2 architecture boundary", () => {
  const files = walk(tuiV2Root);

  it("finds the tui-v2 source tree", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("keeps the renderer framework out of renderer-independent modules", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (RENDERER_ALLOWED.has(file)) continue;
      const src = readFileSync(file, "utf8");
      if (/from\s+["']@opentui\//.test(src) || /from\s+["']react["']/.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never writes raw terminal bytes from renderer-independent modules", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (RENDERER_ALLOWED.has(file)) continue;
      const src = readFileSync(file, "utf8");
      if (/process\.stdout\.write|process\.stdin\.setRawMode|process\.stdin\.write/.test(src))
        offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
