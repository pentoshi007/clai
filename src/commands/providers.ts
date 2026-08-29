import chalk from "chalk";
import { askChoice, askLine, askSecret } from "../noninteractive/readline-prompts.js";
import { getProvider, pingProvider } from "../llm/router.js";
import {
  assertProvider,
  maskSecret,
  normalizeEndpointUrl,
} from "../llm/provider.js";
import {
  appendProviderEndpoint,
  getActiveProviderEndpoint,
  getConfig,
  getProviderEndpoints,
  getProviderModel,
  providerUsesEndpoints,
  setDefaultProvider,
  setProviderEndpoints,
  updateConfig,
} from "../store/config.js";
import {
  appendProviderKey,
  envValue,
  getFallbackKeysPath,
  getProviderKeys,
  getProviderSecret,
  listProviderStatuses,
  unsetProviderSecret,
} from "../store/keys.js";
import type { ProviderId } from "../types.js";

export interface SetKeyOptions {
  fromEnv?: string | undefined;
  stdin?: boolean | undefined;
  /** Repeatable for endpoint providers: `--url a --url b` stores both. */
  url?: string | string[] | undefined;
  skipPing?: boolean | undefined;
}

function urlList(url: SetKeyOptions["url"]): string[] {
  if (!url) return [];
  return (Array.isArray(url) ? url : [url]).map((u) => u.trim()).filter(Boolean);
}

