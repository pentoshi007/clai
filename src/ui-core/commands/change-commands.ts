import type { AppServices } from "../bootstrap/composition-root.js";
import type { SessionChangesReport } from "../../app/controllers/session-changes.js";
import { createTextPagerSource, type ArtifactPagerSource } from "../rendering/artifact-pager-source.js";

export function formatSessionChanges(report: SessionChangesReport): string {
  if (!report.totals) return "# Session changes\n\nNo line changes recorded in this session.\n";
  const { added, removed } = report.totals;
  return [
    "# Session changes", "",
    `**Total** · **+${added} -${removed}** · ${report.files.length} file${report.files.length === 1 ? "" : "s"}`,
    "",
    ...report.files.map((file) => `> +${file.added} -${file.removed}  ${file.path.replace(/[\r\n]/g, "\\n")}`),
    "",
  ].join("\n");
}

export function handleChanges(services: AppServices): void {
  const source = createSessionChangesPagerSource(services);
  services.overlay.openPager("Session changes", formatSessionChanges(services.session.changesReport()), source, undefined, "force");
}

function createSessionChangesPagerSource(services: AppServices): ArtifactPagerSource {
  const sessionId = services.session.sessionId;
  const path = `memory://session-changes/${sessionId}`;
  let body = formatSessionChanges(services.session.changesReport());
  let source = createTextPagerSource(body, path);
  let disposed = false;
  const listeners = new Set<() => void>();
  const unsubscribe = services.session.subscribe(() => {
    if (disposed || services.session.sessionId !== sessionId) return;
    const next = formatSessionChanges(services.session.changesReport());
    if (next === body) return;
    body = next;
    source.dispose();
    source = createTextPagerSource(body, path);
    for (const listener of listeners) listener();
  });
  return {
    path, pageBytes: source.pageBytes, quotePrefix: "", literalQuotes: true, lineChangeColors: true,
    readPage: (offset) => source.readPage(offset),
    readTail: () => source.readTail!(),
    readAll: () => source.readAll(),
    search: (query, offset, reverse) => source.search(query, offset, reverse),
    isGrowing: () => services.session.sessionId === sessionId && services.session.getState().running,
    watch(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; unsubscribe(); listeners.clear(); source.dispose(); },
  };
}
