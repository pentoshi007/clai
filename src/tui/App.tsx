import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Mode, ProviderId } from "../types.js";
import { assertProvider } from "../llm/provider.js";
import { modelSupportsVision } from "../llm/capabilities.js";
import {
  getConfig,
  getProviderModel,
  setDefaultMode,
  setProviderModel,
  updateConfig,
} from "../store/config.js";
import { estimateMessagesTokens } from "../agent/context-manager.js";
import { saveSession } from "../store/history.js";
import { safeCwd } from "../os/cwd.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { expandMentions, loadImageAttachments } from "../ui/mentions.js";
import { loadPlan, savePlan } from "../store/plan.js";
import { renderPlanDocument } from "../ui/plan-pane.js";
import { initialState, reducer, splitItems, type ToolItem } from "./state.js";
import { createTuiConfirmPort } from "./confirm.js";
import { useAgentRunner } from "./hooks/useAgentRunner.js";
import { useJobs } from "./hooks/useJobs.js";
import { Header } from "./components/Header.js";
import { ItemView } from "./components/items.js";
import { StatusLine } from "./components/StatusLine.js";
import { Composer } from "./components/Composer.js";
import { ConfirmModal } from "./components/ConfirmModal.js";
import { Pager } from "./components/Pager.js";
import { JobsPanel } from "./components/JobsPanel.js";

