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
import {
  importExistingClineAuth,
  pollClineDeviceAuth,
  startClineDeviceAuth,
} from "../llm/cline-auth.js";
import type { ClineOAuthTokens } from "../llm/cline-auth.js";
import {
  codexKeyFromAccessToken,
  encodeCodexKey,
  importExistingCodexKey,
  pollCodexDeviceAuth,
  startCodexBrowserAuth,
  startCodexDeviceAuth,
} from "../llm/codex-auth.js";
import type { CodexCredential } from "../llm/codex-auth.js";
import { openSystemBrowser } from "../mcp/auth/loopback.js";
import {
  importExistingCopilotKey,
  pollCopilotDeviceAuth,
  startCopilotDeviceAuth,
} from "../llm/copilot-auth.js";
import type { ProviderId } from "../types.js";

export interface SetKeyOptions {
  fromEnv?: string | undefined;
  stdin?: boolean | undefined;
  url?: string | string[] | undefined;
  skipPing?: boolean | undefined;
}

function clineCredentialMetadata(tokens: ClineOAuthTokens) {
  return {
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
  };
}

function urlList(url: SetKeyOptions["url"]): string[] {
  if (!url) return [];
  return (Array.isArray(url) ? url : [url]).map((u) => u.trim()).filter(Boolean);
}

