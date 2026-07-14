import { Box, Text, useApp, useInput, useStdin } from "ink";
import chalk from "chalk";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { Mode, ProviderId, ReasoningEffort } from "../types.js";
import { providerIds } from "../types.js";
import { assertProvider, getProviderInfoText } from "../llm/provider.js";
import { getProvider } from "../llm/router.js";
import {
  envValue,
  getProviderSecret,
  getSearchProviderKey,
  listProviderStatuses,
  maskSecret,
  setProviderSecret,
  setSecret,
  unsetProviderSecret,
} from "../store/keys.js";
import { setActiveSearchProvider } from "../store/config.js";
import {
  searchProviderIds,
  type SearchProviderId,
} from "../tools/web/types.js";
import {
  assertSearchProvider,
  searchProviders,
} from "../tools/web/providers/provider.js";
import "../tools/web/providers/duckduckgo.js";
import "../tools/web/providers/brave.js";
import "../tools/web/providers/tavily.js";
import {
  modelSupportsThinking,
  modelSupportsVision,
} from "../llm/capabilities.js";
import {
  getConfig,
  getProviderModel,
  setDefaultMode,
  setDefaultProvider,
  setProviderModel,
  setThinking,
  updateConfig,
} from "../store/config.js";
import { estimateMessagesTokens } from "../agent/context-manager.js";
import {
  clearAllHistory,
  getSession,
  listSessions,
  upsertSession,
} from "../store/history.js";
import { generateSessionTitle } from "../agent/session-title.js";
import { safeCwd } from "../os/cwd.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  expandMentions,
  findFileSuggestions,
  getMentionQuery,
  loadImageAttachments,
  type FileSuggestion,
} from "../ui/mentions.js";
import { deletePlan, loadPlan, savePlan } from "../store/plan.js";
import { renderPlanDocument } from "../ui/plan-pane.js";
import { visibleWidth } from "../ui/markdown.js";
import {
  getSlashCommandSuggestions,
  inferProviderForModel,
  isKnownSlashCommand,
  knownModels,
  slashCommands,
  type SlashCommand,
} from "../repl.js";
import {
  initialState,
  reducer,
  serializeTranscriptForCompaction,
  type ToolItem,
} from "./state.js";
import { renderTranscriptLines } from "./render-lines.js";
import { createTuiConfirmPort } from "./confirm.js";
import { useAgentRunner } from "./hooks/useAgentRunner.js";
import { useJobs } from "./hooks/useJobs.js";
import { useSpinner } from "./hooks/useSpinner.js";
import { useTerminalSize } from "./hooks/useTerminalSize.js";
import { ConfirmModal } from "./components/ConfirmModal.js";
import { Pager } from "./components/Pager.js";
import { JobsPanel } from "./components/JobsPanel.js";
import { PickerPanel, type PickerOption } from "./components/PickerPanel.js";
import { SecretInputPanel } from "./components/SecretInputPanel.js";
import { renderPlanSidebarLines } from "./plan-sidebar-lines.js";
import { clearArtifacts, clearAuditLogs } from "../store/logs.js";
import {
  addScopeTargets,
  clearScope,
  loadScope,
  saveScope,
} from "../store/scope.js";
import { formatKeyStatus } from "./format-keys.js";
import { shouldStoreInPromptHistory } from "./input-history.js";
import {
  DISABLE_MOUSE_REPORTING,
  ENABLE_MOUSE_REPORTING,
  isMouseReport,
  mouseWheelDirection,
  stripMouseReports,
} from "./mouse.js";
import {
  truncateMiddle,
  wrapPlainString,
  relativeTime,
  shortCwd,
} from "./text-format.js";
import { isComposerNewline, newlineHint } from "./key-intent.js";

export interface AppProps {
  version: string;
  initialMode: Mode;
  provider: ProviderId;
  initialModel: string;
  noHistory?: boolean | undefined;
}

const IMPLEMENT_PROMPT =
  "I approve the plan. Execute it now in STRICT ORDER. Task 1 (explore) is ALREADY COMPLETE from the planning phase — " +
  "do NOT re-list or re-read the directory. Start with the FIRST pending task that still needs implementation work. " +
  "For each task: call task.update {taskId, state:'in_progress'} → do the real work → VERIFY it succeeded → " +
  "call task.update {taskId, state:'done'}, then move to the NEXT task. " +
  "If a tool call FAILS, mark the task 'failed', fix the problem, and retry. Do NOT mark a task done when it failed. " +
  "Build the project for real with fs.writeMany (create all files in as few calls as possible). " +
  "Do NOT call web.search — you already know everything needed. " +
  "Run real commands (installs, servers, verification) — do not claim anything ran without a successful tool call.";

const MAX_FILE_SUGGESTIONS = 6;

type Overlay =
  | { kind: "none" }
  | { kind: "pager"; title: string; body: string }
  | { kind: "jobs" }
  | {
      kind: "picker";
      title: string;
      options: PickerOption[];
      searchDescription?: boolean | undefined;
      twoLine?: boolean | undefined;
      onSelect: (value: string) => void;
    };

function truncateAnsi(line: string, maxWidth: number): string {
  let visibleLen = 0;
  let result = "";
  let i = 0;
  while (i < line.length) {
    if (line.startsWith("\x1b[", i)) {
      let j = i + 2;
      while (j < line.length && !/[a-zA-Z]/.test(line[j]!)) {
        j++;
      }
      result += line.slice(i, j + 1);
      i = j + 1;
    } else {
      const codePoint = line.codePointAt(i)!;
      const charLength = codePoint > 0xffff ? 2 : 1;
      const char = line.slice(i, i + charLength);
      const w = Math.max(1, visibleWidth(char));
      if (visibleLen + w > maxWidth) {
        let k = i;
        while (k < line.length) {
          if (line.startsWith("\x1b[", k)) {
            let j = k + 2;
            while (j < line.length && !/[a-zA-Z]/.test(line[j]!)) {
              j++;
            }
            result += line.slice(k, j + 1);
            k = j + 1;
          } else {
            k++;
          }
        }
        break;
      }
      result += char;
      visibleLen += w;
      i += charLength;
    }
  }
  return result;
}

/** Pad an ANSI string to a visible width (measuring wide glyphs correctly). */
function padVisible(line: string, width: number): string {
  const w = visibleWidth(line);
  return w < width ? line + " ".repeat(width - w) : line;
}

