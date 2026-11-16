let handler: (() => boolean) | undefined;

export function registerPagerEscape(next: () => boolean): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = undefined;
  };
}

export function consumePagerEscape(): boolean {
  return handler?.() ?? false;
}
