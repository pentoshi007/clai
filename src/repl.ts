import { clearLine, cursorTo, emitKeypressEvents, moveCursor } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";

import type { ChatImage, ChatMessage, Mode, ProviderId, ReasoningEffort } from "./types.js";
import { confirm } from "@inquirer/prompts";
import { runAskStream, type AskActionRequired } from "./modes/ask.js";
import { resolveTurnInput, shouldRunImageOcr } from "./attachments/service.js";
import {
  runAgent,
  createSessionPolicy,
  type SessionPolicy,
} from "./modes/agent.js";
import { attachClassicRenderer } from "./agent/classic-renderer.js";
import { clearActiveProjectRoot } from "./agent/project-root.js";
import {
  providerSwitcher,
  printProviderKeys,
  setKeyPicker,
  setProviderKey,
  unsetKeyPicker,
  unsetProviderKey,
  useProvider,
} from "./commands/providers.js";
import {
  printSearchProviderKeys,
  useSearchProvider,
} from "./commands/search-providers.js";
import {
  getConfig,
  getProviderModel,
  setDefaultMode,
  setProviderModel,
  setThinking,
  updateConfig,
} from "./store/config.js";
import {
  listSessionSummaries,
  upsertSession,
  clearAllHistory,
  deleteSession,
  getSession,
} from "./store/history.js";
import { beginSessionWorkspace } from "./store/session-workspace.js";
import {
  assertProvider,
  defaultModels,
  getProviderInfoText,
  redactSecrets,
} from "./llm/provider.js";
import { getProvider, providerAuth } from "./llm/router.js";
import { clearTextOnlyModels } from "./llm/tool-protocol.js";
import { providerIds } from "./types.js";
import {
  runUpdate,
  checkForUpdateSilent,
  getCurrentVersion,
} from "./commands/update.js";
import {
  renderModeSwitch,
  renderProviderSwitch,
  PROMPT,
} from "./ui/banner.js";
import { renderIntroCard } from "./ui/intro-card.js";
import {
  clearThinking,
  createThinkingStreamParser,
  getLastThinking,
  rememberThinkingFromText,
  renderAllThinking,
  renderThinkingSummary,
  renderThinkingToggleMessage,
} from "./ui/thinking.js";
import { createMarkdownStreamWriter, renderMarkdown } from "./ui/markdown.js";
import { startThinkingSpinner } from "./ui/spinner.js";
import { modelSupportsThinking } from "./llm/capabilities.js";
import {
  clearViewports,
  getLastViewport,
  getViewport,
  isPagerActive,
  listViewports,
  openPager,
  openViewportPager,
  toggleViewport,
} from "./ui/output-pane.js";
import {
  loadPlan,
  mutatePlan,
  deletePlan,
  isPlanSuccessful,
} from "./store/plan.js";
import { renderPlanDocument, renderPlanChecklist } from "./ui/plan-pane.js";
import { safeCwd, cwdIsBroken, recoverCwd } from "./os/cwd.js";
import {
  compactMessages,
  estimateMessagesTokens,
} from "./agent/context-manager.js";
import { isCtrlC, isCtrlO, isCtrlP, isCtrlT, isEscape } from "./ui/keys.js";
import { imageAttachmentPaths } from "./ui/mentions.js";
import { meaningfulCharCount, runOcr } from "./tools/ocr.js";
import { jobManager } from "./tools/jobs.js";
import { interactiveSessionManager } from "./interactive-session/manager.js";
import {
  handleDraftPlanDecision,
  IMPLEMENT_DIRECTIVE,
} from "./agent/plan-decision.js";
import {
  readPromptLine,
  PROMPT_EXIT_INTENT,
  stripAnsi,
  isPrintableSequence,
  type KeypressKey,
} from "./repl/prompt-line.js";
import {
  slashCommands,
  knownModels,
  getKnownModels,
  looksLikeSlashCommand,
  getSlashCommandSuggestions,
  isKnownSlashCommand,
  slashCommandLabel,
  type SlashCommand,
} from "./repl/slash-commands.js";

// Re-exported so existing imports of these names from "./repl.js" keep
// working unchanged — the command catalogue, model lists, and the line
// editor now live in their own modules under "./repl/".
export {
  slashCommands,
  knownModels,
  getKnownModels,
  inferProviderForModel,
  looksLikeSlashCommand,
  getSlashCommandSuggestions,
  isKnownSlashCommand,
  type SlashCommand,
} from "./repl/slash-commands.js";
export {
  renderSlashCommandMenu,
  renderFileMentionMenu,
} from "./repl/prompt-line.js";

export interface ReplOptions {
  mode?: Mode | undefined;
  provider?: ProviderId | undefined;
  model?: string | undefined;
  noHistory?: boolean | undefined;
}

/** Reset process-global project routing and rotate/adopt classic session identity together. */
export function resetClassicSessionContext(
  state: { session: SessionPolicy },
  sessionId?: string,
  workspace?: { folderName?: string | undefined; code?: string | undefined },
): void {
  const previousSessionId = state.session.sessionId;
  if (!sessionId || sessionId !== previousSessionId) {
    void interactiveSessionManager
      .beginCloseOwner(previousSessionId, "conversation-teardown")
      .catch(() => undefined);
  }
  clearActiveProjectRoot();
  state.session = createSessionPolicy(sessionId);
  void interactiveSessionManager.activateOwner(state.session.sessionId).catch(() => undefined);
  // Isolate scratch + tool outputs per session (restore on history resume).
  beginSessionWorkspace(
    workspace?.folderName
      ? { folderName: workspace.folderName, code: workspace.code }
      : undefined,
  );
}

function splitCommand(line: string): string[] {
  return (
    line
      .match(/(?:[^\s"]+|"[^"]*")+/g)
      ?.map((part) => part.replace(/^"|"$/g, "")) ?? []
  );
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object") {
    const err = error as { name?: string; code?: string; message?: string };
    if (err.name === "AbortError") return true;
    if (err.code === "ABORT_ERR") return true;
    if (typeof err.message === "string" && /abort/i.test(err.message))
      return true;
  }
  return false;
}


async function buildImageOcrGrounding(
  line: string,
  baseDir: string,
): Promise<string> {
  const paths = imageAttachmentPaths(line, baseDir);
  if (paths.length === 0) return "";
  const sections: string[] = [];
  for (const path of paths) {
    try {
      const result = await runOcr({
        path,
        lang: "eng",
        psmCandidates: [6, 3, 11],
        timeoutMs: 60_000,
      });
      const text = result.text.trim();
      if (result.ok && result.reliable && meaningfulCharCount(text) >= 8) {
        sections.push(
          `----- OCR of ${path} -----\n${text}\n----- end OCR -----`,
        );
      }
    } catch {
      // tesseract missing or failed — skip silently; vision bytes still sent.
    }
  }
  if (sections.length === 0) return "";
  return (
    '<image-ocr note="Text extracted locally from the attached image(s) via OCR, in case the model cannot see the image bytes directly. Use it to ground your answer; if you CAN see the image, prefer your own visual reading and use this only to confirm text.">\n' +
    sections.join("\n\n") +
    "\n</image-ocr>"
  );
}

// Abort controller for streaming cancellation
let currentAbortController: AbortController | null = null;

class AbortRunError extends Error {
  constructor() {
    super("Aborted.");
    this.name = "AbortRunError";
  }
}

// Build a concise, width-bounded spinner label for ask-mode research so the
// user sees what's being searched/fetched without the line overflowing.
function askResearchLabel(name: string, argsDisplay: string): string {
  const verb =
    name === "web.search"
      ? "searching the web"
      : name === "web.fetch"
        ? "fetching"
        : name === "tool.batch"
          ? "researching"
          : name === "fs.read"
            ? "reading"
            : name === "fs.list"
              ? "listing"
              : name === "fs.search"
                ? "searching files"
                : name;
  const detail = argsDisplay.trim().replace(/\s+/g, " ");
  const full = detail ? `${verb}: ${detail}` : verb;
  // Leave room for the spinner frame, elapsed time, and padding so the head
  // line never wraps. Columns can be undefined on non-TTY; default to 80.
  const cols = Math.max(40, process.stdout.columns ?? 80);
  const max = Math.max(20, cols - 18);
  return full.length > max ? `${full.slice(0, max - 1)}…` : full;
}

// Stream a response while hiding <think> blocks and handling ESC abort
async function streamWithAbort(
  run: (
    signal: AbortSignal,
    onToken: (t: string) => void,
    setStatus: (label: string) => void,
  ) => Promise<string>,
  signal: AbortSignal,
): Promise<string> {
  let sawToken = false;
  const spinner = startThinkingSpinner("waiting for model", signal);
  // Lets the run function surface progress (e.g. ask-mode research activity)
  // on the spinner's label line. Ignored once visible tokens have started
  // since the spinner is stopped at that point.
  const setStatus = (label: string): void => {
    if (!sawToken && label) spinner.setLabel(label);
  };
  const markdown = createMarkdownStreamWriter((chunk) =>
    process.stdout.write(chunk),
  );
  const parser = createThinkingStreamParser(
    (text) => {
      // Visible content arriving — drop the spinner so output isn't stomped on.
      spinner.stop();
      markdown.push(text);
    },
    (reasoning) => {
      // Reasoning tokens are hidden by default; show progress so users see
      // something is happening even when the model spends a minute thinking.
      spinner.setLabel("thinking");
      spinner.pushPreview(reasoning);
      const approx = reasoning.split(/\s+/).filter(Boolean).length;
      if (approx > 0) spinner.bumpReasoning(approx);
    },
  );

  const onToken = (token: string): void => {
    if (!sawToken) {
      // First raw token from the provider — still hold the spinner if it
      // turns out to be a reasoning token; the parser's callbacks above
      // decide which label to show.
      sawToken = true;
    }
    parser.push(token);
  };

  try {
    const raw = await run(signal, onToken, setStatus);
    spinner.stop();

    parser.finish();
    const result = rememberThinkingFromText(raw);
    if (sawToken) {
      markdown.finish();
    } else if (result.visible) {
      process.stdout.write(renderMarkdown(result.visible));
    }
    if (result.hasThinking) {
      const prefix =
        result.visible && !result.visible.endsWith("\n") ? "\n" : "";
      process.stdout.write(
        `${prefix}${renderThinkingSummary(result.thinkContent)}\n`,
      );
    }
    return result.visible;
  } catch (err) {
    const result = parser.finish();
    if (sawToken) markdown.finish();
    if (signal.aborted) {
      spinner.stop();
      process.stdout.write(chalk.yellow("\n  ⏹ Aborted.\n"));
      return result.visible;
    }
    throw err;
  } finally {
    // Belt and braces: spinner already self-stops on abort, but make sure
    // any other exit path (success, network error) clears it too.
    spinner.stop();
  }
}

async function withAbortableInput<T>(
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  const abortFromRawData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.includes("\x03")) ac.abort();
  };

  currentAbortController = ac;
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  // Raw Ctrl+C fallback for terminals whose keypress normalization is
  // unreliable. Escape is handled by the REPL keypress double-press gate.
  input.on("data", abortFromRawData);
  try {
    return await run(ac.signal);
  } catch (error) {
    if (
      ac.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw new AbortRunError();
    }
    throw error;
  } finally {
    input.off("data", abortFromRawData);
    currentAbortController = null;

    if (input.isTTY) input.setRawMode(true);
    input.resume();
  }
}

