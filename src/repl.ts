import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import type { ChatMessage, Mode, ProviderId } from "./types.js";
import { runAskStream } from "./modes/ask.js";
import { runAgent } from "./modes/agent.js";
import {
  providerSwitcher,
  printProviderKeys,
  setProviderKey,
  unsetProviderKey,
  useProvider,
} from "./commands/providers.js";
import {
  getConfig,
  getProviderModel,
  setDefaultMode,
  setProviderModel,
  updateConfig,
} from "./store/config.js";
import { listSessions, saveSession } from "./store/history.js";
import { assertProvider, defaultModels } from "./llm/provider.js";
import { providerIds } from "./types.js";
import { runUpdate, checkForUpdateSilent, getCurrentVersion } from "./commands/update.js";
import {
  renderBanner,
  renderSessionInfo,
  renderSuggestions,
  renderModeSwitch,
  renderProviderSwitch,
  PROMPT,
} from "./ui/banner.js";

export interface ReplOptions {
  mode?: Mode | undefined;
  provider?: ProviderId | undefined;
  model?: string | undefined;
}

// ── Well-known models per provider ─────────────────────────────────────────
const knownModels: Record<string, string[]> = {
  groq: [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "llama3-70b-8192",
    "mixtral-8x7b-32768",
    "gemma2-9b-it",
    "qwen/qwen3-32b",
  ],
  gemini: [
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ],
  openrouter: [
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemma-3-27b-it:free",
    "deepseek/deepseek-r1:free",
    "qwen/qwen3-32b:free",
    "mistralai/mistral-7b-instruct:free",
  ],
  openai: [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "o1-mini",
  ],
  anthropic: [
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-latest",
    "claude-3-opus-latest",
  ],
  ollama: [
    "llama3.1:8b",
    "llama3.2:3b",
    "mistral:7b",
    "codellama:7b",
  ],
};

// ── Abort controller for streaming cancellation ─────────────────────────────
let currentAbortController: AbortController | null = null;

function splitCommand(line: string): string[] {
  return (
    line
      .match(/(?:[^\s"]+|"[^"]*")+/g)
      ?.map((part) => part.replace(/^"|"$/g, "")) ?? []
  );
}

// ── Strip / collapse <think> blocks ─────────────────────────────────────────
let lastThinkContent = "";

function stripThinking(text: string): { visible: string; hasThinking: boolean; thinkContent: string } {
  const thinkBlocks: string[] = [];
  const visible = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_, content: string) => {
    thinkBlocks.push(content.trim());
    return "";
  }).trim();
  const hasThinking = thinkBlocks.length > 0;
  const thinkContent = thinkBlocks.join("\n\n");
  return { visible, hasThinking, thinkContent };
}

// Stream a response while hiding <think> blocks and handling ESC abort
async function streamWithAbort(
  run: (signal: AbortSignal, onToken: (t: string) => void) => Promise<string>,
): Promise<string> {
  const ac = new AbortController();
  currentAbortController = ac;
  lastThinkContent = "";

  let buffer = "";
  let visibleBuffer = "";
  let inThink = false;
  let thinkBuffer = "";

  const onToken = (token: string): void => {
    buffer += token;
    // Stream-parse <think> blocks on the fly
    let remaining = token;
    while (remaining.length > 0) {
      if (inThink) {
        const closeIdx = remaining.indexOf("</think>");
        if (closeIdx >= 0) {
          thinkBuffer += remaining.slice(0, closeIdx);
          lastThinkContent = thinkBuffer.trim();
          inThink = false;
          remaining = remaining.slice(closeIdx + 8);
        } else {
          thinkBuffer += remaining;
          remaining = "";
        }
      } else {
        const openIdx = remaining.indexOf("<think>");
        if (openIdx >= 0) {
          const before = remaining.slice(0, openIdx);
          if (before) {
            process.stdout.write(before);
            visibleBuffer += before;
          }
          inThink = true;
          thinkBuffer = "";
          remaining = remaining.slice(openIdx + 7);
        } else {
          process.stdout.write(remaining);
          visibleBuffer += remaining;
          remaining = "";
        }
      }
    }
  };

  try {
    const raw = await run(ac.signal, onToken);
    if (lastThinkContent) {
      process.stdout.write(chalk.dim("  [thinking hidden — Ctrl+T to show]\n"));
    }
    return visibleBuffer || raw;
  } catch (err) {
    if (ac.signal.aborted) {
      process.stdout.write(chalk.yellow("\n  ⏹ Aborted.\n"));
      return visibleBuffer;
    }
    throw err;
  } finally {
    currentAbortController = null;
  }
}

