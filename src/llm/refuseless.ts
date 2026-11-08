import { reasoningLevelCatalogEntries } from "./catalog-reasoning-levels.js";
import { createCatalogProvider } from "./catalog-provider.js";

export const REFUSELESS_DEFAULT_BASE_URL = "https://api.refuseless.com/v1";

const handle = createCatalogProvider({
  id: "refuseless",
  displayName: "Refuseless",
  envVar: "REFUSELESS_API_KEY",
  defaultBaseUrl: REFUSELESS_DEFAULT_BASE_URL,
  keyHelp:
    "Create one in the Refuseless console (https://docs.refuseless.com/quickstart), then run `clai set refuseless <key>`.",
  validateKey: (key) => /^\S{16,}$/.test(key.trim()),
  catalogEntries: reasoningLevelCatalogEntries,
});

export const refuselessProvider = handle.provider;
export const resetRefuselessModelCache = handle.resetModelCatalog;
