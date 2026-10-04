import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ChatMessage, CompletionRequest, SuccessfulRequestSnapshot } from "../src/types.js";
import type { ProviderAuth } from "../src/llm/provider.js";
import type { AgentEvent } from "../src/agent/events.js";
import { tokenFixtures, seedTokenFixture } from "./token-overhead-fixtures.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

interface TrialResult {
  fixture: string;
  variant: string;
  repeat: number;
  passed: boolean;
  rounds: number;
  toolCalls: number;
  toolErrors: string[];
  blockedCalls: string[];
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  firstPromptTokens?: number;
  elapsedMs: number;
  toolsStable: boolean;
  systemStable: boolean;
  turns: string[];
  error?: string;
}

async function runTrial(): Promise<void> {
  const [checkout, workRoot, variant, fixtureName, repetition] = process.argv.slice(3);
  if (!checkout || !workRoot || !variant || !fixtureName || !repetition) throw new Error("Missing trial arguments");
  const fixture = tokenFixtures.find((entry) => entry.name === fixtureName)!;
  process.chdir(workRoot);
  for (const [key, folder] of Object.entries({
    CLAI_CONFIG_DIR: "config", CLAI_DATA_DIR: "data", CLAI_HISTORY_DIR: "history",
    CLAI_PLAN_DIR: "plans", CLAI_LOG_DIR: "logs", CLAI_ARTIFACT_DIR: "artifacts",
    CLAI_JOBS_DIR: "jobs", CLAI_SESSION_WORKSPACE_DIR: "scratch", CLAI_MCP_HOME: "home",
  })) {
    process.env[key] = join(workRoot, ".evaluation", folder);
    await mkdir(process.env[key]!, { recursive: true });
  }
  const source = (path: string): string => pathToFileURL(join(checkout, "src", path)).href;
  const [{ runAgentTurn }, { updateConfig }, { setActiveProjectRoot }, { buildTurnHistory }, { createSessionPolicy }] = await Promise.all([
    import(source("agent/runner.ts")) as Promise<typeof import("../src/agent/runner.js")>,
    import(source("store/config.ts")) as Promise<typeof import("../src/store/config.js")>,
    import(source("agent/project-root.ts")) as Promise<typeof import("../src/agent/project-root.js")>,
    import(source("agent/tool-call-parser.ts")) as Promise<typeof import("../src/agent/tool-call-parser.js")>,
    import(source("agent/session-policy.ts")) as Promise<typeof import("../src/agent/session-policy.js")>,
  ]);
  updateConfig({
    defaultProvider: "nvidia", defaultMode: "agent", providerFallback: false,
    thinking: { enabled: false, effort: "medium" }, rtk: false, telemetry: false,
    permissions: "default", sandboxRoots: [workRoot], sandboxReads: true,
    disableKeychain: true, toolCalling: "native",
  });
  setActiveProjectRoot(workRoot);
  if (process.env.CLAI_EVAL_CHAT === "1") {
    const [{ nvidiaProvider }, { openAiCompatibleStream, toCompletionResult }] = await Promise.all([
      import(source("llm/nvidia.ts")) as Promise<typeof import("../src/llm/nvidia.js")>,
      import(source("llm/http.ts")) as Promise<typeof import("../src/llm/http.js")>,
    ]);
    nvidiaProvider.stream = async (request: CompletionRequest, auth: ProviderAuth, onToken: (token: string) => void) =>
      toCompletionResult("nvidia", request.model!, await openAiCompatibleStream({
        provider: "NVIDIA NIM", providerId: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: auth.apiKey!, model: request.model!, messages: request.messages,
        maxTokens: request.maxTokens, temperature: request.temperature, signal: request.signal,
        reasoning: request.thinking, reasoningStyle: "nvidia", tools: request.tools,
        toolChoice: request.toolChoice, parallelToolCalls: request.parallelToolCalls,
        onToolCallDelta: request.onToolCallDelta, onStreamEvent: request.onStreamEvent,
        reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
        forceReasoningReplay: request.forceReasoningReplay, onToken, responsesFirst: false,
      }));
  }
  const wireRequests: unknown[] = [];
  const fetchRequest = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (typeof init?.body === "string") wireRequests.push(JSON.parse(init.body));
    return fetchRequest(input, init);
  };
  const session = createSessionPolicy(`eval-${variant}-${fixtureName}-${repetition}`);
  const result: TrialResult = {
    fixture: fixtureName, variant, repeat: Number(repetition), passed: false,
    rounds: 0, toolCalls: 0, toolErrors: [], blockedCalls: [], promptTokens: 0,
    completionTokens: 0, cachedTokens: 0, elapsedMs: 0, toolsStable: true,
    systemStable: true, turns: [],
  };
  const calls = new Map<string, string>();
  const toolsHashes = new Set<string>();
  const systemHashes = new Set<string>();
  const snapshots: SuccessfulRequestSnapshot[] = [];
  let messages: ChatMessage[] = [];
  let answer = "";
  const started = Date.now();
  try {
    for (const prompt of fixture.prompts) {
      const outcome = await runAgentTurn(prompt, {
        provider: "nvidia", model: process.env.CLAI_EVAL_MODEL!, mode: "agent",
        toolCalling: "native", maxSteps: 10, signal: AbortSignal.timeout(180_000), session,
        history: messages.length ? buildTurnHistory(messages, "") : undefined,
        confirm: { confirmTool: async () => true, confirmPentest: async () => false },
        onMessages: (value: ChatMessage[]) => { messages = value; },
        onSuccessfulRequest: (snapshot: SuccessfulRequestSnapshot) => {
          result.rounds += 1;
          snapshots.push(snapshot);
          toolsHashes.add(hash(snapshot.tools));
          systemHashes.add(hash(snapshot.messages[0]));
        },
        onEvent: (event: AgentEvent) => {
          if (event.type === "token-usage") {
            const usage = event.usage;
            result.firstPromptTokens ??= usage.promptTokens;
            result.promptTokens += usage.promptTokens;
            result.completionTokens += usage.completionTokens;
            result.cachedTokens += usage.cachedPromptTokens ?? 0;
          }
          if (event.type === "tool-call") {
            result.toolCalls += 1;
            calls.set(event.id, event.name);
          }
          if (event.type === "tool-result" && event.ok === false) result.toolErrors.push(calls.get(event.id) ?? "unknown");
          if (event.type === "tool-blocked") result.blockedCalls.push(event.name);
          if (event.type === "assistant-message") answer += event.text + "\n";
        },
      });
      result.turns.push(outcome.status);
    }
    const testsUnchanged = await Promise.all(Object.entries(fixture.files)
      .filter(([name]) => name.endsWith(".test.mjs"))
      .map(async ([name, content]) => await readFile(join(workRoot, name), "utf8") === content));
    result.passed = testsUnchanged.every(Boolean) && await fixture.verify(workRoot, answer);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  result.elapsedMs = Date.now() - started;
  result.toolsStable = toolsHashes.size === 1;
  result.systemStable = systemHashes.size === 1;
  await writeFile(join(workRoot, ".evaluation", "requests.json"), JSON.stringify({ snapshots, wireRequests, messages, answer }, null, 2));
  console.log(JSON.stringify(result));
}