function help(): string {
  const maxCmd = Math.max(
    ...slashCommands.map((command) => slashCommandLabel(command).length),
  );
  const lines = slashCommands
    .map((command) => {
      const label = slashCommandLabel(command).padEnd(maxCmd + 2);
      return `  ${chalk.cyan(label)}${chalk.dim(command.description)}`;
    })
    .join("\n");
  return (
    lines +
    chalk.dim(
      "\n\n  ESC twice cancels turn + jobs  │  Ctrl+C clears input (twice to exit)  │  Ctrl+T toggle thinking  │  Ctrl+O opens tool output pager (q to close)",
    )
  );
}


async function pickInline<T>(options: {
  items: { label: string; value: T; filterText: string }[];
  header?: string;
  pageSize?: number;
}): Promise<T | undefined> {
  const { items, header, pageSize = 15 } = options;
  if (items.length === 0) return undefined;

  return new Promise((resolve) => {
    let filter = "";
    let filterCursor = 0;
    let selectedIndex = 0;
    let renderedLines = 0;

    const promptLabel = chalk.dim("  filter: ");
    const promptLabelLen = stripAnsi(promptLabel).length;

    const getFiltered = () => {
      const needle = filter.trim().toLowerCase();
      if (!needle) return items;
      return items.filter((item) =>
        item.filterText.toLowerCase().includes(needle),
      );
    };

    const renderMenu = (): void => {
      const filtered = getFiltered();
      if (selectedIndex >= filtered.length)
        selectedIndex = Math.max(0, filtered.length - 1);

      const cols = process.stdout.columns || 80;

      // Scroll the visible window so the selected item is always shown
      let start = 0;
      if (filtered.length > pageSize) {
        start = Math.max(0, selectedIndex - Math.floor(pageSize / 2));
        start = Math.min(start, filtered.length - pageSize);
      }
      const visible = filtered.slice(start, start + pageSize);
      const lines: string[] = [];

      for (let i = 0; i < visible.length; i++) {
        const marker =
          start + i === selectedIndex ? chalk.magenta("›") : " ";
        let full = `  ${marker} ${visible[i]!.label}`;
        const stripped = stripAnsi(full);
        if (stripped.length > cols - 1) {
          full = full.slice(0, cols - 1) + chalk.dim("…");
        }
        lines.push(full);
      }
      if (filtered.length > pageSize) {
        const prefix = start > 0 ? `… ${start} above · ` : "";
        const suffix =
          start + pageSize < filtered.length
            ? ` · ${filtered.length - start - pageSize} below`
            : "";
        lines.push(chalk.dim(`    ${prefix}${visible.length} shown${suffix}`));
      }
      if (filtered.length === 0) {
        lines.push(chalk.dim("    no matches"));
      }

      // Clear old menu
      const toClear = Math.max(renderedLines, lines.length + 1); // +1 for filter line
      cursorTo(output, 0);
      clearLine(output, 0);
      output.write(`${promptLabel}${filter}`);

      if (toClear > 0) {
        // Reserve space
        if (renderedLines === 0 && lines.length > 0) {
          output.write("\n".repeat(lines.length));
          moveCursor(output, 0, -lines.length);
        }
        for (let i = 0; i < toClear; i++) {
          output.write("\x1b[B");
          cursorTo(output, 0);
          clearLine(output, 0);
          if (i < lines.length) output.write(lines[i]!);
        }
        moveCursor(output, 0, -toClear);
      }

      cursorTo(output, promptLabelLen + filterCursor);
      renderedLines = lines.length;
    };

    const cleanup = (): void => {
      input.off("keypress", handleKeypress);
      // Clear menu from screen
      cursorTo(output, 0);
      clearLine(output, 0);
      for (let i = 0; i < renderedLines; i++) {
        output.write("\x1b[B");
        cursorTo(output, 0);
        clearLine(output, 0);
      }
      if (renderedLines > 0) moveCursor(output, 0, -renderedLines);
      renderedLines = 0;
      // Restore terminal state to what readPromptLine expects:
      // raw mode off, input paused.
      input.pause();
      if (input.isTTY) input.setRawMode(false);
      output.write("\n");
    };

    function handleKeypress(sequence: string, key: KeypressKey): void {
      if (isPagerActive()) return;

      if (isCtrlC(key) || isEscape(key)) {
        cleanup();
        resolve(undefined);
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        const filtered = getFiltered();
        const picked = filtered[selectedIndex];
        cleanup();
        resolve(picked?.value);
        return;
      }

      if (key.name === "tab") {
        const filtered = getFiltered();
        const picked = filtered[selectedIndex];
        if (picked) {
          filter = picked.filterText;
          filterCursor = filter.length;
          selectedIndex = 0;
          renderMenu();
        }
        return;
      }

      if (key.name === "up") {
        const filtered = getFiltered();
        if (filtered.length > 0) {
          selectedIndex =
            (selectedIndex - 1 + filtered.length) % filtered.length;
          renderMenu();
        }
        return;
      }

      if (key.name === "down") {
        const filtered = getFiltered();
        if (filtered.length > 0) {
          selectedIndex = (selectedIndex + 1) % filtered.length;
          renderMenu();
        }
        return;
      }

      if (key.name === "backspace") {
        if (filterCursor > 0) {
          filter =
            filter.slice(0, filterCursor - 1) + filter.slice(filterCursor);
          filterCursor -= 1;
          selectedIndex = 0;
          renderMenu();
        }
        return;
      }

      if (key.name === "delete") {
        if (filterCursor < filter.length) {
          filter =
            filter.slice(0, filterCursor) + filter.slice(filterCursor + 1);
          selectedIndex = 0;
          renderMenu();
        }
        return;
      }

      if (key.name === "left") {
        if (filterCursor > 0) {
          filterCursor -= 1;
          renderMenu();
        }
        return;
      }

      if (key.name === "right") {
        if (filterCursor < filter.length) {
          filterCursor += 1;
          renderMenu();
        }
        return;
      }

      if (isPrintableSequence(sequence) && !key.ctrl && !key.meta) {
        filter =
          filter.slice(0, filterCursor) + sequence + filter.slice(filterCursor);
        filterCursor += sequence.length;
        selectedIndex = 0;
        renderMenu();
      }
    }

    if (header) {
      console.log(header);
    }
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.on("keypress", handleKeypress);
    renderMenu();
  });
}

