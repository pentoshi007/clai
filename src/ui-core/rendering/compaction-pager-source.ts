import type { AppServices } from "../bootstrap/composition-root.js";
import { displayCompactSummary } from "../state/transcript-hydrate.js";
import type { CompactedItem } from "../state/transcript-types.js";
import { createTextPagerSource, DEFAULT_ARTIFACT_PAGE_BYTES, type ArtifactPagerSource } from "./artifact-pager-source.js";

export function createCompactionPagerSource(services: AppServices, initial: CompactedItem): ArtifactPagerSource {
  const sessionId = services.session.sessionId;
  const path = `memory://compaction/${initial.id}`;
  const subscriptions = new Set<() => void>();
  let latest = initial;
  let rendered: CompactedItem | undefined;
  let source: ArtifactPagerSource | undefined;
  let disposed = false;
  const current = (): CompactedItem => {
    if (services.session.sessionId !== sessionId) return latest;
    const item = services.transcript.getState().byId.get(initial.id);
    if (item?.kind === "compacted") latest = item;
    return latest;
  };
  const active = (): ArtifactPagerSource => {
    if (disposed) throw new Error("compaction pager is closed");
    const item = current();
    if (!source || rendered !== item) {
      source?.dispose();
      rendered = item;
      const summary = item.streaming ? item.summary : displayCompactSummary(item.summary);
      const body = item.error ? `${summary}\n\nCompaction failed: ${item.error}`.trim() : summary;
      source = createTextPagerSource(body || "(waiting for compaction output)", path);
    }
    return source;
  };
  return {
    path,
    pageBytes: DEFAULT_ARTIFACT_PAGE_BYTES,
    readPage: (offset) => active().readPage(offset),
    readTail: () => active().readTail!(),
    readAll: () => active().readAll(),
    search: (query, offset, reverse) => active().search(query, offset, reverse),
    isGrowing: () => !disposed && services.session.sessionId === sessionId && current().streaming === true,
    watch(listener) {
      if (disposed) return () => undefined;
      let previous = current();
      const unsubscribe = services.transcript.subscribe(() => {
        const item = current();
        if (previous === item) return;
        previous = item;
        listener();
      });
      subscriptions.add(unsubscribe);
      return () => { unsubscribe(); subscriptions.delete(unsubscribe); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions.clear();
      source?.dispose();
    },
  };
}