function comparePair(before: TrialResult, after: TrialResult) {
  const rejectionReasons = [];
  if (!before.passed || !after.passed) rejectionReasons.push("A fixture outcome was not verified");
  if (after.error || after.blockedCalls.length) rejectionReasons.push("Candidate encountered an error or blocked call");
  if (after.toolCalls > before.toolCalls) rejectionReasons.push("Candidate used more tool calls");
  if (after.rounds > before.rounds) rejectionReasons.push("Candidate used more model rounds");
  if (after.toolErrors.length > before.toolErrors.length) rejectionReasons.push("Candidate produced more tool errors");
  if (after.toolErrors.some((name) => /^fs\.(?:edit|replaceLines|read|search)/.test(name))) {
    rejectionReasons.push("Candidate produced an edit, read or search error");
  }
  if (!after.toolsStable || !after.systemStable) rejectionReasons.push("Candidate changed its tools or system prefix");
  if (before.turns.at(-1) === "succeeded" && after.turns.at(-1) !== "succeeded") {
    rejectionReasons.push("Candidate did not retain the baseline completion status");
  }
  return {
    fixture: before.fixture, repeat: before.repeat,
    accepted: rejectionReasons.length === 0, rejectionReasons,
    toolCallDelta: after.toolCalls - before.toolCalls,
    modelRoundDelta: after.rounds - before.rounds,
    promptTokenDelta: after.promptTokens - before.promptTokens,
    firstPromptTokenDelta: (after.firstPromptTokens ?? 0) - (before.firstPromptTokens ?? 0),
    elapsedMsDelta: after.elapsedMs - before.elapsedMs,
  };
}

