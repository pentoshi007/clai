import { useEffect, useRef, useState, type RefObject } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ArtifactPagerSource } from "../../../ui-core/rendering/artifact-pager-source.js";
import { canExtend, refreshReadingWindow, shiftReadingWindow, type ReadingWindow, type ScrollDirection } from "../../../ui-core/rendering/pager-reading-window.js";

type Edge = "top" | "bottom";
export type PagerScroll = RefObject<ScrollBoxRenderable | null>;

function useDocumentReads(source: ArtifactPagerSource | undefined) {
  const [page, setPage] = useState<ReadingWindow>();
  const [error, setError] = useState<string>();
  const current = useRef(page);
  const revision = useRef(0);
  const busy = useRef(false);
  const anchor = useRef<Edge | number | undefined>(undefined);
  function publish(next: ReadingWindow): void {
    current.current = next;
    setPage(next);
  }
  function cancel(): void {
    revision.current++;
    busy.current = false;
    anchor.current = undefined;
  }
  useEffect(() => {
    current.current = undefined;
    setPage(undefined);
    setError(undefined);
    return cancel;
  }, [source]);
  async function navigate(read: () => Promise<ReadingWindow | undefined>, position?: () => Edge | number | undefined): Promise<boolean> {
    const ticket = ++revision.current;
    busy.current = true;
    try {
      const result = await read();
      if (!result || ticket !== revision.current) return false;
      anchor.current = position?.();
      publish(result);
      return true;
    } catch (e) {
      if (ticket === revision.current) setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (ticket === revision.current) {
        revision.current++;
        busy.current = false;
      }
    }
  }
  return { page, current, revision, busy, anchor, publish, cancel, navigate, error, setError };
}

type Reads = ReturnType<typeof useDocumentReads>;

function useSourceUpdates(source: ArtifactPagerSource | undefined, following: boolean, reads: Reads): void {
  useEffect(() => {
    if (!source) return;
    let active = true;
    let reading = false;
    let pending = false;
    async function pull(): Promise<void> {
      if (!active || !source) return;
      if (reading) { pending = true; return; }
      reading = true;
      const version = reads.revision.current;
      try {
        const page = following && source.readTail ? await source.readTail() : await refreshReadingWindow(source, reads.current.current);
        if (!active || version !== reads.revision.current || reads.busy.current) return;
        if (following) reads.anchor.current = "bottom";
        reads.publish(page);
      } catch (e) {
        if (active) reads.setError(e instanceof Error ? e.message : String(e));
      } finally {
        reading = false;
        if (pending && active) { pending = false; void pull(); }
      }
    }
    const unwatch = source.watch?.(() => { void pull(); });
    void pull();
    return () => { active = false; unwatch?.(); };
  }, [source, following]);
}

function remainingRows(box: ScrollBoxRenderable): number {
  return Math.max(0, box.scrollHeight - box.viewport.height - box.scrollTop);
}

function useWindowNavigation(source: ArtifactPagerSource | undefined, reads: Reads, scroll: PagerScroll, pause: () => void) {
  function extend(direction: ScrollDirection, top: number): void {
    const page = reads.current.current;
    const box = scroll.current;
    if (!source || !page || !box || reads.busy.current) return;
    if (!canExtend(page, direction)) return;
    const distance = direction < 0 ? top : box.scrollHeight - box.viewport.height - top;
    if (distance > 2 * box.viewport.height) return;
    pause();
    let changedAtTop = false;
    void reads.navigate(async () => {
      const result = await shiftReadingWindow(source, page, direction);
      changedAtTop = result.changedAtTop;
      return result.window;
    }, () => changedAtTop ? remainingRows(box) : undefined);
  }
  function jump(edge: Edge): void {
    const page = reads.current.current;
    const box = scroll.current;
    if (edge === "top") pause();
    reads.cancel();
    if (page && source && canExtend(page, edge === "top" ? -1 : 1)) {
      const offset = edge === "top" ? 0 : Math.max(0, page.totalBytes - source.pageBytes);
      void reads.navigate(() => source.readPage(offset), () => edge);
    } else if (box) box.scrollTo(edge === "top" ? 0 : Math.max(0, box.scrollHeight - box.viewport.height));
  }
  return { extend, jump };
}

export function usePagerDocument(source: ArtifactPagerSource | undefined, body: string, scroll: PagerScroll) {
  const reads = useDocumentReads(source);
  const canFollow = Boolean(source?.watch);
  const [following, setFollowing] = useState(() => canFollow && (source?.isGrowing?.() ?? true));
  useSourceUpdates(source, following, reads);
  const pause = () => setFollowing(false);
  const navigation = useWindowNavigation(source, reads, scroll, pause);
  async function search(query: string, reverse: boolean, fromStart: boolean): Promise<boolean> {
    if (!source) return false;
    pause();
    const page = reads.current.current;
    const start = reverse || fromStart ? page?.offset : page?.nextOffset;
    return reads.navigate(() => source.search(query.trim(), start ?? 0, reverse), () => "top");
  }
  function toggleFollow(): void {
    reads.cancel();
    setFollowing(!following);
  }
  return { ...navigation, body: source ? reads.page?.body || "(no output yet)" : body, page: reads.page, anchor: reads.anchor,
    error: reads.error, clearError: () => reads.setError(undefined), search, canFollow, following, pause, toggleFollow };
}

export type PagerDocument = ReturnType<typeof usePagerDocument>;
