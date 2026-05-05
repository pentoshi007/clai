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
import { assertProvider } from "./llm/provider.js";
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

function splitCommand(line: string): string[] {
  return (
    line
      .match(/(?:[^\s"]+|"[^"]*")+/g)
      ?.map((part) => part.replace(/^"|"$/g, "")) ?? []
  );
}

function help(): string {
  const cmds = [
    ["/ask", "switch to ask mode"],
    ["/agent", "switch to agent mode"],
    ["/model <name>", "switch model"],
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
  return cmds
    .map((c) => `  ${chalk.cyan(c[0]!.padEnd(maxCmd + 2))}${chalk.dim(c[1]!)}`)
    .join("\n");
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
      const model = args.join(" ");
      if (!model) console.log(chalk.dim("usage: /model <name>"));
      else {
        state.model = model;
        setProviderModel(state.provider, model);
        console.log(renderProviderSwitch(state.provider, model));
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
  console.log();

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
        const answer =
          state.mode === "ask"
            ? await runAskStream(line, (token) => process.stdout.write(token), {
                provider: state.provider,
                model: state.model,
                history: state.messages,
              })
            : await runAgent(line, {
                provider: state.provider,
                model: state.model,
                history: state.messages,
              });
        if (state.mode === "ask") {
          process.stdout.write("\n");
        }
        console.log(); // breathing room between exchanges
        state.messages.push(
          { role: "user", content: line },
          { role: "assistant", content: answer },
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
