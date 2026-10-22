import type { AppServices } from "../bootstrap/composition-root.js";
import type { ToolItem } from "../state/transcript-types.js";
import {
  createArtifactPagerSource,
  createTextPagerSource,
  DEFAULT_ARTIFACT_PAGE_BYTES,
  type ArtifactPagerSource,
} from "./artifact-pager-source.js";

export function createToolOutputPagerSource(
  services: AppServices,
  initial: Pick<ToolItem, "toolCallId" | "artifactPath">,
  format: (body: string) => string,
): ArtifactPagerSource {
  const sessionId = services.session.sessionId;
  const spool = services.session.spool;
  const path = `memory://tool-output/${initial.toolCallId}`;
  const subscriptions = new Set<() => void>();
  const artifacts = new Map<string, ArtifactPagerSource>();
  let disposed = false;
  let latest: ToolItem | undefined;
  let version = -1;
  let memory: ArtifactPagerSource | undefined;

  const current = (): ToolItem | undefined => {
    if (services.session.sessionId !== sessionId) return latest;
    const state = services.transcript.getState();
    const item = latest ? state.byId.get(latest.id) : [...state.byId.values()].reverse().find(
      (candidate): candidate is ToolItem => candidate.kind === "tool" && candidate.toolCallId === initial.toolCallId,
    );
    if (item?.kind === "tool") latest = item;
    return latest;
  };
  const spooled = (): ArtifactPagerSource => {
    const nextVersion = spool.version(initial.toolCallId);
    if (!memory || services.session.sessionId === sessionId && nextVersion !== version) {
      memory?.dispose();
      version = nextVersion;
      memory = createTextPagerSource(format(spool.tail(initial.toolCallId)), path);
    }
    return memory;
  };
  current();
  spooled();
  const active = (): ArtifactPagerSource => {
    if (disposed) throw new Error("tool output pager is closed");
    const artifactPath = current()?.artifactPath ?? initial.artifactPath;
    if (!artifactPath) return spooled();
    let source = artifacts.get(artifactPath);
    if (!source) {
      source = createArtifactPagerSource(artifactPath);
      artifacts.set(artifactPath, source);
    }
    return source;
  };
  const read = async <T>(operation: (source: ArtifactPagerSource) => Promise<T>): Promise<T> => {
    try {
      return await operation(active());
    } catch (error) {
      if (disposed || !(current()?.artifactPath ?? initial.artifactPath)) throw error;
      return operation(spooled());
    }
  };
  return {
    path,
    pageBytes: DEFAULT_ARTIFACT_PAGE_BYTES,
    readPage: (offset) => read((source) => source.readPage(offset)),
    readTail: () => read((source) => source.readTail!()),
    readAll: () => read((source) => source.readAll()),
    search: (query, offset, reverse) => read((source) => source.search(query, offset, reverse)),
    isGrowing: () => !disposed && services.session.sessionId === sessionId && ["running", "queued"].includes(current()?.status ?? ""),
    watch(listener) {
      if (disposed) return () => undefined;
      let previous = current();
      let previousVersion = spool.version(initial.toolCallId);
      const unsubscribe = services.transcript.subscribe(() => {
        const next = current();
        const nextVersion = spool.version(initial.toolCallId);
        if (next === previous && nextVersion === previousVersion) return;
        previous = next;
        previousVersion = nextVersion;
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
      memory?.dispose();
      for (const source of artifacts.values()) source.dispose();
      artifacts.clear();
    },
  };
}