export function App({
  version,
  initialMode,
  provider: initialProvider,
  initialModel,
  noHistory = false,
}: AppProps) {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { columns: cols, rows } = useTerminalSize();
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [provider, setProvider] = useState<ProviderId>(initialProvider);
  const [model, setModel] = useState<string>(initialModel);
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  const [secretRequest, setSecretRequest] = useState<
    { title: string; prompt: string } | undefined
  >();
  const secretResolver = useRef<
    ((value: string | undefined) => void) | undefined
  >();
  // Provider picker selection is asynchronous when a key is required. Keep
  // repeated Enter events (or a fast double-submit) from opening a second
  // secret prompt before the first activation has finished persisting.
  const providerActivationRef = useRef<ProviderId | undefined>(undefined);
  const exitRef = useRef<(() => void) | undefined>(undefined);
  const [scroll, setScroll] = useState(0); // lines scrolled up from bottom
  const [compacting, setCompacting] = useState(false);
  const [compactStartedAt, setCompactStartedAt] = useState<number | undefined>(undefined);
  const [mouseMode, setMouseMode] = useState(true);
  const [planPaneVisible, setPlanPaneVisible] = useState(true);
  const history = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const historyDraft = useRef("");
  const lastCtrlC = useRef(0);
  const lastDragTime = useRef(0);
  const isCtrlHPressed = useRef(false);
  const jobs = useJobs(overlay.kind === "jobs");
  const spinner = useSpinner(state.status.running || compacting);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const latestItems = useRef(state.items);
  latestItems.current = state.items;

  // Tracks model-generated session titles. `titledAtUserCount` records the
  // number of user turns the current title was generated from, so we can
  // refresh the title as the conversation grows past it without regenerating
  // on every single turn. Reset whenever a fresh session starts.
  const titleRef = useRef<{
    titledAtUserCount: number;
    inFlight: boolean;
    requestId: number;
  }>({
    titledAtUserCount: 0,
    inFlight: false,
    requestId: 0,
  });

  const compactAbortRef = useRef<AbortController | undefined>(undefined);
  const cancelCompaction = useCallback(() => {
    if (compactAbortRef.current) {
      compactAbortRef.current.abort();
      compactAbortRef.current = undefined;
    }
    setCompacting(false);
    setCompactStartedAt(undefined);
  }, []);

  useEffect(() => {
    if (!process.stdout.isTTY) return;
    process.stdout.write(
      mouseMode ? ENABLE_MOUSE_REPORTING : DISABLE_MOUSE_REPORTING,
    );
    return () => {
      process.stdout.write(DISABLE_MOUSE_REPORTING);
    };
  }, [mouseMode]);

  // Confirm port → in-app modal
  const confirmController = useMemo(() => createTuiConfirmPort(), []);
  const confirmResolver = useRef<((ok: boolean) => void) | undefined>(
    undefined,
  );
  useEffect(() => {
    confirmController.setHandler(
      (req) =>
        new Promise<boolean>((res) => {
          confirmResolver.current = res;
          dispatch({
            type: "event",
            event: { type: "confirm-request", id: "c", ...req },
          });
        }),
    );
  }, [confirmController]);

  const ctxRef = useRef({ mode, provider, model });
  ctxRef.current = { mode, provider, model };
  const requestSecret = useCallback(
    (request: { title: string; prompt: string }) =>
      new Promise<string | undefined>((resolveSecret) => {
        secretResolver.current = resolveSecret;
        setSecretRequest(request);
      }),
    [],
  );
  const runner = useAgentRunner({
    dispatchEvent: (event) => dispatch({ type: "event", event }),
    confirm: confirmController.port,
    getContext: useCallback(() => ctxRef.current, []),
    requestSecret,
    onSwitchToAgent: useCallback(() => {
      setMode("agent");
      setDefaultMode("agent");
      dispatch({ type: "notice", level: "info", text: "mode → agent" });
    }, []),
    onForceExit: useCallback(() => exitRef.current?.(), []),
  });

  const exitTui = useCallback(() => {
    cancelCompaction();
    runner.abort();
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = undefined;
    }
    const messages = runner.getMessages();
    if (!noHistory && !getConfig().privateMode && messages.length > 0) {
      // Shutdown must not wait for a slow history backend.
      void upsertSession(
        runner.getSession().sessionId,
        messages,
        undefined,
        latestItems.current,
      ).catch(() => undefined);
    }
    exit();
  }, [cancelCompaction, exit, noHistory, runner]);
  exitRef.current = exitTui;

  // Generate (and later refresh) a concise, model-written title for the
  // active session. Runs only when a real exchange exists, throttles by user
  // turn count, and guards against overlapping requests and session resets.
  const maybeUpdateTitle = useCallback(
    (sessionId: string) => {
      if (noHistory || getConfig().privateMode) return;
      if (titleRef.current.inFlight) return;
      const messages = runner.getMessages();
      const userCount = messages.filter((m) => m.role === "user").length;
      const hasAssistant = messages.some(
        (m) => m.role === "assistant" && m.content.trim().length > 0,
      );
      if (userCount === 0 || !hasAssistant) return;
      const titledAt = titleRef.current.titledAtUserCount;
      // Title on the first completed exchange, then refresh once two more
      // user turns have accumulated so the name tracks the evolving topic.
      const shouldGenerate = titledAt === 0 || userCount - titledAt >= 2;
      if (!shouldGenerate) return;

      titleRef.current.inFlight = true;
      const requestId = ++titleRef.current.requestId;
      const targetCount = userCount;
      const ctx = ctxRef.current;
      // Keep immutable snapshots. The user may start `/new`, resume another
      // session, or exit while the title request is in flight.
      const titleMessages = messages.map((message) => ({ ...message }));
      const titleTranscript = latestItems.current.map((item) => ({ ...item }));
      void generateSessionTitle(messages, {
        provider: ctx.provider,
        model: ctx.model,
      })
        .then((title) => {
          if (titleRef.current.requestId === requestId) {
            titleRef.current.inFlight = false;
          }
          if (!title) return;
          if (titleRef.current.requestId === requestId) {
            titleRef.current.titledAtUserCount = targetCount;
          }
          // Persist against the original session, not whatever session is
          // currently visible in the TUI.
          void upsertSession(
            sessionId,
            titleMessages,
            title,
            titleTranscript,
          ).catch(() => undefined);
        })
        .catch(() => {
          if (titleRef.current.requestId === requestId) {
            titleRef.current.inFlight = false;
          }
        });
    },
    [noHistory, runner],
  );

  useEffect(() => {
    if (noHistory || getConfig().privateMode) return;
    if (state.items.length === 0) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      const messages = runner.getMessages();
      // Only persist sessions that contain an actual conversation. This keeps
      // `/new` with no input, or a cleared-then-exited session (notices only,
      // no user turns), out of the history list.
      if (!messages.some((m) => m.role === "user")) return;
      const sessionId = runner.getSession().sessionId;
      void upsertSession(sessionId, messages, undefined, state.items).catch(
        () => undefined,
      );
      maybeUpdateTitle(sessionId);
    }, 250);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [noHistory, runner, state.items, maybeUpdateTitle]);

  useEffect(
    () => () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      const messages = runner.getMessages();
      if (
        !noHistory &&
        !getConfig().privateMode &&
        messages.some((m) => m.role === "user")
      ) {
        void upsertSession(
          runner.getSession().sessionId,
          messages,
          undefined,
          latestItems.current,
        ).catch(() => undefined);
      }
    },
    [noHistory, runner],
  );

  const startTurn = useCallback(
    async (
      display: string,
      modelInput: string,
      images?: ReturnType<typeof loadImageAttachments>,
    ) => {
      setScroll(0);
      dispatch({ type: "submit", text: display });
      await runner.run(
        modelInput,
        images && images.length > 0 ? { images } : undefined,
      );
    },
    [runner],
  );

  const beginTurn = useCallback(
    (rawText: string) => {
      const vision = modelSupportsVision(provider, model);
      const expansion = expandMentions(rawText, safeCwd(), vision);
      const images = vision ? loadImageAttachments(rawText, safeCwd()) : [];
      const modelInput = expansion.contextBlock
        ? `${rawText}\n\n${expansion.contextBlock}`
        : rawText;
      void startTurn(rawText, modelInput, images);
    },
    [provider, model, startTurn],
  );

  useEffect(() => {
    if (
      !state.status.running &&
      !state.pendingConfirm &&
      state.queued.length > 0 &&
      !runner.isRunning()
    ) {
      const next = state.queued[0]!;
      dispatch({ type: "dequeue" });
      beginTurn(next);
    }
  }, [
    state.status.running,
    state.pendingConfirm,
    state.queued,
    runner,
    beginTurn,
  ]);

  const lastToolOutput = useCallback((): ToolItem | undefined => {
    for (let i = state.items.length - 1; i >= 0; i -= 1) {
      const item = state.items[i]!;
      if (item.kind === "tool" && item.output) return item;
    }
    return undefined;
  }, [state.items]);

  const openToolOutput = useCallback(async (item: ToolItem): Promise<void> => {
    let body = item.output;
    if (item.artifactPath) {
      body = await readFile(item.artifactPath, "utf8").catch(() => item.output);
    }
    setOverlay({ kind: "pager", title: `${item.name} · full output`, body });
  }, []);

  const runImplement = useCallback(async () => {
    const session = runner.getSession();
    const plan = await loadPlan(session.sessionId).catch(() => undefined);
    if (!plan) {
      dispatch({
        type: "notice",
        level: "info",
        text: "no plan to implement — ask clai to plan a multi-step task first",
      });
      return;
    }
    if (plan.tasks.every((t) => t.state === "done")) {
      dispatch({
        type: "notice",
        level: "info",
        text: "this plan is already complete ✓",
      });
      return;
    }
    plan.status = "approved";
    await savePlan(plan).catch(() => undefined);
    session.planApproved.value = true;
    dispatch({
      type: "notice",
      level: "info",
      text: "✦ plan approved — executing it now",
    });
    void startTurn("/implement", IMPLEMENT_PROMPT);
  }, [runner, startTurn]);

  // After a turn ends, if the agent just created (or revised) a plan that is
  // still a draft awaiting approval, prompt the user with a yes/no modal to
  // implement it now or discard it. /implement and /discard remain available.
  const maybePromptPlanApproval = useCallback(async () => {
    const session = runner.getSession();
    if (session.planApproved.value) return;
    if (confirmResolver.current) return; // a confirm is already on screen
    const plan = await loadPlan(session.sessionId).catch(() => undefined);
    if (!plan || plan.status !== "draft" || plan.tasks.length === 0) return;
    const ok = await new Promise<boolean>((res) => {
      confirmResolver.current = res;
      dispatch({
        type: "event",
        event: {
          type: "confirm-request",
          id: "plan",
          kind: "plan",
          prompt: `Implement this plan now? "${plan.goal}" — ${plan.tasks.length} task(s). (Y to implement · N to discard)`,
        },
      });
    });
    if (ok) {
      await runImplement();
    } else {
      await deletePlan(session.sessionId).catch(() => undefined);
      session.planApproved.value = false;
      dispatch({
        type: "notice",
        level: "info",
        text: `plan discarded · ${plan.goal}`,
      });
    }
  }, [runner, runImplement]);

  // Detect a turn finishing (running true → false) and offer plan approval.
  const prevRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = state.status.running;
    if (wasRunning && !state.status.running) {
      void maybePromptPlanApproval();
    }
  }, [state.status.running, maybePromptPlanApproval]);

  const chooseModel = useCallback(async () => {
    const providerImpl = getProvider(provider);
    let models: string[] = [];
    if (providerImpl.listModels) {
      try {
        const secret = await getProviderSecret(provider);
        models = await providerImpl.listModels({
          apiKey: secret.value,
          baseUrl: provider === "ollama" ? secret.value : undefined,
        });
      } catch (error) {
        dispatch({
          type: "notice",
          level: "warn",
          text: `could not refresh ${provider} models: ${error instanceof Error ? error.message : String(error)} · showing known models`,
        });
      }
    }
    if (models.length === 0) models = knownModels[provider] ?? [];
    if (!models.includes(model)) models.unshift(model);
    setOverlay({
      kind: "picker",
      title: `Models · ${provider}`,
      options: models.map((value) => ({
        value,
        label: value,
        active: value === model,
      })),
      onSelect: (value) => {
        setModel(value);
        setProviderModel(provider, value);
        setOverlay({ kind: "none" });
        // If the selected model belongs to a different provider, auto-switch
        // so requests are sent to the right endpoint (e.g. minimaxai/minimax-m3
        // is an NVIDIA model and must not be sent to the Gemini API).
        const inferred = inferProviderForModel(value);
        if (inferred && inferred !== provider) {
          void activateProvider(assertProvider(inferred));
        } else {
          dispatch({ type: "notice", level: "info", text: `model → ${value}` });
        }
      },
    });
  }, [model, provider]);

  const activateProvider = useCallback(
    async (next: ProviderId): Promise<void> => {
      if (providerActivationRef.current) return;
      providerActivationRef.current = next;
      // Unmount the picker before opening the secret prompt. This makes the
      // prompt the sole owner of stdin while activation is in progress.
      setOverlay({ kind: "none" });
      try {
        const configured =
          next === "ollama" ||
          Boolean(envValue(next)) ||
          Boolean((await getProviderSecret(next)).value);
        if (!configured) {
          const key = await requestSecret({
            title: `${next} API key`,
            prompt: `No API key is configured for ${next}. Enter it now to activate this provider.`,
          });
          if (!key) {
            dispatch({
              type: "notice",
              level: "warn",
              text: `provider unchanged · ${next} needs an API key`,
            });
            return;
          }
          const trimmedKey = key.trim();
          if (!getProvider(next).validateKey(trimmedKey)) {
            dispatch({
              type: "notice",
              level: "warn",
              text: `invalid API key format for ${next}`,
            });
            return;
          }
          await setProviderSecret(next, trimmedKey);
          const saved = await getProviderSecret(next);
          if (saved.value !== trimmedKey) {
            throw new Error(`could not persist the ${next} API key; provider was not changed`);
          }
        }
        const nextModel = getProviderModel(next);
        setDefaultProvider(next);
        setProvider(next);
        setModel(nextModel);
        dispatch({
          type: "notice",
          level: "info",
          text: `provider → ${next} · model → ${nextModel}`,
        });
      } catch (error) {
        dispatch({
          type: "notice",
          level: "warn",
          text: error instanceof Error ? error.message : String(error),
        });
      } finally {
        providerActivationRef.current = undefined;
      }
    },
    [requestSecret],
  );

  const chooseProvider = useCallback(() => {
    setOverlay({
      kind: "picker",
      title: "Providers",
      searchDescription: false,
      options: providerIds.map((value) => ({
        value,
        label: value,
        description: getProviderModel(value),
        active: value === provider,
      })),
      onSelect: (value) => {
        const next = assertProvider(value);
        void activateProvider(next);
      },
    });
  }, [activateProvider, provider]);

  const activateSearchProvider = useCallback(
    async (next: SearchProviderId): Promise<void> => {
      const adapter = searchProviders[next];
      if (adapter?.needsApiKey) {
        const current = await getSearchProviderKey(next);
        if (!current.value) {
          const key = await requestSecret({
            title: `${next} search API key`,
            prompt: `No API key is configured for ${adapter.displayName}. Enter it now to use this search provider.`,
          });
          if (!key) {
            dispatch({
              type: "notice",
              level: "warn",
              text: `search provider unchanged · ${next} needs an API key`,
            });
            return;
          }
          await setSecret("search", next, key);
        }
      }
      setActiveSearchProvider(next);
      setOverlay({ kind: "none" });
      dispatch({
        type: "notice",
        level: "info",
        text: `search provider → ${next}`,
      });
    },
    [requestSecret],
  );

  const chooseSearchProvider = useCallback(() => {
    const active = getConfig().activeSearchProvider;
    setOverlay({
      kind: "picker",
      title: "Search providers",
      options: searchProviderIds.map((id) => {
        const adapter = searchProviders[id];
        return {
          value: id,
          label: id === active ? `${id} · active` : id,
          description: adapter?.needsApiKey
            ? `${adapter.displayName} · API key required`
            : `${adapter?.displayName ?? id} · keyless`,
        };
      }),
      onSelect: (value) => {
        void activateSearchProvider(assertSearchProvider(value));
      },
    });
  }, [activateSearchProvider]);

  const setReasoning = useCallback((value: string) => {
    if (value === "off" || value === "none") setThinking({ enabled: false });
    else setThinking({ enabled: true, effort: value as ReasoningEffort });
    dispatch({
      type: "notice",
      level: "info",
      text:
        value === "off" || value === "none"
          ? "thinking → off"
          : `thinking → ${value}`,
    });
  }, []);

  const chooseReasoning = useCallback(() => {
    const current = getConfig().thinking;
    const descriptions: Record<string, string> = {
      off: "disable reasoning",
      minimal: "lowest latency",
      low: "light reasoning",
      medium: "balanced",
      high: "deep reasoning",
      xhigh: "maximum depth",
    };
    setOverlay({
      kind: "picker",
      title: `Reasoning · ${modelSupportsThinking(provider, model) ? "supported" : "model may ignore it"}`,
      options: Object.entries(descriptions).map(([value, description]) => ({
        value,
        label: value,
        description,
        active: value === (current.enabled ? current.effort : "off"),
      })),
      onSelect: (value) => {
        setReasoning(value);
        setOverlay({ kind: "none" });
      },
    });
  }, [model, provider, setReasoning]);

  const handleLocalSlash = useCallback(
    (text: string): boolean => {
      const [cmd, ...rest] = text.trim().split(/\s+/);
      const arg = rest.join(" ").trim();
      const info = (t: string) =>
        dispatch({ type: "notice", level: "info", text: t });
      const warn = (t: string) =>
        dispatch({ type: "notice", level: "warn", text: t });
      switch (cmd) {
        case "/ask":
          setMode("ask");
          setDefaultMode("ask");
          info("mode → ask");
          return true;
        case "/agent":
          setMode("agent");
          setDefaultMode("agent");
          info("mode → agent");
          return true;
        case "/clear":
          cancelCompaction();
          runner.reset();
          dispatch({ type: "reset" });
          info("context cleared");
          return true;
        case "/new":
          cancelCompaction();
          runner.abort();
          if (autosaveTimer.current) {
            clearTimeout(autosaveTimer.current);
            autosaveTimer.current = undefined;
          }
          const messages = runner.getMessages();
          if (
            !noHistory &&
            !getConfig().privateMode &&
            messages.some((m) => m.role === "user")
          ) {
            // Persist in the background; the new session must be interactive
            // immediately even if the history backend is slow or locked.
            void upsertSession(
              runner.getSession().sessionId,
              messages,
              undefined,
              latestItems.current,
            ).catch(() => undefined);
          }
          runner.reset();
          titleRef.current = {
            titledAtUserCount: 0,
            inFlight: false,
            requestId: titleRef.current.requestId + 1,
          };
          dispatch({ type: "reset" });
          info("fresh session started");
          return true;
        case "/clean":
          cancelCompaction();
          runner.reset();
          titleRef.current = {
            titledAtUserCount: 0,
            inFlight: false,
            requestId: titleRef.current.requestId + 1,
          };
          dispatch({ type: "reset" });
          info("fresh session started");
          return true;
        case "/think":
        case "/thinking":
          dispatch({ type: "toggle-thinking" });
          return true;
        case "/implement":
          if (runner.isRunning()) warn("a turn is already running");
          else void runImplement();
          return true;
        case "/plan":
          void (async () => {
            const plan = await loadPlan(runner.getSession().sessionId).catch(
              () => undefined,
            );
            if (!plan) info("no active plan yet");
            else
              setOverlay({
                kind: "pager",
                title: "Plan",
                body: renderPlanDocument(plan),
              });
          })();
          return true;
        case "/jobs":
          setOverlay({ kind: "jobs" });
          return true;
        case "/output": {
          const outputs = state.items.filter(
            (item): item is ToolItem =>
              item.kind === "tool" && Boolean(item.output),
          );
          if (!arg) {
            if (outputs.length) dispatch({ type: "toggle-output" });
            else info("no tool output yet");
            return true;
          }
          if (arg === "list" || arg === "ls") {
            info(
              outputs.length
                ? outputs.map((item) => `${item.id} · ${item.name}`).join("\n")
                : "no tool output yet",
            );
            return true;
          }
          const selectedOutput =
            arg && arg !== "last"
              ? outputs.find((item) => item.id === arg)
              : lastToolOutput();
          if (!selectedOutput)
            info(arg ? `no tool output: ${arg}` : "no tool output yet");
          else void openToolOutput(selectedOutput);
          return true;
        }
        case "/model":
          if (!arg || arg === "list" || arg === "ls") {
            void chooseModel();
            return true;
          }
          {
            const options = knownModels[provider] ?? [];
            const index = Number.parseInt(arg, 10);
            const nextModel =
              Number.isInteger(index) && index >= 1 && index <= options.length
                ? options[index - 1]!
                : arg;
            setModel(nextModel);
            setProviderModel(provider, nextModel);
            // If the model lives under a different provider's list, switch to
            // that provider so the request goes to the right endpoint.
            const inferred = inferProviderForModel(nextModel);
            if (inferred && inferred !== provider) {
              void activateProvider(assertProvider(inferred));
            } else {
              info(`model → ${nextModel}`);
            }
            return true;
          }
        case "/provider":
        case "/use":
          if (!arg) {
            chooseProvider();
            return true;
          }
          try {
            const next = assertProvider(arg);
            void activateProvider(next);
          } catch {
            warn(`unknown provider: ${arg}`);
          }
          return true;
        case "/search":
        case "/search-provider":
          if (!arg || arg === "list" || arg === "ls") {
            chooseSearchProvider();
            return true;
          }
          try {
            const next = assertSearchProvider(arg);
            void activateSearchProvider(next);
          } catch {
            warn(`unknown search provider: ${arg}`);
          }
          return true;
        case "/mouse": {
          const normalized = arg.toLowerCase();
          if (!normalized) {
            info(
              `mouse=${mouseMode ? "on" : "off"} · on: touchpad scrolls chat; off: native select/copy`,
            );
            return true;
          }
          if (/^(on|true|1|enable)$/i.test(normalized)) {
            setMouseMode(true);
            info(
              "mouse=on · touchpad scrolls chat; use Option/Shift selection if your terminal requires it",
            );
            return true;
          }
          if (/^(off|false|0|disable)$/i.test(normalized)) {
            setMouseMode(false);
            info(
              "mouse=off · native select/copy restored; use PageUp/PageDown/Ctrl+U/Ctrl+D or j/k to scroll chat",
            );
            return true;
          }
          warn("usage: /mouse [on|off]");
          return true;
        }
        case "/variants":
        case "/reasoning": {
          if (!arg) {
            chooseReasoning();
            return true;
          }
          const value = arg.toLowerCase();
          if (/^(on|enable|true)$/.test(value)) {
            setThinking({ enabled: true });
            info(`thinking → ${getConfig().thinking.effort}`);
          } else if (["off", "none", "disable", "false"].includes(value)) {
            setReasoning("off");
          } else if (
            ["minimal", "low", "medium", "high", "xhigh"].includes(value)
          ) {
            setReasoning(value);
          } else
            warn("usage: /variants [on|off|minimal|low|medium|high|xhigh]");
          return true;
        }
        case "/cwd": {
          if (!arg) {
            info(`cwd: ${safeCwd()}`);
            return true;
          }
          const target = resolve(safeCwd(), arg);
          if (!existsSync(target)) {
            warn(`no such directory: ${target}`);
            return true;
          }
          try {
            process.chdir(target);
            info(`cwd → ${target}`);
          } catch (e) {
            warn(
              `could not chdir: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          return true;
        }
        case "/allow":
          if (!arg || arg === "list" || arg === "ls") {
            const list = [...runner.getSession().allow];
            info(
              list.length
                ? `allowed: ${list.join(", ")}`
                : "no session allowances",
            );
            return true;
          }
          runner.getSession().allow.add(arg);
          info(`allowed for session: ${arg}`);
          return true;
        case "/disallow":
          if (arg) runner.getSession().allow.delete(arg);
          info(arg ? `disallowed: ${arg}` : "usage: /disallow <tool>");
          return true;
        case "/context": {
          const msgs = runner.getMessages();
          info(
            `context: ${msgs.length} messages · ~${estimateMessagesTokens(msgs)} tokens`,
          );
          return true;
        }
        case "/compact": {
          if (runner.isRunning()) {
            warn("wait for the current operation to finish");
            return true;
          }
          cancelCompaction();
          const ac = new AbortController();
          compactAbortRef.current = ac;
          setCompacting(true);
          setCompactStartedAt(Date.now());
          info("compacting conversation…");
          const fullSession = serializeTranscriptForCompaction(state.items);
          void runner
            .compact(fullSession, 2, ac.signal)
            .then((result) => {
              if (ac.signal.aborted) return;
              if (!result.summarized || result.after === result.before) {
                info("nothing to compact yet — more conversation is needed");
                return;
              }
              const memoMsg =
                result.messages.find(
                  (m) =>
                    m.role === "system" &&
                    m.content.startsWith("Session memory"),
                ) ??
                result.messages.find((m, i) => i > 0 && m.role === "system");
              const summary = memoMsg ? memoMsg.content : "Compacted context";
              dispatch({ type: "compacted", summary, keepRecent: 2 });
              const freed = Math.max(
                0,
                result.beforeTokens - result.afterTokens,
              );
              const pct =
                result.beforeTokens > 0
                  ? Math.round((freed / result.beforeTokens) * 100)
                  : 0;
              info(
                `context compacted — earlier turns summarized into a memory · ` +
                  `freed ~${freed.toLocaleString()} tokens (${pct}% smaller, ` +
                  `~${result.beforeTokens.toLocaleString()} → ~${result.afterTokens.toLocaleString()} est.)`,
              );
            })
            .catch((error) => {
              if (
                ac.signal.aborted ||
                (error instanceof Error && error.name === "AbortError")
              ) {
                info("compaction cancelled");
              } else {
                warn(
                  `compaction failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            })
            .finally(() => {
              if (compactAbortRef.current === ac) {
                compactAbortRef.current = undefined;
                setCompacting(false);
                setCompactStartedAt(undefined);
              }
            });
          return true;
        }
        case "/save":
          void (async () => {
            const msgs = runner.getMessages();
            if (msgs.length === 0) {
              info("nothing to save yet");
              return;
            }
            // Continuous autosave already persists this conversation under
            // its live sessionId — upsert that same row (optionally renaming
            // it) instead of minting a separate duplicate entry.
            const rec = await upsertSession(
              runner.getSession().sessionId,
              msgs,
              arg || undefined,
              state.items,
            ).catch(() => undefined);
            info(rec ? `saved session ${rec.id}` : "save failed");
          })();
          return true;
        case "/history":
          void (async () => {
            const sessions = await listSessions(50);
            const currentMessages = runner.getMessages();
            if (sessions.length === 0 && currentMessages.length === 0) {
              info("no session history yet — start chatting to create one");
              return;
            }
            setOverlay({
              kind: "picker",
              title: "Session history",
              twoLine: true,
              options: [
                // Always show where the user currently is, even a brand-new
                // /new session with nothing sent yet — otherwise the picker
                // can look like it's viewing whichever past session happens
                // to sort first, with no indication of "you are here".
                {
                  value: "__current__",
                  label: "Current session",
                  description: currentMessages.length
                    ? `active now · ${currentMessages.length} messages`
                    : "active now · new, empty session",
                  active: true,
                },
                ...sessions.map((session) => {
                  const date = session.updatedAt ?? session.createdAt;
                  const when = relativeTime(date);
                  const stamp = date.slice(0, 16).replace("T", " ");
                  const count =
                    session.transcript?.length ?? session.messages.length;
                  const where = shortCwd(session.cwd);
                  const meta = [
                    when ? `${when} · ${stamp}` : stamp,
                    `${count} msgs`,
                    where,
                  ]
                    .filter(Boolean)
                    .join("  ·  ");
                  return {
                    value: session.id,
                    label: session.name ?? session.id,
                    description: meta,
                  };
                }),
              ],
              onSelect: (id) => {
                void (async () => {
                  if (id === "__current__") {
                    setOverlay({ kind: "none" });
                    info("showing current session");
                    return;
                  }
                  const session = await getSession(id);
                  if (!session) {
                    warn("session not found");
                    return;
                  }
                  cancelCompaction();
                  runner.setMessages(session.messages, session.id);
                  // Keep the resumed session's existing title; only refresh
                  // once the user adds new turns on top of it.
                  titleRef.current = {
                    titledAtUserCount: session.messages.filter(
                      (m) => m.role === "user",
                    ).length,
                    inFlight: false,
                    requestId: titleRef.current.requestId + 1,
                  };
                  setOverlay({ kind: "none" });
                  dispatch({
                    type: "load-history",
                    messages: session.messages,
                    transcript: session.transcript,
                  });
                  setScroll(0);
                  info(
                    `session resumed · ${session.transcript?.length ?? session.messages.length} items`,
                  );
                })();
              },
            });
          })();
          return true;
        case "/reset":
          void clearAllHistory().then((result) =>
            info(`history cleared · ${result.detail || "ok"}`),
          );
          return true;
        case "/discard":
          void (async () => {
            const session = runner.getSession();
            const plan = await loadPlan(session.sessionId).catch(
              () => undefined,
            );
            if (!plan) {
              info("no active plan to discard");
              return;
            }
            await deletePlan(session.sessionId);
            session.planApproved.value = false;
            info(`plan discarded · ${plan.goal}`);
          })();
          return true;
        case "/scope":
          void (async () => {
            const [sub = "show", ...parts] = arg.split(/\s+/).filter(Boolean);
            if (["clear", "reset", "off"].includes(sub)) {
              await clearScope();
              info("engagement scope cleared");
              return;
            }
            if (sub === "show" || sub === "list" || sub === "ls") {
              const scope = await loadScope();
              info(
                scope
                  ? `scope: ${scope.name ?? "unnamed"} · ${scope.authorizedTargets.join(", ")}`
                  : "no engagement scope configured",
              );
              return;
            }
            if (sub === "add") {
              const targets = parts
                .join(" ")
                .split(/[\s,]+/)
                .filter(Boolean);
              if (!targets.length) {
                warn("usage: /scope add <target1,target2>");
                return;
              }
              const scope = await addScopeTargets(targets);
              info(`scope updated · ${scope.authorizedTargets.join(", ")}`);
              return;
            }
            if (sub === "new" || sub === "set") {
              const targets = parts
                .join(" ")
                .split(/[\s,]+/)
                .filter(Boolean);
              if (!targets.length) {
                warn("usage: /scope new <target1,target2>");
                return;
              }
              await saveScope({
                authorizedTargets: targets,
                createdAt: new Date().toISOString(),
              });
              info(`scope created · ${targets.join(", ")}`);
              return;
            }
            warn("usage: /scope [show|clear|new <targets>|add <targets>]");
          })().catch((error) =>
            warn(error instanceof Error ? error.message : String(error)),
          );
          return true;
        case "/privacy":
          void (async () => {
            const sub = (arg || "status").toLowerCase();
            if (["on", "enable"].includes(sub)) {
              updateConfig({ privateMode: true });
              info("private mode → on");
              return;
            }
            if (["off", "disable"].includes(sub)) {
              updateConfig({ privateMode: false });
              info("private mode → off");
              return;
            }
            if (sub === "status") {
              info(`private mode: ${getConfig().privateMode ? "on" : "off"}`);
              return;
            }
            if (sub === "clear-history") {
              const result = await clearAllHistory();
              info(`history cleared · ${result.detail || "ok"}`);
              return;
            }
            if (sub === "clear-logs") {
              const result = await clearAuditLogs();
              info(`audit logs cleared · ${result.removed} files`);
              return;
            }
            if (sub === "clear-artifacts") {
              const result = await clearArtifacts();
              info(`artifacts cleared · ${result.removed} files`);
              return;
            }
            if (sub === "clear-all") {
              const [historyResult, logResult, artifactResult] =
                await Promise.all([
                  clearAllHistory(),
                  clearAuditLogs(),
                  clearArtifacts(),
                ]);
              info(
                `cleared history (${historyResult.detail || "ok"}), logs (${logResult.removed}), artifacts (${artifactResult.removed})`,
              );
              return;
            }
            warn(
              "usage: /privacy [status|on|off|clear-history|clear-logs|clear-artifacts|clear-all]",
            );
          })();
          return true;
        case "/freeonly": {
          const on = /^(on|true|1|enable)$/i.test(arg),
            off = /^(off|false|0|disable)$/i.test(arg);
          if (!on && !off) {
            info(`freeOnly=${getConfig().freeOnly}`);
            return true;
          }
          updateConfig({ freeOnly: on });
          info(`freeOnly=${on}`);
          return true;
        }
        case "/fallback": {
          const on = /^(on|true|1|enable)$/i.test(arg),
            off = /^(off|false|0|disable)$/i.test(arg);
          if (!on && !off) {
            info(`providerFallback=${getConfig().providerFallback}`);
            return true;
          }
          updateConfig({ providerFallback: on });
          info(`providerFallback=${on}`);
          return true;
        }
        case "/info":
          void (async () => {
            const providerVal = arg.trim().toLowerCase();
            let targetProvider: string = provider;
            if (providerVal) {
              try {
                targetProvider = assertProvider(providerVal);
              } catch {
                warn(`unknown provider: ${providerVal}`);
                return;
              }
            }
            const infoText = getProviderInfoText(targetProvider);
            setOverlay({
              kind: "pager",
              title: `${targetProvider} Info`,
              body: infoText,
            });
          })();
          return true;
        case "/keys":
          void (async () => {
            const llm = await listProviderStatuses(provider);
            const activeSearch = getConfig().activeSearchProvider;
            const search = await Promise.all(
              searchProviderIds.map(async (id) => {
                const secret = await getSearchProviderKey(id);
                const keyless = id === "duckduckgo";
                return {
                  provider: id,
                  active: id === activeSearch,
                  configured: keyless || Boolean(secret.value),
                  source: keyless ? "keyless" : secret.source,
                  maskedKey: secret.value
                    ? maskSecret(secret.value)
                    : undefined,
                };
              }),
            );
            setOverlay({
              kind: "pager",
              title: "Credential status",
              body: formatKeyStatus(llm, search),
            });
          })().catch((error) =>
            warn(
              `could not read keys: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          return true;
        case "/set": {
          const parts = arg.split(/\s+/).filter(Boolean);
          const providerVal = parts[0];
          const keyVal = parts[1];
          void (async () => {
            if (!providerVal) {
              const llm = await listProviderStatuses(provider);
              const activeSearch = getConfig().activeSearchProvider;
              const search = await Promise.all(
                searchProviderIds.map(async (id) => {
                  const secret = await getSearchProviderKey(id);
                  const keyless = id === "duckduckgo";
                  return {
                    provider: id,
                    configured: keyless || Boolean(secret.value),
                    maskedKey: secret.value
                      ? maskSecret(secret.value)
                      : undefined,
                  };
                }),
              );
              setOverlay({
                kind: "picker",
                title: "Set API key for provider",
                options: [
                  ...llm.map((status) => ({
                    value: `llm:${status.provider}`,
                    label: `${status.provider.padEnd(12)} ${status.configured ? chalk.green("✓ key set") : chalk.red("✗ no key")}${status.active ? " (active)" : ""}`,
                    description: status.model,
                  })),
                  ...search.map((status) => ({
                    value: `search:${status.provider}`,
                    label: `${status.provider.padEnd(12)} ${status.configured ? chalk.green("✓ key set") : chalk.red("✗ no key")}`,
                    description: `Search provider${status.provider === activeSearch ? " (active)" : ""}`,
                  })),
                ],
                onSelect: (val) => {
                  setOverlay({ kind: "none" });
                  void (async () => {
                    const isSearch = val.startsWith("search:");
                    const id = val.split(":")[1]!;
                    if (isSearch) {
                      const next = id as SearchProviderId;
                      if (next === "duckduckgo") {
                        info("duckduckgo is keyless and requires no setup");
                        return;
                      }
                      const secret = await getSearchProviderKey(next);
                      if (secret.value) {
                        const reset = await new Promise<boolean>(
                          (resolveConfirm) => {
                            confirmResolver.current = resolveConfirm;
                            dispatch({
                              type: "event",
                              event: {
                                type: "confirm-request",
                                id: "c",
                                kind: "reset",
                                prompt: `${next} already has a key (${maskSecret(secret.value!)}). Reset it?`,
                              },
                            });
                          },
                        );
                        if (!reset) {
                          info("cancelled");
                          return;
                        }
                      }
                      const key = await requestSecret({
                        title: `${next} API key`,
                        prompt: `Enter API key for ${next}:`,
                      });
                      if (!key) {
                        info("cancelled");
                        return;
                      }
                      await setSecret("search", next, key.trim());
                      info(`saved ${next} ${maskSecret(key.trim())}`);
                    } else {
                      const next = id as ProviderId;
                      if (next === "ollama") {
                        const key = await requestSecret({
                          title: "Ollama host URL",
                          prompt: `Enter host URL for Ollama:`,
                        });
                        if (!key) {
                          info("cancelled");
                          return;
                        }
                        updateConfig({ ollamaHost: key.trim() });
                        info(`saved ollama host → ${key.trim()}`);
                        return;
                      }
                      const secret = await getProviderSecret(next);
                      if (secret.value) {
                        const reset = await new Promise<boolean>(
                          (resolveConfirm) => {
                            confirmResolver.current = resolveConfirm;
                            dispatch({
                              type: "event",
                              event: {
                                type: "confirm-request",
                                id: "c",
                                kind: "reset",
                                prompt: `${next} already has a key (${maskSecret(secret.value!)}). Reset it?`,
                              },
                            });
                          },
                        );
                        if (!reset) {
                          info("cancelled");
                          return;
                        }
                      }
                      const key = await requestSecret({
                        title: `${next} API key`,
                        prompt: `Enter API key for ${next}:`,
                      });
                      if (!key) {
                        info("cancelled");
                        return;
                      }
                      if (!getProvider(next).validateKey(key.trim())) {
                        warn(`invalid API key format for ${next}`);
                        return;
                      }
                      await setProviderSecret(next, key.trim());
                      info(`saved ${next} ${maskSecret(key.trim())}`);
                    }
                  })();
                },
              });
            } else {
              try {
                const isSearch = ["brave", "tavily", "duckduckgo"].includes(
                  providerVal,
                );
                if (isSearch) {
                  const next = providerVal as SearchProviderId;
                  if (next === "duckduckgo") {
                    info("duckduckgo is keyless and requires no setup");
                    return;
                  }
                  let key = keyVal;
                  if (!key) {
                    const secret = await getSearchProviderKey(next);
                    if (secret.value) {
                      const reset = await new Promise<boolean>(
                        (resolveConfirm) => {
                          confirmResolver.current = resolveConfirm;
                          dispatch({
                            type: "event",
                            event: {
                              type: "confirm-request",
                              id: "c",
                              kind: "reset",
                              prompt: `${next} already has a key (${maskSecret(secret.value!)}). Reset it?`,
                            },
                          });
                        },
                      );
                      if (!reset) {
                        info("cancelled");
                        return;
                      }
                    }
                    key = await requestSecret({
                      title: `${next} API key`,
                      prompt: `Enter API key for ${next}:`,
                    });
                    if (!key) {
                      info("cancelled");
                      return;
                    }
                  }
                  await setSecret("search", next, key.trim());
                  info(`saved ${next} ${maskSecret(key.trim())}`);
                } else {
                  const next = assertProvider(providerVal);
                  if (next === "ollama") {
                    let key = keyVal;
                    if (!key) {
                      key = await requestSecret({
                        title: "Ollama host URL",
                        prompt: `Enter host URL for Ollama:`,
                      });
                      if (!key) {
                        info("cancelled");
                        return;
                      }
                    }
                    updateConfig({ ollamaHost: key.trim() });
                    info(`saved ollama host → ${key.trim()}`);
                    return;
                  }
                  let key = keyVal;
                  if (!key) {
                    const secret = await getProviderSecret(next);
                    if (secret.value) {
                      const reset = await new Promise<boolean>(
                        (resolveConfirm) => {
                          confirmResolver.current = resolveConfirm;
                          dispatch({
                            type: "event",
                            event: {
                              type: "confirm-request",
                              id: "c",
                              kind: "reset",
                              prompt: `${next} already has a key (${maskSecret(secret.value!)}). Reset it?`,
                            },
                          });
                        },
                      );
                      if (!reset) {
                        info("cancelled");
                        return;
                      }
                    }
                    key = await requestSecret({
                      title: `${next} API key`,
                      prompt: `Enter API key for ${next}:`,
                    });
                    if (!key) {
                      info("cancelled");
                      return;
                    }
                  }
                  if (!getProvider(next).validateKey(key.trim())) {
                    warn(`invalid API key format for ${next}`);
                    return;
                  }
                  await setProviderSecret(next, key.trim());
                  info(`saved ${next} ${maskSecret(key.trim())}`);
                }
              } catch (e: any) {
                warn(e.message);
              }
            }
          })();
          return true;
        }
        case "/unset": {
          const parts = arg.split(/\s+/).filter(Boolean);
          const providerVal = parts[0];
          void (async () => {
            if (!providerVal) {
              const llm = await listProviderStatuses(provider);
              const activeSearch = getConfig().activeSearchProvider;
              const search = await Promise.all(
                searchProviderIds.map(async (id) => {
                  const secret = await getSearchProviderKey(id);
                  const keyless = id === "duckduckgo";
                  return {
                    provider: id,
                    configured: keyless || Boolean(secret.value),
                    maskedKey: secret.value
                      ? maskSecret(secret.value)
                      : undefined,
                  };
                }),
              );
              setOverlay({
                kind: "picker",
                title: "Unset API key for provider",
                options: [
                  ...llm.map((status) => ({
                    value: `llm:${status.provider}`,
                    label: `${status.provider.padEnd(12)} ${status.configured ? chalk.green("✓ ") + (status.maskedKey ?? "key set") : chalk.red("✗ no key")}${status.active ? " (active)" : ""}`,
                    description: status.model,
                  })),
                  ...search.map((status) => ({
                    value: `search:${status.provider}`,
                    label: `${status.provider.padEnd(12)} ${status.configured ? chalk.green("✓ ") + (status.maskedKey ?? "keyless") : chalk.red("✗ no key")}`,
                    description: `Search provider${status.provider === activeSearch ? " (active)" : ""}`,
                  })),
                ],
                onSelect: (val) => {
                  setOverlay({ kind: "none" });
                  void (async () => {
                    const isSearch = val.startsWith("search:");
                    const id = val.split(":")[1]!;
                    if (isSearch) {
                      const next = id as SearchProviderId;
                      if (next === "duckduckgo") {
                        info(
                          "duckduckgo requires no credentials and cannot be unset",
                        );
                        return;
                      }
                      const secret = await getSearchProviderKey(next);
                      if (!secret.value) {
                        warn(`${next} has no key to unset`);
                        return;
                      }
                      const { unsetSearchProviderKey } =
                        await import("../commands/search-providers.js");
                      await unsetSearchProviderKey(next);
                      info(`unset ${next}`);
                    } else {
                      const next = id as ProviderId;
                      if (next === "ollama") {
                        info("ollama does not store an API key");
                        return;
                      }
                      const secret = await getProviderSecret(next);
                      if (!secret.value) {
                        warn(`${next} has no key to unset`);
                        return;
                      }
                      await unsetProviderSecret(next);
                      info(`unset ${next}`);
                    }
                  })();
                },
              });
            } else {
              try {
                const isSearch = ["brave", "tavily", "duckduckgo"].includes(
                  providerVal,
                );
                if (isSearch) {
                  const next = providerVal as SearchProviderId;
                  if (next === "duckduckgo") {
                    info(
                      "duckduckgo requires no credentials and cannot be unset",
                    );
                    return;
                  }
                  const secret = await getSearchProviderKey(next);
                  if (!secret.value) {
                    warn(`${next} has no key to unset`);
                    return;
                  }
                  const { unsetSearchProviderKey } =
                    await import("../commands/search-providers.js");
                  await unsetSearchProviderKey(next);
                  info(`unset ${next}`);
                } else {
                  const next = assertProvider(providerVal);
                  if (next === "ollama") {
                    info("ollama does not store an API key");
                    return;
                  }
                  const secret = await getProviderSecret(next);
                  if (!secret.value) {
                    warn(`${next} has no key to unset`);
                    return;
                  }
                  await unsetProviderSecret(next);
                  info(`unset ${next}`);
                }
              } catch (e: any) {
                warn(e.message);
              }
            }
          })();
          return true;
        }
        case "/permissions": {
          const current = getConfig().permissions ?? "default";
          if (!arg) {
            setOverlay({
              kind: "picker",
              title: "Permissions mode",
              options: [
                {
                  value: "default",
                  label: "default",
                  description: "normal behavior (prompts for confirmation on mutating actions)",
                  active: current === "default",
                },
                {
                  value: "allow-all",
                  label: "allow-all",
                  description: "run everything without confirmation (except passwords)",
                  active: current === "allow-all",
                },
              ],
              onSelect: (val) => {
                updateConfig({ permissions: val as "default" | "allow-all" });
                info(`permissions → ${val}`);
                setOverlay({ kind: "none" });
              },
            });
            return true;
          }
          const value = arg.toLowerCase().trim();
          if (value === "default" || value === "normal") {
            updateConfig({ permissions: "default" });
            info("permissions → default");
          } else if (["allow-all", "allowall", "all"].includes(value)) {
            updateConfig({ permissions: "allow-all" });
            info("permissions → allow-all");
          } else {
            warn("usage: /permissions [default|allow-all]");
          }
          return true;
        }
        case "/update":
          info(
            `${cmd} manages updates; use the equivalent \`clai update\` command outside the TUI`,
          );
          return true;
        case "/help":
          setOverlay({
            kind: "picker",
            title: "Command reference",
            options: slashCommands.map((item) => ({
              value: item.command,
              label: `${item.command}${item.usage ? ` ${item.usage}` : ""}`,
              description: item.description,
            })),
            onSelect: (value) => {
              const next = `${value} `;
              setInput(next);
              setCursor(next.length);
              setSelected(0);
              setOverlay({ kind: "none" });
            },
          });
          return true;
        case "/exit":
        case "/quit":
          exitTui();
          return true;
        default:
          return false;
      }
    },
    [
      activateProvider,
      activateSearchProvider,
      chooseModel,
      chooseProvider,
      chooseReasoning,
      chooseSearchProvider,
      compacting,
      exitTui,
      mouseMode,
      noHistory,
      provider,
      runner,
      runImplement,
      lastToolOutput,
      openToolOutput,
      setReasoning,
      state.items,
      requestSecret,
      setOverlay,
    ],
  );

  const submitText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      historyIdx.current = -1;
      historyDraft.current = "";
      setInput("");
      setCursor(0);
      setSelected(0);
      // A macOS/Linux drag-and-drop commonly starts with an absolute path.
      // Only route a leading slash through the command handler when its first
      // token is an actual clai command; file paths remain normal prompts.
      if (trimmed.startsWith("/") && isKnownSlashCommand(trimmed)) {
        if (!handleLocalSlash(trimmed))
          dispatch({
            type: "notice",
            level: "warn",
            text: `unknown command: ${trimmed}`,
          });
        return;
      }
      if (shouldStoreInPromptHistory(trimmed)) history.current.push(trimmed);
      if (runner.isRunning()) dispatch({ type: "queue", text: trimmed });
      else beginTurn(trimmed);
    },
    [handleLocalSlash, runner, beginTurn],
  );

  const answerConfirm = useCallback((ok: boolean) => {
    confirmResolver.current?.(ok);
    confirmResolver.current = undefined;
    dispatch({ type: "confirm-resolved" });
  }, []);

  const answerSecret = useCallback((value: string | undefined) => {
    secretResolver.current?.(value);
    secretResolver.current = undefined;
    setSecretRequest(undefined);
  }, []);

  // Layout math (keep the composer pinned to the bottom)
  const suggestions: SlashCommand[] = input.startsWith("/")
    ? getSlashCommandSuggestions(input)
    : [];
  const mention = getMentionQuery(input, cursor);
  const fileSuggestions: FileSuggestion[] = mention
    ? findFileSuggestions(mention.query, safeCwd(), MAX_FILE_SUGGESTIONS)
    : [];
  const slashMenuOpen = suggestions.length > 0;
  const fileMenuOpen =
    !slashMenuOpen && Boolean(mention) && fileSuggestions.length > 0;
  const menuOpen = slashMenuOpen || fileMenuOpen;
  const overlayOpen = overlay.kind !== "none";
  const modalActive =
    Boolean(state.pendingConfirm) || Boolean(secretRequest) || overlayOpen;

  // Leave the terminal's final row unused. Painting through the last cell can
  // trigger an implicit scroll in several terminals, which looks like a full
  // screen flash on every keypress/spinner frame.
  const usableRows = Math.max(8, rows - 1);
  const headerH = 0;
  const inputWidth = Math.max(10, cols - 10);
  let statusH = 0;
  if (secretRequest) {
    const wrappedPromptLines = wrapPlainString(
      secretRequest.prompt,
      cols - 6,
    );
    statusH = 5 + wrappedPromptLines.length; // 1 (header) + 1 (password) + 1 (help) + 2 (borders) = 5, plus prompt lines
  } else if (state.pendingConfirm) {
    const wrappedPromptLines = wrapPlainString(
      state.pendingConfirm.prompt,
      cols - 6,
    );
    statusH = 4 + wrappedPromptLines.length; // 1 (header) + 1 (help) + 2 (borders) = 4, plus prompt lines
  }
  const chromeH = !secretRequest && !state.pendingConfirm ? 1 : 0;
  const gapH = 1;

  const wrappedInputLines = wrapPlainString(input, inputWidth);
  const maxAvailableForComposer = Math.max(
    3,
    usableRows - headerH - statusH - chromeH - gapH - 8,
  );
  const maxComposerTextRows = Math.max(1, maxAvailableForComposer - 2);
  const composerTextH = Math.min(wrappedInputLines.length, maxComposerTextRows);
  const composerH = composerTextH + 2;

  const maxMenuRows = Math.max(
    3,
    usableRows - headerH - statusH - composerH - chromeH - gapH - 3,
  );
  const menuH = slashMenuOpen
    ? Math.min(suggestions.length, maxMenuRows)
    : fileMenuOpen
      ? fileSuggestions.length
      : 0;
  const viewportH = Math.max(
    3,
    usableRows - headerH - statusH - composerH - menuH - chromeH - gapH,
  );
  const slashWindowStart = slashMenuOpen
    ? Math.min(
        Math.max(0, selected - Math.floor(menuH / 2)),
        Math.max(0, suggestions.length - menuH),
      )
    : 0;
  const visibleSlashSuggestions = suggestions.slice(
    slashWindowStart,
    slashWindowStart + menuH,
  );

  const livePlan = useMemo(() => {
    for (let i = state.items.length - 1; i >= 0; i -= 1) {
      const item = state.items[i];
      if (item?.kind === "plan") return item.plan;
    }
    return undefined;
  }, [state.items]);
  // Two columns only when both remain genuinely readable. Below this content-
  // based breakpoint the plan stays available inline and through Ctrl+P.
  const showPlanSidebar = Boolean(
    planPaneVisible && livePlan && cols >= 100 && overlay.kind === "none",
  );
  const planSidebarWidth = showPlanSidebar
    ? Math.min(48, Math.max(32, Math.floor((cols - 7) * 0.32)))
    : 0;
  const transcriptWidth = showPlanSidebar
    ? cols - 6 - planSidebarWidth - 1
    : cols - 6;

  const transcriptLines = renderTranscriptLines(state, {
    width: transcriptWidth,
    thinkingExpanded: state.thinkingExpanded,
    outputExpanded: state.outputExpanded,
    running: state.status.running,
    version,
    mode,
    provider,
    model,
    permissions: getConfig().permissions ?? "default",
    hidePlanItems: Boolean(livePlan),
  });
  const total = transcriptLines.length;
  const maxOffset = Math.max(0, total - viewportH);
  const offset = Math.min(scroll, maxOffset);
  const end = total - offset;
  const start = Math.max(0, end - viewportH);
  let visible = transcriptLines.slice(start, end);
  if (visible.length < viewportH) {
    visible = [...visible, ...Array(viewportH - visible.length).fill("")];
  }
  // Sidebar rendered to strings (not an Ink flex column) so each viewport row
  // can be composed as ONE Text node — see renderPlanSidebarLines for why.
  const planSidebarLines =
    showPlanSidebar && livePlan
      ? renderPlanSidebarLines(livePlan, planSidebarWidth, viewportH)
      : [];

  // SGR mouse reporting keeps wheel/trackpad events distinct from cursor-key
  // sequences, so scrolling the transcript never walks prompt history.
  // Mouse wheel scroll stays enabled while a confirm box is showing (so the
  // user can review context before answering); it's disabled for overlays/
  // secret prompts, which own their own content and scrolling.
  useEffect(() => {
    const confirmOnlyModal =
      Boolean(state.pendingConfirm) && !secretRequest && !overlayOpen;
    if (!stdin || (modalActive && !confirmOnlyModal)) return;
    const onData = (chunk: Buffer | string): void => {
      const data = String(chunk);
      if (data === "\x08" || data === "\b") {
        isCtrlHPressed.current = true;
        setPlanPaneVisible((visible) => !visible);
        return;
      }
      const direction = mouseWheelDirection(data);
      if (direction < 0) {
        setScroll((value) => Math.min(maxOffset, value + 3));
        return;
      }
      if (direction > 0) {
        setScroll((value) => Math.max(0, value - 3));
        return;
      }

      // Handle drag to scroll when mouse mode is active
      if (mouseMode) {
        const match = data.match(/\x1b\[<(\d+);(\d+);(\d+)([mM])/);
        if (match) {
          const button = parseInt(match[1]!, 10);
          const y = parseInt(match[3]!, 10);
          const action = match[4];

          // Drag event (button 32, pressed/moving action M)
          if (button === 32 && action === "M") {
            const now = Date.now();
            if (now - lastDragTime.current > 100) {
              if (y <= 4) {
                setScroll((value) => Math.min(maxOffset, value + 1));
                lastDragTime.current = now;
              } else if (y >= viewportH) {
                setScroll((value) => Math.max(0, value - 1));
                lastDragTime.current = now;
              }
            }
          }
        }
      }
    };
    stdin.prependListener("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin, modalActive, maxOffset, mouseMode, viewportH, state.pendingConfirm, secretRequest, overlayOpen]);

  // Key handling
  const onInputRef = useRef<(ch: string, key: any) => void>(undefined as any);
  onInputRef.current = (ch, key) => {
    if (key.backspace && isCtrlHPressed.current) {
      isCtrlHPressed.current = false;
      return;
    }
    // While a confirmation box (sudo/mutating command/plan implement/etc.) is
    // showing, ConfirmModal owns y/n/Esc — but the main transcript behind it
    // should still be scrollable so the user can review context before
    // deciding. Only scroll keys pass through; everything else (including
    // plain text) stays blocked so it can't leak into the confirm prompt.
    // Overlays (pager/picker/jobs) and the secret prompt are excluded here:
    // they render their own content and already handle their own scrolling.
    if (modalActive) {
      if (state.pendingConfirm && !secretRequest && !overlayOpen) {
        if (key.pageUp) {
          setScroll((s) => Math.min(maxOffset, s + viewportH));
          return;
        }
        if (key.pageDown) {
          setScroll((s) => Math.max(0, s - viewportH));
          return;
        }
        if (key.ctrl && ch === "u") {
          setScroll((s) => Math.min(maxOffset, s + Math.floor(viewportH / 2)));
          return;
        }
        if (key.ctrl && ch === "d") {
          setScroll((s) => Math.max(0, s - Math.floor(viewportH / 2)));
          return;
        }
        if (ch === "j" || (key.downArrow && (key.shift || key.ctrl || key.meta))) {
          setScroll((s) => Math.max(0, s - 1));
          return;
        }
        if (ch === "k" || (key.upArrow && (key.shift || key.ctrl || key.meta))) {
          setScroll((s) => Math.min(maxOffset, s + 1));
          return;
        }
      }
      return; // everything else: overlay/modal owns input
    }
    const cleanedChunk = stripMouseReports(ch)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    if (isMouseReport(ch) && cleanedChunk.length === 0) return;

    // Global shortcuts
    if (key.ctrl && ch === "t") {
      dispatch({ type: "toggle-thinking" });
      return;
    }
    if (key.ctrl && ch === "o") {
      const hasOutput = state.items.some(
        (item) =>
          (item.kind === "tool" && Boolean(item.output)) ||
          item.kind === "compacted",
      );
      if (hasOutput) dispatch({ type: "toggle-output" });
      else
        dispatch({
          type: "notice",
          level: "info",
          text: "no tool output or compacted context yet",
        });
      return;
    }
    // Ctrl+H is ASCII backspace (0x08). Depending on the terminal/Ink
    // version it arrives either as ctrl+h or as a backspace key event.
    // A normal Backspace is usually DEL (0x7f), so do not consume that.
    const isPlanToggle =
      (key.ctrl && (ch.toLowerCase() === "h" || ch.toLowerCase() === "b" || key.backspace)) ||
      ch === "\b" ||
      (key as any).sequence === "\x08" ||
      (key as any).sequence === "\b";
    if (isPlanToggle) {
      setPlanPaneVisible((visible) => !visible);
      return;
    }
    if (key.ctrl && ch === "p") {
      void (async () => {
        const plan = await loadPlan(runner.getSession().sessionId).catch(
          () => undefined,
        );
        if (plan)
          setOverlay({
            kind: "pager",
            title: "Plan",
            body: renderPlanDocument(plan),
          });
        else
          dispatch({
            type: "notice",
            level: "info",
            text: "no active plan yet",
          });
      })();
      return;
    }
    if (key.ctrl && ch === "j") {
      setOverlay({ kind: "jobs" });
      return;
    }

    // Scrolling
    if (key.pageUp) {
      setScroll((s) => Math.min(maxOffset, s + viewportH));
      return;
    }
    if (key.pageDown) {
      setScroll((s) => Math.max(0, s - viewportH));
      return;
    }
    if (key.ctrl && ch === "u") {
      setScroll((s) => Math.min(maxOffset, s + Math.floor(viewportH / 2)));
      return;
    }
    if (key.ctrl && ch === "d") {
      setScroll((s) => Math.max(0, s - Math.floor(viewportH / 2)));
      return;
    }
    if (key.upArrow && (key.shift || key.ctrl || key.meta)) {
      setScroll((s) => Math.min(maxOffset, s + 1));
      return;
    }
    if (key.downArrow && (key.shift || key.ctrl || key.meta)) {
      setScroll((s) => Math.max(0, s - 1));
      return;
    }
    if (!input && maxOffset > 0 && ch === "k") {
      setScroll((s) => Math.min(maxOffset, s + 1));
      return;
    }
    if (!input && maxOffset > 0 && ch === "j") {
      setScroll((s) => Math.max(0, s - 1));
      return;
    }

    if (key.escape) {
      if (compacting) {
        cancelCompaction();
        return;
      }
      if (state.outputExpanded) dispatch({ type: "toggle-output" });
      else if (runner.isRunning()) runner.abort();
      else if (input) {
        setInput("");
        setCursor(0);
        setSelected(0);
      }
      return;
    }
    if (key.ctrl && ch === "c") {
      const now = Date.now();
      if (now - lastCtrlC.current < 1500) {
        exitTui();
        return;
      }
      lastCtrlC.current = now;
      if (runner.isRunning()) runner.abort();
      return;
    }

    // Slash menu navigation
    if (menuOpen && (key.upArrow || key.downArrow)) {
      setSelected((s) => {
        const n = slashMenuOpen ? suggestions.length : fileSuggestions.length;
        return key.upArrow ? (s - 1 + n) % n : (s + 1) % n;
      });
      return;
    }
    if (menuOpen && key.tab) {
      if (slashMenuOpen) {
        setInput(suggestions[selected]!.command + " ");
        setCursor(suggestions[selected]!.command.length + 1);
      } else if (mention && fileSuggestions[selected]) {
        const suggestion = fileSuggestions[selected]!;
        const inserted = `@${suggestion.value}${suggestion.isDir ? "" : " "}`;
        const next =
          input.slice(0, mention.start) + inserted + input.slice(cursor);
        setInput(next);
        setCursor(mention.start + inserted.length);
      }
      setSelected(0);
      return;
    }
    // Insert a newline instead of submitting. Works on every OS/terminal:
    // Ctrl+J (universal line feed) and Alt/Option+Enter, plus Shift/Meta+Enter
    // where the terminal reports the modifier. Plain Enter still submits below.
    if (isComposerNewline(ch, key)) {
      const next = input.slice(0, cursor) + "\n" + input.slice(cursor);
      setInput(next);
      setCursor(cursor + 1);
      setSelected(0);
      historyIdx.current = -1;
      historyDraft.current = "";
      return;
    }
    if (key.return) {
      if (slashMenuOpen) {
        submitText(suggestions[selected]!.command);
        return;
      }
      if (fileMenuOpen && mention && fileSuggestions[selected]) {
        const suggestion = fileSuggestions[selected]!;
        const inserted = `@${suggestion.value}${suggestion.isDir ? "" : " "}`;
        const next =
          input.slice(0, mention.start) + inserted + input.slice(cursor);
        setInput(next);
        setCursor(mention.start + inserted.length);
        setSelected(0);
        return;
      }
      submitText(input);
      return;
    }

    // History (when menu closed)
    if (!menuOpen && key.upArrow) {
      if (history.current.length === 0) return;
      if (historyIdx.current < 0) historyDraft.current = input;
      const idx =
        historyIdx.current < 0
          ? history.current.length - 1
          : Math.max(0, historyIdx.current - 1);
      historyIdx.current = idx;
      const v = history.current[idx] ?? "";
      setInput(v);
      setCursor(v.length);
      return;
    }
    if (!menuOpen && key.downArrow) {
      if (historyIdx.current < 0) return;
      const idx = historyIdx.current + 1;
      if (idx >= history.current.length) {
        historyIdx.current = -1;
        const draft = historyDraft.current;
        setInput(draft);
        setCursor(draft.length);
        return;
      }
      historyIdx.current = idx;
      const v = history.current[idx] ?? "";
      setInput(v);
      setCursor(v.length);
      return;
    }

    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(input.length, c + 1));
      return;
    }
    if (key.backspace && (key.ctrl || key.meta)) {
      setInput("");
      setCursor(0);
      setSelected(0);
      historyIdx.current = -1;
      historyDraft.current = "";
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setInput(input.slice(0, cursor - 1) + input.slice(cursor));
      setCursor(cursor - 1);
      setSelected(0);
      historyIdx.current = -1;
      historyDraft.current = "";
      return;
    }
    if (key.ctrl || key.meta) return;
    if (cleanedChunk) {
      setInput(input.slice(0, cursor) + cleanedChunk + input.slice(cursor));
      setCursor(cursor + cleanedChunk.length);
      setSelected(0);
      historyIdx.current = -1;
      historyDraft.current = "";
    }
  };

  const handleInputStable = useCallback((ch: string, key: any) => {
    onInputRef.current?.(ch, key);
  }, []);

  useInput(handleInputStable);

  const closeOverlay = useCallback(() => setOverlay({ kind: "none" }), []);

  // Render
  const timerStart = compacting ? compactStartedAt : state.status.startedAt;
  const elapsed = timerStart
    ? Math.max(0, Math.floor((Date.now() - timerStart) / 1000))
    : 0;

  const before = input.slice(0, cursor);
  const at = input.slice(cursor, cursor + 1) || " ";
  const after = input.slice(cursor + 1);

  const footerInnerWidth = Math.max(20, cols - 6); // outer paddingX(2) + footer paddingX(1)
  const runningBadgeWidth = compacting
    ? " COMPACTING ".length
    : " RUNNING ".length;
  const cancelBadgeWidth = " ESC CANCEL ".length;
  const queuedBadgeWidth =
    state.queued.length > 0 ? ` ${state.queued.length} QUEUED `.length + 1 : 0;
  const scrollBadgeWidth =
    (maxOffset > offset ? ` ▲ ${maxOffset - offset} `.length + 1 : 0) +
    (offset > 0 ? ` ▼ ${offset} `.length + 1 : 0);
  const spinnerWidth = 3; // spinner plus following space
  const fixedRunningFooterWidth =
    runningBadgeWidth +
    1 +
    spinnerWidth +
    1 +
    cancelBadgeWidth +
    queuedBadgeWidth +
    scrollBadgeWidth;
  const runningActivityWidth = Math.max(
    12,
    footerInnerWidth - fixedRunningFooterWidth,
  );
  const rawRunningActivity = `${compacting ? "compacting conversation" : state.status.activity || "working"}${state.status.step > 0 ? ` (step ${state.status.step})` : ""} · ${elapsed}s`;
  const runningActivity = truncateMiddle(
    rawRunningActivity.replace(/\s+/g, " ").trim(),
    runningActivityWidth,
  );

  return (
    <Box flexDirection="column" width={cols} height={usableRows} paddingX={2}>
      {/* Transcript viewport OR overlay */}
      {overlay.kind === "pager" ? (
        <Pager
          title={overlay.title}
          body={overlay.body}
          height={viewportH}
          onClose={closeOverlay}
        />
      ) : overlay.kind === "jobs" ? (
        <JobsPanel jobs={jobs} onClose={closeOverlay} />
      ) : overlay.kind === "picker" ? (
        <PickerPanel
          title={overlay.title}
          options={overlay.options}
          searchDescription={overlay.searchDescription}
          twoLine={overlay.twoLine}
          height={viewportH}
          onSelect={overlay.onSelect}
          onClose={closeOverlay}
        />
      ) : showPlanSidebar && livePlan ? (
        // Compose the transcript and the plan sidebar into a SINGLE column of
        // pre-padded lines. Ink under-measures wide emoji (✅) by one cell when
        // it pads a flex column to fill width, which shoved the sidebar one cell
        // right on emoji rows and bowed its border. Merging each row into one
        // Text (no sibling column for Ink to pad) keeps every border straight.
        <Box flexDirection="column" height={viewportH} width={cols - 6} overflow="hidden">
          {visible.map((line, i) => {
            const cleanLine = line.replace(/\r?\n/g, "");
            const left = padVisible(
              truncateAnsi(cleanLine, transcriptWidth),
              transcriptWidth,
            );
            const right = planSidebarLines[i] ?? "";
            return (
              <Text key={i} wrap="truncate-end">
                {`${left} ${right}`}
              </Text>
            );
          })}
        </Box>
      ) : (
        <Box flexDirection="row" height={viewportH} width={cols - 6} overflow="hidden">
          <Box
            flexDirection="column"
            width={transcriptWidth}
            height={viewportH}
            flexShrink={0}
            overflow="hidden"
          >
            {visible.map((line, i) => {
              const truncated = truncateAnsi(line, transcriptWidth);
              return (
                <Text key={i} wrap="wrap">
                  {truncated === "" ? " " : truncated}
                </Text>
              );
            })}
          </Box>
        </Box>
      )}

      {/* Gap between viewport and composer/status */}
      <Box height={gapH} />

      {/* Slash menu (sits just above the composer) */}
      {slashMenuOpen && !modalActive
        ? visibleSlashSuggestions.map((cmd, i) => {
            const absoluteIndex = slashWindowStart + i;
            return (
              <Text
                key={cmd.command}
                wrap="truncate-end"
                backgroundColor={
                  absoluteIndex === selected
                    ? "#2563EB"
                    : absoluteIndex % 2 === 0
                      ? "#1E293B"
                      : "#0F172A"
                }
              >
                <Text
                  color={absoluteIndex === selected ? "#FFFFFF" : "#67E8F9"}
                  bold
                >
                  {absoluteIndex === selected ? " ❯ " : "   "}
                  {cmd.command.padEnd(14)}
                </Text>
                {cmd.usage ? (
                  <Text
                    color={absoluteIndex === selected ? "#FFFFFF" : "#CBD5E1"}
                  >
                    {cmd.usage}{" "}
                  </Text>
                ) : null}
                <Text color="#F8FAFC">
                  {"  "}
                  {cmd.description}
                </Text>
                {i === visibleSlashSuggestions.length - 1 &&
                slashWindowStart + menuH < suggestions.length ? (
                  <Text
                    dimColor
                  >{`  · ${suggestions.length - slashWindowStart - menuH} more ↓`}</Text>
                ) : null}
              </Text>
            );
          })
        : null}
      {fileMenuOpen && !modalActive
        ? fileSuggestions.map((file, i) => (
            <Text
              key={file.value}
              wrap="truncate-end"
              backgroundColor={
                i === selected ? "#2563EB" : i % 2 === 0 ? "#1E293B" : "#0F172A"
              }
            >
              <Text
                color={
                  i === selected
                    ? "#FFFFFF"
                    : file.isDir
                      ? "#67E8F9"
                      : "#F8FAFC"
                }
                bold={i === selected}
              >
                {i === selected ? "❯ " : "  "}
                {file.isDir ? "▸ " : "· "}
                {file.value}
              </Text>
              <Text dimColor>
                {file.isDir ? "  directory" : "  attach file"}
              </Text>
            </Text>
          ))
        : null}

      {/* Confirm/secret controls sit directly above the composer. */}
      {secretRequest ? (
        <SecretInputPanel
          title={secretRequest.title}
          prompt={secretRequest.prompt}
          onSubmit={(value) => answerSecret(value)}
          onCancel={() => answerSecret(undefined)}
        />
      ) : state.pendingConfirm ? (
        <ConfirmModal
          confirm={state.pendingConfirm}
          onAnswer={answerConfirm}
          overlayOpen={overlayOpen}
          onViewPlan={
            state.pendingConfirm.kind === "plan"
              ? () => {
                  void (async () => {
                    const plan = await loadPlan(
                      runner.getSession().sessionId,
                    ).catch(() => undefined);
                    if (plan)
                      setOverlay({
                        kind: "pager",
                        title: "Plan",
                        body: renderPlanDocument(plan),
                      });
                  })();
                }
              : undefined
          }
        />
      ) : null}

      {/* Composer (pinned bottom) */}
      <Box
        borderStyle="round"
        borderColor={
          state.pendingConfirm || secretRequest
            ? "yellow"
            : state.status.running
              ? "yellow"
              : "cyan"
        }
        paddingX={1}
      >
        <Text color={state.status.running ? "yellow" : "cyan"} bold>
          {state.pendingConfirm || secretRequest ? "! " : "❯ "}
        </Text>
        {secretRequest ? (
          <Text bold>Input locked · complete the secure input above</Text>
        ) : state.pendingConfirm ? (
          <Text bold>
            Input locked · answer the confirmation above with Y or N
          </Text>
        ) : input.length === 0 ? (
          <Text dimColor>
            {state.status.running
              ? "type to queue a message…"
              : `ask anything · / for commands · @file to attach · ${newlineHint()} · esc to cancel`}
          </Text>
        ) : (
          (() => {
            let cursorLineIdx = 0;
            for (let i = 0; i < wrappedInputLines.length; i++) {
              const line = wrappedInputLines[i]!;
              if (cursor >= line.startIdx && cursor <= line.endIdx) {
                cursorLineIdx = i;
                if (cursor === line.startIdx) {
                  break;
                }
              }
            }

            let startLine = Math.max(
              0,
              cursorLineIdx - Math.floor(composerTextH / 2),
            );
            let endLine = Math.min(
              wrappedInputLines.length - 1,
              startLine + composerTextH - 1,
            );
            startLine = Math.max(0, endLine - composerTextH + 1);

            const startCharIdx = wrappedInputLines[startLine]!.startIdx;
            const endCharIdx = wrappedInputLines[endLine]!.endIdx;

            const slicedInput = input.slice(startCharIdx, endCharIdx);
            const slicedCursor = cursor - startCharIdx;
            const beforeSliced = slicedInput.slice(0, slicedCursor);
            const atSliced =
              slicedInput.slice(slicedCursor, slicedCursor + 1) || " ";
            const afterSliced = slicedInput.slice(slicedCursor + 1);

            return (
              <Text wrap="wrap">
                <Text color="#F8FAFC">{beforeSliced}</Text>
                <Text backgroundColor="#22D3EE" color="#020617" bold>
                  {atSliced}
                </Text>
                <Text color="#F8FAFC">{afterSliced}</Text>
              </Text>
            );
          })()
        )}
      </Box>

      {/* Persistent chrome belongs below the input, separate from conversation content. */}
      {!secretRequest && !state.pendingConfirm ? (
        <Box paddingX={1} justifyContent="center">
          {state.status.running || compacting ? (
            <>
              <Text backgroundColor="#B45309" color="#FFFFFF" bold>
                {" "}
                {compacting ? "COMPACTING" : "RUNNING"}{" "}
              </Text>
              <Text> </Text>
              <Text color="magenta">{spinner} </Text>
              <Box width={runningActivityWidth} flexShrink={1}>
                <Text color="yellow" wrap="truncate-end">
                  {runningActivity}
                </Text>
              </Box>
              <Text> </Text>
              <Text backgroundColor="#334155" color="#F8FAFC">
                {" "}
                ESC CANCEL{" "}
              </Text>
              {state.queued.length > 0 ? (
                <>
                  <Text> </Text>
                  <Text
                    backgroundColor="#854D0E"
                    color="#FFFFFF"
                    bold
                  >{` ${state.queued.length} QUEUED `}</Text>
                </>
              ) : null}
            </>
          ) : (
            <>
              <Text backgroundColor="#166534" color="#FFFFFF" bold>
                {" "}
                READY{" "}
              </Text>
              {state.queued.length > 0 ? (
                <Text
                  backgroundColor="#854D0E"
                  color="#FFFFFF"
                  bold
                >{` ${state.queued.length} QUEUED `}</Text>
              ) : null}
              <Text> </Text>
              <Text backgroundColor="#334155" color="#F8FAFC">
                {" "}
                / COMMANDS{" "}
              </Text>
              <Text> </Text>
              <Text backgroundColor="#334155" color="#F8FAFC">
                {" "}
                CTRL+T THINKING{" "}
              </Text>
              <Text> </Text>
              <Text backgroundColor="#334155" color="#F8FAFC">
                {" "}
                CTRL+O OUTPUT{" "}
              </Text>
              {livePlan ? (
                <>
                  <Text> </Text>
                  <Text
                    backgroundColor={planPaneVisible ? "#7E22CE" : "#334155"}
                    color="#F8FAFC"
                  >{` CTRL+H PLAN ${planPaneVisible ? "ON" : "OFF"} `}</Text>
                </>
              ) : null}
              <Text> </Text>
              <Text
                backgroundColor={mouseMode ? "#155E75" : "#334155"}
                color="#F8FAFC"
              >{` MOUSE ${mouseMode ? "ON" : "OFF"} `}</Text>
            </>
          )}
          {maxOffset > offset ? (
            <>
              <Text> </Text>
              <Text
                backgroundColor="#854D0E"
                color="#FFFFFF"
                bold
              >{` ▲ ${maxOffset - offset} `}</Text>
            </>
          ) : null}
          {offset > 0 ? (
            <>
              <Text> </Text>
              <Text
                backgroundColor="#854D0E"
                color="#FFFFFF"
                bold
              >{` ▼ ${offset} `}</Text>
            </>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
