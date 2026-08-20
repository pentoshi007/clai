import { Command, Option } from "commander";
import chalk from "chalk";
import { fileURLToPath } from "node:url";
import type { Mode, ProviderId } from "./types.js";

/** Absolute path to this module — used to re-exec under Bun for OpenTUI. */
const CLAI_ENTRY = fileURLToPath(import.meta.url);
import { resolveTurnInput } from "./attachments/service.js";
import { startNoninteractive } from "./noninteractive/start-noninteractive.js";
import { readStdinText } from "./noninteractive/read-stdin.js";
import {
  providerSwitcher,
  printProviderKeys,
  setProviderKey,
  unsetProviderKey,
  useProvider,
  ensureProviderConfigured,
} from "./commands/providers.js";
import { runDoctor } from "./commands/doctor.js";
import {
  runUpdate,
  checkForUpdateSilent,
  getCurrentVersion,
} from "./commands/update.js";
import {
  getConfig,
  getConfigPath,
  getProviderModel,
  setDefaultMode,
  setProviderModel,
  updateConfig,
} from "./store/config.js";
import { assertProvider } from "./llm/provider.js";
import { listSessionSummaries, getSession } from "./store/history.js";
import { canUseTui } from "./ui-core/bootstrap/can-use-tui.js";
import {
  isBunRuntime,
  isOpenTuiFfiError,
  openTuiRuntimeHint,
  reexecWithBunIfNeeded,
} from "./os/bun-runtime.js";
import {
  UI_FLAG_CHOICES,
  resolveUiChoice,
} from "./ui-core/bootstrap/ui-selection.js";
import { warnOnce } from "./ui/warn-once.js";

interface GlobalOptions {
  mode?: Mode | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  yes?: boolean | undefined;
  noHistory?: boolean | undefined;
  showThinking?: boolean | undefined;
  verbose?: boolean | undefined;
  quiet?: boolean | undefined;
  tui?: boolean | undefined;
  classic?: boolean | undefined;
  ui?: string | undefined;
}

function modeOption(): Option {
  return new Option("--mode <mode>", "execution mode").choices([
    "ask",
    "agent",
    "plan",
  ]);
}

function resolveProvider(value?: string): ProviderId | undefined {
  return value ? assertProvider(value) : undefined;
}

async function startInteractive(
  options: GlobalOptions,
  resolved: {
    mode: Mode;
    provider: ProviderId | undefined;
    model: string;
    noHistory: boolean | undefined;
  },
): Promise<void> {
  const ui = resolveUiChoice(options);

  if (ui === "noninteractive") {
    throw new Error("No prompt supplied; pass a prompt or pipe one on stdin.");
  }

  if (ui === "classic") {
    const { startClassic } = await import("./classic/bootstrap/start-classic.js");
    await startClassic(resolved);
    return;
  }

  const gate = canUseTui();
  if (!gate.ok) {
    warnOnce(`TUI unavailable (${gate.reason}); using classic.`);
    const { startClassic } = await import("./classic/bootstrap/start-classic.js");
    await startClassic(resolved);
    return;
  }

  if (!isBunRuntime()) {
    if (reexecWithBunIfNeeded(CLAI_ENTRY)) return;
    warnOnce(openTuiRuntimeHint());
    const { startClassic } = await import("./classic/bootstrap/start-classic.js");
    await startClassic(resolved);
    return;
  }

  try {
    const { startTuiV2 } = await import("./tui-v2/bootstrap/start-tui-v2.js");
    await startTuiV2(resolved);
  } catch (error) {
    if (!isOpenTuiFfiError(error)) throw error;
    warnOnce("Failed to start OpenTUI renderer; using classic.");
    const { startClassic } = await import("./classic/bootstrap/start-classic.js");
    await startClassic(resolved);
  }
}

