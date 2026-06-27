import { Command, Option } from "commander";
import chalk from "chalk";
import type { Mode, ProviderId } from "./types.js";
import { runAsk, runAskStream } from "./modes/ask.js";
import { runAgent } from "./modes/agent.js";
import { startRepl } from "./repl.js";
import {
  providerSwitcher,
  printProviderKeys,
  setProviderKey,
  unsetProviderKey,
  useProvider,
  ensureProviderConfigured,
} from "./commands/providers.js";
import { runDoctor } from "./commands/doctor.js";
import { runUpdate, checkForUpdateSilent, getCurrentVersion } from "./commands/update.js";
import {
  getConfig,
  getProviderModel,
  setDefaultMode,
  setProviderModel,
  updateConfig,
} from "./store/config.js";
import { assertProvider } from "./llm/provider.js";
import { listSessions, saveSession, getSession } from "./store/history.js";
import {
  clearThinking,
  createThinkingStreamParser,
  rememberThinkingFromText,
  renderThinkingSummary,
} from "./ui/thinking.js";
import { createMarkdownStreamWriter, renderMarkdown } from "./ui/markdown.js";
import { canUseTui } from "./tui/can-use-tui.js";
import { shouldUseTui } from "./tui/default.js";

interface GlobalOptions {
  mode?: Mode | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  yes?: boolean | undefined;
  noHistory?: boolean | undefined;
  tui?: boolean | undefined;
  classic?: boolean | undefined;
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
  const config = getConfig();
  const provider = resolveProvider(options.provider);
  const activeProvider = provider ?? config.defaultProvider;
  const mode = options.mode ?? config.defaultMode;
  const model = options.model ?? getProviderModel(activeProvider);
  await ensureProviderConfigured(activeProvider);

  if (!prompt) {
    if (shouldUseTui(options)) {
      const gate = canUseTui();
      if (gate.ok) {
        const { startTui } = await import("./tui/index.js");
        await startTui({
          mode,
          provider,
          model,
          noHistory: options.noHistory,
        });
        return;
      }
      console.error(
        chalk.dim(`  TUI unavailable (${gate.reason}); using classic REPL.`),
      );
    }
    await startRepl({ mode, provider, model, noHistory: options.noHistory });
    return;
  }