function help(): string {
  const cmds = [
    ["/ask", "switch to ask mode"],
    ["/agent", "switch to agent mode"],
    ["/model [name|#]", "list models or switch (e.g. /model 2)"],
    ["/provider [name]", "switch provider or open picker"],
    ["/use <provider>", "alias for /provider <name>"],
    ["/set <provider> [key]", "store API key"],
    ["/unset <provider>", "remove key"],
    ["/keys", "list configured providers"],
    ["/clear", "clear context"],
    ["/history", "show past sessions"],
    ["/save <name>", "save session"],
    ["/cwd <path>", "change working directory"],
    ["/allow <tool>", "allow a tool for session"],
    ["/update", "check for updates"],
    ["/exit", "quit"],
    ["/help", "list commands"],
  ];
  const maxCmd = Math.max(...cmds.map((c) => c[0]!.length));
  const lines = cmds
    .map((c) => `  ${chalk.cyan(c[0]!.padEnd(maxCmd + 2))}${chalk.dim(c[1]!)}`)
    .join("\n");
  return lines + chalk.dim("\n\n  ESC / Ctrl+C  abort current response");
}

function showModelPicker(provider: string): void {
  const models = knownModels[provider] ?? [];
  const def = defaultModels[provider as ProviderId] ?? "";
  if (models.length === 0) {
    console.log(chalk.dim("  No known models for this provider. Type /model <name> to set manually."));
    return;
  }
  console.log(chalk.dim(`  Available models for ${chalk.cyan(provider)}:`));
  models.forEach((m, i) => {
    const marker = m === def ? chalk.yellow(" ← default") : "";
    console.log(`  ${chalk.dim(`${i + 1}.`)} ${chalk.white(m)}${marker}`);
  });
  console.log(chalk.dim("  Use /model <name> or /model <#> to select."));
}

async function handleSlash(
  line: string,
  state: {
    mode: Mode;
    provider: ProviderId;
    model: string;
    messages: ChatMessage[];
  },
): Promise<boolean> {
  const [command, ...args] = splitCommand(line);
  switch (command) {
    case "/ask":
      state.mode = "ask";
      setDefaultMode("ask");
      console.log(renderModeSwitch("ask"));
      return true;
    case "/agent":
      state.mode = "agent";
      setDefaultMode("agent");
      console.log(renderModeSwitch("agent"));
      return true;
    case "/model": {
      const arg = args.join(" ").trim();
      if (!arg) {
        // No arg → show picker
        showModelPicker(state.provider);
        return true;
      }
      // Numeric → pick from known list
      const num = parseInt(arg, 10);
      const models = knownModels[state.provider] ?? [];
      if (!isNaN(num) && num >= 1 && num <= models.length) {
        const picked = models[num - 1]!;
        state.model = picked;
        setProviderModel(state.provider, picked);
        console.log(renderProviderSwitch(state.provider, picked));
      } else {
        // Name → set directly
        state.model = arg;
        setProviderModel(state.provider, arg);
        console.log(renderProviderSwitch(state.provider, arg));
      }
      return true;
    }
    case "/provider":
    case "/use": {
      await providerSwitcher(args[0]);
      const config = getConfig();
      state.provider = config.defaultProvider;
      state.model = getProviderModel(state.provider);
      console.log(renderProviderSwitch(state.provider, state.model));
      return true;
    }
    case "/set": {
      if (!args[0]) console.log(chalk.dim("usage: /set <provider> [key]"));
      else await setProviderKey(args[0], args[1], {});
      return true;
    }
    case "/unset": {
      if (!args[0]) console.log(chalk.dim("usage: /unset <provider>"));
      else await unsetProviderKey(args[0]);
      return true;
    }
    case "/keys":
      await printProviderKeys();
      return true;
    case "/clear":
      state.messages.length = 0;
      console.log(chalk.dim("  context cleared"));
      return true;
    case "/history": {
      const sessions = await listSessions();
      if (sessions.length === 0) console.log(chalk.dim("  no saved sessions"));
      for (const session of sessions) {
        console.log(
          chalk.dim("  ") +
            `${session.createdAt} ${session.name ?? session.id} ${chalk.dim(`(${session.messages.length} msgs)`)}`,
        );
      }
      return true;
    }
    case "/save": {
      const record = await saveSession(
        state.messages,
        args.join(" ") || undefined,
      );
      console.log(chalk.dim(`  saved session ${record.id}`));
      return true;
    }
    case "/cwd": {
      const dir = args.join(" ");
      if (!dir) console.log(chalk.dim(`  ${process.cwd()}`));
      else {
        process.chdir(dir);
        const config = getConfig();
        updateConfig({
          sandboxRoots: Array.from(
            new Set([...config.sandboxRoots, process.cwd()]),
          ),
        });
        console.log(chalk.dim(`  cwd → ${process.cwd()}`));
      }
      return true;
    }
    case "/allow": {
      const tool = args[0];
      if (!tool) console.log(chalk.dim("usage: /allow <tool>"));
      else {
        const config = getConfig();
        updateConfig({
          allowAlwaysTools: Array.from(
            new Set([...config.allowAlwaysTools, tool]),
          ),
        });
        console.log(chalk.dim(`  allowed ${tool} ✓`));
      }
      return true;
    }
    case "/think":
    case "/thinking": {
      if (lastThinkContent) {
        console.log(chalk.dim("─── thinking ──────────────────────────────────"));
        console.log(chalk.dim(lastThinkContent));
        console.log(chalk.dim("───────────────────────────────────────────────"));
      } else {
        console.log(chalk.dim("  No thinking from last response."));
      }
      return true;
    }
    case "/exit":
    case "/quit":
      return false;
    case "/update":
      await runUpdate();
      return true;
    case "/help":
      console.log(help());
      return true;
    default:
      console.log(chalk.dim(`  unknown command: ${command}. Try /help`));
      return true;
  }
}

