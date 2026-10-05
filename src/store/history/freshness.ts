export interface HistoryFreshness {
  readonly writerGeneration?: string | undefined;
  readonly revision?: number | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function historyRevision(record: Pick<HistoryFreshness, "revision"> | undefined): number {
  const revision = record?.revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

export function historyWriterGeneration(record: Pick<HistoryFreshness, "writerGeneration"> | undefined): string | undefined {
  const generation = record?.writerGeneration;
  return typeof generation === "string" && generation.length > 0 ? generation : undefined;
}

export function compareHistoryFreshness(left: HistoryFreshness, right: HistoryFreshness): number {
  const leftGeneration = historyWriterGeneration(left);
  const rightGeneration = historyWriterGeneration(right);
  if (leftGeneration || rightGeneration) {
    if (!leftGeneration) return -1;
    if (!rightGeneration) return 1;
    const delta = leftGeneration.localeCompare(rightGeneration);
    if (delta !== 0) return delta;
  }
  const delta = historyRevision(left) - historyRevision(right);
  if (delta !== 0) return delta;
  if (historyRevision(left) > 0) return 0;
  const timestamp = (record: HistoryFreshness): number => Date.parse(record.updatedAt || record.createdAt || "") || 0;
  return timestamp(left) - timestamp(right);
}
