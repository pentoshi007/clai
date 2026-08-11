export interface ListWindowInput {
  readonly count: number;
  readonly active: number;
  readonly height: number;
  readonly previousTop?: number | undefined;
  readonly margin?: number | undefined;
}

export interface ListWindow {
  readonly top: number;
  readonly height: number;
  readonly clippedAbove: boolean;
  readonly clippedBelow: boolean;
}

export function listWindow(input: ListWindowInput): ListWindow {
  const height = Math.max(1, Math.min(input.height, Math.max(1, input.count)));
  const max = Math.max(0, input.count - height);
  const margin = Math.min(input.margin ?? 1, Math.floor((height - 1) / 2));
  const active = Math.max(0, Math.min(input.active, Math.max(0, input.count - 1)));

  let top = Math.max(0, Math.min(input.previousTop ?? 0, max));
  if (active - margin < top) top = active - margin;
  if (active + margin > top + height - 1) top = active + margin - height + 1;
  top = Math.max(0, Math.min(top, max));

  return {
    top,
    height,
    clippedAbove: top > 0,
    clippedBelow: top + height < input.count,
  };
}

export function windowCounter(active: number, count: number): string | undefined {
  if (count === 0) return undefined;
  const index = Math.max(0, Math.min(active, count - 1));
  return `${index + 1}/${count}`;
}
