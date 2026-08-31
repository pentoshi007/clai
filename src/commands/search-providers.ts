import chalk from "chalk";

import { askSecret } from "../noninteractive/readline-prompts.js";
import {
  assertSearchProvider,
  searchProviders,
} from "../tools/web/providers/provider.js";
import {
  getActiveSearchProvider,
  setActiveSearchProvider,
} from "../store/config.js";
import {
  appendSearchProviderKey,
  getFallbackKeysPath,
  getSearchProviderKeys,
  maskSecret,
  unsetSearchProviderSecret,
} from "../store/keys.js";
import type { SearchProviderId } from "../tools/web/types.js";
import "../tools/web/providers/duckduckgo.js";
import "../tools/web/providers/brave.js";
import "../tools/web/providers/tavily.js";
import "../tools/web/providers/exa.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function promptForSecret(id: SearchProviderId): Promise<string> {
  const value = await askSecret(
    `Enter API key for ${id} (input hidden, leave blank to cancel):`,
  );
  return value ?? "";
}

export function isSearchProviderId(value: string): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "brave" ||
    normalized === "tavily" ||
    normalized === "duckduckgo" ||
    normalized === "exa"
  );
}

export interface SetSearchKeyOptions {
  fromEnv?: string | undefined;
  stdin?: boolean | undefined;
}

export async function setSearchProviderKey(
  providerValue: string,
  keyArg: string | undefined,
  options: SetSearchKeyOptions = {},
): Promise<void> {
  const provider = assertSearchProvider(providerValue);
  const adapter = searchProviders[provider];

  if (!adapter || !adapter.needsApiKey) {
    console.log(`${provider} does not require an API key (keyless provider).`);
    return;
  }

  let secret = keyArg;
  if (options.fromEnv) {
    secret = process.env[options.fromEnv];
    if (!secret) {
      throw new Error(`Environment variable ${options.fromEnv} is empty or missing`);
    }
  }
  if (options.stdin) secret = await readStdin();
  if (!secret) secret = await promptForSecret(provider);
  if (!secret) {
    console.log("cancelled");
    return;
  }

  secret = secret.trim();
  const storage = await appendSearchProviderKey(provider, secret);
  if (storage === "fallback") {
    console.warn(
      chalk.yellow(
        `Warning: OS keychain unavailable; stored in ${getFallbackKeysPath()} with restricted permissions.`,
      ),
    );
  }

  const multi = await getSearchProviderKeys(provider);
  const count = multi.source === "env" ? 1 : multi.keys.length;
  console.log(
    count > 1
      ? `added ${provider} ${maskSecret(secret)} · ${count} keys total`
      : `saved ${provider} ${maskSecret(secret)}`,
  );
}

export async function unsetSearchProviderKey(
  providerValue: string,
): Promise<void> {
  const provider = assertSearchProvider(providerValue);
  const multi = await getSearchProviderKeys(provider);
  const count = multi.source === "env" ? 0 : multi.keys.length;
  await unsetSearchProviderSecret(provider);
  console.log(
    count > 1 ? `unset all ${count} keys for ${provider}` : `unset ${provider}`,
  );
}

export async function useSearchProvider(providerValue: string): Promise<void> {
  const provider = assertSearchProvider(providerValue);
  setActiveSearchProvider(provider);
  console.log(`active search provider = ${provider}`);
}

export async function printSearchProviderKeys(): Promise<void> {
  console.log(chalk.bold("Search Providers:"));
  console.log(chalk.dim("  PROVIDER      SOURCE    KEYS"));

  const active = getActiveSearchProvider();
  const ids: SearchProviderId[] = ["duckduckgo", "brave", "tavily", "exa"];
  for (const id of ids) {
    const adapter = searchProviders[id];
    const isActive = id === active;
    const tag = isActive ? chalk.cyan(" ◀") : "";

    if (!adapter || !adapter.needsApiKey) {
      console.log(`  ${chalk.green("✓")} ${id.padEnd(13)} keyless   —${tag}`);
      continue;
    }

    const multi = await getSearchProviderKeys(id);
    const count = multi.keys.length;
    const activeIndex = count > 0 ? multi.activeIndex : 0;
    const activeKey = multi.keys[activeIndex]?.value;
    const mark = count > 0 ? chalk.green("✓") : chalk.red("✗");
    const source = (count > 0 ? multi.source : "no key").padEnd(9);
    const keySummary =
      count === 0
        ? "—"
        : count === 1
          ? maskSecret(activeKey ?? multi.keys[0]!.value)
          : `${count} keys`;
    console.log(`  ${mark} ${id.padEnd(13)} ${source} ${keySummary}${tag}`);
    if (count > 1) {
      multi.keys.forEach((key, index) => {
        const star = index === activeIndex ? chalk.cyan(" ★ active") : "";
        console.log(`      [${index + 1}] ${maskSecret(key.value)}${star}`);
      });
    }
  }
}
