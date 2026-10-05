import type { AppServices } from "../bootstrap/composition-root.js";
import { createSessionPromptsPagerSource } from "../rendering/session-prompts-pager-source.js";

export function handlePrompts(services: AppServices): void {
  if (!services.session.isPromptHistoryEnabled()) {
    services.session.notice("info", "session prompt history is disabled in private mode or with --no-history");
    return;
  }
  const source = createSessionPromptsPagerSource(services.session.promptHistory);
  services.overlay.openPager(
    "Session prompts",
    "# Session prompts\n\nLoading saved prompts…\n",
    source,
    undefined,
    "force",
  );
}
