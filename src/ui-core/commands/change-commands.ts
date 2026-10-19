import type { AppServices } from "../bootstrap/composition-root.js";
import type { FileLineChanges, SessionChangesReport } from "../../app/controllers/session-changes.js";
import type { FileChange } from "../../tools/file-diff.js";
import type { ArtifactPage, ArtifactPagerSource } from "../rendering/artifact-pager-source.js";
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

const CHANGES_STYLE = { quotePrefix: "", literalQuotes: true, lineChangeColors: true, diffLines: true } as const;

export function handleChanges(services: AppServices): void {
  const source = createSessionChangesPagerSource(services);
  services.overlay.openPager("Session changes", formatSessionChanges(services.session.changesReport()), source, undefined, "force");
}

function createSessionChangesPagerSource(services: AppServices): ArtifactPagerSource {
  const sessionId = services.session.sessionId;
  const path = `memory://session-changes/${sessionId}`;
  let report = services.session.changesReport();
  let body = formatSessionChanges(report);
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
    for (const listener of listeners) listener();
  });
  const page = async (): Promise<ArtifactPage> => {
    if (disposed) throw new Error("session changes pager is closed");
    const totalBytes = Buffer.byteLength(body, "utf8");
    return { body, offset: 0, nextOffset: totalBytes, totalBytes, pageNumber: 1, pageCount: 1 };
  };
  return {
    path, pageBytes: Number.MAX_SAFE_INTEGER, layout: "continuous", ...CHANGES_STYLE,
    readPage: page,
    readTail: page,
    readAll: async () => (await page()).body,
    search: async (query) => (query && body.includes(query) ? page() : undefined),
    isGrowing: () => services.session.sessionId === sessionId && services.session.getState().running,
    watch(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; unsubscribe(); listeners.clear(); },
  };
}
