import { Box, Text, useApp, useInput } from "ink";
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
import { getSlashCommandSuggestions, type SlashCommand } from "../repl.js";
import { initialState, reducer, type ToolItem } from "./state.js";
import { renderTranscriptLines } from "./render-lines.js";
import { createTuiConfirmPort } from "./confirm.js";
import { useAgentRunner } from "./hooks/useAgentRunner.js";
import { useJobs } from "./hooks/useJobs.js";
import { useSpinner } from "./hooks/useSpinner.js";
import { useTerminalSize } from "./hooks/useTerminalSize.js";
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

const MAX_SUGGESTIONS = 6;

type Overlay = { kind: "none" } | { kind: "pager"; title: string; body: string } | { kind: "jobs" };

export function App({ version, initialMode, provider: initialProvider, initialModel }: AppProps) {
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
  const [scroll, setScroll] = useState(0); // lines scrolled up from bottom
  const history = useRef<string[]>([]);
  const historyIdx = useRef(-1);
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
  const runner = useAgentRunner({
    dispatchEvent: (event) => dispatch({ type: "event", event }),
    confirm: confirmController.port,
    getContext: useCallback(() => ctxRef.current, []),
  });

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

  const handleLocalSlash = useCallback(
    (text: string): boolean => {
      const [cmd, ...rest] = text.trim().split(/\s+/);
      const arg = rest.join(" ").trim();
      const info = (t: string) => dispatch({ type: "notice", level: "info", text: t });
      const warn = (t: string) => dispatch({ type: "notice", level: "warn", text: t });
      switch (cmd) {
        case "/ask": setMode("ask"); setDefaultMode("ask"); info("mode → ask"); return true;
        case "/agent": setMode("agent"); setDefaultMode("agent"); info("mode → agent"); return true;
        case "/clear":
        case "/new":
        case "/clean": runner.reset(); dispatch({ type: "reset" }); return true;
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
          const last = lastToolOutput();
          if (!last) info("no tool output yet");
          else setOverlay({ kind: "pager", title: `${last.name} output`, body: last.output });
          return true;
        }
        case "/model":
          if (!arg) { info("usage: /model <name>"); return true; }
          setModel(arg); setProviderModel(provider, arg); info(`model → ${arg}`); return true;
        case "/provider":
        case "/use":
          if (!arg) { info("usage: /provider <name>"); return true; }
          try {
            const next = assertProvider(arg);
            setProvider(next);
            const m = getProviderModel(next);
            setModel(m);
            info(`provider → ${next} / ${m}`);
          } catch { warn(`unknown provider: ${arg}`); }
          return true;
        case "/cwd": {
          if (!arg) { info(`cwd: ${safeCwd()}`); return true; }
          const target = resolve(safeCwd(), arg);
          if (!existsSync(target)) { warn(`no such directory: ${target}`); return true; }
          try { process.chdir(target); info(`cwd → ${target}`); }
          catch (e) { warn(`could not chdir: ${e instanceof Error ? e.message : String(e)}`); }
          return true;
        }
        case "/allow":
          if (!arg) {
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
          const { before, after } = runner.compact();
          info(`compacted ${before} → ${after} messages`); return true;
        }
        case "/save":
          void (async () => {
            const msgs = runner.getMessages();
            if (msgs.length === 0) { info("nothing to save yet"); return; }
            const rec = await saveSession(msgs, arg || undefined).catch(() => undefined);
            info(rec ? `saved session ${rec.id}` : "save failed");
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
        case "/history":
        case "/set":
        case "/unset":
        case "/scope":
        case "/update":
          info(`${cmd} is interactive — run it from classic mode (clai --classic) or the \`clai\` subcommand`);
          return true;
        case "/help":
          info("commands: /ask /agent /model <name> /provider <name> /implement /plan /jobs /output /cwd /allow /context /compact /save /clear /think /exit  ·  keys: ctrl+t thinking · ctrl+o output · ctrl+p plan · ctrl+j jobs · pgup/pgdn scroll · esc cancel · ctrl+c exit");
          return true;
        case "/exit":
        case "/quit": exit(); return true;
        default: return false;
      }
    },
    [exit, provider, runner, runImplement, lastToolOutput],
  );

  const submitText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      history.current.push(text);
      historyIdx.current = -1;
      setInput("");
      setCursor(0);
      setSelected(0);
      if (trimmed.startsWith("/")) {
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

  // ── Layout math (keep the composer pinned to the bottom) ────────────────────
  const suggestions: SlashCommand[] = input.startsWith("/")
    ? getSlashCommandSuggestions(input).slice(0, MAX_SUGGESTIONS)
    : [];
  const menuOpen = suggestions.length > 0;
  const overlayOpen = overlay.kind !== "none";
  const modalActive = Boolean(state.pendingConfirm) || overlayOpen;

  const headerH = 1;
  const statusH = 1;
  const composerH = 3;
  const menuH = menuOpen ? suggestions.length : 0;
  const viewportH = Math.max(3, rows - headerH - statusH - composerH - menuH);

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
    if (key.ctrl && ch === "o") { dispatch({ type: "toggle-output" }); return; }
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

    if (key.escape) {
      if (runner.isRunning()) runner.abort();
      else if (input) { setInput(""); setCursor(0); setSelected(0); }
      return;
    }
    if (key.ctrl && ch === "c") {
      if (runner.isRunning()) { runner.abort(); return; }
      const now = Date.now();
      if (now - lastCtrlC.current < 1500) exit();
      else lastCtrlC.current = now;
      return;
    }

    // Slash menu navigation
    if (menuOpen && (key.upArrow || key.downArrow)) {
      setSelected((s) => {
        const n = suggestions.length;
        return key.upArrow ? (s - 1 + n) % n : (s + 1) % n;
      });
      return;
    }
    if (menuOpen && key.tab) {
      setInput(suggestions[selected]!.command + " ");
      setCursor(suggestions[selected]!.command.length + 1);
      setSelected(0);
      return;
    }
    if (key.return) {
      if (menuOpen) { submitText(suggestions[selected]!.command); return; }
      submitText(input);
      return;
    }

    // History (when menu closed)
    if (!menuOpen && key.upArrow) {
      if (history.current.length === 0) return;
      const idx = historyIdx.current < 0 ? history.current.length - 1 : Math.max(0, historyIdx.current - 1);
      historyIdx.current = idx;
      const v = history.current[idx] ?? "";
      setInput(v); setCursor(v.length);
      return;
    }
    if (!menuOpen && key.downArrow) {
      if (historyIdx.current < 0) return;
      const idx = historyIdx.current + 1;
      if (idx >= history.current.length) { historyIdx.current = -1; setInput(""); setCursor(0); return; }
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
      return;
    }
    if (key.ctrl || key.meta) return;
    if (ch) {
      setInput(input.slice(0, cursor) + ch + input.slice(cursor));
      setCursor(cursor + ch.length);
      setSelected(0);
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
    <Box flexDirection="column" width={cols} height={rows}>
      {/* Header */}
      <Box>
        <Text>
          <Text color="magenta">● </Text>
          <Text bold>clai </Text>
          <Text dimColor>v{version}</Text>
          <Text dimColor>{"   "}</Text>
          <Text color="yellow">{mode}</Text>
          <Text dimColor> · </Text>
          <Text color="green">{provider}</Text>
          <Text dimColor>/</Text>
          <Text color="cyan">{model}</Text>
          {offset > 0 ? <Text dimColor>{`   ▲ ${offset} lines up — PgDn`}</Text> : null}
        </Text>
      </Box>

      {/* Transcript viewport OR overlay */}
      {overlay.kind === "pager" ? (
        <Pager title={overlay.title} body={overlay.body} height={viewportH} onClose={closeOverlay} />
      ) : overlay.kind === "jobs" ? (
        <JobsPanel jobs={jobs} onClose={closeOverlay} />
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
      {menuOpen && !modalActive
        ? suggestions.map((cmd, i) => (
            <Text key={cmd.command} wrap="truncate-end">
              <Text color={i === selected ? "magenta" : "cyan"}>
                {i === selected ? "❯ " : "  "}
                {cmd.command}
              </Text>
              {cmd.usage ? <Text dimColor> {cmd.usage}</Text> : null}
              <Text dimColor>{"  "}{cmd.description}</Text>
            </Text>
          ))
        : null}

      {/* Status line / confirm modal */}
      {state.pendingConfirm ? (
        <ConfirmModal confirm={state.pendingConfirm} onAnswer={answerConfirm} />
      ) : (
        <Box>
          {state.status.running ? (
            <Text>
              <Text color="magenta">{spinner} </Text>
              <Text color="yellow">{state.status.activity || "working"}</Text>
              {state.status.step > 0 ? <Text dimColor>{` · step ${state.status.step}`}</Text> : null}
              <Text dimColor>{` · ${elapsed}s · esc to cancel`}</Text>
              {state.queued.length > 0 ? <Text dimColor>{` · ${state.queued.length} queued`}</Text> : null}
            </Text>
          ) : (
            <Text dimColor>
              ready
              {state.queued.length > 0 ? ` · ${state.queued.length} queued` : ""}
              {"  ·  / commands · ctrl+t thinking · ctrl+o output"}
            </Text>
          )}
        </Box>
      )}

      {/* Composer (pinned bottom) */}
      <Box borderStyle="round" borderColor={state.status.running ? "yellow" : "magenta"} paddingX={1}>
        <Text color={state.status.running ? "yellow" : "magenta"} bold>
          {"❯ "}
        </Text>
        {input.length === 0 ? (
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
    </Box>
  );
}
