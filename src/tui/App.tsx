import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Mode, ProviderId, ReasoningEffort } from "../types.js";
import { providerIds } from "../types.js";
import { assertProvider } from "../llm/provider.js";
import { getProvider } from "../llm/router.js";
import { envValue, getProviderSecret, getSearchProviderKey, listProviderStatuses, maskSecret, setProviderSecret } from "../store/keys.js";
import { searchProviderIds } from "../tools/web/types.js";
import { modelSupportsThinking, modelSupportsVision } from "../llm/capabilities.js";
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
import { clearAllHistory, getSession, listSessions, saveSession } from "../store/history.js";
import { safeCwd } from "../os/cwd.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expandMentions, findFileSuggestions, getMentionQuery, loadImageAttachments, type FileSuggestion } from "../ui/mentions.js";
import { deletePlan, loadPlan, savePlan } from "../store/plan.js";
import { renderPlanDocument } from "../ui/plan-pane.js";
import { getSlashCommandSuggestions, isKnownSlashCommand, knownModels, slashCommands, type SlashCommand } from "../repl.js";
import { initialState, reducer, serializeTranscriptForCompaction, type ToolItem } from "./state.js";
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
import { clearArtifacts, clearAuditLogs } from "../store/logs.js";
import { addScopeTargets, clearScope, loadScope, saveScope } from "../store/scope.js";
import { formatKeyStatus } from "./format-keys.js";

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
  | { kind: "picker"; title: string; options: PickerOption[]; onSelect: (value: string) => void };

