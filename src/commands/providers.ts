import { confirm, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import { getProvider, pingProvider } from "../llm/router.js";
import { assertProvider, maskSecret } from "../llm/provider.js";
import {
  getConfig,
  getProviderModel,
  setDefaultProvider,
  updateConfig,
} from "../store/config.js";
import {
  envValue,
  getFallbackKeysPath,
  getProviderSecret,
  listProviderStatuses,
  setProviderSecret,
  unsetProviderSecret,
} from "../store/keys.js";
import type { ProviderId } from "../types.js";

export interface SetKeyOptions {
  fromEnv?: string | undefined;
  stdin?: boolean | undefined;
  url?: string | undefined;
  skipPing?: boolean | undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function promptForSecret(provider: ProviderId): Promise<string> {
  const raw = await password({
    message: `Enter API key for ${provider} (input hidden, leave blank to cancel):`,
    mask: "•",
  });
  return raw.trim();
}

function invalidFormatHint(provider: ProviderId): string {
  if (provider === "groq") return "Groq keys usually start with gsk_";
  if (provider === "gemini") return "Gemini keys usually start with AIza";
  if (provider === "openrouter")
    return "OpenRouter keys usually start with sk-or-";
  if (provider === "openai") return "OpenAI keys usually start with sk- or sk-proj-";
  if (provider === "anthropic")
    return "Anthropic keys usually start with sk-ant-";
  if (provider === "nvidia")
    return "NVIDIA NIM keys usually start with nvapi-";
  if (provider === "agentrouter")
    return "AgentRouter keys usually start with sk- (issued at https://agentrouter.org/console/token)";
  if (provider === "kimchi")
    return "Kimchi keys are alphanumeric (at least 8 characters)";
  if (provider === "aws-mantle")
    return "Mantle keys are alphanumeric with base64 characters (at least 8 characters)";
  if (provider === "bynara")
    return "Bynara keys usually start with sk_nry_ (at least 8 characters)";
  return "Ollama expects a URL such as http://localhost:11434";
}

export async function setProviderKey(
  providerValue: string,
  keyArg: string | undefined,
  options: SetKeyOptions,
): Promise<void> {
  // Search-provider ids (`brave`, `tavily`, `duckduckgo`) are stored in
  // the `search:` namespace (Requirement 3.1). Dispatch before the LLM
  // path so the matching helper handles the keyless DuckDuckGo no-op.
  if (
    providerValue === "brave" ||
    providerValue === "tavily" ||
    providerValue === "duckduckgo"
  ) {
    const { setSearchProviderKey } = await import("./search-providers.js");
    const opts: { fromEnv?: string; stdin?: boolean } = {};
    if (options.fromEnv !== undefined) opts.fromEnv = options.fromEnv;
    if (options.stdin !== undefined) opts.stdin = options.stdin;
    await setSearchProviderKey(providerValue, keyArg, opts);
    return;
  }

  const provider = assertProvider(providerValue);
  const providerImpl = getProvider(provider);

  let secret = options.url ?? keyArg;
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

  secret = secret.trim();

  if (!providerImpl.validateKey(secret)) {
    process.exitCode = 2;
    throw new Error(
      `Invalid ${provider} format. ${invalidFormatHint(provider)}.`,
    );
  }

  if (provider === "ollama") {
    updateConfig({ ollamaHost: secret });
    setDefaultProvider(provider);
  } else {
    const storage = await setProviderSecret(provider, secret);
    if (storage === "fallback") {
      process.exitCode = 3;
      console.warn(
        chalk.yellow(
          `Warning: OS keychain unavailable; stored in ${getFallbackKeysPath()} with restricted permissions.`,
        ),
      );
    }
  }

  if (!options.skipPing) {
    try {
      await pingProvider(provider, secret);
    } catch (error) {
      process.exitCode = 4;
      console.warn(
        chalk.yellow(
          `Saved, but ping failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }
  }

  console.log(
    `saved ${provider} ${provider === "ollama" ? secret : maskSecret(secret)}`,
  );
}

export async function unsetProviderKey(providerValue: string): Promise<void> {
  if (
    providerValue === "brave" ||
    providerValue === "tavily" ||
    providerValue === "duckduckgo"
  ) {
    const { unsetSearchProviderKey } = await import("./search-providers.js");
    await unsetSearchProviderKey(providerValue);
    return;
  }
  const provider = assertProvider(providerValue);
  await unsetProviderSecret(provider);
  console.log(`unset ${provider}`);
}

export async function printProviderKeys(): Promise<void> {
  const config = getConfig();
  const statuses = await listProviderStatuses(config.defaultProvider);
  
  console.log(chalk.bold("LLM Providers:"));
  console.log(chalk.dim("  PROVIDER      SOURCE    KEY           MODEL"));
  
  for (const s of statuses) {
    const mark = s.configured ? chalk.green("✓") : chalk.red("✗");
    const tag = s.active ? chalk.cyan(" ◀") : "";
    const key = s.maskedKey || (s.configured ? "••••••••" : "—");
    const source = (s.source === "missing" ? "no key" : s.source).padEnd(9);
    console.log(
      `  ${mark} ${s.provider.padEnd(13)} ${source} ${key.padEnd(13)} ${s.model}${tag}`
    );
  }

  console.log("");
  const { printSearchProviderKeys } = await import(
    "./search-providers.js"
  );
  await printSearchProviderKeys();
}

export async function ensureProviderConfigured(
  provider: ProviderId,
): Promise<void> {
  const secret = await getProviderSecret(provider);
  if (secret.value || envValue(provider) || provider === "ollama") return;
  if (!process.stdin.isTTY) return;
  const entered = await promptForSecret(provider);
  if (!entered) return;
  await setProviderKey(provider, entered, { skipPing: false });
}

export async function useProvider(providerValue: string): Promise<void> {
  const provider = assertProvider(providerValue);
  const secret = await getProviderSecret(provider);
  if (!secret.value && !envValue(provider) && provider !== "ollama") {
    const entered = await promptForSecret(provider);
    if (!entered) {
      console.log("provider unchanged");
      return;
    }
    await setProviderKey(provider, entered, { skipPing: false });
  }
  setDefaultProvider(provider);
  console.log(`now using ${provider} · model=${getProviderModel(provider)}`);
}

export async function providerSwitcher(
  providerValue?: string | undefined,
): Promise<void> {
  if (providerValue) {
    await useProvider(providerValue);
    return;
  }

  const config = getConfig();
  const statuses = await listProviderStatuses(config.defaultProvider);
  const pageSize = 15;
  const selected = await select({
    message: "Select provider:",
    pageSize,
    choices: statuses.map((status) => ({
      name: `${status.provider.padEnd(10)} ${status.configured ? "✓ key set" : "✗ no key"}${status.active ? " (active)" : ""}`,
      value: status.provider,
    })),
    loop: false,
  });
  await useProvider(selected);
}

export async function setKeyPicker(
  providerValue?: string | undefined,
  keyArg?: string | undefined,
): Promise<void> {
  if (providerValue) {
    await setProviderKey(providerValue, keyArg, {});
    return;
  }

  const config = getConfig();
  const statuses = await listProviderStatuses(config.defaultProvider);
  const pageSize = 15;
  const selected = await select({
    message: "Set API key for provider:",
    pageSize,
    choices: statuses.map((status) => ({
      name: `${status.provider.padEnd(12)} ${status.configured ? chalk.green("✓ key set") : chalk.red("✗ no key")}${status.active ? chalk.cyan(" (active)") : ""}`,
      value: status.provider,
    })),
    loop: false,
  });

  const secret = await getProviderSecret(selected);
  if (secret.value) {
    // Key already set — ask whether to reset
    const reset = await confirm({
      message: `${selected} already has a key (${maskSecret(secret.value)}). Reset it?`,
      default: false,
    });
    if (!reset) {
      console.log(chalk.dim("cancelled"));
      return;
    }
  }
  // Prompt for the new key
  await setProviderKey(selected, undefined, {});
}

export async function unsetKeyPicker(
  providerValue?: string | undefined,
): Promise<void> {
  if (providerValue) {
    await unsetProviderKey(providerValue);
    return;
  }

  const config = getConfig();
  const statuses = await listProviderStatuses(config.defaultProvider);
  const pageSize = 15;
  const selected = await select({
    message: "Unset API key for provider:",
    pageSize,
    choices: statuses.map((status) => ({
      name: `${status.provider.padEnd(12)} ${status.configured ? chalk.green("✓ ") + (status.maskedKey ?? "key set") : chalk.red("✗ no key")}${status.active ? chalk.cyan(" (active)") : ""}`,
      value: status.provider,
    })),
    loop: false,
  });

  const secret = await getProviderSecret(selected);
  if (!secret.value && selected !== "ollama") {
    console.log(chalk.dim(`${selected} has no key to unset`));
    return;
  }
  await unsetProviderKey(selected);
}
