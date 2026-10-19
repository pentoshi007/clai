import type { AppServices } from "../bootstrap/composition-root.js";
import type { FileLineChanges, SessionChangesReport } from "../../app/controllers/session-changes.js";
import type { FileChange } from "../../tools/file-diff.js";
import { createTextPagerSource, type ArtifactPagerSource } from "../rendering/artifact-pager-source.js";
import { sessionChangeDiff } from "../rendering/session-change-diff.js";

const EMPTY_CHANGES = "# Session changes\n\nNo line changes recorded in this session.\n";
const MISSING_DIFF = " │ diff not kept in this session";
const formattedReports = new WeakMap<SessionChangesReport, string>();

function fileLabel(file: FileLineChanges): string {
  return `> +${file.added} -${file.removed}  ${file.path.replace(/[\r\n]/g, "\\n")}`;
}

function changesByPath(changes: readonly FileChange[]): Map<string, FileChange[]> {
  const byPath = new Map<string, FileChange[]>();
  for (const change of changes) {
    const list = byPath.get(change.path);
    if (list) list.push(change);
    else byPath.set(change.path, [change]);
  }
  return byPath;
}

function renderSessionChanges(report: SessionChangesReport): string {
  if (!report.totals) return EMPTY_CHANGES;
  const { added, removed } = report.totals;
  const diffs = changesByPath(report.changes);
  return [
    "# Session changes", "",
    `**Total** · **+${added} -${removed}** · ${report.files.length} file${report.files.length === 1 ? "" : "s"}`,
    "",
    ...report.files.map(fileLabel),
    "",
    "---",
    ...report.files.flatMap((file) => ["", fileLabel(file), ...(diffs.get(file.path)?.map(sessionChangeDiff) ?? [MISSING_DIFF])]),
    "",
  ].join("\n");
}

export function formatSessionChanges(report: SessionChangesReport): string {
  let body = formattedReports.get(report);
  if (body === undefined) {
    body = renderSessionChanges(report);
    formattedReports.set(report, body);
  }
  return body;
}

export async function handleChanges(services: AppServices): Promise<void> {
  const source = createSessionChangesPagerSource(services);
  const page = await source.readPage(0);
  services.overlay.openPager("Session changes", page.body, source, undefined, "force");
}

function createSessionChangesPagerSource(services: AppServices): ArtifactPagerSource {
  const sessionId = services.session.sessionId;
  const path = `memory://session-changes/${sessionId}`;
  let report = services.session.changesReport();
  let body = formatSessionChanges(report);
  let source = createTextPagerSource(body, path);
  let disposed = false;
  const listeners = new Set<() => void>();
  const unsubscribe = services.session.subscribe(() => {
    if (disposed || services.session.sessionId !== sessionId) return;
    const nextReport = services.session.changesReport();
    if (nextReport === report) return;
    report = nextReport;
    const next = formatSessionChanges(report);
    if (next === body) return;
    body = next;
    source.dispose();
    source = createTextPagerSource(body, path);
    for (const listener of listeners) listener();
  });
  return {
    path, pageBytes: source.pageBytes, quotePrefix: "", literalQuotes: true, lineChangeColors: true, diffLines: true,
    readPage: (offset) => source.readPage(offset),
    readTail: () => source.readTail!(),
    readAll: () => source.readAll(),
    search: (query, offset, reverse) => source.search(query, offset, reverse),
    isGrowing: () => services.session.sessionId === sessionId && services.session.getState().running,
    watch(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; unsubscribe(); listeners.clear(); source.dispose(); },
  };
}
