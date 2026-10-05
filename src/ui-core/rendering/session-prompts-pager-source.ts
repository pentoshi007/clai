import type { SessionPromptStore } from "../../store/session-prompts.js";
import {
  createArtifactPagerSource,
  createTextPagerSource,
  type ArtifactPagerSource,
} from "./artifact-pager-source.js";

export function createSessionPromptsPagerSource(
  store: SessionPromptStore,
  pageBytes = 16 * 1024,
): ArtifactPagerSource {
  const file = createArtifactPagerSource(store.path, pageBytes);
  const empty = createTextPagerSource(
    "# Session prompts\n\nNo user prompts have been sent in this session.\n",
    "memory://session-prompts",
    pageBytes,
  );
  const subscriptions = new Set<() => void>();
  let disposed = false;
  const active = async (): Promise<ArtifactPagerSource> => {
    await store.flush();
    if (disposed) throw new Error("session prompts pager is disposed");
    return await store.count() > 0 ? file : empty;
  };
  return {
    path: file.path,
    pageBytes: file.pageBytes,
    readPage: async (offset) => (await active()).readPage(offset),
    readTail: async () => (await active()).readTail!(),
    readAll: async () => (await active()).readAll(),
    search: async (query, fromOffset, reverse) => (await active()).search(query, fromOffset, reverse),
    isGrowing: () => false,
    watch(listener) {
      if (disposed) return () => undefined;
      const unsubscribe = store.subscribe(listener);
      subscriptions.add(unsubscribe);
      return () => { unsubscribe(); subscriptions.delete(unsubscribe); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions.clear();
      file.dispose();
      empty.dispose();
    },
  };
}
