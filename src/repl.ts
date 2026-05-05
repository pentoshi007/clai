import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import type { ChatMessage, Mode, ProviderId } from "./types.js";
import { runAsk } from "./modes/ask.js";
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
  return [
    "/ask                  switch to ask mode",
    "/agent                switch to agent mode",
    "/model <name>         switch model",
    "/provider [name]      switch provider or open picker",
    "/use <provider>       alias for /provider <name>",
    "/set <provider> [key] store API key",
    "/unset <provider>     remove key",
    "/keys                 list configured providers",
    "/clear                clear context",
    "/history              show past sessions",
    "/save <name>          save session",
    "/cwd <path>           change working directory",
    "/allow <tool>         allow a tool for session/config",
    "/exit                 quit",
    "/help                 list commands",
  ].join("\n");
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
      console.log(chalk.green("mode: ask"));
      return true;
    case "/agent":
      state.mode = "agent";
      setDefaultMode("agent");
      console.log(chalk.yellow("mode: agent"));
      return true;
    case "/model": {
      const model = args.join(" ");
      if (!model) console.log("usage: /model <name>");
      else {
        state.model = model;
        setProviderModel(state.provider, model);
        console.log(`model: ${model}`);
      }
      return true;
    }
    case "/provider":
    case "/use": {
      await providerSwitcher(args[0]);
      const config = getConfig();
      state.provider = config.defaultProvider;
      state.model = getProviderModel(state.provider);
      return true;
    }
    case "/set": {
      if (!args[0]) console.log("usage: /set <provider> [key]");
      else await setProviderKey(args[0], args[1], {});
      return true;
    }
    case "/unset": {
      if (!args[0]) console.log("usage: /unset <provider>");
      else await unsetProviderKey(args[0]);
      return true;
    }
    case "/keys":
      await printProviderKeys();
      return true;
    case "/clear":
      state.messages.length = 0;
      console.log("context cleared");
      return true;
    case "/history": {
      const sessions = await listSessions();
      if (sessions.length === 0) console.log("no saved sessions yet");
      for (const session of sessions) {
        console.log(
          `${session.createdAt} ${session.name ?? session.id} (${session.messages.length} messages) ${session.cwd}`,
        );
      }
      return true;
    }
    case "/save": {
      const record = await saveSession(
        state.messages,
        args.join(" ") || undefined,
      );
      console.log(`saved session ${record.id}`);
      return true;
    }
    case "/cwd": {
      const dir = args.join(" ");
      if (!dir) console.log(process.cwd());
      else {
        process.chdir(dir);
        const config = getConfig();
        updateConfig({
          sandboxRoots: Array.from(
            new Set([...config.sandboxRoots, process.cwd()]),
          ),
        });
        console.log(`cwd: ${process.cwd()}`);
      }
      return true;
    }
    case "/allow": {
      const tool = args[0];
      if (!tool) console.log("usage: /allow <tool>");
      else {
        const config = getConfig();
        updateConfig({
          allowAlwaysTools: Array.from(
            new Set([...config.allowAlwaysTools, tool]),
          ),
        });
        console.log(`allowed ${tool}`);
      }
      return true;
    }
    case "/exit":
    case "/quit":
      return false;
    case "/help":
      console.log(help());
      return true;
    default:
      console.log(`unknown command: ${command}. Try /help`);
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
  console.log(chalk.bold("clai"));
  console.log(
    `mode=${state.mode} provider=${state.provider} model=${state.model}. Type /help for commands.`,
  );

  try {
    while (true) {
      const line = (await rl.question(chalk.cyan("clai> "))).trim();
      if (!line) continue;
      if (line.startsWith("/")) {
        const shouldContinue = await handleSlash(line, state);
        if (!shouldContinue) break;
        continue;
      }

      try {
        const answer =
          state.mode === "ask"
            ? await runAsk(line, {
                provider: state.provider,
                model: state.model,
                history: state.messages,
              })
            : await runAgent(line, {
                provider: state.provider,
                model: state.model,
                history: state.messages,
              });
        console.log(chalk.gray("─".repeat(40)));
        console.log(answer);
        console.log(chalk.gray("─".repeat(40)));
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
    rl.close();
  }
}