async function pickModelInteractively(
  provider: ProviderId,
  currentModel: string,
): Promise<string | undefined> {
  let models: string[] = [];
  let fetchedDynamically = false;
  const def = defaultModels[provider] ?? "";

  const providerImpl = getProvider(provider);
  if (providerImpl.listModels) {
    try {
      const auth = await providerAuth(provider);
      models = await providerImpl.listModels(auth);
      fetchedDynamically = models.length > 0;
    } catch (error) {
      console.warn(
        chalk.yellow(
          `  Warning: Could not fetch models from ${provider}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  if (models.length === 0) {
    models = knownModels[provider] ?? [];
    if (models.length > 0 && providerImpl.listModels) {
      console.warn(
        chalk.yellow(
          `  Warning: ${provider} model list could not be refreshed; showing known models.`,
        ),
      );
    }
  }

  if (models.length === 0) {
    console.log(
      chalk.dim(
        "  No known models for this provider. Type /model <name> to set manually.",
      ),
    );
    return undefined;
  }

  const header = fetchedDynamically
    ? chalk.dim(`  ↑↓:navigate  ·  type:filter  ·  tab:fill  ·  enter:select  ·  esc:cancel`)
    : chalk.dim(`  ↑↓:navigate  ·  type:filter  ·  tab:fill  ·  enter:select  ·  esc:cancel`);

  const items = models.map((model, index) => {
    const tags: string[] = [];
    if (model === currentModel) tags.push(chalk.green("active"));
    if (model === def) tags.push(chalk.yellow("default"));
    const suffix = tags.length > 0 ? `  ${chalk.dim(tags.join(" · "))}` : "";
    const label = `${chalk.dim(`${(index + 1).toString().padStart(2)}.`)} ${model}${suffix}`;
    return { label, value: model, filterText: model };
  });

  return pickInline({
    items,
    header,
    pageSize: Math.min(15, models.length),
  });
}

async function showModelList(provider: string, currentModel: string): Promise<void> {
  let models: string[] = [];
  let fetchedDynamically = false;
  const def = defaultModels[provider as ProviderId] ?? "";

  const providerImpl = getProvider(provider as ProviderId);
  if (providerImpl.listModels) {
    try {
      const auth = await providerAuth(provider as ProviderId);
      models = await providerImpl.listModels(auth);
      fetchedDynamically = models.length > 0;
    } catch {
      // Silently fall back to empty array on error
    }
  }

  if (models.length === 0) {
    models = knownModels[provider] ?? [];
    if (models.length > 0 && providerImpl.listModels) {
      console.warn(
        chalk.yellow(
          `  Warning: ${provider} model list could not be refreshed; showing known models.`,
        ),
      );
    }
  }

  if (models.length === 0) {
    console.log(
      chalk.dim(
        "  No known models for this provider. Type /model <name> to set manually.",
      ),
    );
    return;
  }
  const sourceSuffix = fetchedDynamically
    ? chalk.dim(" (fetched live)")
    : chalk.dim(" (known models)");
  console.log(chalk.dim(`  Available models for ${chalk.cyan(provider)}:${sourceSuffix}`));
  models.forEach((m, i) => {
    const tags: string[] = [];
    if (m === currentModel) tags.push("active");
    if (m === def) tags.push("default");
    const tag = tags.length > 0 ? chalk.dim(`  (${tags.join(" · ")})`) : "";
    console.log(`  ${chalk.dim(`${i + 1}.`)} ${chalk.white(m)}${tag}`);
  });
  console.log(chalk.dim("  Use /model <name> or /model <#> to select."));
}

function maybePrintThinkingTip(provider: ProviderId, model: string): void {
  if (getConfig().thinking.enabled) return;
  if (!modelSupportsThinking(provider, model)) return;
  console.log(
    chalk.dim("  💡 ") +
      chalk.dim(`${model} supports reasoning. Run `) +
      chalk.cyan("/effort") +
      chalk.dim(" to pick an effort level or ") +
      chalk.cyan("/effort high") +
      chalk.dim(" to enable directly."),
  );
}


async function offerAgentSwitch(
  info: AskActionRequired,
  state: {
    mode: Mode;
    provider: ProviderId;
    model: string;
    messages: ChatMessage[];
    session: SessionPolicy;
  },
  requestModel: string,
  images: ChatImage[],
): Promise<string> {
  if (info.preamble) {
    process.stdout.write(`${renderMarkdown(info.preamble)}\n`);
  }
  const toolsNote =
    info.tools.length > 0 ? ` (${info.tools.join(", ")})` : "";
  console.log(
    chalk.yellow(
      `  This needs to take actions${toolsNote}, which ask mode can't do — it's read-only.`,
    ),
  );

  // inquirer expects cooked mode; mirror the slash-command path so the
  // prompt reads cleanly, then restore raw mode for the next run/prompt.
  input.pause();
  if (input.isTTY) input.setRawMode(false);
  let switchNow = false;
  try {
    switchNow = await confirm({
      message: chalk.yellow("switch to agent mode and run it?"),
      default: true,
    });
  } catch {
    // Treat an aborted/failed prompt as "no".
    switchNow = false;
  } finally {
    if (input.isTTY) input.setRawMode(true);
    input.resume();
  }

  if (!switchNow) {
    console.log(chalk.dim("  Staying in ask mode."));
    return "Staying in ask mode; the task wasn't run. Use /agent to run tasks that take actions.";
  }

  state.mode = "agent";
  setDefaultMode("agent");
  console.log(renderModeSwitch("agent"));

  const classicRenderer = attachClassicRenderer();
  return withAbortableInput(async (signal) =>
    runAgent(info.prompt, {
      provider: state.provider,
      model: requestModel,
      history: state.messages,
      signal,
      session: state.session,
      images,
      onEvent: classicRenderer.onEvent,
    }),
  );
}


async function persistSession(
  state: {
    messages: ChatMessage[];
    historyId: string | undefined;
    session: SessionPolicy;
  },
  name?: string,
): Promise<void> {
  const id = state.historyId ?? state.session.sessionId;
  const record = await upsertSession(id, state.messages, name);
  state.historyId = record.id;
}

async function handleSlash(
  line: string,
  state: {
    mode: Mode;
    provider: ProviderId;
    model: string;
    messages: ChatMessage[];
    session: SessionPolicy;
    resumedMessageCount: number;
    historyId: string | undefined;
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
        // No arg → interactive picker (up/down, Enter to select)
        const picked = await pickModelInteractively(
          state.provider,
          state.model,
        );
        if (!picked) {
          console.log(chalk.dim("  model unchanged"));
          return true;
        }
        state.model = picked;
        setProviderModel(state.provider, picked);
        // Sticky text-only from a prior tools-unsupported 400 should not
        // permanently disable native tools after the user switches models.
        clearTextOnlyModels();
        console.log(renderProviderSwitch(state.provider, picked));
        maybePrintThinkingTip(state.provider, picked);
        return true;
      }
      if (arg === "list" || arg === "ls") {
        await showModelList(state.provider, state.model);
        return true;
      }
      // Numeric → pick from known list
      const num = parseInt(arg, 10);
      const models = knownModels[state.provider] ?? [];
      if (!isNaN(num) && num >= 1 && num <= models.length) {
        const picked = models[num - 1]!;
        state.model = picked;
        setProviderModel(state.provider, picked);
        clearTextOnlyModels();
        console.log(renderProviderSwitch(state.provider, picked));
        maybePrintThinkingTip(state.provider, picked);
      } else {
        // Name → set directly
        state.model = arg;
        setProviderModel(state.provider, arg);
        clearTextOnlyModels();
        console.log(renderProviderSwitch(state.provider, arg));
        maybePrintThinkingTip(state.provider, arg);
      }
      return true;
    }
    case "/provider":
    case "/use": {
      await providerSwitcher(args[0]);
      const config = getConfig();
      state.provider = config.defaultProvider;
      state.model = getProviderModel(state.provider);
      clearTextOnlyModels();
      console.log(renderProviderSwitch(state.provider, state.model));
      maybePrintThinkingTip(state.provider, state.model);
      return true;
    }
    case "/set": {
      await setKeyPicker(args[0], args[1]);
      return true;
    }
    case "/unset": {
      await unsetKeyPicker(args[0]);
      return true;
    }
    case "/keys":
      await printProviderKeys();
      return true;
    case "/info": {
      const providerVal = args.join(" ").trim().toLowerCase();
      let targetProvider: string = state.provider;
      if (providerVal) {
        try {
          targetProvider = assertProvider(providerVal);
        } catch {
          console.log(chalk.dim(`  unknown provider: ${providerVal}`));
          return true;
        }
      }
      const infoText = getProviderInfoText(targetProvider);
      console.log(infoText);
      return true;
    }
    case "/search":
    case "/search-provider":
      if (!args[0] || args[0] === "list" || args[0] === "ls") {
        await printSearchProviderKeys();
      } else {
        await useSearchProvider(args[0]);
      }
      return true;
    case "/effort":
    case "/reasoning": {
      const arg = (args[0] ?? "").toLowerCase().trim();
      const current = getConfig().thinking;
      const supported = modelSupportsThinking(state.provider, state.model);
      const allEfforts: { value: ReasoningEffort | "off"; label: string; desc: string }[] = [
        { value: "off",     label: "off",     desc: "disable thinking entirely" },
        { value: "none",    label: "none",    desc: "no reasoning tokens (fastest)" },
        { value: "minimal", label: "minimal", desc: "bare minimum reasoning" },
        { value: "low",     label: "low",     desc: "modest reasoning, optimized for speed" },
        { value: "medium",  label: "medium",  desc: "balanced quality and latency (default)" },
        { value: "high",    label: "high",    desc: "deep reasoning for complex tasks" },
        { value: "xhigh",   label: "xhigh",   desc: "maximum reasoning depth (highest latency)" },
        { value: "max",     label: "max",     desc: "highest supported reasoning depth for the model" },
      ];

      if (!arg) {
        // Show current status
        const status = current.enabled ? chalk.green("on") : chalk.dim("off");
        const support = supported
          ? chalk.green("supported")
          : chalk.yellow("not advertised by this model");
        console.log(
          chalk.dim("  thinking: ") +
            status +
            chalk.dim("  effort: ") +
            chalk.cyan(current.effort) +
            chalk.dim("  · ") +
            support,
        );

        // Interactive picker for effort levels
        const items = allEfforts.map((e) => {
          const isActive =
            (e.value === "off" && !current.enabled) ||
            (e.value !== "off" && current.enabled && current.effort === e.value);
          const activeTag = isActive ? chalk.green(" (active)") : "";
          const label = `  ${chalk.cyan(e.label.padEnd(8))} ${chalk.dim(e.desc)}${activeTag}`;
          return { label, value: e.value, filterText: e.label };
        });

        const picked = await pickInline({
          items,
          header: chalk.dim(
            "  ↑↓:navigate  ·  enter:select  ·  esc:cancel",
          ),
          pageSize: allEfforts.length,
        });

        if (!picked) {
          console.log(chalk.dim("  effort unchanged"));
          return true;
        }

        if (picked === "off") {
          setThinking({ enabled: false });
          console.log(chalk.dim(`  thinking: ${chalk.dim("off")}`));
        } else {
          setThinking({ enabled: true, effort: picked as ReasoningEffort });
          console.log(
            chalk.dim(
              `  thinking: ${chalk.green("on")}  effort: ${chalk.cyan(picked)}`,
            ),
          );
          if (!supported) {
            console.log(
              chalk.yellow("  note: current model may ignore the thinking flag."),
            );
          }
        }
        return true;
      }

      if (arg === "on" || arg === "enable" || arg === "true") {
        setThinking({ enabled: true });
        console.log(
          chalk.dim(
            `  thinking: ${chalk.green("on")} (effort=${getConfig().thinking.effort})`,
          ),
        );
        if (!supported) {
          console.log(
            chalk.yellow("  note: current model may ignore the thinking flag."),
          );
        }
        return true;
      }
      if (arg === "off" || arg === "disable" || arg === "false" || arg === "none") {
        setThinking({ enabled: false });
        console.log(chalk.dim(`  thinking: ${chalk.dim("off")}`));
        return true;
      }
      const validEfforts: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
      if (validEfforts.includes(arg as ReasoningEffort)) {
        setThinking({ enabled: true, effort: arg as ReasoningEffort });
        console.log(
          chalk.dim(
            `  thinking: ${chalk.green("on")}  effort: ${chalk.cyan(arg)}`,
          ),
        );
        if (!supported) {
          console.log(
            chalk.yellow("  note: current model may ignore the thinking flag."),
          );
        }
        return true;
      }

      console.log(chalk.dim("  usage: /effort on|off|none|minimal|low|medium|high|xhigh|max"));
      return true;
    }
    case "/clear":
      state.messages.length = 0;
      state.resumedMessageCount = 0;
      state.session.planApproved.value = false;
      console.log(chalk.dim("  context cleared"));
      return true;
    case "/new": {
      // Save the current session if it has new messages, then start fresh
      if (state.messages.length > state.resumedMessageCount) {
        if (!getConfig().privateMode) {
          await persistSession(state);
          console.log(chalk.dim("  current session saved"));
        }
      }
      resetClassicSessionContext(state);
      state.messages.length = 0;
      state.resumedMessageCount = 0;
      state.historyId = undefined;
      console.log(chalk.dim("  ✦ fresh session started"));
      return true;
    }
    case "/history": {
      if (args[0] && ["delete", "remove", "rm", "del"].includes(args[0].toLowerCase())) {
        const targetId = args[1]?.trim() ?? args.slice(1).join(" ").trim();
        if (!targetId) {
          console.log(chalk.dim("  usage: /history delete <session-id>"));
          return true;
        }
        const result = await deleteSession(targetId);
        console.log(result.deleted ? chalk.green(`  deleted ${targetId}`) : chalk.yellow(`  ${result.detail}`));
        return true;
      }
      const sessions = await listSessionSummaries(50, { recovery: "background" });
      if (sessions.length === 0) {
        console.log(chalk.dim("  no saved sessions"));
        return true;
      }

      const sessionLabel = (s: (typeof sessions)[0]): string =>
        s.name?.trim() || s.id;

      const items = sessions.map((s) => {
        const name = sessionLabel(s);
        const date = chalk.dim(s.createdAt.replace("T", " ").slice(0, 19));
        const msgs = chalk.dim(`(${s.messageCount} msgs)`);
        const label = `${date}  ${chalk.white(name)}  ${msgs}`;
        return { label, value: s.id, filterText: `${name} ${s.createdAt}` };
      });

      const selectedId = await pickInline({
        items,
        header: chalk.dim(
          `  ↑↓:navigate  ·  type:filter  ·  enter:resume  ·  esc:cancel`,
        ),
        pageSize: Math.min(15, items.length),
      });

      if (!selectedId) {
        console.log(chalk.dim("  cancelled"));
        return true;
      }

      clearActiveProjectRoot();

      // Load the selected session
      const session = await getSession(selectedId);
      if (!session) {
        console.log(chalk.red("  session not found"));
        return true;
      }

      // Save current session first if it has new messages
      if (state.messages.length > state.resumedMessageCount) {
        if (!getConfig().privateMode) {
          await persistSession(state);
        }
      }

      resetClassicSessionContext(state, session.id, {
        folderName: session.workspaceFolder,
        code: session.workspaceCode,
      });

      // Replay only a recent visual tail; the full path-backed model history is
      // installed below for an explicit continuation.
      console.log(chalk.dim(`\n  ── resuming session ──\n`));
      const displayMessages = session.messages
        .filter((message) =>
          message.role === "user" || message.role === "assistant",
        )
        .slice(-120);
      const omittedDisplay =
        session.messages.filter((message) =>
          message.role === "user" || message.role === "assistant",
        ).length - displayMessages.length;
      if (omittedDisplay > 0) {
        console.log(
          chalk.dim(
            `  … ${omittedDisplay} older messages omitted from initial display …\n`,
          ),
        );
      }
      for (const msg of displayMessages) {
        if (msg.role === "user") {
          console.log(`${PROMPT}${chalk.white(msg.content)}`);
        } else if (msg.role === "assistant") {
          process.stdout.write(renderMarkdown(msg.content));
          process.stdout.write("\n");
        }
      }
      console.log(chalk.dim(`  ── end of history · continue below ──\n`));

      // Load into state so the user can continue. Adopt the resumed record's
      // id so continuing the conversation updates that same row instead of
      // minting a new, unnamed duplicate on the next save/exit.
      state.messages.splice(0, state.messages.length, ...session.messages);
      state.resumedMessageCount = session.messages.length;
      state.historyId = session.id;
      return true;
    }
    case "/save": {
      const name = args.join(" ") || undefined;
      if (state.historyId) {
        await upsertSession(state.historyId, state.messages, name);
        console.log(chalk.dim(`  saved session ${state.historyId}`));
        return true;
      }
      const record = await upsertSession(state.session.sessionId, state.messages, name);
      state.historyId = record.id;
      console.log(chalk.dim(`  saved session ${record.id}`));
      return true;
    }
    case "/reset": {
      const result = await clearAllHistory();
      console.log(
        chalk.dim(`  all history cleared (${result.detail || "ok"})`),
      );
      return true;
    }
    case "/cwd": {
      const dir = args.join(" ");
      if (!dir) {
        if (cwdIsBroken()) {
          const recovered = recoverCwd();
          console.log(
            chalk.yellow(
              `  ⚠ the previous working directory no longer exists — moved to ${recovered}`,
            ),
          );
        } else {
          console.log(chalk.dim(`  ${safeCwd()}`));
        }
      } else {
        try {
          process.chdir(dir);
        } catch (error) {
          console.log(
            chalk.red(
              `  ✗ cannot change to ${dir}: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          return true;
        }
        const config = getConfig();
        updateConfig({
          sandboxRoots: Array.from(
            new Set([...config.sandboxRoots, safeCwd()]),
          ),
        });
        console.log(chalk.dim(`  cwd → ${safeCwd()}`));
      }
      return true;
    }
    case "/allow": {
      const tool = args[0];
      if (!tool) {
        console.log(chalk.dim("usage: /allow <tool>|list"));
        return true;
      }
      if (tool === "list" || tool === "ls") {
        if (state.session.allow.size === 0) {
          console.log(chalk.dim("  no session allows"));
        } else {
          for (const allowed of state.session.allow) {
            console.log(chalk.dim(`  ✓ ${allowed}`));
          }
        }
        return true;
      }
      state.session.allow.add(tool);
      console.log(chalk.dim(`  allowed ${tool} for this session only ✓`));
      return true;
    }
    case "/disallow": {
      const tool = args[0];
      if (!tool) {
        console.log(chalk.dim("usage: /disallow <tool>"));
        return true;
      }
      if (state.session.allow.delete(tool)) {
        console.log(chalk.dim(`  revoked ${tool} ✓`));
      } else {
        console.log(chalk.dim(`  ${tool} was not in the session allow list`));
      }
      return true;
    }
    case "/context": {
      const tokens = estimateMessagesTokens(state.messages);
      console.log(
        chalk.dim(
          `  ${state.messages.length} message(s), ~${tokens.toLocaleString()} tokens estimated`,
        ),
      );
      return true;
    }
    case "/plan": {
      const sub = (args[0] ?? "").toLowerCase();
      if (!sub || sub === "mode" || sub === "on" || sub === "enter") {
        state.mode = "plan";
        setDefaultMode("plan");
        console.log(renderModeSwitch("plan"));
        console.log(
          chalk.dim(
            "  plan mode on — describe the multi-step task you want to plan.\n",
          ),
        );
        return true;
      }
      if (sub === "off" || sub === "agent") {
        state.mode = "agent";
        setDefaultMode("agent");
        console.log(renderModeSwitch("agent"));
        return true;
      }
      if (sub === "view" || sub === "show") {
        const plan = await loadPlan(state.session.sessionId).catch(
          () => undefined,
        );
        if (!plan) {
          console.log(chalk.dim("  no active plan to view"));
          return true;
        }
        if (process.stdout.isTTY && input.isTTY) {
          await openPager({
            title: `plan · ${plan.goal}`,
            body: renderPlanDocument(plan),
          });
        } else {
          console.log(renderPlanDocument(plan));
        }
        return true;
      }
      console.log(chalk.dim("  usage: /plan [view|off]"));
      return true;
    }
    case "/discard": {
      const plan = await loadPlan(state.session.sessionId).catch(
        () => undefined,
      );
      if (!plan) {
        console.log(
          chalk.dim("  no active plan to discard"),
        );
        return true;
      }
      await deletePlan(state.session.sessionId).catch(() => undefined);
      state.session.planApproved.value = false;
      console.log(
        chalk.yellow(`  ✗ plan discarded — "${plan.goal}"`) +
          chalk.dim("\n  later messages are now independent of it.\n"),
      );
      return true;
    }
    case "/compact": {
      const before = state.messages.length;
      const compacted = compactMessages(state.messages, { budgetTokens: 0 });
      state.messages.splice(0, state.messages.length, ...compacted);
      console.log(
        chalk.dim(
          `  compacted ${before} → ${state.messages.length} messages (~${estimateMessagesTokens(state.messages).toLocaleString()} tokens)`,
        ),
      );
      return true;
    }
    case "/scope": {
      const sub = (args[0] ?? "show").toLowerCase();
      const {
        loadScope,
        saveScope,
        addScopeTargets,
        clearScope,
        isScopeActive,
        getScopePath,
        resetScopeCache,
      } = await import("./store/scope.js");
      if (sub === "show" || sub === "ls" || sub === "list") {
        resetScopeCache();
        const scope = await loadScope();
        if (!scope) {
          console.log(chalk.dim("  no engagement scope configured"));
          console.log(chalk.dim(`  expected at: ${getScopePath()}`));
          console.log(
            chalk.dim(
              "  create one with: /scope add domain1,domain2 or `clai scope add --targets ...`",
            ),
          );
          return true;
        }
        const status = isScopeActive(scope)
          ? chalk.green("active")
          : chalk.yellow("expired or empty");
        console.log(
          chalk.dim(`  scope: ${scope.name ?? "(unnamed)"} [${status}]`),
        );
        console.log(
          chalk.dim(`  authorized: ${scope.authorizedTargets.join(", ")}`),
        );
        if (scope.excludedTargets && scope.excludedTargets.length > 0) {
          console.log(
            chalk.dim(`  excluded:   ${scope.excludedTargets.join(", ")}`),
          );
        }
        if (scope.expiresAt) {
          console.log(chalk.dim(`  expires:    ${scope.expiresAt}`));
        }
        return true;
      }
      if (sub === "clear" || sub === "reset" || sub === "off") {
        await clearScope();
        console.log(chalk.dim("  engagement scope cleared"));
        return true;
      }
      if (sub === "add") {
        const rest = args.slice(1).join(" ").trim();
        if (!rest) {
          console.log(chalk.dim("  usage: /scope add <target1,target2,...>"));
          return true;
        }
        const targets = rest
          .split(/\s+/)[0]!
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        if (targets.length === 0) {
          console.log(chalk.dim("  no targets parsed"));
          return true;
        }
        const scope = await addScopeTargets(targets);
        console.log(
          chalk.dim(
            `  added ${targets.length} target(s); scope now has ${scope.authorizedTargets.length}`,
          ),
        );
        return true;
      }
      if (sub === "new" || sub === "set") {
        const rest = args.slice(1).join(" ").trim();
        if (!rest) {
          console.log(
            chalk.dim(
              "  usage: /scope new <target1,target2,...> [name=<engagement>] [expires=<iso>]",
            ),
          );
          return true;
        }
        // Parse: first whitespace-delimited token is the targets list,
        // remaining `key=value` pairs configure name/expires/note.
        const tokens = rest.split(/\s+/);
        const targetsRaw = tokens[0] ?? "";
        const targets = targetsRaw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        if (targets.length === 0) {
          console.log(chalk.dim("  no targets parsed"));
          return true;
        }
        let name: string | undefined;
        let expires: string | undefined;
        let note: string | undefined;
        let exclude: string[] | undefined;
        for (const token of tokens.slice(1)) {
          const eq = token.indexOf("=");
          if (eq < 0) continue;
          const key = token.slice(0, eq).toLowerCase();
          const value = token.slice(eq + 1);
          if (key === "name") name = value;
          else if (key === "expires") expires = value;
          else if (key === "note") note = value;
          else if (key === "exclude")
            exclude = value
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);
        }
        const scope = {
          name,
          authorizedTargets: targets,
          excludedTargets: exclude,
          authorizationNote: note,
          createdAt: new Date().toISOString(),
          expiresAt: expires,
        };
        await saveScope(scope);
        console.log(
          chalk.dim(
            `  saved scope${name ? ` "${name}"` : ""} with ${targets.length} target(s)`,
          ),
        );
        return true;
      }
      console.log(
        chalk.dim(
          "  usage: /scope [show|clear|new <targets>|add <targets> [key=value]...]",
        ),
      );
      return true;
    }
    case "/privacy": {
      const sub = (args[0] ?? "status").toLowerCase();
      if (sub === "on" || sub === "enable") {
        updateConfig({ privateMode: true });
        console.log(
          chalk.dim(
            "  privateMode: " +
              chalk.green("on") +
              "  (history not written; in-memory only)",
          ),
        );
        return true;
      }
      if (sub === "off" || sub === "disable") {
        updateConfig({ privateMode: false });
        console.log(chalk.dim("  privateMode: " + chalk.dim("off")));
        return true;
      }
      if (sub === "status" || sub === "show") {
        const cfg = getConfig();
        console.log(
          chalk.dim(
            `  privateMode: ${cfg.privateMode ? chalk.green("on") : chalk.dim("off")}  retention: ${cfg.historyRetentionLimit || "unlimited"}`,
          ),
        );
        return true;
      }
      const { clearAllHistory } = await import("./store/history.js");
      const { clearAuditLogs, clearArtifacts } =
        await import("./store/logs.js");
      if (sub === "clear-history") {
        const r = await clearAllHistory();
        console.log(chalk.dim(`  history cleared (${r.detail || "ok"})`));
        return true;
      }
      if (sub === "clear-logs") {
        const r = await clearAuditLogs();
        console.log(chalk.dim(`  audit logs cleared (${r.removed} files)`));
        return true;
      }
      if (sub === "clear-artifacts") {
        const r = await clearArtifacts();
        console.log(chalk.dim(`  artifacts cleared (${r.removed} files)`));
        return true;
      }
      if (sub === "clear-all") {
        const a = await clearAllHistory();
        const b = await clearAuditLogs();
        const c = await clearArtifacts();
        console.log(
          chalk.dim(
            `  history (${a.detail || "ok"}); logs (${b.removed}); artifacts (${c.removed})`,
          ),
        );
        return true;
      }
      console.log(
        chalk.dim(
          "  usage: /privacy [status|on|off|clear-history|clear-logs|clear-artifacts|clear-all]",
        ),
      );
      return true;
    }
    case "/freeonly": {
      const arg = (args[0] ?? "").toLowerCase().trim();
      if (!arg) {
        const value = getConfig().freeOnly;
        console.log(
          chalk.dim(
            `  freeOnly: ${value ? chalk.green("on") : chalk.dim("off")}  (applies when /fallback is on)`,
          ),
        );
        return true;
      }
      if (arg === "on" || arg === "true" || arg === "enable") {
        updateConfig({ freeOnly: true });
        console.log(chalk.dim("  freeOnly: " + chalk.green("on")));
        return true;
      }
      if (arg === "off" || arg === "false" || arg === "disable") {
        updateConfig({ freeOnly: false });
        console.log(chalk.dim("  freeOnly: " + chalk.dim("off")));
        return true;
      }
      console.log(chalk.dim("  usage: /freeonly [on|off]"));
      return true;
    }
    case "/fallback": {
      const arg = (args[0] ?? "").toLowerCase().trim();
      if (!arg) {
        const value = getConfig().providerFallback;
        console.log(
          chalk.dim(
            `  fallback: ${value ? chalk.green("on") : chalk.dim("off")}  (selected provider/model only when off)`,
          ),
        );
        return true;
      }
      if (arg === "on" || arg === "true" || arg === "enable") {
        updateConfig({ providerFallback: true });
        console.log(chalk.dim("  fallback: " + chalk.green("on")));
        return true;
      }
      if (arg === "off" || arg === "false" || arg === "disable") {
        updateConfig({ providerFallback: false });
        console.log(chalk.dim("  fallback: " + chalk.dim("off")));
        return true;
      }
      console.log(chalk.dim("  usage: /fallback [on|off]"));
      return true;
    }
    case "/output": {
      const target = args[0] ?? "last";
      if (target === "list" || target === "ls") {
        const all = listViewports();
        if (all.length === 0) {
          console.log(chalk.dim("  no tool outputs recorded yet"));
        } else {
          for (const v of all) {
            console.log(
              chalk.dim(
                `  ${v.id} — ${v.toolName} ${v.argsDisplay}${v.artifactPath ? ` (${v.artifactPath})` : ""}`,
              ),
            );
          }
        }
        return true;
      }
      const viewport =
        target === "last" ? getLastViewport() : getViewport(target);
      if (!viewport) {
        console.log(chalk.dim(`  no viewport: ${target}`));
        return true;
      }
      // On a TTY, open the alternate-screen pager so users can scroll long
      // outputs and close with q / Ctrl+O. In non-TTY contexts (piped or
      // CI), fall back to the inline toggle so the artifact still lands in
      // the captured stdout.
      if (process.stdout.isTTY) {
        await openViewportPager(viewport.id);
      } else {
        await toggleViewport(viewport.id);
      }
      return true;
    }
    case "/think":
    case "/thinking": {
      if (getLastThinking()) {
        console.log(renderAllThinking());
      } else {
        console.log(chalk.dim("  No thinking from last response."));
      }
      return true;
    }
    case "/exit":
    case "/quit":
      process.stdout.write(chalk.dim("  Goodbye!\n"));
      return false;
    case "/clean": {
      // A fresh session, not just a cleared screen: new identity, policy,
      // plan approval, allowances and scratch workspace.
      state.messages.length = 0;
      state.resumedMessageCount = 0;
      state.historyId = undefined;
      resetClassicSessionContext(state);
      clearViewports();
      clearThinking();
      // Clear the entire screen and move cursor to top
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
      // Re-render the startup intro card
      console.log(
        renderIntroCard({
          version: getCurrentVersion(),
          workdir: safeCwd(),
          model: state.model,
          provider: state.provider,
          mode: state.mode,
          permissions: getConfig().permissions ?? "default",
        }),
      );
      console.log();
      return true;
    }
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
  const provider = options.provider
    ? assertProvider(options.provider)
    : config.defaultProvider;
  // Bind a unique session workspace before any tool/scratch path is resolved.
  beginSessionWorkspace();
  const state = {
    mode: options.mode ?? config.defaultMode,
    provider,
    model: options.model ?? getProviderModel(provider),
    messages: [] as ChatMessage[],
    session: createSessionPolicy(),
    resumedMessageCount: 0,
    historyId: undefined as string | undefined,
  };

  const promptHistory: string[] = [];
  let isReadingPrompt = false;
  let outputShortcutBusy = false;
  let lastOutputShortcutAt = 0;
  let abortPressCount = 0;
  let lastEscapeAt = 0;

  emitKeypressEvents(input);

  // Only expected abort noise is tolerated. Anything else leaves the process
  // with unknown invariants, so it shuts down through the same boundary.
  const handleFatal = (kind: "rejection" | "exception", cause: unknown): void => {
    if (isAbortLikeError(cause)) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(
      chalk.red(`\n  ✖ fatal ${kind}: ${redactSecrets(message)}\n`),
    );
    void shutdown(1);
  };
  const handleUnhandledRejection = (reason: unknown): void =>
    handleFatal("rejection", reason);
  const handleUncaughtException = (error: unknown): void =>
    handleFatal("exception", error);
  process.on("unhandledRejection", handleUnhandledRejection);
  process.on("uncaughtException", handleUncaughtException);

  // Double Esc cancels the turn + jobs; Ctrl+C aborts; Ctrl+T toggles thinking
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  const handleThinkingShortcut = (): void => {
    process.stdout.write(`\n${renderThinkingToggleMessage()}\n`);
  };
  const handleOutputShortcut = async (): Promise<void> => {
    if (outputShortcutBusy) return;
    const now = Date.now();
    if (now - lastOutputShortcutAt < 400) return;
    lastOutputShortcutAt = now;
    outputShortcutBusy = true;
    try {
      const v = getLastViewport();
      if (!v) {
        process.stdout.write(chalk.dim("\n  (no tool output to expand yet)\n"));
        return;
      }

      if (currentAbortController || !isReadingPrompt) {

        if (v.artifactPath) {
          process.stdout.write(
            chalk.dim(
              `\n  ▸ ${v.toolName} output is streaming to:\n    ${v.artifactPath}\n` +
                `    (tail it in another terminal now, or press Ctrl+O here after it finishes)\n`,
            ),
          );
        } else {
          process.stdout.write(
            chalk.dim(
              `\n  (press Ctrl+O at the prompt after it finishes to open ${v.toolName})\n`,
            ),
          );
        }
        return;
      }
      // Idle path: open the full output in the alternate-screen pager.
      // Keys (q / ESC / Ctrl+O) inside the pager close it and return here.
      await openViewportPager(v.id);
    } finally {
      outputShortcutBusy = false;
    }
  };
  let planShortcutBusy = false;
  const handlePlanShortcut = async (): Promise<void> => {
    if (planShortcutBusy) return;
    planShortcutBusy = true;
    try {
      // Only open the pager when idle (same reasoning as Ctrl+O).
      if (currentAbortController || !isReadingPrompt) {
        process.stdout.write(
          chalk.dim(
            "\n  (press Ctrl+P at the prompt when idle to view the plan)\n",
          ),
        );
        return;
      }
      const plan = await loadPlan(state.session.sessionId).catch(
        () => undefined,
      );
      if (!plan) {
        process.stdout.write(
          chalk.dim(
            '\n  (no plan yet — ask clai to plan a multi-step task, e.g. "build a react blog app")\n',
          ),
        );
        return;
      }
      await openPager({
        title: `plan · ${plan.goal}`,
        body: renderPlanDocument(plan),
      });
    } finally {
      planShortcutBusy = false;
    }
  };
  const handleKeypress = (_sequence: string, key: KeypressKey): void => {
    if (isPagerActive()) return;
    if (isCtrlT(key) && !isReadingPrompt) handleThinkingShortcut();
    if (isCtrlO(key) && !isReadingPrompt) {
      void handleOutputShortcut();
    }
    if (isCtrlP(key) && !isReadingPrompt) {
      void handlePlanShortcut();
    }
    if (isEscape(key) && currentAbortController) {
      const now = Date.now();
      if (lastEscapeAt > 0 && now - lastEscapeAt < 1_500) {
        lastEscapeAt = 0;
        abortPressCount += 1;
        currentAbortController.abort();
        void jobManager.cancelAll(state.session.sessionId);
        void interactiveSessionManager.cancelOwner(state.session.sessionId);
        process.stdout.write(
          chalk.yellow("\n  ⏹ cancelling turn + session processes…\n"),
        );
      } else {
        lastEscapeAt = now;
        process.stdout.write(
          chalk.dim("\n  (press Esc again to cancel turn + session jobs)\n"),
        );
      }
    } else if (isCtrlC(key) && currentAbortController) {
      abortPressCount += 1;
      currentAbortController.abort();
      if (abortPressCount === 1) {
        process.stdout.write(chalk.yellow("\n  ⏹ aborting…\n"));
      } else {
        process.stdout.write(chalk.yellow("  ⏹ force-killing…\n"));
      }
    }
  };
  input.on("keypress", handleKeypress);
  const siginfo = "SIGINFO" as NodeJS.Signals;
  let siginfoRegistered = false;
  try {
    process.on(siginfo, handleThinkingShortcut);
    siginfoRegistered = true;
  } catch {
    // SIGINFO is macOS/BSD-specific; other platforms can still use /think.
  }
  let lastSigintAt = 0;
  let shuttingDown = false;

  /** One shutdown boundary for normal quit, signals and fatal errors. */
  const finalizeSession = async (): Promise<void> => {
    isReadingPrompt = false;
    input.off("keypress", handleKeypress);
    process.off("SIGINT", handleSigint);
    process.off("unhandledRejection", handleUnhandledRejection);
    process.off("uncaughtException", handleUncaughtException);
    if (siginfoRegistered) process.off(siginfo, handleThinkingShortcut);
    if (state.messages.length > state.resumedMessageCount) {
      // Honor `--no-history` and the persistent privateMode setting.
      if (!options.noHistory && !getConfig().privateMode) {
        await persistSession(state).catch(() => undefined);
      }
    }
    if (input.isTTY) input.setRawMode(false);
  };

  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const cleanup = await interactiveSessionManager
      .closeAll("app-shutdown")
      .catch(() => undefined);
    for (const failure of cleanup?.failures ?? []) {
      process.stderr.write(
        `clai interactive-session cleanup: [${failure.code}] ${failure.message}\n`,
      );
    }
    await finalizeSession();
    // Force exit so lingering handles (timers, watchers, bg jobs) don't keep
    // the process alive after the user chose to quit.
    process.exitCode = code;
    process.exit(code);
  };

  const handleSigint = (): void => {
    if (currentAbortController) {
      currentAbortController.abort();
      return;
    }
    if (isReadingPrompt) {
      // readPromptLine's keypress handler owns the prompt-level Ctrl+C
      // semantics; do nothing here so the two paths never fight.
      return;
    }
    const now = Date.now();
    if (now - lastSigintAt < 1_000) {
      console.log();
      void shutdown(0);
      return;
    }
    lastSigintAt = now;
    console.log(chalk.dim("\n  (press Ctrl+C again to exit)"));
  };
  process.on("SIGINT", handleSigint);

  // Startup intro card
  console.log(
    renderIntroCard({
      version: getCurrentVersion(),
      workdir: safeCwd(),
      model: state.model,
      provider: state.provider,
      mode: state.mode,
      permissions: getConfig().permissions ?? "default",
    }),
  );
  console.log();

  // Hint thinking-capable users that the toggle exists. We default it to
  // off for speed, since on NIM many models route through a much slower
  // chat-template path when reasoning is enabled.
  if (
    !getConfig().thinking.enabled &&
    modelSupportsThinking(state.provider, state.model)
  ) {
    console.log(
      chalk.dim("  💡 ") +
        chalk.dim(`${state.model} supports reasoning. Run `) +
        chalk.cyan("/effort") +
        chalk.dim(" to pick an effort level or ") +
        chalk.cyan("/effort high") +
        chalk.dim(" to enable directly.\n"),
    );
  }

  // Non-blocking update check
  checkForUpdateSilent();

  try {
    while (true) {
      isReadingPrompt = true;
      const rawLine = await readPromptLine({
        history: promptHistory,
        onThinkingShortcut: handleThinkingShortcut,
        onOutputShortcut: handleOutputShortcut,
        onPlanShortcut: handlePlanShortcut,
      });
      isReadingPrompt = false;
      if (rawLine === PROMPT_EXIT_INTENT) break;
      const line = rawLine.trim();
      if (!line) continue;

      // /implement — approve the active plan and execute it
      // Handled here (not in handleSlash) because it must trigger a full
      // agent run with the plan marked approved, not just print something.
      let implementApproved = false;
      let effectiveLine = line;
      if (line === "/implement" || line.startsWith("/implement ")) {
        const plan = await loadPlan(state.session.sessionId).catch(
          () => undefined,
        );
        if (!plan) {
          console.log(
            chalk.dim(
              "  no plan to implement — ask clai to plan a multi-step task first",
            ),
          );
          continue;
        }
        if (isPlanSuccessful(plan)) {
          console.log(chalk.dim("  this plan is already complete ✓"));
          continue;
        }
        plan.status = "approved";
        await mutatePlan(plan.sessionId, (draft) => {
          if (draft.status === "approved") return false;
          draft.status = "approved";
          return true;
        }).catch(() => undefined);
        state.session.planApproved.value = true;
        console.log(
          chalk.cyan("  ✦ plan approved — clai will now execute it\n"),
        );
        console.log(renderPlanChecklist(plan) + "\n");
        implementApproved = true;
        if (state.mode === "plan") {
          state.mode = "agent";
          setDefaultMode("agent");
          console.log(renderModeSwitch("agent"));
        }
        effectiveLine = IMPLEMENT_DIRECTIVE;
      }

      // Continuation detection
      // When the user types "continue" after the agent paused at a step limit,
      // augment the bare keyword with rich resumption context so the model
      // picks up from where it left off instead of restarting.
      const REPL_CONTINUE_RE =
        /^(?:continue|proceed|keep\s+going|go\s+on|resume|finish\s+it|next)$/i;
      if (
        REPL_CONTINUE_RE.test(line) &&
        !implementApproved &&
        state.messages.length > 0
      ) {
        const lastMsg = state.messages[state.messages.length - 1];
        if (
          lastMsg?.role === "assistant" &&
          /Session paused after \d+ steps/i.test(lastMsg.content)
        ) {
          effectiveLine =
            "Continue from where you left off. " +
            "The previous session summary is in your context — review it and resume the next pending task. " +
            "Do NOT repeat completed work. Do NOT re-fetch data you already have.";
        }
      }

      // Only remember real prompts in the history ring. Slash commands
      // are operational toggles (eg /model, /provider) and surfacing them
      // when the user presses ↑ to recall a past prompt is just noise.
      if (
        !looksLikeSlashCommand(line) &&
        promptHistory[promptHistory.length - 1] !== line
      ) {
        promptHistory.push(line);
      }
      if (looksLikeSlashCommand(line) && !implementApproved) {
        // Slash commands may call inquirer/password prompts, which expect the
        // terminal in cooked mode. Normal model runs keep raw mode enabled so
        // ESC/Ctrl+C can abort while streaming.
        input.pause();
        if (input.isTTY) input.setRawMode(false);
        const shouldContinue = await handleSlash(line, state);
        if (!shouldContinue) break;
        continue;
      }

      try {
        clearThinking();
        abortPressCount = 0;
        lastEscapeAt = 0;
        let assistantContent = "";
        // Expand @file mentions and drag-and-dropped paths into real context.
        // The user-visible `line` stays readable in history; the model gets
        // the line plus an appended block of file contents / path notes.
        const resolvedInput = resolveTurnInput({
          prompt: effectiveLine,
          mode: state.mode,
          provider: state.provider,
          model: state.model,
          baseDir: safeCwd(),
        });
        const requestModel = resolvedInput.model;
        const visionCapable = resolvedInput.capability.vision;
        const expansion = { attachments: resolvedInput.attachments };
        const images = [...resolvedInput.images];
        if (resolvedInput.fallbackReason) {
          console.log(chalk.dim(`  ↳ ${resolvedInput.fallbackReason}`));
        }
        for (const issue of resolvedInput.imageIssues) {
          console.log(chalk.yellow(`  ↳ ${issue}`));
        }
        const hasImageAttachment = expansion.attachments.some(
          (att) => att.kind === "image" && att.sendable !== false,
        );
        const sentImagePaths = new Set(
          images.map((img) => img.path).filter((p): p is string => Boolean(p)),
        );
        // Vision is authoritative for visual analysis. OCR is opt-in when the
        // selected model cannot see the image and the user specifically asks
        // for text extraction; it is never treated as layout/color evidence.
        const shouldOcr = shouldRunImageOcr({
          hasImage: hasImageAttachment,
          visionCapable,
          support: resolvedInput.capability.support,
          prompt: effectiveLine,
        });
        const ocrGrounding = shouldOcr
          ? await buildImageOcrGrounding(effectiveLine, safeCwd())
          : "";
        const modelInput = ocrGrounding
          ? `${resolvedInput.prompt}\n\n${ocrGrounding}`
          : resolvedInput.prompt;
        if (expansion.attachments.length > 0) {
          for (const att of expansion.attachments) {
            const tag =
              att.kind === "text"
                ? chalk.green("attached")
                : att.kind === "missing"
                  ? chalk.red("not found")
                  : att.kind === "image" && sentImagePaths.has(att.path)
                    ? chalk.green("image (sent to model)")
                    : att.kind === "image" && visionCapable
                      ? chalk.yellow("image (not sent)")
                      : chalk.yellow(att.kind);
            console.log(chalk.dim(`  ↳ ${tag}: `) + chalk.dim(att.path));
          }
        }
        if (state.mode === "ask") {
          let actionRequired: AskActionRequired | undefined;
          assistantContent = await withAbortableInput(async (signal) =>
            streamWithAbort(async (runSignal, onToken, setStatus) => {
              return await runAskStream(modelInput, onToken, {
                provider: state.provider,
                model: requestModel,
                history: state.messages,
                signal: runSignal,
                images,
                onActionRequired: (info) => {
                  actionRequired = info;
                },
                onEvent: (event) => {
                  if (event.type === "tool-call") {
                    setStatus(askResearchLabel(event.name, event.argsDisplay));
                  }
                },
              });
            }, signal),
          );
          process.stdout.write("\n");
          if (actionRequired) {
            // The task needs actions ask mode can't perform. Offer to switch
            // into agent mode and run it there. On confirm, state.mode flips
            // so subsequent turns stay in agent mode too.
            assistantContent = await offerAgentSwitch(
              actionRequired,
              state,
              requestModel,
              images,
            );
          }
        } else {
          const classicRenderer = attachClassicRenderer();
          assistantContent = await withAbortableInput(async (signal) =>
            runAgent(modelInput, {
              provider: state.provider,
              model: requestModel,
              history: state.messages,
              signal,
              session: state.session,
              images,
              visionProven: resolvedInput.capability.support === "yes",
              mode: state.mode === "plan" ? "plan" : "agent",
              onEvent: classicRenderer.onEvent,
            }),
          );
        }
        console.log();
        const userHistoryMessage: ChatMessage = {
          role: "user",
          content: modelInput,
        };
        if (images.length > 0) userHistoryMessage.images = images;
        state.messages.push(userHistoryMessage, {
          role: "assistant",
          content: assistantContent,
        });

        // After plan mode (or any draft plan), offer Accept / Discard / View / Suggest.
        if (state.mode === "plan" || !state.session.planApproved.value) {
          const draft = await loadPlan(state.session.sessionId).catch(
            () => undefined,
          );
          if (draft && draft.status === "draft") {
            input.pause();
            if (input.isTTY) input.setRawMode(false);
            try {
              const decision = await handleDraftPlanDecision({
                plan: draft,
                sessionId: state.session.sessionId,
                planApproved: state.session.planApproved,
                setModeAgent: () => {
                  state.mode = "agent";
                  setDefaultMode("agent");
                  console.log(renderModeSwitch("agent"));
                },
              });
              if (decision.action === "implement") {
                const classicRenderer = attachClassicRenderer();
                const followUp = await withAbortableInput(async (signal) =>
                  runAgent(decision.line, {
                    provider: state.provider,
                    model: requestModel,
                    history: state.messages,
                    signal,
                    session: state.session,
                    mode: "agent",
                    onEvent: classicRenderer.onEvent,
                  }),
                );
                console.log();
                state.messages.push(
                  { role: "user", content: decision.line },
                  { role: "assistant", content: followUp },
                );
              } else if (decision.action === "suggest") {
                state.mode = "plan";
                setDefaultMode("plan");
                const classicRenderer = attachClassicRenderer();
                const revision = await withAbortableInput(async (signal) =>
                  runAgent(decision.line, {
                    provider: state.provider,
                    model: requestModel,
                    history: state.messages,
                    signal,
                    session: state.session,
                    mode: "plan",
                    onEvent: classicRenderer.onEvent,
                  }),
                );
                console.log();
                state.messages.push(
                  { role: "user", content: decision.line },
                  { role: "assistant", content: revision },
                );
                // Re-prompt if a new draft exists
                const revised = await loadPlan(state.session.sessionId).catch(
                  () => undefined,
                );
                if (revised && revised.status === "draft") {
                  const again = await handleDraftPlanDecision({
                    plan: revised,
                    sessionId: state.session.sessionId,
                    planApproved: state.session.planApproved,
                    setModeAgent: () => {
                      state.mode = "agent";
                      setDefaultMode("agent");
                      console.log(renderModeSwitch("agent"));
                    },
                  });
                  if (again.action === "implement") {
                    const classicRenderer2 = attachClassicRenderer();
                    const followUp2 = await withAbortableInput(async (signal) =>
                      runAgent(again.line, {
                        provider: state.provider,
                        model: requestModel,
                        history: state.messages,
                        signal,
                        session: state.session,
                        mode: "agent",
                        onEvent: classicRenderer2.onEvent,
                      }),
                    );
                    console.log();
                    state.messages.push(
                      { role: "user", content: again.line },
                      { role: "assistant", content: followUp2 },
                    );
                  } else if (again.action === "suggest") {
                    // Leave feedback in chat; next turn continues plan mode
                    state.messages.push({
                      role: "user",
                      content: again.line,
                    });
                  }
                }
              }
            } finally {
              if (input.isTTY) input.setRawMode(true);
              input.resume();
            }
          }
        }
      } catch (error) {
        if (error instanceof AbortRunError) {
          process.stdout.write(chalk.yellow("\n  ⏹ Aborted.\n"));
          continue;
        }
        // Still save the exchange so /history doesn't lose conversations
        // that hit transient errors (e.g. "requires root", network timeout).
        const errMsg = error instanceof Error ? error.message : String(error);
        state.messages.push(
          { role: "user", content: line },
          { role: "assistant", content: `[error: ${errMsg}]` },
        );
        console.error(chalk.red(errMsg));
      }
    }
  } finally {
    await shutdown(0);
  }
}