async function oneShot(
  promptParts: string[] | undefined,
  options: GlobalOptions,
): Promise<void> {
  const promptFromArgs = promptParts?.join(" ").trim() ?? "";
  const config = getConfig();
  const provider = resolveProvider(options.provider);
  const activeProvider = provider ?? config.defaultProvider;
  const mode = options.mode ?? config.defaultMode;
  const model = options.model ?? getProviderModel(activeProvider);
  const prompt =
    promptFromArgs ||
    (resolveUiChoice(options) === "noninteractive" && !process.stdin.isTTY
      ? await readStdinText(process.stdin)
      : "");

  if (!prompt) {
    await startInteractive(options, {
      mode,
      provider,
      model,
      noHistory: options.noHistory,
    });
    return;
  }

  const resolved = resolveTurnInput({
    prompt,
    mode,
    provider: activeProvider,
    model,
  });
  if (resolved.fallbackReason) {
    console.error(chalk.dim(`  ${resolved.fallbackReason}`));
  }
  for (const issue of resolved.imageIssues) {
    console.error(chalk.yellow(`  ${issue}`));
  }
  const result = await startNoninteractive({
    prompt: resolved.prompt,
    historyPrompt: prompt,
    provider: resolved.provider,
    model: resolved.model,
    mode: resolved.mode,
    yes: options.yes,
    noHistory: options.noHistory,
    showThinking: options.showThinking,
    verbose: options.verbose,
    quiet: options.quiet,
    images: [...resolved.images],
    visionProven: resolved.capability.support === "yes",
  });
  process.exitCode = result.exitCode;
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
    .description(
      "A cross-platform AI CLI assistant with ask, agent, and plan modes. Built by Aniket Pandey, pentoshi007 on GitHub.",
    )
    .version(getCurrentVersion())
    .addOption(modeOption())
    .option("--provider <provider>", "LLM provider to use")
    .option("--model <model>", "model to use")
    .option("-y, --yes", "auto-confirm tool execution for one-shot agent mode")
    .option(
      "--no-history",
      "do not persist this session to history (in-memory only)",
    )
    .option(
      "--show-thinking",
      "print reasoning to stderr (or set CLAI_SHOW_THINKING=1)",
    )
    .option("--verbose", "show expanded tool output and diff hunks")
    .option("--quiet", "write only the final answer to stdout")
    .option("--tui", "launch OpenTUI; ignored when a prompt is supplied")
    .option("--classic", "launch classic UI; ignored when a prompt is supplied")
    .addOption(
      new Option(
        "--ui <mode>",
        "interactive frontend: tui (OpenTUI) or classic. v2/opentui alias tui; legacy/ink alias classic; ignored when a prompt is supplied",
      ).choices([...UI_FLAG_CHOICES]),
    )
    .argument("[prompt...]", "one-shot prompt")
    .action(
      async (promptParts: string[] | undefined, options: GlobalOptions) => {
        await oneShot(promptParts, options);
      },
    );

  program
    .command("config")
    .description("print, set, or get configuration settings")
    .argument("[key]", "config key to get, or 'set' action")
    .argument("[value]", "config value to set, or key if first arg is 'set'")
    .argument("[value2]", "value if using 'config set key value'")
    .action(
      (
        key: string | undefined,
        value: string | undefined,
        value2: string | undefined,
      ) => {
        const current = getConfig();
        if (!key) {
          console.log(`Config path: ${getConfigPath()}`);
          console.log(JSON.stringify(current, null, 2));
          return;
        }

        let targetKey: string | undefined;
        let targetValue: string | undefined;
        let isSet = false;

        if (key === "set") {
          targetKey = value;
          targetValue = value2;
          isSet = true;
        } else if (key === "get") {
          targetKey = value;
          isSet = false;
        } else if (value !== undefined) {
          targetKey = key;
          targetValue = value;
          isSet = true;
        } else {
          targetKey = key;
          isSet = false;
        }

        if (!targetKey) {
          console.error(chalk.red("  ✗ Missing configuration key"));
          process.exit(1);
        }

        if (!(targetKey in current)) {
          console.error(
            chalk.red(`  ✗ Unknown configuration key: ${targetKey}`),
          );
          console.error(`  Available keys: ${Object.keys(current).join(", ")}`);
          process.exit(1);
        }

        if (isSet) {
          if (targetValue === undefined) {
            console.error(chalk.red("  ✗ Missing value for key: " + targetKey));
            process.exit(1);
          }
          let typedValue: any = targetValue;
          const currentType = typeof (current as any)[targetKey];
          if (currentType === "boolean") {
            typedValue =
              targetValue === "true" ||
              targetValue === "1" ||
              targetValue === "yes";
          } else if (currentType === "number") {
            typedValue = Number(targetValue);
            if (isNaN(typedValue)) {
              console.error(
                chalk.red(`  ✗ Value for ${targetKey} must be a number`),
              );
              process.exit(1);
            }
          }
          updateConfig({ [targetKey]: typedValue });
          console.log(chalk.green(`  ✓ Set ${targetKey} = ${typedValue}`));
        } else {
          console.log((getConfig() as any)[targetKey]);
        }
      },
    );

  program
    .command("set")
    .description("store or append an API key (multi-key) or endpoint URL")
    .argument("<provider>", "provider id")
    .argument("[apiKey]", "API key")
    .option("--from-env <envVar>", "import key from environment variable")
    .option("--stdin", "read key from stdin")
    .option(
      "--url <url>",
      "endpoint / base URL (Ollama, Modal, Lightning) — repeatable; last becomes active",
      (value: string, previous: string[] | undefined) => [
        ...(previous ?? []),
        value,
      ],
    )
    .option("--skip-ping", "save without pinging provider")
    .action(
      async (
        provider: string,
        apiKey: string | undefined,
        options: {
          fromEnv?: string | undefined;
          stdin?: boolean | undefined;
          url?: string | string[] | undefined;
          skipPing?: boolean | undefined;
        },
      ) => {
        await setProviderKey(provider, apiKey, options);
      },
    );

  program
    .command("unset")
    .description("remove all stored API keys for a provider")
    .argument("<provider>", "provider id")
    .option("--url", "remove the stored endpoint URLs instead of the keys")
    .action(async (provider: string, options: { url?: boolean | undefined }) => {
      await unsetProviderKey(provider, options);
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
      const { useSearchProvider } =
        await import("./commands/search-providers.js");
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
    .argument("<mode>", "ask, agent, or plan")
    .action((mode: string) => {
      if (mode !== "ask" && mode !== "agent" && mode !== "plan")
        throw new Error("Mode must be ask, agent, or plan");
      setDefaultMode(mode as Mode);
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
      const sessions = await listSessionSummaries();
      for (const session of sessions) {
        console.log(
          `${session.updatedAt} ${session.name ?? session.id} (${session.messageCount} messages) ${session.cwd}`,
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
    .description(
      "manage the default pentest engagement scope (authorized targets) inherited by new sessions; use /scope inside a session to scope that session only",
    );

  scopeCommand
    .command("show")
    .description("print the default engagement scope for new sessions")
    .action(async () => {
      const { loadScope, isScopeActive, getScopePath, resetScopeCache } =
        await import("./store/scope.js");
      resetScopeCache();
      const scope = await loadScope();
      if (!scope) {
        console.log("No default engagement scope configured.");
        console.log(`  expected at: ${getScopePath()}`);
        console.log("  sessions that ran /scope keep their own scope instead.");
        return;
      }
      console.log(JSON.stringify(scope, null, 2));
      console.log(
        isScopeActive(scope)
          ? "  status: active"
          : "  status: expired or empty",
      );
      console.log(
        "  applies to sessions that have not set their own scope with /scope.",
      );
    });

  scopeCommand
    .command("new")
    .description("create or replace the default engagement scope for new sessions")
    .requiredOption(
      "--targets <list>",
      "comma-separated authorized targets (domains, IPs, CIDRs)",
    )
    .option("--exclude <list>", "comma-separated excluded targets")
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
          ? (phases.filter(
              (
                phase,
              ): phase is
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
    .description(
      "set or show how many sessions to keep in history (0=unlimited)",
    )
    .argument("[limit]", "numeric limit")
    .action((limit?: string) => {
      if (limit === undefined) {
        console.log(
          `historyRetentionLimit=${getConfig().historyRetentionLimit || "unlimited"}`,
        );
        return;
      }
      const n = Math.max(0, Math.floor(Number(limit)));
      if (!Number.isFinite(n))
        throw new Error("limit must be a non-negative number");
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
    .description(
      "delete saved tool artifacts (~/.clai/outputs and per-session temp folders)",
    )
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
      const { clearAuditLogs, clearArtifacts } =
        await import("./store/logs.js");
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
  // Ensure errors are always visible, even on Windows where stdout may
  // buffer and the process exits before flushing.
  try {
    printError(error);
  } catch {
    // stderr write itself failed; last-resort diagnostic.
    try { process.stderr.write(`clai fatal: ${error}\n`); } catch { /* truly hopeless */ }
  }
  if (!process.exitCode) {
    process.exitCode = 1;
  }
});

// On Windows cmd.exe, Node/Bun can exit before stderr is flushed.
// Handle uncaught exceptions at the process level so the binary never
// "hangs then exits silently" — it always prints *something*.
process.on('uncaughtException', (err) => {
  try { process.stderr.write(`\nclai: uncaught error: ${err?.message ?? err}\n`); } catch { /* */ }
  process.exitCode = 1;
});
process.on('unhandledRejection', (reason) => {
  try { process.stderr.write(`\nclai: unhandled rejection: ${reason}\n`); } catch { /* */ }
  process.exitCode = 1;
});
