import { reasoningLevelCatalogEntries } from "./catalog-reasoning-levels.js";
import { createCatalogProvider } from "./catalog-provider.js";

export const SILKCOMPUTE_DEFAULT_BASE_URL = "https://api.silkcompute.com/v1";

const handle = createCatalogProvider({
  id: "silkcompute",
  displayName: "Silk Compute",
  envVar: "SILK_API_KEY",
  defaultBaseUrl: SILKCOMPUTE_DEFAULT_BASE_URL,
  keyHelp:
    "Create one at https://platform.silkcompute.com/api-keys, then run `clai set silkcompute <key>`.",
  validateKey: (key) => /^sk-\S{16,}$/.test(key.trim()),
  catalogEntries: reasoningLevelCatalogEntries,
});

export const silkcomputeProvider = handle.provider;
export const resetSilkComputeModelCache = handle.resetModelCatalog;
