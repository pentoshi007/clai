import type { SessionController } from "../../app/controllers/session-controller.js";
import { createSavedPromptReader } from "../../store/session-prompts.js";
import { shouldStoreInPromptHistory } from "./input-history.js";
import type { PromptHistory } from "./prompt-history.js";

type PromptSession = Pick<SessionController, "promptHistory" | "isPromptHistoryEnabled" | "subscribe">;

export function bindSavedPromptHistory(history: PromptHistory, session: PromptSession): () => void {
  let store: PromptSession["promptHistory"] | undefined;
  let enabled: boolean | undefined;
  const refresh = (): void => {
    const next = session.promptHistory;
    const active = session.isPromptHistoryEnabled();
    if (store === next && enabled === active) return;
    const changed = store !== undefined;
    store = next;
    enabled = active;
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
    history.setOlderSource(undefined);
  };
}