export async function startRepl(options: ReplOptions = {}): Promise<void> {
  const config = getConfig();
  const state = {
    mode: options.mode ?? config.defaultMode,
    provider: options.provider ?? config.defaultProvider,
    model: options.model ?? config.defaultModel,
    messages: [] as ChatMessage[],
  };
  if (options.provider) {
    state.provider = assertProvider(options.provider);
  }

  const rl = readline.createInterface({ input, output });

  // ── ESC / Ctrl+C abort ──────────────────────────────────────────────────
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false); // keep readline in control
  }
  // Ctrl+C while streaming → abort; otherwise readline handles it
  process.on("SIGINT", () => {
    if (currentAbortController) {
      currentAbortController.abort();
    } else {
      // No active stream → exit
      console.log();
      process.exit(0);
    }
  });

  // ── Startup banner ──────────────────────────────────────────────────────
  console.log(renderBanner(getCurrentVersion()));
  console.log(
    renderSessionInfo({
      workdir: process.cwd(),
      model: state.model,
      provider: state.provider,
      mode: state.mode,
    }),
  );
  console.log(renderSuggestions());
  console.log(chalk.dim("  ESC / Ctrl+C to abort a response  │  /model to list models  │  /think to show thinking\n"));

  // Non-blocking update check
  checkForUpdateSilent();

  try {
    while (true) {
      const line = (await rl.question(PROMPT)).trim();
      if (!line) continue;
      if (line.startsWith("/")) {
        const shouldContinue = await handleSlash(line, state);
        if (!shouldContinue) break;
        continue;
      }

      try {
        if (state.mode === "ask") {
          await streamWithAbort(async (signal, onToken) => {
            return await runAskStream(line, onToken, {
              provider: state.provider,
              model: state.model,
              history: state.messages,
              signal,
            });
          });
          process.stdout.write("\n");
        } else {
          await runAgent(line, {
            provider: state.provider,
            model: state.model,
            history: state.messages,
          });
        }
        console.log();
        state.messages.push(
          { role: "user", content: line },
          { role: "assistant", content: "" },
        );
      } catch (error) {
        console.error(
          chalk.red(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  } finally {
    if (state.messages.length > 0) {
      await saveSession(state.messages, `repl-${new Date().toISOString()}`);
    }
    rl.close();
  }
}
