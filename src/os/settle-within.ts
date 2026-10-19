export function settleWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, ms));
    timer.unref?.();
    const settle = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    work.then(settle, settle);
  });
}