  clearThinking();
  let answer = "";
  if (mode === "ask") {
    let sawToken = false;
    const markdown = createMarkdownStreamWriter((chunk) => process.stdout.write(chunk));
    const parser = createThinkingStreamParser((text) => markdown.push(text));
    const raw = await runAskStream(prompt, (token) => {
      sawToken = true;
      parser.push(token);
    }, {
      provider,
      model,
    });
    const result = sawToken ? parser.finish() : rememberThinkingFromText(raw);
    if (sawToken) {
      markdown.finish();
    } else if (result.visible) {
      process.stdout.write(renderMarkdown(result.visible));
    }
    if (result.hasThinking) {
      const prefix = result.visible && !result.visible.endsWith("\n") ? "\n" : "";
      process.stdout.write(`${prefix}${renderThinkingSummary(result.thinkContent)}\n`);
    }
    process.stdout.write("\n");
    answer = result.visible;
  } else {
    answer = await runAgent(prompt, { provider, model, autoConfirm: options.yes });
  }
  if (!options.noHistory) {
    await saveSession([
      { role: "user", content: prompt },
      { role: "assistant", content: answer },
    ]);
  }
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
    .version(getCurrentVersion())
    .addOption(modeOption())
    .option("--provider <provider>", "LLM provider to use")
    .option("--model <model>", "model to use")
    .option("-y, --yes", "auto-confirm tool execution for one-shot agent mode")
    .option(
      "--no-history",
      "do not persist this session to history (in-memory only)",
    )
    .option("--tui", "launch the full-screen terminal UI (default)")
    .option("--classic", "launch the legacy line-based REPL")
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
    .command("search-provider")
    .description("set the active search provider for web.search")
    .argument("<provider>", "search provider id (brave, tavily, duckduckgo)")
    .action(async (provider: string) => {
      const { useSearchProvider } = await import("./commands/search-providers.js");
      await useSearchProvider(provider);
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
    .option("--show <sessionId>", "print a saved session")
    .action(async (options: { show?: string | undefined }) => {
      if (options.show) {
        const session = await getSession(options.show);
        if (!session) throw new Error(`No session found: ${options.show}`);
        console.log(JSON.stringify(session, null, 2));
        return;
      }
      const sessions = await listSessions();
      for (const session of sessions) {
        console.log(
          `${session.updatedAt} ${session.name ?? session.id} (${session.messages.length} messages) ${session.cwd}`,
        );
      }
    });

  program
    .command("update")
    .description("check for updates and show upgrade instructions")
    .action(async () => {
      await runUpdate();
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

  const scopeCommand = program
    .command("scope")
    .description("manage the pentest engagement scope (authorized targets)");

  scopeCommand
    .command("show")
    .description("print the current engagement scope")
    .action(async () => {
      const { loadScope, isScopeActive, getScopePath, resetScopeCache } =
        await import("./store/scope.js");
      resetScopeCache();
      const scope = await loadScope();
      if (!scope) {
        console.log("No engagement scope configured.");
        console.log(`  expected at: ${getScopePath()}`);
        return;
      }
      console.log(JSON.stringify(scope, null, 2));
      console.log(
        isScopeActive(scope)
          ? "  status: active"
          : "  status: expired or empty",
      );
    });

  scopeCommand
    .command("new")
    .description("create or replace the engagement scope")
    .requiredOption(
      "--targets <list>",
      "comma-separated authorized targets (domains, IPs, CIDRs)",
    )
    .option(
      "--exclude <list>",
      "comma-separated excluded targets",
    )
    .option(
      "--phases <list>",
      "comma-separated phases (recon,enumeration,exploitation,post-exploitation)",
    )
    .option("--name <name>", "engagement name")
    .option("--note <text>", "authorization note")
    .option("--expires <iso>", "ISO date when this scope expires")
    .option("--max-rate <n>", "max requests per second", parseFloat)
    .option(
      "--max-concurrency <n>",
      "max concurrent network operations",
      parseFloat,
    )
    .action(
      async (options: {
        targets: string;
        exclude?: string | undefined;
        phases?: string | undefined;
        name?: string | undefined;
        note?: string | undefined;
        expires?: string | undefined;
        maxRate?: number | undefined;
        maxConcurrency?: number | undefined;
      }) => {
        const { saveScope } = await import("./store/scope.js");
        const split = (raw: string | undefined): string[] | undefined =>
          raw === undefined
            ? undefined
            : raw
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean);
        const phases = split(options.phases);
        const allowedPhases = phases
          ? (phases.filter((phase): phase is
              | "recon"
              | "enumeration"
              | "exploitation"
              | "post-exploitation" =>
              [
                "recon",
                "enumeration",
                "exploitation",
                "post-exploitation",
              ].includes(phase),
            ) as Array<
              "recon" | "enumeration" | "exploitation" | "post-exploitation"
            >)
          : undefined;
        const targets = split(options.targets) ?? [];
        if (targets.length === 0) {
          throw new Error("--targets must list at least one target");
        }
        const scope = {
          name: options.name,
          authorizedTargets: targets,
          excludedTargets: split(options.exclude),
          allowedPhases,
          authorizationNote: options.note,
          createdAt: new Date().toISOString(),
          expiresAt: options.expires,
          maxRate: options.maxRate,
          maxConcurrency: options.maxConcurrency,
        };
        await saveScope(scope);
        console.log(
          `Saved engagement scope${scope.name ? ` "${scope.name}"` : ""} with ${targets.length} authorized target(s).`,
        );
      },
    );

  scopeCommand
    .command("add")
    .description("append targets to the active engagement scope")
    .requiredOption(
      "--targets <list>",
      "comma-separated authorized targets (domains, IPs, CIDRs)",
    )
    .action(async (options: { targets: string }) => {
      const { addScopeTargets } = await import("./store/scope.js");
      const targets = options.targets
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (targets.length === 0) {
        throw new Error("--targets must list at least one target");
      }
      const scope = await addScopeTargets(targets);
      console.log(
        `Added ${targets.length} authorized target(s). Scope now has ${scope.authorizedTargets.length}.`,
      );
    });

  scopeCommand
    .command("clear")
    .description("clear the active engagement scope")
    .action(async () => {
      const { clearScope, getScopePath } = await import("./store/scope.js");
      await clearScope();
      console.log(`Engagement scope cleared (${getScopePath()}).`);
    });

  const privacyCommand = program
    .command("privacy")
    .description("control retention, private mode, and clear stored data");

  privacyCommand
    .command("status")
    .description("show retention and private-mode status")
    .action(() => {
      const cfg = getConfig();
      console.log(
        `privateMode=${cfg.privateMode}  historyRetentionLimit=${cfg.historyRetentionLimit || "unlimited"}`,
      );
    });

  privacyCommand
    .command("on")
    .description("enable private mode (no history persisted)")
    .action(() => {
      updateConfig({ privateMode: true });
      console.log("privateMode=on");
    });

  privacyCommand
    .command("off")
    .description("disable private mode")
    .action(() => {
      updateConfig({ privateMode: false });
      console.log("privateMode=off");
    });

  privacyCommand
    .command("retention")
    .description("set or show how many sessions to keep in history (0=unlimited)")
    .argument("[limit]", "numeric limit")
    .action((limit?: string) => {
      if (limit === undefined) {
        console.log(
          `historyRetentionLimit=${getConfig().historyRetentionLimit || "unlimited"}`,
        );
        return;
      }
      const n = Math.max(0, Math.floor(Number(limit)));
      if (!Number.isFinite(n)) throw new Error("limit must be a non-negative number");
      updateConfig({ historyRetentionLimit: n });
      console.log(`historyRetentionLimit=${n || "unlimited"}`);
    });

  privacyCommand
    .command("clear-history")
    .description("delete all saved chat history")
    .action(async () => {
      const { clearAllHistory } = await import("./store/history.js");
      const r = await clearAllHistory();
      console.log(`history cleared (${r.detail || "ok"})`);
    });

  privacyCommand
    .command("clear-logs")
    .description("delete all audit logs")
    .action(async () => {
      const { clearAuditLogs } = await import("./store/logs.js");
      const r = await clearAuditLogs();
      console.log(`audit logs cleared (${r.removed} files)`);
    });

  privacyCommand
    .command("clear-artifacts")
    .description("delete all saved tool artifacts under ~/.clai/outputs")
    .action(async () => {
      const { clearArtifacts } = await import("./store/logs.js");
      const r = await clearArtifacts();
      console.log(`artifacts cleared (${r.removed} files)`);
    });

  privacyCommand
    .command("clear-all")
    .description("delete history, logs, and artifacts")
    .action(async () => {
      const { clearAllHistory } = await import("./store/history.js");
      const { clearAuditLogs, clearArtifacts } = await import(
        "./store/logs.js"
      );
      const a = await clearAllHistory();
      const b = await clearAuditLogs();
      const c = await clearArtifacts();
      console.log(
        `history (${a.detail || "ok"}); logs (${b.removed}); artifacts (${c.removed})`,
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
