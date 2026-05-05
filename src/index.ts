import { Command, Option } from "commander";
import chalk from "chalk";
import type { Mode, ProviderId } from "./types.js";
import { runAsk } from "./modes/ask.js";
import { runAgent } from "./modes/agent.js";
import { startRepl } from "./repl.js";
import {
  providerSwitcher,
  printProviderKeys,
  setProviderKey,
  unsetProviderKey,
  useProvider,
} from "./commands/providers.js";
import { runDoctor } from "./commands/doctor.js";
import {
  getConfig,
  setDefaultMode,
  setProviderModel,
  updateConfig,
} from "./store/config.js";
import { assertProvider } from "./llm/provider.js";
import { listSessions } from "./store/history.js";

interface GlobalOptions {
  mode?: Mode | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  yes?: boolean | undefined;
}

function modeOption(): Option {
  return new Option("--mode <mode>", "execution mode").choices([
    "ask",
    "agent",
  ]);
}

function resolveProvider(value?: string): ProviderId | undefined {
  return value ? assertProvider(value) : undefined;
}

async function oneShot(
  promptParts: string[] | undefined,
  options: GlobalOptions,
): Promise<void> {
  const prompt = promptParts?.join(" ").trim();
  const provider = resolveProvider(options.provider);
  const mode = options.mode ?? getConfig().defaultMode;
  const model = options.model ?? getConfig().defaultModel;

  if (!prompt) {
    await startRepl({ mode, provider, model });
    return;
  }

  const answer =
    mode === "ask"
      ? await runAsk(prompt, { provider, model })
      : await runAgent(prompt, { provider, model, autoConfirm: options.yes });
  console.log(answer);
}

function printError(error: unknown): void {
  console.error(
    chalk.red(error instanceof Error ? error.message : String(error)),
  );
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("clai")
    .description("A cross-platform AI CLI assistant with ask and agent modes")
    .version("0.1.0")
    .addOption(modeOption())
    .option("--provider <provider>", "LLM provider to use")
    .option("--model <model>", "model to use")
    .option("-y, --yes", "auto-confirm tool execution for one-shot agent mode")
    .argument("[prompt...]", "one-shot prompt")
    .action(
      async (promptParts: string[] | undefined, options: GlobalOptions) => {
        await oneShot(promptParts, options);
      },
    );

  program
    .command("config")
    .description("print config path and current non-secret settings")
    .action(() => {
      console.log(JSON.stringify(getConfig(), null, 2));
    });

  program
    .command("set")
    .description("store an API key or Ollama URL")
    .argument("<provider>", "provider id")
    .argument("[apiKey]", "API key")
    .option("--from-env <envVar>", "import key from environment variable")
    .option("--stdin", "read key from stdin")
    .option("--url <url>", "Ollama base URL")
    .option("--skip-ping", "save without pinging provider")
    .action(
      async (
        provider: string,
        apiKey: string | undefined,
        options: {
          fromEnv?: string | undefined;
          stdin?: boolean | undefined;
          url?: string | undefined;
          skipPing?: boolean | undefined;
        },
      ) => {
        await setProviderKey(provider, apiKey, options);
      },
    );

  program
    .command("unset")
    .description("remove a stored API key")
    .argument("<provider>", "provider id")
    .action(async (provider: string) => {
      await unsetProviderKey(provider);
    });

  program
    .command("keys")
    .description("list configured providers with masked keys")
    .action(async () => {
      await printProviderKeys();
    });

  program
    .command("use")
    .description("set the active default provider")
    .argument("<provider>", "provider id")
    .action(async (provider: string) => {
      await useProvider(provider);
    });

  program
    .command("provider")
    .description("switch provider or open interactive provider picker")
    .argument("[provider]", "provider id")
    .action(async (provider?: string) => {
      await providerSwitcher(provider);
    });

  program
    .command("model")
    .description("set the active model for the current provider")
    .argument("<model>", "model name")
    .action((model: string) => {
      const config = getConfig();
      setProviderModel(config.defaultProvider, model);
      console.log(`model=${model}`);
    });

  program
    .command("mode")
    .description("set default mode")
    .argument("<mode>", "ask or agent")
    .action((mode: string) => {
      if (mode !== "ask" && mode !== "agent")
        throw new Error("Mode must be ask or agent");
      setDefaultMode(mode);
      console.log(`mode=${mode}`);
    });

  program
    .command("doctor")
    .description("check dependencies and provider configuration")
    .action(async () => {
      await runDoctor();
    });

  program
    .command("history")
    .description("list saved sessions")
    .action(async () => {
      const sessions = await listSessions();
      for (const session of sessions) {
        console.log(
          `${session.createdAt} ${session.name ?? session.id} (${session.messages.length} messages) ${session.cwd}`,
        );
      }
    });

  program
    .command("update")
    .description("print update instructions")
    .action(() => {
      console.log(
        "Update via your installer: npm i -g clai, brew upgrade clai, scoop update clai, or download the latest GitHub release.",
      );
    });

  program
    .command("authorize-pentest")
    .description("store the pentest authorization acknowledgement")
    .argument("<ack>", "type AGREE to acknowledge")
    .action((ack: string) => {
      if (ack !== "AGREE") throw new Error("Type AGREE to continue");
      updateConfig({ pentestAuthorized: true });
      console.log(
        "Pentest authorization acknowledgement stored. Only test systems you own or have written permission to test.",
      );
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  printError(error);
  if (!process.exitCode) {
    process.exitCode = 1;
  }
});
