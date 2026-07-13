import { clearLine, cursorTo, emitKeypressEvents, moveCursor } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";

import type { ChatImage, ChatMessage, Mode, ProviderId, ReasoningEffort } from "./types.js";
import { confirm } from "@inquirer/prompts";
import { runAskStream, type AskActionRequired } from "./modes/ask.js";
import {
  runAgent,
  createSessionPolicy,
  type SessionPolicy,
} from "./modes/agent.js";
import { attachClassicRenderer } from "./agent/classic-renderer.js";
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
  listSessions,
  saveSession,
  upsertSession,
  clearAllHistory,
  getSession,
} from "./store/history.js";
import { assertProvider, defaultModels, getProviderInfoText } from "./llm/provider.js";
import { getProvider, providerAuth } from "./llm/router.js";
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
import {
  modelSupportsThinking,
  modelSupportsVision,
  preferredVisionModel,
} from "./llm/capabilities.js";
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
import { loadPlan, savePlan, deletePlan } from "./store/plan.js";
import { renderPlanDocument, renderPlanChecklist } from "./ui/plan-pane.js";
import { safeCwd, cwdIsBroken, recoverCwd } from "./os/cwd.js";
import {
  compactMessages,
  estimateMessagesTokens,
} from "./agent/context-manager.js";
import { isCtrlC, isCtrlO, isCtrlP, isCtrlT, isEscape } from "./ui/keys.js";
import {
  expandMentions,
  loadImageAttachments,
  imageAttachmentPaths,
} from "./ui/mentions.js";
import { imageOcr } from "./tools/image.js";
import {
  readPromptLine,
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

/**
 * Build an OCR text layer for attached images. Some providers/proxies accept
 * multimodal `image_url` parts but silently ignore the bytes upstream — the
 * model then hallucinates an answer from the filename ("Screenshot…AM.png" →
 * "a dark terminal"). To make image handling robust regardless of whether the
 * provider's vision actually fired, we OCR each attached image locally and
 * append the extracted text as supplementary grounding. Vision models still
 * get the real bytes for colors/layout/style; this only ADDS a safety net.
 *
 * Best-effort: if tesseract is missing or OCR yields nothing, returns "".
 */
async function buildImageOcrGrounding(
  line: string,
  baseDir: string,
): Promise<string> {
  const paths = imageAttachmentPaths(line, baseDir);
  if (paths.length === 0) return "";
  const sections: string[] = [];
  for (const path of paths) {
    try {
      const result = await imageOcr({ path });
      const text = result.output.trim();
      // tesseract emits noise/garbage on non-text images; only include a
      // section when there is a meaningful amount of recognized text.
      const meaningful = (text.match(/[A-Za-z0-9]/g) ?? []).length;
      if (result.ok && meaningful >= 8) {
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
let abortPressCount = 0;
let lastAbortPressAt = 0;
const ABORT_PRESS_DEDUP_MS = 40;
const FORCE_EXIT_AFTER_ABORT_PRESSES = 2;

class AbortRunError extends Error {
  constructor() {
    super("Aborted.");
    this.name = "AbortRunError";
  }
}

function resetAbortEscalation(): void {
  abortPressCount = 0;
  lastAbortPressAt = 0;
}

/**
 * Shared by raw input, readline keypresses, and SIGINT. A single terminal
 * Ctrl+C can produce both a raw `data` event and a `keypress` event, so dedupe
 * those notifications before counting presses. The raw-data path is the only
 * reliable fallback in some terminals and must retain the same force-exit
 * behavior as the normalized keypress path.
 */
function abortCurrentRun(): void {
  if (!currentAbortController) return;
  const now = Date.now();
  if (now - lastAbortPressAt < ABORT_PRESS_DEDUP_MS) return;
  lastAbortPressAt = now;
  abortPressCount += 1;
  currentAbortController.abort();
  if (abortPressCount >= FORCE_EXIT_AFTER_ABORT_PRESSES) {
    process.stdout.write(chalk.yellow("\n  ⏹ force-exiting…\n"));
    process.exit(130);
  }
  process.stdout.write(chalk.yellow("\n  ⏹ aborting…\n"));
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
    // Flush the live-display pipeline, but trust the returned text as the
    // authoritative answer (the live stream may briefly mirror a tool-call
    // preamble during ask-mode research rounds).
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
  resetAbortEscalation();
  const abortFromRawData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.includes("\x03") || text === "\x1b") {
      abortCurrentRun();
    }
  };

  currentAbortController = ac;
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  // readline's keypress normalization is not equally reliable in every
  // terminal (notably Windows PowerShell after raw-mode transitions). Watch
  // raw bytes as a fallback so Ctrl+C and a bare ESC can always abort a run.
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
    // Keep stdin raw/resumed for the next prompt. Toggling back to cooked mode
    // between a response and the following prompt can leave PowerShell waiting
    // for Enter before keypress events flow again.
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
      "\n\n  ESC abort  │  Ctrl+C clears input (twice to exit)  │  Ctrl+T toggle thinking  │  Ctrl+O opens tool output pager (q to close)",
    )
  );
}

/** Generic inline picker — renders a filterable list below the current cursor
 *  position and returns the selected value on Enter, or undefined on Escape.
 *  Supports: typing to filter, ↑/↓ to navigate, Tab to fill the filter with
 *  the highlighted item's value, Enter to confirm, Escape to cancel. */
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
    ? chalk.dim(`  ↑/↓ navigate · type to filter · Tab to fill · Enter to select · ESC to cancel`)
    : chalk.dim(`  ↑/↓ navigate · type to filter · Tab to fill · Enter to select · ESC to cancel`);

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
      chalk.cyan("/variants") +
      chalk.dim(" to pick an effort level or ") +
      chalk.cyan("/variants high") +
      chalk.dim(" to enable directly."),
  );
}

