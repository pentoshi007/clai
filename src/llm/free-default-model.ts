import { defaultModels } from "./provider.js";
import { freeProvider } from "./free.js";

const CATALOG_TIMEOUT_MS = 2_500;

export interface FreeDefaultModelDeps {
  readonly listModels?: (() => Promise<string[]>) | undefined;
  readonly timeoutMs?: number | undefined;
}

function withTimeout(
  work: Promise<string[]>,
  timeoutMs: number,
): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export function pickFreeModel(catalog: readonly string[]): string {
  const usable = catalog.filter((id) => id.trim().length > 0);
  if (usable.length === 0) return defaultModels.free;
  if (usable.includes(defaultModels.free)) return defaultModels.free;
  return (
    usable.find((id) => id.startsWith("free-2/")) ??
    usable.find((id) => id.startsWith("free-1/")) ??
    defaultModels.free
  );
}

let cachedPick: string | undefined;

export function resetFreeDefaultModelCache(): void {
  cachedPick = undefined;
}

export async function resolveFreeDefaultModel(
  deps: FreeDefaultModelDeps = {},
): Promise<string> {
  if (cachedPick !== undefined && deps.listModels === undefined) return cachedPick;
  const list: () => Promise<string[]> =
    deps.listModels ??
    (() => freeProvider.listModels?.({ apiKey: undefined }) ?? Promise.resolve([]));
  const catalog = await withTimeout(
    Promise.resolve().then(() => list()),
    deps.timeoutMs ?? CATALOG_TIMEOUT_MS,
  );
  const picked = pickFreeModel(catalog ?? []);
  if (deps.listModels === undefined) cachedPick = picked;
  return picked;
}