function addEndpoint(provider: ProviderId, raw: string): void {
  const url = normalizeEndpointUrl(raw);
  const { endpoints, added } = appendProviderEndpoint(provider, url);
  const position = `#${endpoints.activeIndex + 1}/${endpoints.urls.length}`;
  const label = getProvider(provider).displayName;
  console.log(
    added
      ? `saved ${label} endpoint ${position} ${url}`
      : `${label} endpoint ${position} ${url} is now active`,
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
      : `Enter API key for ${getProvider(provider).displayName} (input hidden, leave blank to cancel):`;
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
  if (provider === "explabs")
    return "Experiential Labs keys start with xpl_ (mint one at https://platform.experientiallabs.ai/settings/api-keys)";
  if (provider === "vercel")
    return "Vercel AI Gateway keys are issued by Vercel (AI_GATEWAY_API_KEY)";
  if (provider === "deepseek")
    return "DeepSeek keys start with sk- (from https://platform.deepseek.com)";
  if (provider === "kimi")
    return "Kimi keys start with sk- (from https://platform.kimi.ai)";
  if (provider === "glm")
    return "GLM keys are alphanumeric or id.secret (from https://open.bigmodel.cn or https://z.ai)";
  if (provider === "minimax")
    return "MiniMax keys are alphanumeric (from https://intl.minimaxi.com or https://api.minimax.chat)";
  if (provider === "codex")
    return "Chatgpt Subscription uses ChatGPT sign-in — run `clai auth chatgpt` (or import with --import)";
  if (provider === "copilot")
    return "Github Copilot uses GitHub sign-in — run `clai auth copilot` (or import with --import)";
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
  const label = providerImpl.displayName;

  const urls = urlList(options.url);
  if (providerUsesEndpoints(provider) && urls.length > 0) {
    for (const url of urls) addEndpoint(provider, url);
    if (!keyArg && !options.fromEnv && !options.stdin) return;
  }

  let secret = providerUsesEndpoints(provider) ? keyArg : (urls[0] ?? keyArg);
  let clineMetadata: ReturnType<typeof clineCredentialMetadata> | undefined;
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
  if (!secret && provider === "cline" && !options.fromEnv) {
    const tokens = await resolveClineTokensInteractive();
    if (!tokens) {
      console.log("cancelled");
      return;
    }
    secret = tokens.accessToken;
    clineMetadata = clineCredentialMetadata(tokens);
  }
  if (!secret && provider === "codex" && !options.fromEnv) {
    const credential = await resolveCodexCredentialInteractive();
    if (!credential) {
      console.log("cancelled");
      return;
    }
    secret = encodeCodexKey(credential);
  }
  if (!secret && provider === "copilot" && !options.fromEnv) {
    const token = await resolveCopilotCredentialInteractive();
    if (!token) {
      console.log("cancelled");
      return;
    }
    secret = token;
  }
  if (!secret) {
    secret = await promptForSecret(provider);
  }
  if (!secret) {
    console.log("cancelled");
    return;
  }

  secret = secret.trim();

  if (providerUsesEndpoints(provider) && /^https?:\/\//i.test(secret)) {
    addEndpoint(provider, secret);
    return;
  }

  if (!providerImpl.validateKey(secret)) {
    process.exitCode = 2;
    throw new Error(
      `Invalid ${label} format. ${invalidFormatHint(provider)}.`,
    );
  }

  const modalEndpointMissing =
    provider === "modal" && !getActiveProviderEndpoint("modal");

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
    const storage = clineMetadata
      ? await appendProviderKey(provider, secret, clineMetadata)
      : await appendProviderKey(provider, secret);
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
        ? `added ${label} ${maskSecret(secret)} · ${count} keys total`
        : `saved ${label} ${maskSecret(secret)}`,
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
  const label = getProvider(provider).displayName;
  if (options.url) {
    if (!providerUsesEndpoints(provider)) {
      console.log(`${label} has no endpoint URLs`);
      return;
    }
    const count = getProviderEndpoints(provider).urls.length;
    setProviderEndpoints(provider, []);
    console.log(
      count > 0
        ? `unset ${count} endpoint URL${count === 1 ? "" : "s"} for ${label}`
        : `${label} had no endpoint URLs`,
    );
    return;
  }
  const multi = await getProviderKeys(provider);
  const count = multi.source === "env" ? 0 : multi.keys.length;
  await unsetProviderSecret(provider);
  console.log(
    count > 1 ? `unset all ${count} keys for ${label}` : `unset ${label}`,
  );
}

export async function printProviderKeys(): Promise<void> {
  const config = getConfig();
  const statuses = await listProviderStatuses(config.defaultProvider);

  console.log(chalk.bold("LLM Providers:"));
  console.log(chalk.dim("  PROVIDER                            SOURCE    KEYS          MODEL"));

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
    const name = getProvider(s.provider).displayName;
    console.log(
      `  ${mark} ${name.padEnd(34)} ${source} ${String(keySummary).padEnd(13)} ${s.model}${tag}`,
    );
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
  const label = getProvider(provider).displayName;
  if (provider === "modal") {
    if (!(await promptModalSetup())) {
      console.log("provider unchanged");
      return;
    }
    setDefaultProvider(provider);
    console.log(`now using ${label} · model=${getProviderModel(provider)}`);
    return;
  }
  const secret = await getProviderSecret(provider);
  if (!secret.value && !envValue(provider) && provider !== "ollama" && provider !== "free") {
    if (provider === "cline") {
      const tokens = await resolveClineTokensInteractive();
      if (!tokens) {
        console.log("provider unchanged");
        return;
      }
      await appendProviderKey(
        "cline",
        tokens.accessToken,
        clineCredentialMetadata(tokens),
      );
    } else if (provider === "codex") {
      const credential = await resolveCodexCredentialInteractive();
      if (!credential) {
        console.log("provider unchanged");
        return;
      }
      await appendProviderKey("codex", encodeCodexKey(credential));
    } else if (provider === "copilot") {
      const token = await resolveCopilotCredentialInteractive();
      if (!token) {
        console.log("provider unchanged");
        return;
      }
      await appendProviderKey("copilot", token);
    } else {
      const entered = await promptForSecret(provider);
      if (!entered) {
        console.log("provider unchanged");
        return;
      }
      await setProviderKey(provider, entered, { skipPing: false });
    }
  }
  setDefaultProvider(provider);
  console.log(`now using ${label} · model=${getProviderModel(provider)}`);
}

export async function authCline(
  providerValue: string,
  options: { import?: boolean | undefined } = {},
): Promise<void> {
  const provider = assertProvider(providerValue);
  if (provider !== "cline") {
    throw new Error(
      `OAuth browser sign-in is only supported for the cline provider (got "${provider}"). Use \`clai set ${provider} <key>\` instead.`,
    );
  }

  if (options.import) {
    process.stderr.write("Looking for an existing Cline CLI/Desktop sign-in…\n");
    const tokens = await importExistingClineAuth();
    if (!tokens) {
      process.exitCode = 5;
      throw new Error(
        "No usable Cline credential found. Sign in with `clai auth cline` (no --import) or install Cline CLI/Desktop and log in first.",
      );
    }
    const token = tokens.accessToken;
    const storage = await appendProviderKey(
      "cline",
      token,
      clineCredentialMetadata(tokens),
    );
    if (storage === "fallback") {
      process.exitCode = 3;
      console.warn(
        chalk.yellow(
          `Warning: OS keychain unavailable; stored in ${getFallbackKeysPath()} with restricted permissions.`,
        ),
      );
    }
    const multi = await getProviderKeys("cline");
    console.log(
      `imported cline ${maskSecret(token)} · ${multi.keys.length} key${multi.keys.length === 1 ? "" : "s"} total`,
    );
    return;
  }

  const tokens = await resolveClineTokensInteractive();
  if (!tokens) {
    process.exitCode = 5;
    throw new Error("Cline authentication failed or was cancelled.");
  }
  const token = tokens.accessToken;
  const storage = await appendProviderKey(
    "cline",
    token,
    clineCredentialMetadata(tokens),
  );
  if (storage === "fallback") {
    process.exitCode = 3;
    console.warn(
      chalk.yellow(
        `Warning: OS keychain unavailable; stored in ${getFallbackKeysPath()} with restricted permissions.`,
      ),
    );
  }
  const multi = await getProviderKeys("cline");
  console.log(
    `authenticated cline ${maskSecret(token)} · ${multi.keys.length} key${multi.keys.length === 1 ? "" : "s"} total`,
  );
}

export async function resolveClineTokensInteractive(): Promise<
  ClineOAuthTokens | undefined
> {
  const start = await startClineDeviceAuth();
  console.log("To authenticate Cline:");
  console.log(
    `  1. Open this link on any device:\n       ${start.verificationUrl}`,
  );
  console.log(`  2. Enter code: ${chalk.bold(start.userCode)}`);
  console.log("");

  const tokens = await pollClineDeviceAuth(start, {
    onPending: (remaining) => {
      const mm = Math.floor(remaining / 60);
      const ss = String(remaining % 60).padStart(2, "0");
      process.stderr.write(
        `\rWaiting for approval… ${mm}:${ss} remaining (Ctrl-C to cancel)   `,
      );
    },
  });
  process.stderr.write("\n");
  return tokens;
}

export async function resolveClineCredentialInteractive(): Promise<
  string | undefined
> {
  return (await resolveClineTokensInteractive())?.accessToken;
}

export async function authCodex(
  providerValue: string,
  options: {
    import?: boolean | undefined;
    browser?: boolean | undefined;
    headless?: boolean | undefined;
  } = {},
): Promise<void> {
  const provider = assertProvider(providerValue);
  const label = getProvider(provider).displayName;
  if (provider !== "codex") {
    throw new Error(
      `OAuth browser sign-in is only supported for the ${label} provider. Use \`clai set ${provider} <key>\` instead.`,
    );
  }

  if (options.import) {
    process.stderr.write("Looking for an existing Chatgpt Subscription sign-in…\n");
    const key = await importExistingCodexKey();
    if (!key) {
      process.exitCode = 5;
      throw new Error(
        "No usable ChatGPT Subscription credential found. Sign in with `clai auth chatgpt` (no --import) or install Codex CLI and log in first.",
      );
    }
    const storage = await appendProviderKey("codex", key);
    if (storage === "fallback") {
      process.exitCode = 3;
      console.warn(
        chalk.yellow(
          `Warning: OS keychain unavailable; stored in ${getFallbackKeysPath()} with restricted permissions.`,
        ),
      );
    }
    const multi = await getProviderKeys("codex");
    console.log(
      `imported Chatgpt Subscription ${maskSecret(key)} · ${multi.keys.length} key${multi.keys.length === 1 ? "" : "s"} total`,
    );
    return;
  }

  let credential: CodexCredential | undefined;
  if (options.headless) {
    credential = await resolveCodexCredentialInteractive();
  } else {
    const method = options.browser
      ? "browser"
      : await askChoice<"browser" | "headless" | "apikey">(
          "How do you want to sign in to ChatGPT Subscription?",
          [
            {
              name: "Sign in with ChatGPT (browser) — opens auth.openai.com login",
              value: "browser",
            },
            {
              name: "Sign in with ChatGPT (headless) — device code on any device",
              value: "headless",
            },
            {
              name: "Manually enter an access token / API key",
              value: "apikey",
            },
          ],
        );
    if (!method) {
      console.log("cancelled");
      return;
    }
    if (method === "headless") {
      credential = await resolveCodexCredentialInteractive();
    } else if (method === "apikey") {
      const pasted = await askSecret(
        "Paste a Chatgpt Subscription access token or stored `codex:` key:",
      );
      const key = pasted ? codexKeyFromAccessToken(pasted) ?? (pasted.startsWith("codex:") ? pasted : undefined) : undefined;
      if (!key) {
        process.exitCode = 5;
        throw new Error(
          "That token is not a valid ChatGPT access token (no chatgpt account id). Sign in with `clai auth chatgpt` instead.",
        );
      }
      await storeCodexKey(key);
      return;
    } else {
      try {
        const handle = await startCodexBrowserAuth();
        console.log("To authenticate ChatGPT Subscription:");
        console.log(`  Open this link in your browser:\n       ${handle.url}\n`);
        console.log(`Waiting for browser authorization…\n`);
        await openSystemBrowser(handle.url).catch(() => {});
        credential = await handle.waitForCredential();
      } catch (error) {
        if (options.browser) throw error;
        console.warn(
          chalk.yellow(
            `Browser sign-in unavailable (${error instanceof Error ? error.message : String(error)}); falling back to device code.`,
          ),
        );
        credential = await resolveCodexCredentialInteractive();
      }
    }
  }

  if (!credential) {
    process.exitCode = 5;
    throw new Error("ChatGPT Subscription authentication failed or was cancelled.");
  }
  await storeCodexKey(encodeCodexKey(credential));
}

async function storeCodexKey(key: string): Promise<void> {
  const storage = await appendProviderKey("codex", key);
  if (storage === "fallback") {
    process.exitCode = 3;
    console.warn(
      chalk.yellow(
        `Warning: OS keychain unavailable; stored in ${getFallbackKeysPath()} with restricted permissions.`,
      ),
    );
  }
  const multi = await getProviderKeys("codex");
  console.log(
    `authenticated Chatgpt Subscription ${maskSecret(key)} · ${multi.keys.length} key${multi.keys.length === 1 ? "" : "s"} total`,
  );
}

export async function authCopilot(
  providerValue: string,
  options: { import?: boolean | undefined } = {},
): Promise<void> {
  const provider = assertProvider(providerValue);
  const label = getProvider(provider).displayName;
  if (provider !== "copilot") {
    throw new Error(
      `OAuth browser sign-in is only supported for the ${label} provider. Use \`clai set ${provider} <key>\` instead.`,
    );
  }

  if (options.import) {
    process.stderr.write("Looking for an existing Github Copilot sign-in…\n");
    const key = await importExistingCopilotKey();
    if (!key) {
      process.exitCode = 5;
      throw new Error(
        "No usable Github Copilot credential found. Sign in with `clai auth copilot` (no --import) or install Copilot CLI/VS Code and log in first.",
      );
    }
    const storage = await appendProviderKey("copilot", key);
    if (storage === "fallback") {
      process.exitCode = 3;
      console.warn(
        chalk.yellow(
          `Warning: OS keychain unavailable; stored in ${getFallbackKeysPath()} with restricted permissions.`,
        ),
      );
    }
    const multi = await getProviderKeys("copilot");
    console.log(
      `imported Github Copilot ${maskSecret(key)} · ${multi.keys.length} key${multi.keys.length === 1 ? "" : "s"} total`,
    );
    return;
  }

  const token = await resolveCopilotCredentialInteractive();
  if (!token) {
    process.exitCode = 5;
    throw new Error("Github Copilot authentication failed or was cancelled.");
  }
  const storage = await appendProviderKey("copilot", token);
  if (storage === "fallback") {
    process.exitCode = 3;
    console.warn(
      chalk.yellow(
        `Warning: OS keychain unavailable; stored in ${getFallbackKeysPath()} with restricted permissions.`,
      ),
    );
  }
  const multi = await getProviderKeys("copilot");
  console.log(
    `authenticated Github Copilot ${maskSecret(token)} · ${multi.keys.length} key${multi.keys.length === 1 ? "" : "s"} total`,
  );
}

export async function resolveCodexCredentialInteractive(): Promise<
  CodexCredential | undefined
> {
  const start = await startCodexDeviceAuth();
  console.log("To authenticate ChatGPT Subscription:");
  console.log(
    `  1. Open this link on any device:\n       ${start.verificationUrl}`,
  );
  console.log(`  2. Enter code: ${chalk.bold(start.userCode)}`);
  console.log("");

  const credential = await pollCodexDeviceAuth(start, {
    onPending: (remaining) => {
      const mm = Math.floor(remaining / 60);
      const ss = String(remaining % 60).padStart(2, "0");
      process.stderr.write(
        `\rWaiting for approval… ${mm}:${ss} remaining (Ctrl-C to cancel)   `,
      );
    },
  });
  process.stderr.write("\n");
  return credential;
}

export async function resolveCopilotCredentialInteractive(): Promise<
  string | undefined
> {
  const start = await startCopilotDeviceAuth();
  console.log("To authenticate Github Copilot:");
  console.log(
    `  1. Open this link on any device:\n       ${start.verificationUrl}`,
  );
  console.log(`  2. Enter code: ${chalk.bold(start.userCode)}`);
  console.log("");

  const token = await pollCopilotDeviceAuth(start, {
    onPending: (remaining) => {
      const mm = Math.floor(remaining / 60);
      const ss = String(remaining % 60).padStart(2, "0");
      process.stderr.write(
        `\rWaiting for approval… ${mm}:${ss} remaining (Ctrl-C to cancel)   `,
      );
    },
  });
  process.stderr.write("\n");
  return token;
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
    statuses.map((status) => {
      const label = getProvider(status.provider).displayName;
      return {
        name: `${label.padEnd(34)} ${status.configured ? "✓ key set" : "✗ no key"}${status.active ? " (active)" : ""}`,
        value: status.provider,
      };
    }),
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
      const name = getProvider(status.provider).displayName;
      return {
        name: `${name.padEnd(34)} ${label}${status.active ? chalk.cyan(" (active)") : ""}`,
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
      name: `${getProvider(status.provider).displayName.padEnd(34)} ${status.configured ? chalk.green("✓ ") + (status.maskedKey ?? "key set") : chalk.red("✗ no key")}${status.active ? chalk.cyan(" (active)") : ""}`,
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
