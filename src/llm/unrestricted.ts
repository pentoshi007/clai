import { createCatalogProvider } from "./catalog-provider.js";

export const UNRESTRICTED_DEFAULT_BASE_URL = "https://api.unrestricted.sh/v1";

const handle = createCatalogProvider({
  id: "unrestricted",
  displayName: "Unrestricted",
  envVar: "UNRESTRICTED_API_KEY",
  defaultBaseUrl: UNRESTRICTED_DEFAULT_BASE_URL,
  keyHelp:
    "Create one at https://unrestricted.sh (keys start with unr_sk_), then run `clai set unrestricted <key>`.",
  validateKey: (key) => /^unr_sk_\S{8,}$/.test(key.trim()),
});

export const unrestrictedProvider = handle.provider;
export const resetUnrestrictedModelCache = handle.resetModelCatalog;