async function runComparison(): Promise<void> {
  const baseline = process.argv[2];
  if (!baseline) throw new Error("Usage: node --import tsx scripts/evaluate-token-overhead.ts <baseline-checkout>");
  const [{ getProviderKeys }, { getProviderModel }] = await Promise.all([
    import("../src/store/keys.js"), import("../src/store/config.js"),
  ]);
  const keys = await getProviderKeys("nvidia");
  const active = keys.keys[keys.activeIndex];
  const key = active && !active.disabled ? active : keys.keys.find((entry) => !entry.disabled);
  if (!key) throw new Error("No NVIDIA credentials configured");
  const reportRoot = await mkdtemp(join(tmpdir(), "clai-token-evaluation-"));
  const results: TrialResult[] = [];
  const selectedFixtures = process.env.CLAI_EVAL_FIXTURES?.split(",");
  const pairLimit = Math.min(12, Math.max(1, Number(process.env.CLAI_EVAL_PAIRS ?? 12)));
  let pairs = 0;
  for (let repeat = 1; repeat <= 2; repeat += 1) {
    for (const fixture of tokenFixtures) {
      if (pairs >= pairLimit) break;
      if (selectedFixtures && !selectedFixtures.includes(fixture.name)) continue;
      const workRoot = join(reportRoot, `${fixture.name}-${repeat}`);
      const variants = repeat === 1 ? ["before", "after"] : ["after", "before"];
      for (const variant of variants) {
        await rm(workRoot, { recursive: true, force: true });
        await mkdir(workRoot, { recursive: true });
        await seedTokenFixture(workRoot, fixture);
        console.log(`Evaluating ${fixture.name} ${repeat}/2 ${variant}`);
        const output = await new Promise<string>((resolveOutput, reject) => {
          const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--trial",
            variant === "before" ? resolve(baseline) : sourceRoot, workRoot, variant, fixture.name, String(repeat)], {
            cwd: sourceRoot,
            env: { ...process.env, NVIDIA_API_KEY: key.value, CLAI_EVAL_MODEL: process.env.CLAI_EVAL_MODEL ?? getProviderModel("nvidia") },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
          child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
          child.on("error", reject);
          child.on("exit", (code) => code === 0 ? resolveOutput(stdout) : reject(new Error(`Trial exited ${code}: ${stderr.slice(-1500)}`)));
        });
        const result = JSON.parse(output.trim().split("\n").at(-1)!) as TrialResult;
        results.push(result);
        console.log(JSON.stringify(result));
        await writeFile(join(reportRoot, `${fixture.name}-${repeat}-${variant}-requests.json`), await readFile(join(workRoot, ".evaluation", "requests.json")));
        await writeFile(join(reportRoot, "results.json"), JSON.stringify(results, null, 2));
        if (result.error && result.rounds === 0) throw new Error(`Provider failed before evaluation; report: ${reportRoot}`);
      }
      const pairResults = results.filter((result) => result.fixture === fixture.name && result.repeat === repeat);
      const comparison = comparePair(pairResults.find((result) => result.variant === "before")!,
        pairResults.find((result) => result.variant === "after")!);
      console.log(JSON.stringify(comparison));
      const comparisons = results.filter((result) => result.variant === "before")
        .flatMap((before) => {
          const after = results.find((result) => result.variant === "after" && result.fixture === before.fixture && result.repeat === before.repeat);
          return after ? [comparePair(before, after)] : [];
        });
      await writeFile(join(reportRoot, "comparisons.json"), JSON.stringify(comparisons, null, 2));
      pairs += 1;
    }
  }
  console.log(`Report: ${join(reportRoot, "results.json")}`);
}

if (process.argv[2] === "--trial") await runTrial();
else await runComparison();
