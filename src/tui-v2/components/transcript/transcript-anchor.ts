import type { CliRenderer, Renderable, ScrollBoxRenderable } from "@opentui/core";

export interface TranscriptAnchor {
  readonly itemId: string;
  readonly offset: number;
}

export type TranscriptWindowJump =
  | { readonly kind: "anchor"; readonly anchor: TranscriptAnchor; readonly delta: number }
  | { readonly kind: "item"; readonly itemId: string }
  | { readonly kind: "edge"; readonly edge: "top" | "bottom" };

export function settleTranscriptLayout(renderer: CliRenderer): void {
  if (renderer.root.getLayoutNode().isDirty()) renderer.root.calculateLayout();
}

export function contentTopOf(sb: ScrollBoxRenderable, itemId: string): number | undefined {
  let node: Renderable | null | undefined = sb.content.findDescendantById(itemId);
  let top = 0;
  while (node && node !== sb.content) {
    top += node.getLayoutNode().getComputedTop();
    node = node.parent;
  }
  return node === sb.content ? top : undefined;
}

export function captureTranscriptAnchor(
  sb: ScrollBoxRenderable,
  candidates: readonly string[],
): TranscriptAnchor | undefined {
  for (const itemId of candidates) {
    const top = contentTopOf(sb, itemId);
    if (top !== undefined) return { itemId, offset: top - sb.scrollTop };
  }
  return undefined;
}

function syncScrollExtent(sb: ScrollBoxRenderable): number {
  const height = Math.max(0, sb.content.getLayoutNode().getComputedHeight());
  sb.verticalScrollBar.scrollSize = height;
  return Math.max(0, height - (sb.viewport?.height ?? 0));
}

export function applyTranscriptWindowJump(
  sb: ScrollBoxRenderable,
  jump: TranscriptWindowJump,
): void {
  const max = syncScrollExtent(sb);
  let target: number | undefined;
  if (jump.kind === "edge") target = jump.edge === "top" ? 0 : max;
  else {
    const itemId = jump.kind === "anchor" ? jump.anchor.itemId : jump.itemId;
    const top = contentTopOf(sb, itemId);
    if (top !== undefined) {
      target = jump.kind === "anchor" ? top - jump.anchor.offset + jump.delta : top;
    }
  }
  if (target === undefined) return;
  sb.scrollTo(Math.max(0, Math.min(max, Math.round(target))));
}
