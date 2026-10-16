import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import type { ChatMessage, CompletionRequest, GenerationAttemptInput, SuccessfulRequestSnapshot } from "../src/types.js";
import { seedTokenFixture, tokenFixtures, verifyTokenFixture } from "./token-overhead-fixtures.js";
import type { FixtureToolExecution } from "./token-fixture-evidence.js";
import { parseEvaluationConfig } from "./token-evaluation-config.js";
import { EvaluationObserver } from "./token-evaluation-observer.js";
import { EvaluationEvents, summarizeAttempts } from "./token-evaluation-metrics.js";
import type { EvaluationReport } from "./token-evaluation-report.js";

export async function runEvaluationTrial(args: readonly string[]): Promise<void> {
  const [checkout, workRoot, variant, fixtureName, repetition, configPath, routeIndex, callLimit] = args;
  if (!checkout || !workRoot || !variant || !fixtureName || !repetition || !configPath || !routeIndex || !callLimit) throw new Error("Missing isolated trial arguments");
  const configInput: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const config = parseEvaluationConfig(configInput, tokenFixtures.map((fixture) => fixture.name));
  const route = config.routes[Number(routeIndex)];
  const fixture = tokenFixtures.find((entry) => entry.name === fixtureName);
  const budget = Number(callLimit);
  if (!route || !fixture || !Number.isInteger(budget) || budget < 1 || budget > config.maxCalls) throw new Error("Invalid trial route, fixture or budget");
  process.chdir(workRoot);
  for (const [key, folder] of Object.entries({
    CLAI_CONFIG_DIR: "config", CLAI_DATA_DIR: "data", CLAI_HISTORY_DIR: "history", CLAI_PLAN_DIR: "plans", CLAI_LOG_DIR: "logs",
    CLAI_ARTIFACT_DIR: "artifacts", CLAI_JOBS_DIR: "jobs", CLAI_SESSION_WORKSPACE_DIR: "scratch", CLAI_MCP_HOME: "home", CLAI_SCOPE_DIR: "scopes",
  })) {
    process.env[key] = join(workRoot, ".evaluation", folder);
    await mkdir(process.env[key]!, { recursive: true });
  }
  process.env.CLAI_SCOPE_FILE = join(workRoot, ".evaluation", "scope.json");
  await seedTokenFixture(workRoot, fixture);
  const source = (path: string): string => pathToFileURL(join(checkout, "src", path)).href;
  const [{ runAgentTurn }, { updateConfig }, { setActiveProjectRoot }, { buildTurnHistory }, { createSessionPolicy }, { jobManager }, usage, fingerprints, router] = await Promise.all([
    import(source("agent/runner.ts")) as Promise<typeof import("../src/agent/runner.js")>,
    import(source("store/config.ts")) as Promise<typeof import("../src/store/config.js")>,
    import(source("agent/project-root.ts")) as Promise<typeof import("../src/agent/project-root.js")>,
    import(source("agent/tool-call-parser.ts")) as Promise<typeof import("../src/agent/tool-call-parser.js")>,
    import(source("agent/session-policy.ts")) as Promise<typeof import("../src/agent/session-policy.js")>,
    import(source("tools/jobs.ts")) as Promise<typeof import("../src/tools/jobs.js")>,
    import(source("llm/operation-usage.ts")) as Promise<typeof import("../src/llm/operation-usage.js")>,
    import(source("llm/request-fingerprint.ts")) as Promise<typeof import("../src/llm/request-fingerprint.js")>,
    import(source("llm/router.ts")) as Promise<typeof import("../src/llm/router.js")>,
  ]);
  updateConfig({ defaultProvider: route.provider, defaultModel: route.model, defaultMode: "agent", providerFallback: false,
    thinking: route.thinking, rtk: false, telemetry: false, permissions: "default", sandboxRoots: [workRoot], sandboxReads: true,
    disableKeychain: true, toolCalling: route.toolCalling });
  setActiveProjectRoot(workRoot);
  const observer = new EvaluationObserver();
  const events = new EvaluationEvents();
  const originalFetch = globalThis.fetch;
  const begin = usage.OperationUsageRecorder.prototype.begin;
  usage.OperationUsageRecorder.prototype.begin = function (input: GenerationAttemptInput) {
    return observer.begin(input, { begin: (entry) => begin.call(this, entry) });
  };
  const provider = router.getProvider(route.provider);
  const complete = provider.complete;
  const stream = provider.stream;
  const observePinnedRequest = (request: CompletionRequest): void => {
    if (request.model !== route.model || (request.provider !== undefined && request.provider !== route.provider)) throw new Error("Evaluation route change blocked");
    observer.noteRequest(request);
  };
  provider.complete = async function (request, auth, onStatus) { observePinnedRequest(request); return complete.call(this, request, auth, onStatus); };
  if (stream) provider.stream = async function (request, auth, onToken, onStatus) { observePinnedRequest(request); return stream.call(this, request, auth, onToken, onStatus); };
  globalThis.fetch = (input, init) => observer.fetch(input, init, { maxCalls: budget, fetch: originalFetch, fingerprint: (body) => fingerprints.fingerprintFinalRequest(route, body) });
  const session = createSessionPolicy(`eval-${variant}-${fixtureName}-${repetition}`);
  let messages: ChatMessage[] = [];
  let previous: SuccessfulRequestSnapshot | undefined;
  let successfulModelRounds = 0;
  let answer = "";
  let turn = 0;
  let passed = false;
  let error = false;
  const executions: FixtureToolExecution[] = [];
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  try {
    for (const prompt of fixture.prompts) {
      await runAgentTurn(prompt, {
        provider: route.provider, model: route.model, toolCalling: route.toolCalling,
        mode: "agent", maxSteps: 10, signal: AbortSignal.timeout(180_000), session,
        history: messages.length ? buildTurnHistory(messages, "") : undefined,
        previousSuccessfulRequest: previous,
        confirm: { confirmTool: async () => true, confirmPentest: async () => false },
        onMessages: (value) => { messages = value; },
        onSuccessfulRequest: (snapshot) => { previous = snapshot; successfulModelRounds += 1; },
        onToolResult: (call, result) => {
          const job = call.name === "shell.wait" && typeof call.args.id === "string" ? jobManager.getJob(call.args.id) : undefined;
          executions.push({ name: call.name, args: structuredClone(call.args), result: structuredClone(result), turn,
            ...(job ? { job: { id: job.id, status: job.status, artifactPath: job.artifactPath ?? "", exitCode: job.exitCode } } : {}),
          });
        },
        onEvent: (event) => { events.observe(event, performance.now() - started, turn); if (event.type === "assistant-message") answer += `${event.text}\n`; },
      });
      turn += 1;
    }
    passed = await verifyTokenFixture(fixture, workRoot, answer, { executions, observedCalls: events.observedCalls });
  } catch { error = true; }
  finally {
    globalThis.fetch = originalFetch;
    usage.OperationUsageRecorder.prototype.begin = begin;
    provider.complete = complete;
    if (stream) provider.stream = stream;
    for (const job of jobManager.getRunningJobs(session.sessionId)) await jobManager.stopJob(job.id);
  }
  const cpu = process.cpuUsage(cpuStarted);
  const report: EvaluationReport = {
    version: 1, fixture: fixtureName, variant, repeat: Number(repetition), route, passed, error,
    modelRounds: null, successfulModelRounds, providerInvocations: observer.providerInvocations, auxiliaryInvocations: observer.auxiliaryInvocations,
    toolCalls: events.toolCalls, toolErrors: events.toolErrors, blockedCalls: events.blockedCalls,
    elapsedMs: performance.now() - started, firstTokenMs: events.firstVisibleTokenMs,
    peakRssBytes: process.resourceUsage().maxRSS * 1024, cpuMicroseconds: cpu.user + cpu.system, observerOverheadMs: observer.assemblyMilliseconds,
    attempts: observer.attempts, usageSummary: summarizeAttempts(observer.attempts), cost: null, firstAttemptValidity: null, repairCalls: null,
    wires: observer.wires,
    cache: { knownCacheHitRate: null, eligiblePrefixReuse: null, warmEligibleRequests: null },
    coverageGaps: ["Warm eligible-prefix denominator and cold/warm classifications require route-specific cache baseline before release",
      "Total model rounds are unknown; successful core rounds and provider/auxiliary invocations are reported separately",
      "Assembly overhead measures offline observer fingerprinting only, not the full runner assembly hot path",
      "First-attempt repair classification and auxiliary cost completeness need scenario-specific assertions"],
  };
  await writeFile(join(workRoot, ".evaluation", "report.json"), `${JSON.stringify(report)}\n`);
  console.log(JSON.stringify({ passed, error, admissions: observer.wires.length }));
}
