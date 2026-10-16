import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { seedTokenFixture, tokenFixtures, verifyTokenFixture } from "../../scripts/token-overhead-fixtures.js";
import { type FixtureEvidence, type FixtureToolExecution, terminalTranscriptIsCursorSafe } from "../../scripts/token-fixture-evidence.js";
import { toolRegistry } from "../../src/tools/registry.js";
import { interactiveSessionManager } from "../../src/interactive-session/manager.js";
import { jobManager } from "../../src/tools/jobs.js";
import { prepareEvaluationResponderWake } from "../../scripts/token-evaluation-responder.js";
import { setUpResponderWake } from "../../src/agent/turn/setup/responder-wake.js";
import { decideResponderRead, parseResponderReadRequest } from "../../src/agent/turn/responder-read-tool.js";

const owned: string[] = [];
const owners: string[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    await interactiveSessionManager.cancelOwner(owner);
    for (const job of jobManager.getRunningJobs(owner)) await jobManager.stopJob(job.id);
  }
  await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function setup(name: string) {
  await mkdir(process.env.CLAI_DATA_DIR!, { recursive: true });
  const root = await mkdtemp(join(process.env.CLAI_DATA_DIR!, "lifecycle-fixture-"));
  owned.push(root);
  const owner = `lifecycle-${randomUUID()}`;
  owners.push(owner);
  const fixture = tokenFixtures.find((entry) => entry.name === name)!;
  await seedTokenFixture(root, fixture);
  return { root, owner, fixture };
}
const evidence = (executions: readonly FixtureToolExecution[]): FixtureEvidence => ({ executions, observedCalls: executions.map(({ name, turn }) => ({ name, turn })) });

it("C08 exercises an actual PTY, masked secret delivery, cursor continuation and verified process cleanup", async () => {
  const { root, owner, fixture } = await setup("pty-secret-cancel-natural");
  const options = { sessionId: owner, confirmed: true, requestSecret: async () => "synthetic-session-secret" };
  const startArgs = { command: "node prompt.mjs", cwd: root, terminalMode: "required" };
  const started = await toolRegistry["terminal.start"]!(startArgs, options);
  expect(started.ok).toBe(true);
  const start = started.interactiveSession;
  if (start?.operation !== "start") throw new Error("Missing actual PTY receipt");
  expect(start.transport).toBe("pty");
  const executions: FixtureToolExecution[] = [{ name: "terminal.start", args: startArgs, result: started, turn: 0 }];
  let cursor = start.cursor;
  let promptSeen = started.output.includes("Synthetic secret:");
  for (let read = 0; !promptSeen && read < 4; read += 1) {
    const args = { id: start.sessionId, cursor, waitMs: 2000 };
    const result = await toolRegistry["terminal.read"]!(args, options);
    executions.push({ name: "terminal.read", args, result, turn: 0 });
    const receipt = result.interactiveSession;
    if (receipt?.operation !== "read" || !receipt.page) throw new Error("Missing prompt read receipt");
    cursor = receipt.page.nextCursor;
    promptSeen = result.output.includes("Synthetic secret:");
  }
  expect(promptSeen).toBe(true);
  const sendArgs = { id: start.sessionId, kind: "secret", secretSource: "prompt", secretPrompt: "Synthetic fixture secret", cursor, quietMs: 1000 };
  const sent = await toolRegistry["terminal.send"]!(sendArgs, options);
  expect(sent.ok).toBe(true);
  executions.push({ name: "terminal.send", args: sendArgs, result: sent, turn: 0 });
  const send = sent.interactiveSession;
  if (send?.operation !== "send") throw new Error("Missing actual masked-delivery receipt");
  if (!sent.output.includes("AUTHENTICATED")) {
    const args = { id: start.sessionId, cursor: send.page?.nextCursor ?? start.cursor, waitMs: 1000 };
    executions.push({ name: "terminal.read", args, result: await toolRegistry["terminal.read"]!(args, options), turn: 0 });
  }
  const closeArgs = { id: start.sessionId };
  const closed = await toolRegistry["terminal.close"]!(closeArgs, options);
  executions.push({ name: "terminal.close", args: closeArgs, result: closed, turn: 0 });
  expect(await verifyTokenFixture(fixture, root, "Authenticated; owned session cleaned up", evidence(executions))).toBe(true);
  expect(await verifyTokenFixture(fixture, root, "Authenticated", evidence(executions.slice(0, -1)))).toBe(false);
  const wrongCursor = executions.map((entry) => entry.name === "terminal.send" ? { ...entry, args: { ...entry.args, cursor: start.cursor + 1 } } : entry);
  expect(terminalTranscriptIsCursorSafe(evidence(wrongCursor))).toBe(false);
  expect(JSON.stringify(executions)).not.toContain("synthetic-session-secret");
}, 30_000);