export interface AppProps {
  version: string;
  initialMode: Mode;
  provider: ProviderId;
  initialModel: string;
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

type Overlay =
  | { kind: "none" }
  | { kind: "pager"; title: string; body: string }
  | { kind: "jobs" };

export function App({ version, initialMode, provider: initialProvider, initialModel }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [provider, setProvider] = useState<ProviderId>(initialProvider);
  const [model, setModel] = useState<string>(initialModel);
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const lastCtrlC = useRef<number>(0);
  const jobs = useJobs(overlay.kind === "jobs");

  // Confirm port wired to an in-app modal.
  const confirmController = useMemo(() => createTuiConfirmPort(), []);
  const confirmResolver = useRef<((ok: boolean) => void) | undefined>(undefined);
  useEffect(() => {
    confirmController.setHandler(
      (req) =>
        new Promise<boolean>((resolve) => {
          confirmResolver.current = resolve;
          dispatch({ type: "event", event: { type: "confirm-request", id: "c", ...req } });
        }),
    );
  }, [confirmController]);

  const ctxRef = useRef({ mode, provider, model });
  ctxRef.current = { mode, provider, model };
  const runner = useAgentRunner({
    dispatchEvent: (event) => dispatch({ type: "event", event }),
    confirm: confirmController.port,
    getContext: useCallback(() => ctxRef.current, []),
  });

  const startTurn = useCallback(
    async (display: string, modelInput: string, images?: ReturnType<typeof loadImageAttachments>) => {
      dispatch({ type: "submit", text: display });
      await runner.run(modelInput, images && images.length > 0 ? { images } : undefined);
    },
    [runner],
  );

  // Expand @-mentions/dropped paths, then run the turn.
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

  // Flush the next queued message once the current turn finishes.
  useEffect(() => {
    if (!state.status.running && state.queued.length > 0 && !runner.isRunning()) {
      const next = state.queued[0]!;
      dispatch({ type: "dequeue" });
      beginTurn(next);
    }
  }, [state.status.running, state.queued, runner, beginTurn]);

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
      dispatch({ type: "notice", level: "info", text: "this plan is already complete ✓" });
      return;
    }
    plan.status = "approved";
    await savePlan(plan).catch(() => undefined);
    session.planApproved.value = true;
    dispatch({ type: "notice", level: "info", text: "✦ plan approved — executing it now" });
    void startTurn("/implement", IMPLEMENT_PROMPT);
  }, [runner, startTurn]);

  const lastToolOutput = useCallback((): ToolItem | undefined => {
    for (let i = state.items.length - 1; i >= 0; i -= 1) {
      const item = state.items[i]!;
      if (item.kind === "tool" && item.output) return item;
    }
    return undefined;
  }, [state.items]);

  const handleLocalSlash = useCallback(
    (text: string): boolean => {
      const [cmd, ...rest] = text.trim().split(/\s+/);
      const arg = rest.join(" ").trim();
      switch (cmd) {
        case "/ask":
          setMode("ask");
          setDefaultMode("ask");
          dispatch({ type: "notice", level: "info", text: "mode → ask" });
          return true;
        case "/agent":
          setMode("agent");
          setDefaultMode("agent");
          dispatch({ type: "notice", level: "info", text: "mode → agent" });
          return true;
        case "/clear":
        case "/new":
          runner.reset();
          dispatch({ type: "reset" });
          return true;
        case "/think":
        case "/thinking":
          dispatch({ type: "toggle-thinking" });
          return true;
        case "/implement":
          if (runner.isRunning()) {
            dispatch({ type: "notice", level: "warn", text: "a turn is already running" });
          } else {
            void runImplement();
          }
          return true;
        case "/plan": {
          void (async () => {
            const plan = await loadPlan(runner.getSession().sessionId).catch(() => undefined);
            if (!plan) {
              dispatch({ type: "notice", level: "info", text: "no active plan yet" });
              return;
            }
            setOverlay({ kind: "pager", title: "Plan", body: renderPlanDocument(plan) });
          })();
          return true;
        }
        case "/jobs":
          setOverlay({ kind: "jobs" });
          return true;
        case "/output": {
          const last = lastToolOutput();
          if (!last) {
            dispatch({ type: "notice", level: "info", text: "no tool output yet" });
          } else {
            setOverlay({ kind: "pager", title: `${last.name} output`, body: last.output });
          }
          return true;
        }
        case "/model": {
          if (!arg) {
            dispatch({ type: "notice", level: "info", text: "usage: /model <name>" });
            return true;
          }
          setModel(arg);
          setProviderModel(provider, arg);
          dispatch({ type: "notice", level: "info", text: `model → ${arg}` });
          return true;
        }
        case "/provider":
        case "/use": {
          if (!arg) {
            dispatch({ type: "notice", level: "info", text: "usage: /provider <name>" });
            return true;
          }
          try {
            const next = assertProvider(arg);
            setProvider(next);
            const nextModel = getProviderModel(next);
            setModel(nextModel);
            dispatch({ type: "notice", level: "info", text: `provider → ${next} / ${nextModel}` });
          } catch {
            dispatch({ type: "notice", level: "warn", text: `unknown provider: ${arg}` });
          }
          return true;
        }
        case "/clean":
          runner.reset();
          dispatch({ type: "reset" });
          return true;
        case "/cwd": {
          if (!arg) {
            dispatch({ type: "notice", level: "info", text: `cwd: ${safeCwd()}` });
            return true;
          }
          const target = resolve(safeCwd(), arg);
          if (!existsSync(target)) {
            dispatch({ type: "notice", level: "warn", text: `no such directory: ${target}` });
            return true;
          }
          try {
            process.chdir(target);
            dispatch({ type: "notice", level: "info", text: `cwd → ${target}` });
          } catch (e) {
            dispatch({
              type: "notice",
              level: "warn",
              text: `could not chdir: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
          return true;
        }
        case "/allow": {
          if (!arg) {
            const list = [...runner.getSession().allow];
            dispatch({
              type: "notice",
              level: "info",
              text: list.length ? `allowed: ${list.join(", ")}` : "no session allowances",
            });
            return true;
          }
          runner.getSession().allow.add(arg);
          dispatch({ type: "notice", level: "info", text: `allowed for session: ${arg}` });
          return true;
        }
        case "/disallow": {
          if (arg) runner.getSession().allow.delete(arg);
          dispatch({ type: "notice", level: "info", text: arg ? `disallowed: ${arg}` : "usage: /disallow <tool>" });
          return true;
        }
        case "/context": {
          const msgs = runner.getMessages();
          const tokens = estimateMessagesTokens(msgs);
          dispatch({
            type: "notice",
            level: "info",
            text: `context: ${msgs.length} messages · ~${tokens} tokens`,
          });
          return true;
        }
        case "/compact": {
          const { before, after } = runner.compact();
          dispatch({
            type: "notice",
            level: "info",
            text: `compacted ${before} → ${after} messages`,
          });
          return true;
        }
        case "/save": {
          void (async () => {
            const msgs = runner.getMessages();
            if (msgs.length === 0) {
              dispatch({ type: "notice", level: "info", text: "nothing to save yet" });
              return;
            }
            const rec = await saveSession(msgs, arg || undefined).catch(() => undefined);
            dispatch({
              type: "notice",
              level: "info",
              text: rec ? `saved session ${rec.id}` : "save failed",
            });
          })();
          return true;
        }
        case "/freeonly": {
          const on = /^(on|true|1|enable)$/i.test(arg);
          const off = /^(off|false|0|disable)$/i.test(arg);
          if (!on && !off) {
            dispatch({ type: "notice", level: "info", text: `freeOnly=${getConfig().freeOnly}` });
            return true;
          }
          updateConfig({ freeOnly: on });
          dispatch({ type: "notice", level: "info", text: `freeOnly=${on}` });
          return true;
        }
        case "/fallback": {
          const on = /^(on|true|1|enable)$/i.test(arg);
          const off = /^(off|false|0|disable)$/i.test(arg);
          if (!on && !off) {
            dispatch({
              type: "notice",
              level: "info",
              text: `providerFallback=${getConfig().providerFallback}`,
            });
            return true;
          }
          updateConfig({ providerFallback: on });
          dispatch({ type: "notice", level: "info", text: `providerFallback=${on}` });
          return true;
        }
        case "/keys":
        case "/history":
        case "/set":
        case "/unset":
        case "/scope":
        case "/update":
          dispatch({
            type: "notice",
            level: "info",
            text: `${cmd} is interactive — run it from classic mode (clai --classic) or the \`clai\` subcommand`,
          });
          return true;
        case "/help":
          dispatch({
            type: "notice",
            level: "info",
            text:
              "commands: /ask /agent /model <name> /provider <name> /implement /plan /jobs /output /clear /think /exit  ·  " +
              "Ctrl+T thinking · Ctrl+O output · Ctrl+P plan · Ctrl+J jobs · Esc cancel · Ctrl+C exit",
          });
          return true;
        case "/exit":
        case "/quit":
          exit();
          return true;
        default:
          return false;
      }
    },
    [exit, provider, runner, runImplement, lastToolOutput],
  );

  const handleSubmit = useCallback(
    (text: string) => {
      if (text.startsWith("/")) {
        if (handleLocalSlash(text)) return;
        dispatch({ type: "notice", level: "warn", text: `unknown command: ${text}` });
        return;
      }
      if (runner.isRunning()) {
        dispatch({ type: "queue", text });
        return;
      }
      beginTurn(text);
    },
    [handleLocalSlash, runner, beginTurn],
  );

  const answerConfirm = useCallback((ok: boolean) => {
    confirmResolver.current?.(ok);
    confirmResolver.current = undefined;
    dispatch({ type: "confirm-resolved" });
  }, []);

  const overlayOpen = overlay.kind !== "none";

  // Global keys: overlays, thinking toggle, abort, exit.
  useInput((input, key) => {
    if (state.pendingConfirm || overlayOpen) return; // modal/overlay owns input
    if (key.ctrl && input === "t") {
      dispatch({ type: "toggle-thinking" });
      return;
    }
    if (key.ctrl && input === "o") {
      const last = lastToolOutput();
      if (last) setOverlay({ kind: "pager", title: `${last.name} output`, body: last.output });
      return;
    }
    if (key.ctrl && input === "p") {
      void (async () => {
        const plan = await loadPlan(runner.getSession().sessionId).catch(() => undefined);
        if (plan) setOverlay({ kind: "pager", title: "Plan", body: renderPlanDocument(plan) });
      })();
      return;
    }
    if (key.ctrl && input === "j") {
      setOverlay({ kind: "jobs" });
      return;
    }
    if (key.escape) {
      if (runner.isRunning()) runner.abort();
      return;
    }
    if (key.ctrl && input === "c") {
      if (runner.isRunning()) {
        runner.abort();
        return;
      }
      const now = Date.now();
      if (now - lastCtrlC.current < 1500) exit();
      else lastCtrlC.current = now;
    }
  });

  const { committed, live } = splitItems(state.items);
  const cols = stdout?.columns ?? 80;
  const closeOverlay = useCallback(() => setOverlay({ kind: "none" }), []);

  return (
    <Box flexDirection="column" width={cols}>
      <Static items={committed}>
        {(item) => (
          <ItemView key={item.id} item={item} thinkingExpanded={state.thinkingExpanded} />
        )}
      </Static>

      <Box flexDirection="column">
        {state.items.length === 0 ? (
          <Header version={version} provider={provider} model={model} mode={mode} />
        ) : null}
        {live.map((item) => (
          <ItemView key={item.id} item={item} thinkingExpanded={state.thinkingExpanded} />
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {overlay.kind === "pager" ? (
          <Pager title={overlay.title} body={overlay.body} onClose={closeOverlay} />
        ) : overlay.kind === "jobs" ? (
          <JobsPanel jobs={jobs} onClose={closeOverlay} />
        ) : state.pendingConfirm ? (
          <ConfirmModal confirm={state.pendingConfirm} onAnswer={answerConfirm} />
        ) : (
          <StatusLine
            status={state.status}
            thinkingPreview={state.thinkingPreview}
            queued={state.queued.length}
          />
        )}
        <Composer
          busy={state.status.running}
          disabled={Boolean(state.pendingConfirm) || overlayOpen}
          onSubmit={handleSubmit}
        />
      </Box>
    </Box>
  );
}