export function App({ version, initialMode, provider: initialProvider, initialModel, noHistory = false }: AppProps) {
  const { exit } = useApp();
  const { columns: cols, rows } = useTerminalSize();
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [provider, setProvider] = useState<ProviderId>(initialProvider);
  const [model, setModel] = useState<string>(initialModel);
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  const [secretRequest, setSecretRequest] = useState<{ title: string; prompt: string } | undefined>();
  const secretResolver = useRef<((value: string | undefined) => void) | undefined>();
  const [scroll, setScroll] = useState(0); // lines scrolled up from bottom
  const [compacting, setCompacting] = useState(false);
  const history = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const historyDraft = useRef("");
  const lastCtrlC = useRef(0);
  const jobs = useJobs(overlay.kind === "jobs");
  const spinner = useSpinner(state.status.running);

  // ── Confirm port → in-app modal ────────────────────────────────────────────
  const confirmController = useMemo(() => createTuiConfirmPort(), []);
  const confirmResolver = useRef<((ok: boolean) => void) | undefined>(undefined);
  useEffect(() => {
    confirmController.setHandler(
      (req) =>
        new Promise<boolean>((res) => {
          confirmResolver.current = res;
          dispatch({ type: "event", event: { type: "confirm-request", id: "c", ...req } });
        }),
    );
  }, [confirmController]);

  const ctxRef = useRef({ mode, provider, model });
  ctxRef.current = { mode, provider, model };
  const requestSecret = useCallback((request: { title: string; prompt: string }) =>
    new Promise<string | undefined>((resolveSecret) => {
      secretResolver.current = resolveSecret;
      setSecretRequest(request);
    }), []);
  const runner = useAgentRunner({
    dispatchEvent: (event) => dispatch({ type: "event", event }),
    confirm: confirmController.port,
    getContext: useCallback(() => ctxRef.current, []),
    requestSecret,
  });

  const exitTui = useCallback(() => {
    void (async () => {
      const messages = runner.getMessages();
      if (!noHistory && !getConfig().privateMode && messages.length > 0) {
        await saveSession(messages, undefined, state.items).catch(() => undefined);
      }
      exit();
    })();
  }, [exit, noHistory, runner, state.items]);

  const startTurn = useCallback(
    async (display: string, modelInput: string, images?: ReturnType<typeof loadImageAttachments>) => {
      setScroll(0);
      dispatch({ type: "submit", text: display });
      await runner.run(modelInput, images && images.length > 0 ? { images } : undefined);
    },
    [runner],
  );

  const beginTurn = useCallback(
    (rawText: string) => {
      const vision = modelSupportsVision(provider, model);
      const expansion = expandMentions(rawText, safeCwd(), vision);
      const images = vision ? loadImageAttachments(rawText, safeCwd()) : [];
      const modelInput = expansion.contextBlock ? `${rawText}\n\n${expansion.contextBlock}` : rawText;
      void startTurn(rawText, modelInput, images);
    },
    [provider, model, startTurn],
  );

  useEffect(() => {
    if (!state.status.running && state.queued.length > 0 && !runner.isRunning()) {
      const next = state.queued[0]!;
      dispatch({ type: "dequeue" });
      beginTurn(next);
    }
  }, [state.status.running, state.queued, runner, beginTurn]);

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
      dispatch({ type: "notice", level: "info", text: "no plan to implement — ask clai to plan a multi-step task first" });
      return;
    }
    if (plan.tasks.every((t) => t.state === "done")) {
      dispatch({ type: "notice", level: "info", text: "this plan is already complete ✓" });
      return;
    }
    plan.status = "approved";
    await savePlan(plan).catch(() => undefined);
    session.planApproved.value = true;
    dispatch({ type: "notice", level: "info", text: "✦ plan approved — executing it now" });
    void startTurn("/implement", IMPLEMENT_PROMPT);
  }, [runner, startTurn]);

  const chooseModel = useCallback(() => {
    const models = knownModels[provider] ?? [model];
    setOverlay({
      kind: "picker",
      title: `Models · ${provider}`,
      options: models.map((value) => ({ value, label: value, active: value === model })),
      onSelect: (value) => {
        setModel(value);
        setProviderModel(provider, value);
        setOverlay({ kind: "none" });
        dispatch({ type: "notice", level: "info", text: `model → ${value}` });
      },
    });
  }, [model, provider]);

  const activateProvider = useCallback(async (next: ProviderId): Promise<void> => {
    const configured = next === "ollama" || Boolean(envValue(next)) || Boolean((await getProviderSecret(next)).value);
    if (!configured) {
      const key = await requestSecret({
        title: `${next} API key`,
        prompt: `No API key is configured for ${next}. Enter it now to activate this provider.`,
      });
      if (!key) {
        dispatch({ type: "notice", level: "warn", text: `provider unchanged · ${next} needs an API key` });
        return;
      }
      if (!getProvider(next).validateKey(key)) {
        dispatch({ type: "notice", level: "warn", text: `invalid API key format for ${next}` });
        return;
      }
      await setProviderSecret(next, key);
    }
    const nextModel = getProviderModel(next);
    setDefaultProvider(next);
    setProvider(next);
    setModel(nextModel);
    setOverlay({ kind: "none" });
    dispatch({ type: "notice", level: "info", text: `provider → ${next} · model → ${nextModel}` });
  }, [requestSecret]);

  const chooseProvider = useCallback(() => {
    setOverlay({
      kind: "picker",
      title: "Providers",
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

  const setReasoning = useCallback((value: string) => {
    if (value === "off" || value === "none") setThinking({ enabled: false });
    else setThinking({ enabled: true, effort: value as ReasoningEffort });
    dispatch({
      type: "notice",
      level: "info",
      text: value === "off" || value === "none" ? "thinking → off" : `thinking → ${value}`,
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
      const info = (t: string) => dispatch({ type: "notice", level: "info", text: t });
      const warn = (t: string) => dispatch({ type: "notice", level: "warn", text: t });
      switch (cmd) {
        case "/ask": setMode("ask"); setDefaultMode("ask"); info("mode → ask"); return true;
        case "/agent": setMode("agent"); setDefaultMode("agent"); info("mode → agent"); return true;
        case "/clear": runner.reset(); dispatch({ type: "reset" }); info("context cleared"); return true;
        case "/new":
          void (async () => {
            const messages = runner.getMessages();
            if (!noHistory && !getConfig().privateMode && messages.length > 0) await saveSession(messages, undefined, state.items).catch(() => undefined);
            runner.reset(); dispatch({ type: "reset" }); info("fresh session started");
          })();
          return true;
        case "/clean": runner.reset(); dispatch({ type: "reset" }); info("fresh session started"); return true;
        case "/think":
        case "/thinking": dispatch({ type: "toggle-thinking" }); return true;
        case "/implement":
          if (runner.isRunning()) warn("a turn is already running");
          else void runImplement();
          return true;
        case "/plan":
          void (async () => {
            const plan = await loadPlan(runner.getSession().sessionId).catch(() => undefined);
            if (!plan) info("no active plan yet");
            else setOverlay({ kind: "pager", title: "Plan", body: renderPlanDocument(plan) });
          })();
          return true;
        case "/jobs": setOverlay({ kind: "jobs" }); return true;
        case "/output": {
          const outputs = state.items.filter((item): item is ToolItem => item.kind === "tool" && Boolean(item.output));
          if (arg === "list" || arg === "ls") {
            info(outputs.length ? outputs.map((item) => `${item.id} · ${item.name}`).join("\n") : "no tool output yet");
            return true;
          }
          const selectedOutput = arg && arg !== "last" ? outputs.find((item) => item.id === arg) : lastToolOutput();
          if (!selectedOutput) info(arg ? `no tool output: ${arg}` : "no tool output yet");
          else void openToolOutput(selectedOutput);
          return true;
        }
        case "/model":
          if (!arg || arg === "list" || arg === "ls") { chooseModel(); return true; }
          {
            const options = knownModels[provider] ?? [];
            const index = Number.parseInt(arg, 10);
            const nextModel = Number.isInteger(index) && index >= 1 && index <= options.length ? options[index - 1]! : arg;
            setModel(nextModel); setProviderModel(provider, nextModel); info(`model → ${nextModel}`); return true;
          }
        case "/provider":
        case "/use":
          if (!arg) { chooseProvider(); return true; }
          try {
            const next = assertProvider(arg);
            void activateProvider(next);
          } catch { warn(`unknown provider: ${arg}`); }
          return true;
        case "/variants":
        case "/reasoning": {
          if (!arg) { chooseReasoning(); return true; }
          const value = arg.toLowerCase();
          if (/^(on|enable|true)$/.test(value)) {
            setThinking({ enabled: true });
            info(`thinking → ${getConfig().thinking.effort}`);
          } else if (["off", "none", "disable", "false"].includes(value)) {
            setReasoning("off");
          } else if (["minimal", "low", "medium", "high", "xhigh"].includes(value)) {
            setReasoning(value);
          } else warn("usage: /variants [on|off|minimal|low|medium|high|xhigh]");
          return true;
        }
        case "/cwd": {
          if (!arg) { info(`cwd: ${safeCwd()}`); return true; }
          const target = resolve(safeCwd(), arg);
          if (!existsSync(target)) { warn(`no such directory: ${target}`); return true; }
          try { process.chdir(target); info(`cwd → ${target}`); }
          catch (e) { warn(`could not chdir: ${e instanceof Error ? e.message : String(e)}`); }
          return true;
        }
        case "/allow":
          if (!arg || arg === "list" || arg === "ls") {
            const list = [...runner.getSession().allow];
            info(list.length ? `allowed: ${list.join(", ")}` : "no session allowances");
            return true;
          }
          runner.getSession().allow.add(arg); info(`allowed for session: ${arg}`); return true;
        case "/disallow":
          if (arg) runner.getSession().allow.delete(arg);
          info(arg ? `disallowed: ${arg}` : "usage: /disallow <tool>"); return true;
        case "/context": {
          const msgs = runner.getMessages();
          info(`context: ${msgs.length} messages · ~${estimateMessagesTokens(msgs)} tokens`);
          return true;
        }
        case "/compact": {
          if (runner.isRunning() || compacting) { warn("wait for the current operation to finish"); return true; }
          setCompacting(true);
          info("compacting conversation…");
          const fullSession = serializeTranscriptForCompaction(state.items);
          void runner.compact(fullSession).then((result) => {
            if (result.after === result.before) {
              info("nothing to compact yet — more than 8 recent messages are required");
            } else {
              info(`compacted ${result.before} → ${result.after} messages · ~${result.beforeTokens.toLocaleString()} → ~${result.afterTokens.toLocaleString()} tokens${result.summarized ? "" : " · local fallback"}`);
            }
          }).catch((error) => warn(`compaction failed: ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => setCompacting(false));
          return true;
        }
        case "/save":
          void (async () => {
            const msgs = runner.getMessages();
            if (msgs.length === 0) { info("nothing to save yet"); return; }
            const rec = await saveSession(msgs, arg || undefined, state.items).catch(() => undefined);
            info(rec ? `saved session ${rec.id}` : "save failed");
          })();
          return true;
        case "/history":
          void (async () => {
            const sessions = await listSessions(50);
            const currentMessages = runner.getMessages();
            if (sessions.length === 0 && currentMessages.length === 0) { info("no session history yet"); return; }
            setOverlay({
              kind: "picker",
              title: "Session history",
              options: [
                ...(currentMessages.length ? [{
                  value: "__current__",
                  label: "Current session",
                  description: `${currentMessages.length} messages · active now`,
                  active: true,
                }] : []),
                ...sessions.map((session) => ({
                  value: session.id,
                  label: session.name ?? session.id,
                  description: `${session.createdAt.slice(0, 16).replace("T", " ")} · ${session.transcript?.length ?? session.messages.length} items`,
                })),
              ],
              onSelect: (id) => {
                void (async () => {
                  if (id === "__current__") {
                    setOverlay({ kind: "none" });
                    info("showing current session");
                    return;
                  }
                  const session = await getSession(id);
                  if (!session) { warn("session not found"); return; }
                  runner.setMessages(session.messages);
                  setOverlay({ kind: "none" });
                  dispatch({ type: "load-history", messages: session.messages, transcript: session.transcript });
                  setScroll(0);
                  info(`session resumed · ${session.transcript?.length ?? session.messages.length} items`);
                })();
              },
            });
          })();
          return true;
        case "/reset":
          void clearAllHistory().then((result) => info(`history cleared · ${result.detail || "ok"}`));
          return true;
        case "/discard":
          void (async () => {
            const session = runner.getSession();
            const plan = await loadPlan(session.sessionId).catch(() => undefined);
            if (!plan) { info("no active plan to discard"); return; }
            await deletePlan(session.sessionId);
            session.planApproved.value = false;
            info(`plan discarded · ${plan.goal}`);
          })();
          return true;
        case "/scope":
          void (async () => {
            const [sub = "show", ...parts] = arg.split(/\s+/).filter(Boolean);
            if (["clear", "reset", "off"].includes(sub)) {
              await clearScope(); info("engagement scope cleared"); return;
            }
            if (sub === "show" || sub === "list" || sub === "ls") {
              const scope = await loadScope();
              info(scope ? `scope: ${scope.name ?? "unnamed"} · ${scope.authorizedTargets.join(", ")}` : "no engagement scope configured");
              return;
            }
            if (sub === "add") {
              const targets = parts.join(" ").split(/[\s,]+/).filter(Boolean);
              if (!targets.length) { warn("usage: /scope add <target1,target2>"); return; }
              const scope = await addScopeTargets(targets);
              info(`scope updated · ${scope.authorizedTargets.join(", ")}`); return;
            }
            if (sub === "new" || sub === "set") {
              const targets = parts.join(" ").split(/[\s,]+/).filter(Boolean);
              if (!targets.length) { warn("usage: /scope new <target1,target2>"); return; }
              await saveScope({ authorizedTargets: targets, createdAt: new Date().toISOString() });
              info(`scope created · ${targets.join(", ")}`); return;
            }
            warn("usage: /scope [show|clear|new <targets>|add <targets>]");
          })().catch((error) => warn(error instanceof Error ? error.message : String(error)));
          return true;
        case "/privacy":
          void (async () => {
            const sub = (arg || "status").toLowerCase();
            if (["on", "enable"].includes(sub)) { updateConfig({ privateMode: true }); info("private mode → on"); return; }
            if (["off", "disable"].includes(sub)) { updateConfig({ privateMode: false }); info("private mode → off"); return; }
            if (sub === "status") { info(`private mode: ${getConfig().privateMode ? "on" : "off"}`); return; }
            if (sub === "clear-history") { const result = await clearAllHistory(); info(`history cleared · ${result.detail || "ok"}`); return; }
            if (sub === "clear-logs") { const result = await clearAuditLogs(); info(`audit logs cleared · ${result.removed} files`); return; }
            if (sub === "clear-artifacts") { const result = await clearArtifacts(); info(`artifacts cleared · ${result.removed} files`); return; }
            if (sub === "clear-all") {
              const [historyResult, logResult, artifactResult] = await Promise.all([clearAllHistory(), clearAuditLogs(), clearArtifacts()]);
              info(`cleared history (${historyResult.detail || "ok"}), logs (${logResult.removed}), artifacts (${artifactResult.removed})`); return;
            }
            warn("usage: /privacy [status|on|off|clear-history|clear-logs|clear-artifacts|clear-all]");
          })();
          return true;
        case "/freeonly": {
          const on = /^(on|true|1|enable)$/i.test(arg), off = /^(off|false|0|disable)$/i.test(arg);
          if (!on && !off) { info(`freeOnly=${getConfig().freeOnly}`); return true; }
          updateConfig({ freeOnly: on }); info(`freeOnly=${on}`); return true;
        }
        case "/fallback": {
          const on = /^(on|true|1|enable)$/i.test(arg), off = /^(off|false|0|disable)$/i.test(arg);
          if (!on && !off) { info(`providerFallback=${getConfig().providerFallback}`); return true; }
          updateConfig({ providerFallback: on }); info(`providerFallback=${on}`); return true;
        }
        case "/keys":
          void (async () => {
            const llm = await listProviderStatuses(provider);
            const activeSearch = getConfig().activeSearchProvider;
            const search = await Promise.all(searchProviderIds.map(async (id) => {
              const secret = await getSearchProviderKey(id);
              const keyless = id === "duckduckgo";
              return {
                provider: id,
                active: id === activeSearch,
                configured: keyless || Boolean(secret.value),
                source: keyless ? "keyless" : secret.source,
                maskedKey: secret.value ? maskSecret(secret.value) : undefined,
              };
            }));
            setOverlay({ kind: "pager", title: "Credential status", body: formatKeyStatus(llm, search) });
          })().catch((error) => warn(`could not read keys: ${error instanceof Error ? error.message : String(error)}`));
          return true;
        case "/set":
        case "/unset":
        case "/update":
          info(`${cmd} manages external credentials or updates; use the equivalent \`clai ${cmd.slice(1)}\` command outside the TUI`);
          return true;
        case "/help":
          setOverlay({ kind: "pager", title: "Commands", body: slashCommands.map((item) => `${item.command}${item.usage ? ` ${item.usage}` : ""}\n  ${item.description}`).join("\n\n") });
          return true;
        case "/exit":
        case "/quit": exitTui(); return true;
        default: return false;
      }
    },
    [activateProvider, chooseModel, chooseProvider, chooseReasoning, compacting, exitTui, noHistory, provider, runner, runImplement, lastToolOutput, openToolOutput, setReasoning, state.items],
  );

  const submitText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      history.current.push(text);
      historyIdx.current = -1;
      historyDraft.current = "";
      setInput("");
      setCursor(0);
      setSelected(0);
      // A macOS/Linux drag-and-drop commonly starts with an absolute path.
      // Only route a leading slash through the command handler when its first
      // token is an actual clai command; file paths remain normal prompts.
      if (trimmed.startsWith("/") && isKnownSlashCommand(trimmed)) {
        if (!handleLocalSlash(trimmed)) dispatch({ type: "notice", level: "warn", text: `unknown command: ${trimmed}` });
        return;
      }
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

  // ── Layout math (keep the composer pinned to the bottom) ────────────────────
  const suggestions: SlashCommand[] = input.startsWith("/")
    ? getSlashCommandSuggestions(input)
    : [];
  const mention = getMentionQuery(input, cursor);
  const fileSuggestions: FileSuggestion[] = mention
    ? findFileSuggestions(mention.query, safeCwd(), MAX_FILE_SUGGESTIONS)
    : [];
  const slashMenuOpen = suggestions.length > 0;
  const fileMenuOpen = !slashMenuOpen && Boolean(mention) && fileSuggestions.length > 0;
  const menuOpen = slashMenuOpen || fileMenuOpen;
  const overlayOpen = overlay.kind !== "none";
  const modalActive = Boolean(state.pendingConfirm) || Boolean(secretRequest) || overlayOpen;

  // Leave the terminal's final row unused. Painting through the last cell can
  // trigger an implicit scroll in several terminals, which looks like a full
  // screen flash on every keypress/spinner frame.
  const usableRows = Math.max(8, rows - 1);
  const headerH = 4;
  const statusH = state.pendingConfirm ? 6 : secretRequest ? 7 : 1;
  const composerH = 3;
  const maxMenuRows = Math.max(3, usableRows - headerH - statusH - composerH - 3);
  const menuH = slashMenuOpen ? Math.min(suggestions.length, maxMenuRows) : fileMenuOpen ? fileSuggestions.length : 0;
  const viewportH = Math.max(3, usableRows - headerH - statusH - composerH - menuH);
  const slashWindowStart = slashMenuOpen
    ? Math.min(
        Math.max(0, selected - Math.floor(menuH / 2)),
        Math.max(0, suggestions.length - menuH),
      )
    : 0;
  const visibleSlashSuggestions = suggestions.slice(slashWindowStart, slashWindowStart + menuH);

  const transcriptLines = renderTranscriptLines(state, {
    width: cols,
    thinkingExpanded: state.thinkingExpanded,
    outputExpanded: state.outputExpanded,
    running: state.status.running,
  });
  const total = transcriptLines.length;
  const maxOffset = Math.max(0, total - viewportH);
  const offset = Math.min(scroll, maxOffset);
  const end = total - offset;
  const start = Math.max(0, end - viewportH);
  let visible = transcriptLines.slice(start, end);
  if (visible.length < viewportH) {
    visible = [...Array(viewportH - visible.length).fill(""), ...visible];
  }

  // ── Key handling ────────────────────────────────────────────────────────────
  useInput((ch, key) => {
    if (modalActive) return; // overlay/modal owns input

    // Global shortcuts
    if (key.ctrl && ch === "t") { dispatch({ type: "toggle-thinking" }); return; }
    if (key.ctrl && ch === "o") {
      const last = lastToolOutput();
      if (last) void openToolOutput(last);
      else dispatch({ type: "notice", level: "info", text: "no tool output yet" });
      return;
    }
    if (key.ctrl && ch === "p") {
      void (async () => {
        const plan = await loadPlan(runner.getSession().sessionId).catch(() => undefined);
        if (plan) setOverlay({ kind: "pager", title: "Plan", body: renderPlanDocument(plan) });
        else dispatch({ type: "notice", level: "info", text: "no active plan yet" });
      })();
      return;
    }
    if (key.ctrl && ch === "j") { setOverlay({ kind: "jobs" }); return; }

    // Scrolling
    if (key.pageUp) { setScroll((s) => Math.min(maxOffset, s + viewportH)); return; }
    if (key.pageDown) { setScroll((s) => Math.max(0, s - viewportH)); return; }
    if (key.ctrl && ch === "u") { setScroll((s) => Math.min(maxOffset, s + Math.floor(viewportH / 2))); return; }
    if (key.ctrl && ch === "d") { setScroll((s) => Math.max(0, s - Math.floor(viewportH / 2))); return; }
    if (!input && maxOffset > 0 && ch === "k") {
      setScroll((s) => Math.min(maxOffset, s + 1));
      return;
    }
    if (!input && maxOffset > 0 && ch === "j") {
      setScroll((s) => Math.max(0, s - 1));
      return;
    }

    if (key.escape) {
      if (runner.isRunning()) runner.abort();
      else if (input) { setInput(""); setCursor(0); setSelected(0); }
      return;
    }
    if (key.ctrl && ch === "c") {
      if (runner.isRunning()) { runner.abort(); return; }
      const now = Date.now();
      if (now - lastCtrlC.current < 1500) exitTui();
      else lastCtrlC.current = now;
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
        const next = input.slice(0, mention.start) + inserted + input.slice(cursor);
        setInput(next);
        setCursor(mention.start + inserted.length);
      }
      setSelected(0);
      return;
    }
    if (key.return) {
      if (slashMenuOpen) { submitText(suggestions[selected]!.command); return; }
      if (fileMenuOpen && mention && fileSuggestions[selected]) {
        const suggestion = fileSuggestions[selected]!;
        const inserted = `@${suggestion.value}${suggestion.isDir ? "" : " "}`;
        const next = input.slice(0, mention.start) + inserted + input.slice(cursor);
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
      const idx = historyIdx.current < 0 ? history.current.length - 1 : Math.max(0, historyIdx.current - 1);
      historyIdx.current = idx;
      const v = history.current[idx] ?? "";
      setInput(v); setCursor(v.length);
      return;
    }
    if (!menuOpen && key.downArrow) {
      if (historyIdx.current < 0) return;
      const idx = historyIdx.current + 1;
      if (idx >= history.current.length) {
        historyIdx.current = -1;
        const draft = historyDraft.current;
        setInput(draft); setCursor(draft.length);
        return;
      }
      historyIdx.current = idx;
      const v = history.current[idx] ?? "";
      setInput(v); setCursor(v.length);
      return;
    }

    if (key.leftArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.rightArrow) { setCursor((c) => Math.min(input.length, c + 1)); return; }
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
    if (ch) {
      setInput(input.slice(0, cursor) + ch + input.slice(cursor));
      setCursor(cursor + ch.length);
      setSelected(0);
      historyIdx.current = -1;
      historyDraft.current = "";
    }
  });

  const closeOverlay = useCallback(() => setOverlay({ kind: "none" }), []);

  // ── Render ───────────────────────────────────────────────────────────────────
  const elapsed = state.status.startedAt
    ? Math.max(0, Math.floor((Date.now() - state.status.startedAt) / 1000))
    : 0;

  const before = input.slice(0, cursor);
  const at = input.slice(cursor, cursor + 1) || " ";
  const after = input.slice(cursor + 1);

  return (
    <Box flexDirection="column" width={cols} height={usableRows}>
      {/* Header */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        marginX={2}
        paddingX={1}
      >
        <Box justifyContent="space-between">
          <Text><Text backgroundColor="#2563EB" color="#FFFFFF" bold> ◆ clai </Text><Text color="#94A3B8">  v{version}</Text></Text>
          <Text><Text backgroundColor="#854D0E" color="#FFFFFF" bold>{` ${mode.toUpperCase()} `}</Text><Text color="#94A3B8"> MODE</Text></Text>
        </Box>
        <Text wrap="truncate-end">
          <Text color="green">{provider}</Text><Text dimColor>  /  </Text><Text color="cyan">{model}</Text>
          <Text dimColor>{`  ·  ${safeCwd()}`}</Text>
          {offset > 0 ? <Text color="yellow">{`  ·  ▲ ${offset}`}</Text> : null}
        </Text>
      </Box>

      {/* Transcript viewport OR overlay */}
      {overlay.kind === "pager" ? (
        <Pager title={overlay.title} body={overlay.body} height={viewportH} onClose={closeOverlay} />
      ) : overlay.kind === "jobs" ? (
        <JobsPanel jobs={jobs} onClose={closeOverlay} />
      ) : overlay.kind === "picker" ? (
        <PickerPanel title={overlay.title} options={overlay.options} height={viewportH} onSelect={overlay.onSelect} onClose={closeOverlay} />
      ) : (
        <Box flexDirection="column" height={viewportH}>
          {visible.map((line, i) => (
            <Text key={i} wrap="truncate-end">
              {line === "" ? " " : line}
            </Text>
          ))}
        </Box>
      )}

      {/* Slash menu (sits just above the composer) */}
      {slashMenuOpen && !modalActive
        ? visibleSlashSuggestions.map((cmd, i) => {
            const absoluteIndex = slashWindowStart + i;
            return (
            <Text key={cmd.command} wrap="truncate-end" backgroundColor={absoluteIndex === selected ? "#2563EB" : absoluteIndex % 2 === 0 ? "#1E293B" : "#0F172A"}>
              <Text color={absoluteIndex === selected ? "#FFFFFF" : "#67E8F9"} bold>
                {absoluteIndex === selected ? " ❯ " : "   "}
                {cmd.command.padEnd(14)}
              </Text>
              {cmd.usage ? <Text color={absoluteIndex === selected ? "#FFFFFF" : "#CBD5E1"}>{cmd.usage} </Text> : null}
              <Text color="#F8FAFC">{"  "}{cmd.description}</Text>
              {i === visibleSlashSuggestions.length - 1 && slashWindowStart + menuH < suggestions.length
                ? <Text dimColor>{`  · ${suggestions.length - slashWindowStart - menuH} more ↓`}</Text>
                : null}
            </Text>
            );
          })
        : null}
      {fileMenuOpen && !modalActive
        ? fileSuggestions.map((file, i) => (
            <Text key={file.value} wrap="truncate-end" backgroundColor={i === selected ? "#2563EB" : i % 2 === 0 ? "#1E293B" : "#0F172A"}>
              <Text color={i === selected ? "#FFFFFF" : file.isDir ? "#67E8F9" : "#F8FAFC"} bold={i === selected}>
                {i === selected ? "❯ " : "  "}{file.isDir ? "▸ " : "· "}{file.value}
              </Text>
              <Text dimColor>{file.isDir ? "  directory" : "  attach file"}</Text>
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
        <ConfirmModal confirm={state.pendingConfirm} onAnswer={answerConfirm} />
      ) : (
        <Box>
          {compacting ? (
            <Text><Text color="magenta">{spinner} </Text><Text color="yellow">compacting conversation…</Text></Text>
          ) : state.status.running ? (
            <Text>
              <Text color="magenta">{spinner} </Text>
              <Text color="yellow">{state.status.activity || "working"}</Text>
              {state.status.step > 0 ? <Text dimColor>{` · step ${state.status.step}`}</Text> : null}
              <Text dimColor>{` · ${elapsed}s · esc to cancel`}</Text>
              {state.queued.length > 0 ? <Text dimColor>{` · ${state.queued.length} queued`}</Text> : null}
            </Text>
          ) : null}
        </Box>
      )}

      {/* Composer (pinned bottom) */}
      <Box borderStyle="round" borderColor={state.pendingConfirm || secretRequest ? "yellow" : state.status.running ? "yellow" : "magenta"} paddingX={1}>
        <Text color={state.status.running ? "yellow" : "magenta"} bold>
          {state.pendingConfirm || secretRequest ? "! " : "❯ "}
        </Text>
        {secretRequest ? (
          <Text bold>Input locked · complete the secure input above</Text>
        ) : state.pendingConfirm ? (
          <Text bold>Input locked · answer the confirmation above with Y or N</Text>
        ) : input.length === 0 ? (
          <Text dimColor>
            {state.status.running
              ? "type to queue a message…"
              : "ask anything · / for commands · @file to attach · esc to cancel"}
          </Text>
        ) : (
          <Text wrap="truncate-start">
            {before}
            <Text inverse>{at}</Text>
            {after}
          </Text>
        )}
      </Box>

      {/* Persistent chrome belongs below the input, separate from conversation content. */}
      {!secretRequest && !state.pendingConfirm && !state.status.running && !compacting ? (
        <Box paddingX={1}>
          <Text backgroundColor="#166534" color="#FFFFFF" bold> READY </Text>
          {state.queued.length > 0 ? <Text backgroundColor="#854D0E" color="#FFFFFF" bold>{` ${state.queued.length} QUEUED `}</Text> : null}
          <Text> </Text>
          <Text backgroundColor="#334155" color="#F8FAFC"> / COMMANDS </Text>
          <Text> </Text>
          <Text backgroundColor="#334155" color="#F8FAFC"> CTRL+T THINKING </Text>
          <Text> </Text>
          <Text backgroundColor="#334155" color="#F8FAFC"> CTRL+O OUTPUT </Text>
        </Box>
      ) : null}
    </Box>
  );
}