it("S09 resumes one actual owned job after the pause without accepting a fake or duplicate scan", async () => {
  const { root, owner, fixture } = await setup("security-s09-natural");
  const args = { command: "node check.mjs", cwd: root, background: "always", responder: false, name: "synthetic-scan" };
  const started = await toolRegistry["shell.exec"]!(args, { sessionId: owner });
  const id = started.backgroundJob?.id;
  if (!id) throw new Error("Missing actual owned job");
  const waitArgs = { id, timeoutMs: 10_000 };
  const waited = await toolRegistry["shell.wait"]!(waitArgs, { sessionId: owner });
  const job = jobManager.getJob(id)!;
  const executions: FixtureToolExecution[] = [{ name: "shell.exec", args, result: started, turn: 0 }, { name: "shell.wait", args: waitArgs, result: waited, turn: 1,
    job: { id: job.id, status: job.status, exitCode: job.exitCode, artifactPath: job.artifactPath } }];
  expect(await verifyTokenFixture(fixture, root, "SYNTHETIC_SCAN: status=403 size=64", evidence(executions))).toBe(true);
  expect(await verifyTokenFixture(fixture, root, "The scan exited 0. Status: **403**. Size: **64 bytes**.", evidence(executions))).toBe(true);
  expect(await verifyTokenFixture(fixture, root, "Status: 200. Size: 64.", evidence(executions))).toBe(false);
  expect(await verifyTokenFixture(fixture, root, "Status: 403. Size: 640.", evidence(executions))).toBe(false);
  expect(await verifyTokenFixture(fixture, root, "SYNTHETIC_SCAN: status=403 size=64", evidence([...executions, executions[0]!]))).toBe(false);
  expect(await verifyTokenFixture(fixture, root, "SYNTHETIC_SCAN: status=403 size=64", evidence(executions.slice(0, 1)))).toBe(false);
}, 20_000);

it("C07 checks actual finite foreground execution rather than an answer-only marker", async () => {
  const { root, owner, fixture } = await setup("finite-foreground-natural");
  const args = { command: "node check.mjs", cwd: root, timeoutMs: 10_000 };
  const result = await toolRegistry["shell.exec"]!(args, { sessionId: owner });
  expect(await verifyTokenFixture(fixture, root, "FOREGROUND_CHECK: 73", evidence([{ name: "shell.exec", args, result, turn: 0 }]))).toBe(true);
  expect(await verifyTokenFixture(fixture, root, "FOREGROUND_CHECK: 73")).toBe(false);
});

it("delivers a real owned Responder result through production wake identity before accepting job.read", async () => {
  const { root, owner } = await setup("responder-lifecycle-natural");
  const started = await toolRegistry["shell.exec"]!({ command: "node check.mjs", cwd: root, responder: true }, { sessionId: owner });
  const id = started.backgroundJob?.id;
  if (!id) throw new Error("Missing actual Responder job");
  await jobManager.waitForJob(id, { timeoutMs: 10000 });
  const request = parseResponderReadRequest("job.read", { jobId: id });
  const ports = {
    pendingNotifications: jobManager.getPendingNotifications(owner),
    matchesWakeRevision: () => true,
    isClaimed: () => false,
    markRead: (notificationId: string) => jobManager.markRead(notificationId, owner),
  };
  const ordinary = setUpResponderWake({ prompt: "Continue after delivery", displayPrompt: undefined, pendingNotifications: ports.pendingNotifications });
  expect(decideResponderRead(request, ordinary, ports)).toMatchObject({ marked: false, output: expect.stringContaining("not delivered") });
  const delivery = await prepareEvaluationResponderWake(jobManager, owner);
  expect(delivery.prompt).toContain("RESPONDER_CHECK: 58");
  const wake = setUpResponderWake({ ...delivery, pendingNotifications: ports.pendingNotifications });
  expect(wake.wakeTurn).toBe(true);
  expect(wake.jobId).toBe(id);
  expect(wake.claimedNotificationId).toBe(delivery.notification.id);
  expect(decideResponderRead(request, wake, { ...ports, isClaimed: (notificationId) => notificationId === wake.claimedNotificationId }).marked).toBe(true);
  expect(jobManager.getPendingNotifications(owner).find((entry) => entry.jobId === id)?.readAt).toBeTruthy();
  jobManager.releaseResponderLease(owner, delivery.leaseId);
}, 20000);
