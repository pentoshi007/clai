import { password, select } from "@inquirer/prompts";
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
  return password({
    message: `Enter API key for ${provider} (input hidden, leave blank to cancel):`,
    mask: "•",
  });
}

function invalidFormatHint(provider: ProviderId): string {
  if (provider === "groq") return "Groq keys usually start with gsk_";
  if (provider === "gemini") return "Gemini keys usually start with AIza";
  if (provider === "openrouter")
    return "OpenRouter keys usually start with sk-or-";
  if (provider === "openai") return "OpenAI keys usually start with sk-";
  if (provider === "anthropic")
    return "Anthropic keys usually start with sk-ant-";
  return "Ollama expects a URL such as http://localhost:11434";
}

export async function setProviderKey(
  providerValue: string,
  keyArg: string | undefined,
  options: SetKeyOptions,
): Promise<void> {
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
  const provider = assertProvider(providerValue);
  await unsetProviderSecret(provider);
  console.log(`unset ${provider}`);
}

export async function printProviderKeys(): Promise<void> {
  const config = getConfig();
  const statuses = await listProviderStatuses(config.defaultProvider);
  for (const status of statuses) {
    const active = status.active ? chalk.green("active") : "      ";
    const configured = status.configured ? chalk.green("✓") : chalk.red("✗");
    const source = status.source === "missing" ? "no key" : status.source;
    const secret = status.maskedKey ? ` ${status.maskedKey}` : "";
    const note = status.note ? ` ${status.note}` : "";
    console.log(
      `${active} ${configured} ${status.provider.padEnd(10)} ${source}${secret}${note} model=${status.model}`,
    );
  }
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
  const selected = await select({
    message: "Select provider:",
    choices: statuses.map((status) => ({
      name: `${status.provider.padEnd(10)} ${status.configured ? "✓ key set" : "✗ no key"}${status.active ? " (active)" : ""}`,
      value: status.provider,
    })),
  });
  await useProvider(selected);
}
