import { useEffect, useMemo, useRef, useState } from "react";
import { findPagerMatches, nearestPagerMatch, nextPagerMatch, prevPagerMatch, type PagerMatch } from "../../../ui-core/state/pager-search.js";
import { hasSearchQuery, matchCounterLabel } from "../../../ui-core/state/text-search.js";
import { registerPagerEscape } from "./pager-escape-port.js";
import { groupPagerMatches, pagerRowForMatch, type PagerRow } from "./pager-rows.js";
import type { PagerDocument } from "./pager-document.js";
import type { PagerViewport } from "./pager-viewport.js";

function useFindState(lines: readonly string[]) {
  const [open, edit] = useState(false);
  const [query, setQuery] = useState("");
  const [index, select] = useState(-1);
  const matches = useMemo(() => findPagerMatches(lines, query), [lines, query]);
  const grouped = useMemo(() => groupPagerMatches(matches, index), [matches, index]);
  const active = hasSearchQuery(query);
  function clear(): void { edit(false); setQuery(""); select(-1); }
  const escape = useRef<() => boolean>(() => false);
  escape.current = () => {
    if (!open && !active) return false;
    clear();
    return true;
  };
  useEffect(() => registerPagerEscape(() => escape.current()), []);
  useEffect(() => {
    select(current => current < matches.length ? current : -1);
  }, [matches]);
  return { open, edit, query, setQuery, select, index, matches, grouped, active, clear, label: matchCounterLabel(query, matches.length, index) };
}

export function usePagerFind(lines: readonly string[], rows: readonly PagerRow[], doc: PagerDocument, viewport: PagerViewport, flash: (text: string) => void) {
  const state = useFindState(lines);
  const { index, matches, select, query } = state;
  const pending = useRef<"first" | "last" | undefined>(undefined);
  const top = rows[Math.floor(viewport.top)]?.index ?? 0;
  function jump(i: number, list: readonly PagerMatch[] = matches): void {
    select(i);
    const match = list[i];
    if (!match) return;
    doc.pause();
    queueMicrotask(() => viewport.reveal(pagerRowForMatch(rows, match)));
  }
  function change(value: string): void {
    state.setQuery(value);
    const found = findPagerMatches(lines, value);
    const previous = matches[index];
    jump(nearestPagerMatch(found, previous?.line ?? top, previous?.column), found);
  }
  async function seek(reverse: boolean, fromStart = false): Promise<void> {
    pending.current = reverse ? "last" : "first";
    if (await doc.search(query, reverse, fromStart)) { state.edit(false); return; }
    pending.current = undefined;
    flash(reverse ? "no previous matches" : "no further matches");
  }
  useEffect(() => {
    if (!pending.current || !matches.length) return;
    jump(pending.current === "first" ? 0 : matches.length - 1);
    pending.current = undefined;
  }, [matches]);
  const partial = doc.page && (doc.page.offset > 0 || doc.page.nextOffset < doc.page.totalBytes);
  function step(delta: 1 | -1): void {
    const atEdge = index < 0 || (delta > 0 ? index === matches.length - 1 : index === 0);
    if (partial && state.active && !state.open && atEdge) { void seek(delta < 0); return; }
    if (!matches.length) { if (state.active) flash("no matches"); return; }
    if (index < 0) { jump(nearestPagerMatch(matches, top)); return; }
    const next = delta > 0 ? nextPagerMatch(matches, index) : prevPagerMatch(matches, index);
    if (matches.length > 1 && atEdge) flash(delta > 0 ? "search wrapped to the first match" : "search wrapped to the last match");
    jump(next);
  }
  function submit(): void {
    if (!state.active) { state.clear(); return; }
    if (partial && !matches.length) { void seek(false, true); return; }
    if (!matches.length) { flash("no matches"); return; }
    if (index < 0) jump(nearestPagerMatch(matches, top));
    state.edit(false);
  }
  return { ...state, change, step, submit };
}

export type PagerFind = ReturnType<typeof usePagerFind>;