/** Append (or re-activate) one endpoint URL and report what changed. */
function addEndpoint(provider: ProviderId, raw: string): void {
  const url = normalizeEndpointUrl(raw);
  const { endpoints, added } = appendProviderEndpoint(provider, url);
  const position = `#${endpoints.activeIndex + 1}/${endpoints.urls.length}`;
  console.log(
    added
      ? `saved ${provider} endpoint ${position} ${url}`
      : `${provider} endpoint ${position} ${url} is now active`,
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function promptForSecret(provider: ProviderId): Promise<string> {
  const message =
    provider === "modal"
      ? "Enter Modal proxy token as <token-id>:<token-secret> (input hidden, leave blank to cancel):"
      : `Enter API key for ${provider} (input hidden, leave blank to cancel):`;
  const raw = await askSecret(message);
  return (raw ?? "").trim();
}

function invalidFormatHint(provider: ProviderId): string {
  if (provider === "gemini")
    return "Gemini keys usually start with AIza or AQ.";
  if (provider === "openrouter")
    return "OpenRouter keys usually start with sk-or-";
  if (provider === "openai") return "OpenAI keys usually start with sk- or sk-proj-";
  if (provider === "anthropic")
    return "Anthropic keys usually start with sk-ant-";
  if (provider === "nvidia")
    return "NVIDIA NIM keys usually start with nvapi-";
  if (provider === "agentrouter")
    return "AgentRouter keys usually start with sk- (issued at https://agentrouter.org/console/token)";
  if (provider === "aws-mantle")
    return "Mantle keys are alphanumeric with base64 characters (at least 8 characters)";
  if (provider === "bynara")
    return "Bynara keys usually start with sk_nry_ (at least 8 characters)";
  if (provider === "qwen-cloud")
    return "Qwen Cloud keys usually start with sk- (from https://home.qwencloud.com)";
  if (provider === "modal")
    return "Modal expects a proxy token pair as <token-id>:<token-secret> (wk-…:ws-…, from `modal workspace proxy-tokens create`)";
  if (provider === "lightning")
    return "Lightning AI keys are alphanumeric (from https://lightning.ai/lightning-ai/model-apis/models?showApiKey=true)";
  if (provider === "tokenrouter")
    return "TokenRouter keys usually start with sk- (create one under My Account → API Keys)";
  if (provider === "meta")
    return "Meta Model API keys are alphanumeric (issued in your Meta Model API dashboard, MODEL_API_KEY)";
  if (provider === "orcarouter")
    return "OrcaRouter keys usually start with sk- (create one at https://www.orcarouter.ai/console)";
  if (provider === "merge-gateway")
    return "Merge Gateway keys start with mg_ (create one at https://gateway.merge.dev)";
  return "Ollama expects a URL such as http://localhost:11434";
}

export async function setProviderKey(
  providerValue: string,
  keyArg: string | undefined,
  options: SetKeyOptions,
): Promise<void> {
  
  if (
    providerValue === "brave" ||
    providerValue === "tavily" ||
    providerValue === "duckduckgo" ||
    providerValue === "exa"
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

  // For endpoint providers `--url` is configuration, not a credential, and it
  // is repeatable — each URL is appended and the last one becomes active.
  // Re-passing a known URL just makes that one active.
  const urls = urlList(options.url);
  if (providerUsesEndpoints(provider) && urls.length > 0) {
    for (const url of urls) addEndpoint(provider, url);
    if (!keyArg && !options.fromEnv && !options.stdin) return;
  }

  let secret = providerUsesEndpoints(provider) ? keyArg : (urls[0] ?? keyArg);
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

  // `clai set modal https://…` (and `/set modal https://…`) is unambiguous: a
  // URL can only be an endpoint, never an API key or a token pair.
  if (providerUsesEndpoints(provider) && /^https?:\/\//i.test(secret)) {
    addEndpoint(provider, secret);
    return;
  }

  if (!providerImpl.validateKey(secret)) {
    process.exitCode = 2;
    throw new Error(
      `Invalid ${provider} format. ${invalidFormatHint(provider)}.`,
    );
  }

  // A Modal token cannot be verified until we know which endpoint to call, so
  // store it and tell the user what is still missing instead of failing.
  const modalEndpointMissing =
    provider === "modal" && !getActiveProviderEndpoint("modal");

  // Validate against the provider BEFORE persisting: a dead key used to stay in
  // the rotation circle and cost an extra failed request plus a switch toast on
  // every later turn.
  if (!options.skipPing && !modalEndpointMissing) {
    try {
      await pingProvider(provider, secret);
    } catch (error) {
      process.exitCode = 4;
      console.warn(
        chalk.yellow(
          `Not saved: ping failed: ${error instanceof Error ? error.message : String(error)}. Re-run with --skip-ping to store it anyway.`,
        ),
      );
      return;
    }
  }

  if (provider === "ollama") {
    updateConfig({ ollamaHost: secret });
    setDefaultProvider(provider);
  } else {
    const storage = await appendProviderKey(provider, secret);
    if (storage === "fallback") {
      process.exitCode = 3;
      console.warn(
        chalk.yellow(
          `Warning: OS keychain unavailable; stored in ${getFallbackKeysPath()} with restricted permissions.`,
        ),
      );
    }
  }

  if (provider === "ollama") {
    console.log(`saved ollama ${secret}`);
  } else {
    const multi = await getProviderKeys(provider);
    const count = multi.source === "env" ? 1 : multi.keys.length;
    console.log(
      count > 1
        ? `added ${provider} ${maskSecret(secret)} · ${count} keys total`
        : `saved ${provider} ${maskSecret(secret)}`,
    );
  }

  if (modalEndpointMissing) {
    console.warn(
      chalk.yellow(
        "No Modal endpoint URL yet — the token was stored but requests will fail. " +
          "Add it with: clai set modal --url https://<workspace>--ep-<endpoint>.<region>.modal.direct",
      ),
    );
  }
}

export async function unsetProviderKey(
  providerValue: string,
  options: { url?: boolean | undefined } = {},
): Promise<void> {
  if (
    providerValue === "brave" ||
    providerValue === "tavily" ||
    providerValue === "duckduckgo" ||
    providerValue === "exa"
  ) {
    const { unsetSearchProviderKey } = await import("./search-providers.js");
    await unsetSearchProviderKey(providerValue);
    return;
  }
  const provider = assertProvider(providerValue);
  // `--url` targets the endpoint list instead of the credentials, so a bad URL
  // can be dropped without also throwing away working keys.
  if (options.url) {
    if (!providerUsesEndpoints(provider)) {
      console.log(`${provider} has no endpoint URLs`);
      return;
    }
    const count = getProviderEndpoints(provider).urls.length;
    setProviderEndpoints(provider, []);
    console.log(
      count > 0
        ? `unset ${count} endpoint URL${count === 1 ? "" : "s"} for ${provider}`
        : `${provider} had no endpoint URLs`,
    );
    return;
  }
  const multi = await getProviderKeys(provider);
  const count = multi.source === "env" ? 0 : multi.keys.length;
  await unsetProviderSecret(provider);
  console.log(
    count > 1 ? `unset all ${count} keys for ${provider}` : `unset ${provider}`,
  );
}

export async function printProviderKeys(): Promise<void> {
  const config = getConfig();
  const statuses = await listProviderStatuses(config.defaultProvider);

  console.log(chalk.bold("LLM Providers:"));
  console.log(chalk.dim("  PROVIDER      SOURCE    KEYS          MODEL"));

  for (const s of statuses) {
    const mark = s.configured ? chalk.green("✓") : chalk.red("✗");
    const tag = s.active ? chalk.cyan(" ◀") : "";
    const count = s.keyCount ?? (s.maskedKey ? 1 : 0);
    const keySummary =
      s.provider === "ollama"
        ? s.note || "local"
        : s.provider === "free"
          ? s.note || "keyless"
          : count === 0
            ? "—"
            : count === 1
              ? s.maskedKey || "••••••••"
              : `${count} keys`;
    const source = (s.source === "missing" ? "no key" : s.source).padEnd(9);
    console.log(
      `  ${mark} ${s.provider.padEnd(13)} ${source} ${String(keySummary).padEnd(13)} ${s.model}${tag}`,
    );
    // A key is not enough for endpoint providers — show where it points, and
    // list every stored endpoint with the active one starred.
    if (s.provider !== "ollama" && s.provider !== "free" && s.note) {
      console.log(chalk.dim(`      endpoint: ${s.note}`));
    }
    if (s.endpoints && s.endpoints.length > 1) {
      s.endpoints.forEach((url, i) => {
        const star = i === (s.activeEndpointIndex ?? 0) ? chalk.cyan(" ★ active") : "";
        const disabled = s.disabledEndpoints?.includes(url)
          ? chalk.yellow(" (disabled)")
          : "";
        console.log(chalk.dim(`      (${i + 1}) ${url}`) + star + disabled);
      });
    }
    if (s.maskedKeys && s.maskedKeys.length > 1) {
      let activeIdx = 0;
      if (s.activeMaskedKey) {
        const found = s.maskedKeys.indexOf(s.activeMaskedKey);
        if (found >= 0) activeIdx = found;
      }
      s.maskedKeys.forEach((masked, i) => {
        const star = i === activeIdx ? chalk.cyan(" ★ active") : "";
        const disabled = s.keyDisabled?.[i] === true ? chalk.yellow(" (disabled)") : "";
        console.log(`      [${i + 1}] ${masked}${star}${disabled}`);
      });
    }
  }

  console.log("");
  const { printSearchProviderKeys } = await import("./search-providers.js");
  await printSearchProviderKeys();
}

/**
 * Modal needs two values, so first-run setup asks for both: the endpoint URL
 * (plain input — it is not a secret and masking a long URL only hides typos)
 * and then the proxy token pair. Returns false when anything is still missing,
 * so callers can leave the active provider alone.
 */
async function promptModalSetup(): Promise<boolean> {
  if (!getActiveProviderEndpoint("modal")) {
    if (!process.stdin.isTTY) return false;
    const raw = await askLine(
      "Modal endpoint URL (e.g. https://<workspace>--ep-kimi-k3.us-west.modal.direct, blank to cancel):",
    );
    const url = (raw ?? "").trim();
    if (!url) return false;
    addEndpoint("modal", url);
  }
  if ((await getProviderSecret("modal")).value || envValue("modal")) return true;
  if (!process.stdin.isTTY) return false;
  const entered = await promptForSecret("modal");
  if (!entered) return false;
  await setProviderKey("modal", entered, { skipPing: false });
  // A URL pasted at the token prompt is stored as the endpoint instead, so
  // re-check rather than assuming a pair landed in storage.
  return Boolean((await getProviderSecret("modal")).value);
}

export async function ensureProviderConfigured(
  provider: ProviderId,
): Promise<void> {
  if (provider === "modal") {
    await promptModalSetup();
    return;
  }
  const secret = await getProviderSecret(provider);
  if (secret.value || envValue(provider) || provider === "ollama" || provider === "free") return;
  if (!process.stdin.isTTY) return;
  const entered = await promptForSecret(provider);
  if (!entered) return;
  await setProviderKey(provider, entered, { skipPing: false });
}

export async function useProvider(providerValue: string): Promise<void> {
  const provider = assertProvider(providerValue);
  if (provider === "modal") {
    if (!(await promptModalSetup())) {
      console.log("provider unchanged");
      return;
    }
    setDefaultProvider(provider);
    console.log(`now using ${provider} · model=${getProviderModel(provider)}`);
    return;
  }
  const secret = await getProviderSecret(provider);
  if (!secret.value && !envValue(provider) && provider !== "ollama" && provider !== "free") {
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
  const selected = await askChoice<ProviderId>(
    "Select provider:",
    statuses.map((status) => ({
      name: `${status.provider.padEnd(10)} ${status.configured ? "✓ key set" : "✗ no key"}${status.active ? " (active)" : ""}`,
      value: status.provider,
    })),
  );
  if (!selected) {
    console.log("provider unchanged");
    return;
  }
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
  const selected = await askChoice<ProviderId>(
    "Set / add API key for provider:",
    statuses.map((status) => {
      const count = status.keyCount ?? (status.configured ? 1 : 0);
      const label =
        count > 1
          ? chalk.green(`✓ ${count} keys`)
          : status.configured
            ? chalk.green("✓ key set")
            : chalk.red("✗ no key");
      return {
        name: `${status.provider.padEnd(12)} ${label}${status.active ? chalk.cyan(" (active)") : ""}`,
        value: status.provider,
      };
    }),
  );
  if (!selected) {
    console.log("cancelled");
    return;
  }

  const multi = await getProviderKeys(selected);
  const storedCount = multi.source === "env" ? 0 : multi.keys.length;
  if (storedCount > 0) {
    console.log(
      chalk.dim(
        `${selected} has ${storedCount} key(s). New key will be added (multi-key).`,
      ),
    );
  }
  // Prompt for another key (append)
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
  const selected = await askChoice<ProviderId>(
    "Unset API key for provider:",
    statuses.map((status) => ({
      name: `${status.provider.padEnd(12)} ${status.configured ? chalk.green("✓ ") + (status.maskedKey ?? "key set") : chalk.red("✗ no key")}${status.active ? chalk.cyan(" (active)") : ""}`,
      value: status.provider,
    })),
  );
  if (!selected) {
    console.log("cancelled");
    return;
  }

  const secret = await getProviderSecret(selected);
  if (!secret.value && selected !== "ollama") {
    console.log(chalk.dim(`${selected} has no key to unset`));
    return;
  }
  await unsetProviderKey(selected);
}
