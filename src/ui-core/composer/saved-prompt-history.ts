import type { SessionController } from "../../app/controllers/session-controller.js";
import { createSavedPromptReader } from "../../store/session-prompts.js";
import { shouldStoreInPromptHistory } from "./input-history.js";
import type { PromptHistory } from "./prompt-history.js";

type PromptSession = Pick<SessionController, "promptHistory" | "isPromptHistoryEnabled" | "subscribe">;
type PromptStore = PromptSession["promptHistory"];

export function bindSavedPromptHistory(history: PromptHistory, session: PromptSession): () => void {
  let store: PromptStore | undefined;
  let enabled: boolean | undefined;
  let revision = -1;
  let unsubscribeStore: (() => void) | undefined;

  const refresh = (): void => {
    const next = session.promptHistory;
    const active = session.isPromptHistoryEnabled();
    if (store === next && enabled === active && revision === next.revision) return;
    if (store !== next) {
      unsubscribeStore?.();
      unsubscribeStore = next.subscribe(refresh);
    }
    const changed = store !== undefined && store !== next;
    store = next;
    enabled = active;
    revision = next.revision;
    const reader = active ? createSavedPromptReader(next) : undefined;
    history.setOlderSource(reader ? async () => {
      while (session.isPromptHistoryEnabled() && session.promptHistory === next) {
        const text = await reader.readOlder();
        if (!session.isPromptHistoryEnabled() || session.promptHistory !== next) return undefined;
        if (text === undefined || shouldStoreInPromptHistory(text)) return text;
      }
      return undefined;
    } : undefined, changed);
  };
  refresh();
  const unsubscribe = session.subscribe(refresh);
  return () => {
    unsubscribe();
    unsubscribeStore?.();
    history.setOlderSource(undefined);
  };
}
