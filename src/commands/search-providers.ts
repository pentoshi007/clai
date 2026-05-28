/**
 * CLI helpers for managing search-provider configuration and keys.
 *
 * Implements Requirements 3.1, 3.2, 3.5–3.7:
 *
 * - `clai set <id> [key]`     — store an API key for `brave`/`tavily`
 *                               (DuckDuckGo is keyless and is a no-op).
 * - `clai unset <id>`         — remove a stored key.
 * - `clai search-provider`    — set the active provider (`activeSearchProvider`).
 * - `clai keys`               — extends the LLM listing with search providers,
 *                               using the same masking rule.
 *
 * All key entry uses the `password` prompt with no terminal echo
 * (Requirement 3.2). Secrets land in the same keyring service as LLM
 * keys but under the namespaced account `search:<id>` so the two
 * keyspaces never collide (Requirement 3.1).
 */

import { password } from "@inquirer/prompts";
import chalk from "chalk";

import {
  assertSearchProvider,
  searchProviders,
} from "../tools/web/providers/provider.js";
import {
  getActiveSearchProvider,
  setActiveSearchProvider,
} from "../store/config.js";
import {
  getFallbackKeysPath,
  getSearchProviderKey,
  searchProviderEnvVar,
  setSecret,
  unsetSecret,
  maskSecret,
} from "../store/keys.js";
import type { SearchProviderId } from "../tools/web/types.js";
// Importing the providers ensures their module-level registration in
// `searchProviders` runs before any helper accesses the registry.
import "../tools/web/providers/duckduckgo.js";
import "../tools/web/providers/brave.js";
import "../tools/web/providers/tavily.js";

/** Read a secret from stdin without echoing. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function promptForSecret(id: SearchProviderId): Promise<string> {
  return password({
    message: `Enter API key for ${id} (input hidden, leave blank to cancel):`,
    mask: "•",
  });
}

/**
 * Returns `true` when the supplied id is a known search-provider id.
 * Used by `clai set <id>` to dispatch to the search-provider path
 * before falling through to the LLM-provider path.
 */
export function isSearchProviderId(value: string): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "brave" ||
    normalized === "tavily" ||
    normalized === "duckduckgo"
  );
}

export interface SetSearchKeyOptions {
  fromEnv?: string | undefined;
  stdin?: boolean | undefined;
}

/**
 * Persist a search-provider API key. DuckDuckGo is keyless and is a no-op.
 *
 * Requirement 3.2: prompts use the hidden-input `password` flow so the
 * entered key never lands in shell history or echo.
 */
export async function setSearchProviderKey(
  providerValue: string,
  keyArg: string | undefined,
  options: SetSearchKeyOptions = {},
): Promise<void> {
  const provider = assertSearchProvider(providerValue);
  const adapter = searchProviders[provider];

  if (!adapter || !adapter.needsApiKey) {
    // DuckDuckGo (and any future keyless provider): nothing to store.
    console.log(`${provider} does not require an API key (keyless provider).`);
    return;
  }

  let secret = keyArg;
  if (options.fromEnv) {
    secret = process.env[options.fromEnv];
    if (!secret)
      throw new Error(
        `Environment variable ${options.fromEnv} is empty or missing`,
      );
  }
  if (options.stdin) {
    secret = await readStdin();
  }
  if (!secret) {
    secret = await promptForSecret(provider);
  }
  if (!secret) {
    console.log("cancelled");
    return;
  }

  const storage = await setSecret("search", provider, secret);
  if (storage === "fallback") {
    console.warn(
      chalk.yellow(
        `Warning: OS keychain unavailable; stored in ${getFallbackKeysPath()} with restricted permissions.`,
      ),
    );
  }

  console.log(`saved ${provider} ${maskSecret(secret)}`);
}

export async function unsetSearchProviderKey(
  providerValue: string,
): Promise<void> {
  const provider = assertSearchProvider(providerValue);
  await unsetSecret("search", provider);
  console.log(`unset ${provider}`);
}

/**
 * Set the active search provider used by `web.search`. The id is
 * validated through {@link assertSearchProvider} so unsupported ids
 * are rejected with the supported-list message (Requirement 3.7).
 */
export async function useSearchProvider(providerValue: string): Promise<void> {
  const provider = assertSearchProvider(providerValue);
  setActiveSearchProvider(provider);
  console.log(`active search provider = ${provider}`);
}

/**
 * Print every configured search-provider entry next to the LLM
 * listing. Uses the same masking rule as `clai keys` for LLM keys
 * (Requirement 3.6).
 */
export async function printSearchProviderKeys(): Promise<void> {
  const active = getActiveSearchProvider();
  // Iterate the registered adapters so display names line up.
  const ids: SearchProviderId[] = ["duckduckgo", "brave", "tavily"];
  for (const id of ids) {
    const adapter = searchProviders[id];
    const label = adapter?.displayName ?? id;
    const isActive = id === active;
    const activeMark = isActive ? chalk.green("active") : "      ";
    if (!adapter || !adapter.needsApiKey) {
      console.log(
        `${activeMark} ${chalk.green("✓")} ${id.padEnd(10)} keyless        ${label}`,
      );
      continue;
    }

    const env = searchProviderEnvVar(id);
    const resolved = await getSearchProviderKey(id);
    const configured = Boolean(resolved.value);
    const configMark = configured ? chalk.green("✓") : chalk.red("✗");
    const source = resolved.value ? resolved.source : "missing";
    const masked = resolved.value ? ` ${maskSecret(resolved.value)}` : "";
    const envHint = env ? ` (env=${env})` : "";
    console.log(
      `${activeMark} ${configMark} ${id.padEnd(10)} ${String(source).padEnd(8)}${masked}${envHint}  ${label}`,
    );
  }
}