/**
 * Ask mode hit a task that needs actions it can't perform. Show the model's
 * (cleaned) explanation, then prompt the user to switch into agent mode and
 * run the task there. Returns the text to record as the assistant turn.
 */
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
  onMessages?: (msgs: ChatMessage[]) => void,
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
      onMessages,
    }),
  );
}

/**
 * Save or update the classic REPL's single history row for this run. The
 * first call creates a record and remembers its id on `state.historyId`;
 * every later call (a further /new flush, /history resume, or exit) updates
 * that same row instead of minting a fresh, unnamed duplicate.
 */
async function persistSession(
  state: {
    messages: ChatMessage[];
    historyId: string | undefined;
  },
  name?: string,
): Promise<void> {
  if (state.historyId) {
    await upsertSession(state.historyId, state.messages, name);
    return;
  }
  const record = await saveSession(state.messages, name);
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
        console.log(renderProviderSwitch(state.provider, picked));
        maybePrintThinkingTip(state.provider, picked);
      } else {
        // Name → set directly
        state.model = arg;
        setProviderModel(state.provider, arg);
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
    case "/variants":
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
            "  ↑/↓ navigate · Enter to select · ESC to cancel",
          ),
          pageSize: allEfforts.length,
        });

        if (!picked) {
          console.log(chalk.dim("  variants unchanged"));
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
      const validEfforts: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
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

      console.log(chalk.dim("  usage: /variants on|off|none|minimal|low|medium|high|xhigh"));
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
      state.messages.length = 0;
      state.resumedMessageCount = 0;
      state.historyId = undefined;
      console.log(chalk.dim("  ✦ fresh session started"));
      return true;
    }
    case "/history": {
      const sessions = await listSessions(50);
      if (sessions.length === 0) {
        console.log(chalk.dim("  no saved sessions"));
        return true;
      }

      // Derive a readable name from first user message if name is an auto-generated repl-<iso>
      const sessionLabel = (s: (typeof sessions)[0]): string => {
        let name = s.name ?? s.id;
        // If the name is an auto-generated "repl-..." fallback, derive from first user msg
        if (name.startsWith("repl-")) {
          const firstUser = s.messages.find((m) => m.role === "user");
          if (firstUser) {
            const preview = firstUser.content
              .slice(0, 60)
              .replace(/\n/g, " ")
              .trim();
            name = preview + (firstUser.content.length > 60 ? "…" : "");
          }
        }
        return name;
      };

      const items = sessions.map((s) => {
        const name = sessionLabel(s);
        const date = chalk.dim(s.createdAt.replace("T", " ").slice(0, 19));
        const msgs = chalk.dim(`(${s.messages.length} msgs)`);
        const label = `${date}  ${chalk.white(name)}  ${msgs}`;
        return { label, value: s.id, filterText: `${name} ${s.createdAt}` };
      });

      const selectedId = await pickInline({
        items,
        header: chalk.dim(
          `  ↑/↓ navigate · type to filter · Enter to resume · ESC to cancel`,
        ),
        pageSize: Math.min(15, items.length),
      });

      if (!selectedId) {
        console.log(chalk.dim("  cancelled"));
        return true;
      }

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

      // Replay messages
      console.log(chalk.dim(`\n  ── resuming session ──\n`));
      for (const msg of session.messages) {
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
      const record = await saveSession(state.messages, name);
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
      const plan = await loadPlan(state.session.sessionId).catch(
        () => undefined,
      );
      if (!plan) {
        console.log(
          chalk.dim(
            '  no plan yet — ask clai to plan a multi-step task (e.g. "build a react blog app")',
          ),
        );
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
      // Clear terminal, reset chat state, redraw banner — like a fresh start
      state.messages.length = 0;
      state.resumedMessageCount = 0;
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
    case "/permissions": {
      const arg = (args[0] ?? "").toLowerCase().trim();
      const current = getConfig().permissions ?? "default";
      const allPermissions = [
        { value: "default", label: "default", desc: "normal behavior (prompts for confirmation on mutating actions)" },
        { value: "allow-all", label: "allow-all", desc: "run everything without confirmation (except passwords)" }
      ] as const;

      if (!arg) {
        console.log(
          chalk.dim("  current permissions: ") + chalk.cyan(current)
        );

        const items = allPermissions.map((p) => {
          const isActive = p.value === current;
          const activeTag = isActive ? chalk.green(" (active)") : "";
          const label = `  ${chalk.cyan(p.label.padEnd(12))} ${chalk.dim(p.desc)}${activeTag}`;
          return { label, value: p.value, filterText: p.label };
        });

        const picked = await pickInline({
          items,
          header: chalk.dim(
            "  ↑/↓ navigate · Enter to select · ESC to cancel",
          ),
          pageSize: allPermissions.length,
        });

        if (!picked) {
          console.log(chalk.dim("  permissions unchanged"));
          return true;
        }

        updateConfig({ permissions: picked });
        console.log(chalk.dim(`  permissions → ${chalk.cyan(picked)}`));
        return true;
      }

      if (arg === "default" || arg === "normal") {
        updateConfig({ permissions: "default" });
        console.log(chalk.dim(`  permissions → ${chalk.cyan("default")}`));
        return true;
      }

      if (arg === "allow-all" || arg === "allowall" || arg === "all") {
        updateConfig({ permissions: "allow-all" });
        console.log(chalk.dim(`  permissions → ${chalk.cyan("allow-all")}`));
        return true;
      }

      console.log(chalk.dim("  usage: /permissions [default|allow-all]"));
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
  emitKeypressEvents(input);

  // Survive stray promise rejections (eg AbortError from a cancelled
  // SSE reader) without killing the REPL. Anything that ends up here
  // is a bug — log it dim and keep the prompt alive so the user
  // doesn't lose their session over a transient network hiccup.
  const handleUnhandledRejection = (reason: unknown): void => {
    if (isAbortLikeError(reason)) return; // expected during ESC/abort
    const message = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(
      chalk.dim(`\n  ⚠ background error suppressed: ${message}\n`),
    );
  };
  const handleUncaughtException = (error: unknown): void => {
    if (isAbortLikeError(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      chalk.dim(`\n  ⚠ uncaught error suppressed: ${message}\n`),
    );
  };
  process.on("unhandledRejection", handleUnhandledRejection);
  process.on("uncaughtException", handleUncaughtException);

  // ESC / Ctrl+C abort; Ctrl+T toggles hidden thinking
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
      // Never open the pager while the agent is actively running. The
      // pager takes over all keypress handling (isPagerActive() causes
      // the main handler to bail), which makes ESC / Ctrl+C abort
      // impossible. Only open when we're idle at the prompt.
      if (currentAbortController || !isReadingPrompt) {
        // Give the user something actionable instead of a silent no-op:
        // point at the live artifact file they can tail in another shell,
        // and remind them how to open it once the run finishes.
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
    if ((isEscape(key) || isCtrlC(key)) && currentAbortController) {
      abortCurrentRun();
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
  // Ctrl+C while streaming → abort. While idle at a prompt, the
  // readPromptLine handler clears the line on first press and exits on
  // second press within 1s; so SIGINT here only acts as a fallback for
  // the rare case where no prompt or stream is active.
  const handleSigint = (): void => {
    const now = Date.now();
    if (currentAbortController) {
      abortCurrentRun();
      return;
    }
    if (isReadingPrompt) {
      // readPromptLine's keypress handler owns the prompt-level Ctrl+C
      // semantics; do nothing here so the two paths never fight.
      return;
    }
    if (now - lastSigintAt < 1_000) {
      console.log();
      process.exit(0);
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
        chalk.cyan("/variants") +
        chalk.dim(" to pick an effort level or ") +
        chalk.cyan("/variants high") +
        chalk.dim(" to enable directly.\n"),
    );
  }

  // Non-blocking update check
  checkForUpdateSilent();

  try {
    while (true) {
      isReadingPrompt = true;
      const line = (
        await readPromptLine({
          history: promptHistory,
          onThinkingShortcut: handleThinkingShortcut,
          onOutputShortcut: handleOutputShortcut,
          onPlanShortcut: handlePlanShortcut,
        })
      ).trim();
      isReadingPrompt = false;
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
        if (plan.tasks.every((t) => t.state === "done")) {
          console.log(chalk.dim("  this plan is already complete ✓"));
          continue;
        }
        plan.status = "approved";
        await savePlan(plan).catch(() => undefined);
        state.session.planApproved.value = true;
        console.log(
          chalk.cyan("  ✦ plan approved — clai will now execute it\n"),
        );
        console.log(renderPlanChecklist(plan) + "\n");
        implementApproved = true;
        effectiveLine =
          "I approve the plan. Execute it now in STRICT ORDER. Task 1 (explore) is ALREADY COMPLETE from the planning phase — " +
          "do NOT re-list or re-read the directory. Start with the FIRST pending task that still needs implementation work. " +
          "For each task: call task.update {taskId, state:'in_progress'} → do the real work → VERIFY it succeeded → " +
          "call task.update {taskId, state:'done'}, then move to the NEXT task. " +
          "If a tool call FAILS, mark the task 'failed', fix the problem, and retry. Do NOT mark a task done when it failed. " +
          "Build the project for real with fs.writeMany (create all files in as few calls as possible). " +
          "Do NOT call web.search — you already know everything needed. " +
          "Run real commands (installs, servers, verification) — do not claim anything ran without a successful tool call.";
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

      let stateMessagesUpdated = false;
      const onMessages = (msgs: ChatMessage[]): void => {
        stateMessagesUpdated = true;
        state.messages = msgs;
      };

      try {
        clearThinking();
        resetAbortEscalation();
        let assistantContent = "";
        // Expand @file mentions and drag-and-dropped paths into real context.
        // The user-visible `line` stays readable in history; the model gets
        // the line plus an appended block of file contents / path notes.
        let requestModel = state.model;
        let visionCapable = modelSupportsVision(state.provider, requestModel);
        let expansion = expandMentions(effectiveLine, safeCwd(), visionCapable);
        const hasImageAttachment = expansion.attachments.some(
          (att) => att.kind === "image",
        );
        if (hasImageAttachment && !visionCapable) {
          const fallbackVisionModel = preferredVisionModel(
            state.provider,
            requestModel,
          );
          if (fallbackVisionModel && fallbackVisionModel !== requestModel) {
            const previousModel = requestModel;
            requestModel = fallbackVisionModel;
            visionCapable = true;
            expansion = expandMentions(effectiveLine, safeCwd(), true);
            console.log(
              chalk.dim("  ↳ vision model: ") +
                chalk.dim(
                  `${requestModel} (auto for image; ${previousModel} can't view images)`,
                ),
            );
          }
        }
        const images = visionCapable
          ? loadImageAttachments(effectiveLine, safeCwd())
          : [];
        const sentImagePaths = new Set(
          images.map((img) => img.path).filter((p): p is string => Boolean(p)),
        );
        // OCR grounding: extract text from any attached image locally and
        // append it. This is the safety net for the case the user hit — a
        // provider that accepts image bytes but silently ignores them, so the
        // model otherwise hallucinates from the filename. Cheap, best-effort,
        // and additive (vision models still get the real bytes).
        const ocrGrounding = hasImageAttachment
          ? await buildImageOcrGrounding(effectiveLine, safeCwd())
          : "";
        const contextParts = [expansion.contextBlock, ocrGrounding].filter(
          (part) => part.length > 0,
        );
        const modelInput =
          contextParts.length > 0
            ? `${effectiveLine}\n\n${contextParts.join("\n\n")}`
            : effectiveLine;
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
            onMessages,
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
            onEvent: classicRenderer.onEvent,
            onMessages,
          }),
        );
      }
      console.log();
      if (!stateMessagesUpdated) {
        const userHistoryMessage: ChatMessage = {
          role: "user",
          content: modelInput,
        };
        if (images.length > 0) userHistoryMessage.images = images;
        state.messages.push(userHistoryMessage, {
          role: "assistant",
          content: assistantContent,
        });
      }
    } catch (error) {
      if (error instanceof AbortRunError) {
        process.stdout.write(chalk.yellow("\n  ⏹ Aborted.\n"));
        await persistSession(state, line);
        continue;
      }
      // Still save the exchange so /history doesn't lose conversations
      // that hit transient errors (e.g. "requires root", network timeout).
      const errMsg = error instanceof Error ? error.message : String(error);
      if (!stateMessagesUpdated) {
        state.messages.push(
          { role: "user", content: line },
          { role: "assistant", content: `[error: ${errMsg}]` },
        );
      }
      console.error(chalk.red(errMsg));
      await persistSession(state, line);
    }
    }
  } finally {
    isReadingPrompt = false;
    input.off("keypress", handleKeypress);
    process.off("SIGINT", handleSigint);
    process.off("unhandledRejection", handleUnhandledRejection);
    process.off("uncaughtException", handleUncaughtException);
    if (siginfoRegistered) process.off(siginfo, handleThinkingShortcut);
    if (state.messages.length > state.resumedMessageCount) {
      // Honor `--no-history` and the persistent privateMode setting.
      // The session.allow set is already in-memory only; saveSession itself
      // also bails early when privateMode is on, but checking here keeps
      // intent obvious in the call site.
      if (!options.noHistory && !getConfig().privateMode) {
        await persistSession(state);
      }
    }
    if (input.isTTY) input.setRawMode(false);
    // Force exit so lingering handles (timers, watchers, bg jobs) don't
    // keep the process alive after the user chose to quit.
    process.exit(0);
  }
}
