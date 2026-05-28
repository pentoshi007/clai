// Feature: web-search-and-fetch, Property 15: Search-provider key resolution precedence
//
// Validates: Requirements 3.3
//
// For arbitrary `(envValue, storedValue)` pairs of strings (each independently
// drawn from {undefined, empty, whitespace-only, non-empty UTF-8}),
// `getSearchProviderKey(id)` MUST return:
//
//   1. `{ value: envValue, source: 'env' }`
//        when the provider has an env var AND envValue is a string of length > 0
//   2. `{ value: storedValue, source: 'fallback' }`
//        when the env-var path does NOT win AND storedValue is a string of length > 0
//   3. `{ source: 'missing' }` (value undefined)
//        otherwise.
//
// Setup notes
// -----------
// • The env is stubbed via direct `process.env` overrides (set/delete on the
//   provider's env-var name). The implementation reads `process.env[envVar]`
//   at call time, so no module reset is required between iterations.
// • The keychain is stubbed via `vi.mock` so every keychain operation throws,
//   forcing `setSecret`/`getSecret`/`unsetSecret` down the namespaced
//   fallback-file path (the file living at `${HOME}/.clai/keys.json`).
// • `HOME` is overridden in `beforeAll` to a temp directory so the fallback
//   file is isolated per test run. The dynamic `await import('keys.js')`
//   inside the property re-evaluates the module-scoped `keysFile` constant
//   only once per file load, but that load happens AFTER `HOME` has been
//   redirected so the constant resolves to `${tempDir}/.clai/keys.json`.
//
// Note: `duckduckgo` has no env var (it is keyless per Requirement 3.5), so
// only the fallback / missing branches apply for that provider — the test
// covers that case explicitly by skipping the env-stubbing for it.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Force every keychain operation to throw so that `withKeytar` returns
// `{ ok: false }` and the fallback-file branch is exercised. The error
// message includes the substring "keychain" so the implementation latches
// `keychainRuntimeUnavailable=true` after the first failure, which keeps
// subsequent iterations cheap.
vi.mock("@napi-rs/keyring/keytar.js", () => ({
  default: {
    getPassword: async () => {
      throw new Error("keychain unavailable in tests");
    },
    setPassword: async () => {
      throw new Error("keychain unavailable in tests");
    },
    deletePassword: async () => {
      throw new Error("keychain unavailable in tests");
    },
  },
}));

/** Env var the implementation consults for each provider (per Requirement 3.3). */
const ENV_VARS = {
  brave: "BRAVE_SEARCH_API_KEY",
  tavily: "TAVILY_API_KEY",
  duckduckgo: undefined,
} as const;

const PROVIDERS = ["brave", "tavily", "duckduckgo"] as const;
type ProviderId = (typeof PROVIDERS)[number];

let tempDir: string;
let originalHome: string | undefined;
let originalBrave: string | undefined;
let originalTavily: string | undefined;

beforeAll(() => {
  originalHome = process.env.HOME;
  originalBrave = process.env.BRAVE_SEARCH_API_KEY;
  originalTavily = process.env.TAVILY_API_KEY;

  tempDir = mkdtempSync(join(tmpdir(), "clai-pbt-key-precedence-"));
  process.env.HOME = tempDir;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.TAVILY_API_KEY;

  // Suppress the one-shot stderr warning the keys module emits the first
  // time the keychain fails. The test deliberately makes the keychain
  // fail; the warning is expected but adds noise to test output.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalBrave === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalBrave;

  if (originalTavily === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = originalTavily;

  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Generates the four shapes the property cares about — undefined, empty,
 * whitespace-only, and arbitrary non-empty UTF-8 — without `\0` (which
 * would interact awkwardly with JSON serialization in the fallback file).
 * Maps `null` back to JS `undefined` after generation so fast-check can
 * still shrink toward the smallest counter-example.
 */
const optionalStringArb = fc.oneof(
  fc.constant<undefined>(undefined),
  fc.constant(""),
  fc.constant(" "),
  fc.constant("   "),
  fc.constant("\t\n"),
  fc
    .string({ minLength: 1, maxLength: 64 })
    .filter((s) => !s.includes("\0")),
);

const providerArb = fc.constantFrom<ProviderId>(...PROVIDERS);

describe("Property 15: Search-provider key resolution precedence (Requirement 3.3)", () => {
  it("returns env (when non-empty) → fallback (when non-empty) → missing, for arbitrary inputs", async () => {
    // Dynamic import AFTER `HOME` has been stubbed so the module-scoped
    // `keysFile = join(homedir(), '.clai', 'keys.json')` resolves under
    // the temp dir.
    const { getSearchProviderKey, setSecret, unsetSecret } = await import(
      "../../src/store/keys.js"
    );

    await fc.assert(
      fc.asyncProperty(
        optionalStringArb,
        optionalStringArb,
        providerArb,
        async (envValue, storedValue, providerId) => {
          const envVar = ENV_VARS[providerId];

          // ---- arrange env var ----
          // For providers that have an env var, set it to the generated
          // value (or delete it for `undefined`). DuckDuckGo has no env
          // var, so we leave the environment untouched for it.
          if (envVar) {
            if (envValue === undefined) delete process.env[envVar];
            else process.env[envVar] = envValue;
          }

          // ---- arrange fallback file ----
          // Always clear first, then write only when the storedValue is a
          // non-empty string. (Empty strings can't meaningfully round-trip
          // because the implementation's truthy check would treat them as
          // missing on read; the property's expected-result table reflects
          // that.)
          await unsetSecret("search", providerId);
          if (storedValue !== undefined && storedValue.length > 0) {
            await setSecret("search", providerId, storedValue);
          }

          // ---- act ----
          const result = await getSearchProviderKey(providerId);

          // ---- assert against the precedence oracle ----
          const envWins =
            envVar !== undefined &&
            envValue !== undefined &&
            envValue.length > 0;
          const storedWins =
            !envWins &&
            storedValue !== undefined &&
            storedValue.length > 0;

          if (envWins) {
            expect(result.value).toBe(envValue);
            expect(result.source).toBe("env");
          } else if (storedWins) {
            expect(result.value).toBe(storedValue);
            expect(result.source).toBe("fallback");
          } else {
            expect(result.value).toBeUndefined();
            expect(result.source).toBe("missing");
          }

          // ---- cleanup so state doesn't leak across iterations ----
          if (envVar) delete process.env[envVar];
          await unsetSecret("search", providerId);
        },
      ),
      { numRuns: 100 },
    );
  });
});
