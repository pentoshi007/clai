export interface PagerBodyRegions {
  readonly inputEnd?: number | undefined;
  readonly codeStart?: number | undefined;
  readonly codeEnd?: number | undefined;
  readonly codeOnEveryPage?: boolean | undefined;
}

export function pagerRegionsForPage(
  regions: PagerBodyRegions | undefined,
  pageOffset: number | undefined,
): PagerBodyRegions | undefined {
  if (!regions) return undefined;
  if (!pageOffset) return regions;
  return regions.codeOnEveryPage ? { codeStart: 0 } : undefined;
}
