import { useEffect, useState } from "react";
import { LayoutEvents, type ScrollBoxRenderable } from "@opentui/core";
import type { PagerDocument, PagerScroll } from "./pager-document.js";

function headerHeight(box: ScrollBoxRenderable): number {
  return box.content.findDescendantById("pager-command")?.height ?? 0;
}

function scrollLabel(top: number, max: number): string {
  if (max <= 0) return "all";
  const ratio = top / max;
  if (ratio <= 0.02) return "top";
  if (ratio >= 0.98) return "bottom";
  return `${Math.round(ratio * 100)}%`;
}

function useScrollMetrics(scroll: PagerScroll, doc: PagerDocument, initialHeight: number) {
  const [viewport, setViewport] = useState({ top: 0, height: initialHeight, hint: "top" });
  function refresh(): void {
    const box = scroll.current;
    if (!box) return;
    const height = Math.max(1, box.viewport.height);
    const top = Math.max(0, box.scrollTop - headerHeight(box));
    const hint = scrollLabel(box.scrollTop, box.scrollHeight - height);
    setViewport(prev => prev.top === top && prev.height === height && prev.hint === hint ? prev : { top, height, hint });
  }
  function restore(): void {
    const box = scroll.current;
    const anchor = doc.anchor.current;
    if (!box || anchor === undefined) return;
    const max = box.scrollHeight - box.viewport.height;
    const gap = typeof anchor === "number" ? anchor : 0;
    box.scrollTo(anchor === "top" ? 0 : Math.max(0, max - gap));
    refresh();
  }
  useEffect(restore, [doc.page]);
  useEffect(() => {
    const box = scroll.current;
    if (!box) return;
    let active = true;
    let scheduled = false;
    function resized(): void {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!active) return;
        restore();
        doc.anchor.current = undefined;
        refresh();
      });
    }
    box.verticalScrollBar.on("change", refresh);
    for (const node of [box.content, box.viewport]) {
      node.on("resize", resized);
      node.on(LayoutEvents.RESIZED, resized);
    }
    resized();
    return () => {
      active = false;
      box.verticalScrollBar.off("change", refresh);
      for (const node of [box.content, box.viewport]) {
        node.off("resize", resized);
        node.off(LayoutEvents.RESIZED, resized);
      }
    };
  }, [scroll]);
  return { ...viewport, refresh };
}

export function usePagerViewport(scroll: PagerScroll, doc: PagerDocument, initialHeight: number, rowCount: number) {
  const metrics = useScrollMetrics(scroll, doc, initialHeight);
  function wheel(direction: string | undefined): void {
    if (direction !== "down" && direction !== "up") return;
    if (direction === "up") doc.pause();
    doc.anchor.current = undefined;
    doc.extend(direction === "up" ? -1 : 1, scroll.current?.scrollTop ?? 0);
  }
  function move(delta: number): void {
    const box = scroll.current;
    if (!box) return;
    doc.anchor.current = undefined;
    if (delta < 0) doc.pause();
    const max = box.scrollHeight - box.viewport.height;
    const next = Math.max(0, Math.min(max, box.scrollTop + delta));
    doc.extend(delta < 0 ? -1 : 1, next);
    box.scrollTo(next);
    metrics.refresh();
  }
  function reveal(row: number): void {
    const box = scroll.current;
    if (!box || row < 0) return;
    const height = Math.max(1, box.viewport.height);
    const top = row + headerHeight(box);
    if (top >= box.scrollTop && top < box.scrollTop + height) return;
    box.scrollTo(Math.max(0, Math.min(box.scrollHeight - height, top - Math.floor(height / 3))));
    metrics.refresh();
  }
  const anchor = doc.anchor.current;
  let top = metrics.top;
  if (anchor === "top") top = 0;
  if (anchor === "bottom") top = Math.max(0, rowCount - metrics.height);
  if (typeof anchor === "number") top = Math.max(0, rowCount - metrics.height - anchor);
  return { ...metrics, top, wheel, move, reveal };
}

export type PagerViewport = ReturnType<typeof usePagerViewport>;
