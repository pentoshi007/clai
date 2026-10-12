import type { AppServices } from "../bootstrap/composition-root.js";
import { createSessionPromptsPagerSource } from "../rendering/session-prompts-pager-source.js";

export async function handlePrompts(services: AppServices): Promise<void> {
  if (!services.session.isPromptHistoryEnabled()) {
    services.session.notice("info", "session prompt history is disabled in private mode or with --no-history");
    return;
  }
  const store = services.session.promptHistory;
  try {
    await services.session.ensurePromptHistory();
  } catch (error) {
    services.session.notice("warn", `could not load session prompts: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (store !== services.session.promptHistory || !services.session.isPromptHistoryEnabled()) return;
  const source = createSessionPromptsPagerSource(store);
  services.overlay.openPager(
    "Session prompts",
    "# Session prompts\n\nLoading saved prompts…\n",
    source,
    undefined,
    "force",
  );
}
