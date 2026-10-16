import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactEvaluationText } from "./token-evaluation-failures.js";
import { performance } from "node:perf_hooks";
import type { ChatMessage, CompletionRequest, GenerationAttemptInput, SuccessfulRequestSnapshot } from "../src/types.js";
import { seedTokenFixture, tokenFixtures, verifyTokenFixture } from "./token-overhead-fixtures.js";
import { runIndependentAssertions, type FixtureEvidence, type FixtureToolExecution } from "./token-fixture-evidence.js";
import { parseEvaluationConfig } from "./token-evaluation-config.js";
import { EvaluationObserver } from "./token-evaluation-observer.js";
import { EvaluationEvents, summarizeAttempts } from "./token-evaluation-metrics.js";
import { summarizeEvaluationCache } from "./token-evaluation-cache.js";
import type { EvaluationReport } from "./token-evaluation-report.js";
import { evaluationProvenance, evaluationSnapshot } from "./token-evaluation-provenance.js";
import { prepareEvaluationResponderWake } from "./token-evaluation-responder.js";

export async function runEvaluationTrial(args: readonly string[]): Promise<void> {
  const [checkout, workRoot, variant, fixtureName, repetition, configPath, routeIndex, callLimit] = args;
  if (!checkout || !workRoot || !variant || !fixtureName || !repetition || !configPath || !routeIndex || !callLimit) throw new Error("Missing isolated trial arguments");
  const configInput: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const config = parseEvaluationConfig(configInput, tokenFixtures.map((fixture) => fixture.name));
  const route = config.routes[Number(routeIndex)];
  const definition = tokenFixtures.find((entry) => entry.name === fixtureName);
  const budget = Number(callLimit);
  if (!route || !definition || !Number.isInteger(budget) || budget < 1 || budget > config.maxCalls) throw new Error("Invalid trial route, fixture or budget");
  const initialSnapshot = await evaluationSnapshot(checkout);
  const harnessRoot = fileURLToPath(new URL("..", import.meta.url));
  const harnessSha256 = await evaluationSnapshot(harnessRoot, ["scripts", "package.json", "package-lock.json", "tsconfig.token-audit.json"]);
  process.chdir(workRoot);
  for (const [key, folder] of Object.entries({
    CLAI_CONFIG_DIR: "config", CLAI_DATA_DIR: "data", CLAI_HISTORY_DIR: "history", CLAI_PLAN_DIR: "plans", CLAI_LOG_DIR: "logs",
    CLAI_ARTIFACT_DIR: "artifacts", CLAI_JOBS_DIR: "jobs", CLAI_SESSION_WORKSPACE_DIR: "scratch", CLAI_MCP_HOME: "home", CLAI_SCOPE_DIR: "scopes",
  })) {
    process.env[key] = join(workRoot, ".evaluation", folder);
    await mkdir(process.env[key]!, { recursive: true });
  }
  process.env.CLAI_SCOPE_FILE = join(workRoot, ".evaluation", "scope.json");
  await seedTokenFixture(workRoot, definition);
  const source = (path: string): string => pathToFileURL(join(checkout, "src", path)).href;
  const [{ runAgentTurn }, { updateConfig, setProviderEndpoints }, { setActiveProjectRoot }, { buildTurnHistory }, { createSessionPolicy }, { jobManager }, usage, fingerprints, router] = await Promise.all([
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
    disableKeychain: true, toolCalling: route.toolCalling,
    ...(route.provider === "ollama" && route.endpoint ? { ollamaHost: route.endpoint } : {}) });
  if (route.endpoint && route.provider !== "ollama") setProviderEndpoints(route.provider, [route.endpoint]);
  setActiveProjectRoot(workRoot);
  const sensitiveValues = Object.entries(process.env).filter(([key, value]) => /(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|SECRET|PASSWORD)$/.test(key) && value && value.length >= 8).map(([, value]) => value!);
  const observer = new EvaluationObserver(budget, sensitiveValues);
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
  const credentialMetadata = {
    ...(process.env.CLAI_EVALUATION_REFRESH_TOKEN ? { refreshToken: process.env.CLAI_EVALUATION_REFRESH_TOKEN } : {}),
    ...(process.env.CLAI_EVALUATION_EXPIRES_AT ? { expiresAt: Number(process.env.CLAI_EVALUATION_EXPIRES_AT) } : {}),
  };
  provider.complete = async function (request, auth, onStatus) { observePinnedRequest(request); return complete.call(this, request, { ...auth, ...credentialMetadata }, onStatus); };
  if (stream) provider.stream = async function (request, auth, onToken, onStatus) { observePinnedRequest(request); return stream.call(this, request, { ...auth, ...credentialMetadata }, onToken, onStatus); };
  globalThis.fetch = (input, init) => observer.fetch(input, init, { maxCalls: budget, fetch: originalFetch, fingerprint: (body) => fingerprints.fingerprintFinalRequest(route, body) });
  const sessionIdentity = createHash("sha256").update(JSON.stringify({ workRoot, variant, fixtureName, repetition, route })).digest("hex").slice(0, 32);
  const session = createSessionPolicy(`eval-${sessionIdentity}`);
  let messages: ChatMessage[] = [];
  let previous: SuccessfulRequestSnapshot | undefined;
  let successfulModelRounds = 0;
  let answer = "";
  let turn = 0;
  let passed = false;
  let error = false;
  let turnAssertionsPassed = true;
  const executions: FixtureToolExecution[] = [];
  const receipts = new Map<string, NonNullable<FixtureEvidence["responderReceipts"]>[number]>();
  const captureReceipts = (): void => {
    for (const notification of jobManager.getPendingNotifications(session.sessionId)) {
      const job = jobManager.getJob(notification.jobId);
      if (job) receipts.set(job.id, { jobId: job.id, read: Boolean(notification.readAt), status: job.status, exitCode: job.exitCode });
    }
  };
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  let closeFixture: (() => Promise<void>) | undefined;
  try {
    const prepared = await definition.prepare?.(workRoot);
    closeFixture = prepared?.close;
    const fixture = prepared ? { ...definition, prompts: prepared.prompts, verify: prepared.verify } : definition;
    for (const prompt of fixture.prompts) {
      const wake = fixture.settleResponders && turn > 0 ? await prepareEvaluationResponderWake(jobManager, session.sessionId) : undefined;
      await runAgentTurn(wake?.prompt ?? prompt, {
        ...(wake ? { displayPrompt: wake.displayPrompt } : {}),
        provider: route.provider, model: route.model, toolCalling: route.toolCalling,
        mode: "agent", maxSteps: 30, signal: AbortSignal.timeout(180_000), session,
        requestSecret: async () => fixture.name === "pty-secret-cancel-natural" ? "synthetic-session-secret" : undefined,
        history: messages.length ? buildTurnHistory(messages, "") : undefined,
        previousSuccessfulRequest: previous,
        confirm: { confirmTool: async () => true, confirmPentest: async () => definition.scenarios?.some((id) => id.startsWith("S")) ?? false },
        onDiagnostic: (event) => events.diagnostic(event),
        onMessages: (value) => { messages = value; },
        onSuccessfulRequest: (snapshot) => { previous = snapshot; successfulModelRounds += 1; },
        onToolResult: (call, result) => {
          const job = ["shell.wait", "shell.stop"].includes(call.name) && typeof call.args.id === "string" ? jobManager.getJob(call.args.id) : undefined;
          executions.push({ name: call.name, args: structuredClone(call.args), result: structuredClone(result), turn,
            ...(job ? { job: { id: job.id, status: job.status, artifactPath: job.artifactPath ?? "", exitCode: job.exitCode } } : {}),
          });
        },
        onEvent: (event) => {
          events.observe(event, performance.now() - started, turn);
          if (event.type === "assistant-message") answer += `${event.text}\n`;
          if (event.type === "tool-result") captureReceipts();
        },
      });
      if (wake && !jobManager.markDelivered(wake.notification.id, session.sessionId)) throw new Error("Responder delivery completion could not be persisted");
      const assertions = fixture.turnAssertions?.[turn];
      if (assertions && !runIndependentAssertions(workRoot, assertions)) turnAssertionsPassed = false;
      if (fixture.settleResponders) {
        for (const job of jobManager.getRunningJobs(session.sessionId).filter((entry) => entry.responder)) await jobManager.waitForJob(job.id, { timeoutMs: 30_000 });
      }
      captureReceipts();
      turn += 1;
    }
    passed = turnAssertionsPassed && await verifyTokenFixture(fixture, workRoot, answer, { executions, observedCalls: events.observedCalls, responderReceipts: [...receipts.values()] });
  } catch { error = true; }
  finally {
    globalThis.fetch = originalFetch;
    usage.OperationUsageRecorder.prototype.begin = begin;
    provider.complete = complete;
    if (stream) provider.stream = stream;
    for (const job of jobManager.getRunningJobs(session.sessionId)) await jobManager.stopJob(job.id);
    if (definition.name === "pty-secret-cancel-natural") {
      const { interactiveSessionManager } = await import(source("interactive-session/manager.ts")) as typeof import("../src/interactive-session/manager.js");
      const cleanup = await interactiveSessionManager.cancelOwner(session.sessionId);
      if (cleanup.failures.length) { error = true; passed = false; }
    }
    jobManager.releaseResponderLease(session.sessionId);
    await closeFixture?.();
  }
  const cpu = process.cpuUsage(cpuStarted);
  const provenance = await evaluationProvenance(checkout, definition);
  const finalSnapshot = await evaluationSnapshot(checkout);
  const snapshotStable = initialSnapshot === finalSnapshot && harnessSha256 === await evaluationSnapshot(harnessRoot, ["scripts", "package.json", "package-lock.json", "tsconfig.token-audit.json"]);
  if (!snapshotStable) { error = true; passed = false; }
  const report: EvaluationReport = {
    provenance, snapshot: { initial: initialSnapshot, final: finalSnapshot, stable: snapshotStable, harnessSha256 },
    version: 1, fixture: fixtureName, variant, repeat: Number(repetition), route, passed, error,
    ...events.reliability(), firstAttemptValidity: passed ? events.reliability().firstAttemptValidity : 0, successfulModelRounds, providerInvocations: observer.providerInvocations, auxiliaryInvocations: observer.auxiliaryInvocations,
    toolCalls: events.toolCalls, toolErrors: events.toolErrors, blockedCalls: events.blockedCalls,
    elapsedMs: performance.now() - started, firstTokenMs: events.firstVisibleTokenMs,
    peakRssBytes: process.resourceUsage().maxRSS * 1024, cpuMicroseconds: cpu.user + cpu.system, observerOverheadMs: observer.assemblyMilliseconds,
    attempts: observer.attempts, failures: observer.failures, usageSummary: summarizeAttempts(observer.attempts), cost: null,
    assembly: { turnSetupMs: events.turnSetupMs, requestAssemblyMs: events.requestAssemblyMs, samples: events.assemblySamples },
    correctiveRounds: events.correctiveRounds, retriedToolCalls: events.retriedToolCalls, protocolRepairs: events.protocolRepairs,
    wires: observer.wires,
    cache: summarizeEvaluationCache(observer.cacheObservations),
    coverageGaps: ["Warm eligible-prefix denominators and designated cold/warm cohorts need provider-specific baseline confirmation",
      ...(observer.generationAdmissions !== observer.attempts.length ? ["Some admitted generation requests lack a settled usage record"] : []),
      ...(events.reliability().modelRounds === null ? ["Checkout lacks opt-in round/repair/assembly diagnostics"] : []),
      "First-attempt score is conservative trial-wide execution reliability; expected negative-input failures are not excused",
      "Assembly timings include setup I/O and round construction, not every context refresh; priced auxiliary cost remains unknown"],
  };
  await writeFile(join(workRoot, ".evaluation", "fixture-diagnostics.json"), redactEvaluationText(JSON.stringify({ answer, executions, observedCalls: events.observedCalls, responderReceipts: [...receipts.values()] }), [...sensitiveValues, "synthetic-session-secret"]), { mode: 0o600 });
  await writeFile(join(workRoot, ".evaluation", "report.json"), `${JSON.stringify(report)}\n`);
  console.log(JSON.stringify({ passed, error, admissions: observer.generationAdmissions }));
}
