import { codeBlockCopyAt } from "../../../ui-core/rendering/code-block-copy.js";

interface TextSurface {
  readonly plainText: string;
  readonly screenX: number;
  readonly screenY: number;
  readonly scrollY?: number;
}

interface PointerEvent {
  readonly x: number;
  readonly y: number;
  readonly target: unknown;
}

const isTextSurface = (target: unknown): target is TextSurface =>
  typeof (target as Partial<TextSurface> | null)?.plainText === "string";

export function codeBlockAtPointer(event: PointerEvent): string | undefined {
  const target = event.target;
  if (!isTextSurface(target)) return undefined;
  const row = event.y - target.screenY + (target.scrollY ?? 0);
  return codeBlockCopyAt(target.plainText.split("\n"), row, event.x - target.screenX);
}
