import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JobManager,
  type BackgroundJob,
  type ResponderNotification,
} from "../src/tools/jobs.js";
import {
  createPlan,
  deletePlan,
  loadPlan,
  savePlan,
} from "../src/store/plan.js";

const dirs: string[] = [];
const managers: JobManager[] = [];
const planSessionIds: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(): Promise<{ dir: string; manager: JobManager }> {
  const dir = await mkdtemp(join(tmpdir(), "clai-jobs-"));
  dirs.push(dir);
  const manager = new JobManager(dir);
  managers.push(manager);
  return { dir, manager };
}

async function waitForStatus(manager: JobManager, id: string, statuses: string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (statuses.includes(manager.getJob(id)?.status ?? "")) return;
    await sleep(25);
  }
  throw new Error(`job ${id} did not reach ${statuses.join("/")}`);
}


async function waitForPlanTask(
  sessionId: string,
  taskId: string,
  state: "done" | "failed",
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const plan = await loadPlan(sessionId);
    if (plan?.tasks.find((task) => task.id === taskId)?.state === state) return;
    await sleep(25);
  }
  throw new Error(`task ${taskId} did not settle as ${state}`);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error("condition not reached before timeout");
}
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const job of manager.getRunningJobs()) await manager.stopJob(job.id, { graceMs: 200 });
  }
  // A stopped job's shell can still flush a chunk while the dir is removed,
  // so retry instead of failing the test on an ENOTEMPTY race.
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }),
      ),
  );
  await Promise.all(planSessionIds.splice(0).map((sessionId) => deletePlan(sessionId)));
});

describe("durable background jobs", () => {
  it("rediscovers, offset-tails, and process-group stops a live job after restart", async () => {
    const { dir, manager } = await fixture();
    const secret = "sk-super-secret-value";
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`console.log('${secret}'); setInterval(() => console.log('tick'), 40)`)}`;
    const started = await manager.startJob(command, { ownerSessionId: "session-1" });
    const id = /id=([a-f0-9]+)/.exec(started.output)?.[1];
    expect(id).toBeTruthy();
    await sleep(150);

    const restarted = new JobManager(dir);
    managers.push(restarted);
    const recovered = restarted.getJob(id!);
    expect(recovered).toMatchObject({ status: "running", ownerSessionId: "session-1" });
    expect(recovered?.processGroupId).toBe(recovered?.pid);

    const first = await restarted.tailJob(id!, { stream: "stdout", offset: 0, bytes: 80 });
    const nextOffset = Number(/nextOffset=(\d+)/.exec(first.output)?.[1]);
    const second = await restarted.tailJob(id!, { stream: "stdout", offset: nextOffset, bytes: 80 });
    expect(first.output).not.toContain(secret);
    // Each response is "<header>:\n<payload>"; a real poller reconstructs the
    // stream from the payloads alone (offset/nextOffset are contiguous, so no
    // separator belongs between them — unlike the header line, which isn't
    // part of the byte stream). Comparing full responses with an inserted
    // "\n" would inject the *second* header between the two payload halves,
    // spuriously failing whenever the redaction marker straddles the 80-byte
    // read boundary (path-length dependent, e.g. on macOS runners).
    const payloadOf = (output: string): string => output.slice(output.indexOf("\n") + 1);
    expect(`${payloadOf(first.output)}${payloadOf(second.output)}`).toContain("sk-••••••");
    expect(nextOffset).toBeGreaterThan(0);

    const stopped = await restarted.stopJob(id!, { graceMs: 500 });
    expect(stopped).toMatchObject({ ok: true });
    expect(stopped.output).toMatch(/termination verified/);
    expect(restarted.getJob(id!)?.status).toBe("killed");

    const registry = await readFile(join(dir, "registry-v1.json"), "utf8");
    expect(registry).not.toContain(secret);
    expect(registry).toContain('"status": "killed"');
  });

  it("records nonzero exits as failed with the actual exit code", async () => {
    const { manager } = await fixture();
    const started = await manager.startJob(`${JSON.stringify(process.execPath)} -e "process.exit(7)"`);
    const id = /id=([a-f0-9]+)/.exec(started.output)?.[1];
    expect(id).toBeTruthy();
    await waitForStatus(manager, id!, ["failed"]);
    expect(manager.getJob(id!)).toMatchObject({ status: "failed", exitCode: 7 });
    expect(manager.getPendingNotifications()).toHaveLength(0);
    const tail = await manager.tailJob(id!);
    expect(tail.output).toContain(`[${id}] failed exit=7`);
    expect(tail.backgroundJob).toMatchObject({ status: "failed", exitCode: 7 });
  });

  it("gives Responder launches one no-poll policy and structural ownership", async () => {
    const { manager } = await fixture();
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "setTimeout(() => process.exit(0), 150)",
    )}`;
    const started = await manager.startJob(command, {
      ownerSessionId: "responder-receipt",
      responder: true,
      wakeOnCompletion: true,
    });

    expect(started.ok).toBe(true);
    expect(started.backgroundJob?.responder).toBe(true);
    expect(started.output).toMatch(/Responder owns completion tracking/i);
    expect(started.output).toMatch(/Do not poll/i);
    expect(started.output).not.toMatch(/use shell\.tail|shell\.jobs for status|readiness probe/i);

    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    await waitForStatus(manager, id!, ["exited", "failed"]);
  });

  it("keeps Responder no-poll ownership on deduplicated launches", async () => {
    const { manager } = await fixture();
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "setTimeout(() => process.exit(0), 250)",
    )}`;
    const options = {
      ownerSessionId: "responder-dedup",
      delegationId: "delegation-dedup",
      responder: true,
      wakeOnCompletion: true,
    } as const;
    const first = await manager.startJob(command, options);
    const duplicate = await manager.startJob(command, options);

    expect(duplicate.backgroundJob?.id).toBe(first.backgroundJob?.id);
    expect(duplicate.backgroundJob?.responder).toBe(true);
    expect(duplicate.output).toMatch(/duplicate launch was not started/i);
    expect(duplicate.output).toMatch(/Responder owns completion tracking/i);
    expect(duplicate.output).toMatch(/Do not poll/i);
    expect(duplicate.output).not.toMatch(/poll this id instead|use shell\.tail/i);

    const id = first.backgroundJob?.id;
    expect(id).toBeTruthy();
    await waitForStatus(manager, id!, ["exited", "failed"]);
  });

  it("labels launch success separately from later application failure", async () => {
    const { manager } = await fixture();
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => process.exit(7), 500)")}`;
    const started = await manager.startJob(command);

    expect(started.ok).toBe(true);
    expect(started.output).toContain("OS process launch confirmed");
    expect(started.output).toContain("does not prove application readiness");
    expect(started.output).toContain("shell.tail");

    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    await waitForStatus(manager, id!, ["failed"]);
    expect(manager.getJob(id!)).toMatchObject({ status: "failed", exitCode: 7 });
  });

  it("forwards sensitive stdin once without persisting it and accepts artifact aliases", async () => {
    const { dir, manager } = await fixture();
    const secret = "modal-password-never-persist";
    const script =
      "let data=''; process.stdin.on('data', c => data += c); " +
      "process.stdin.on('end', () => { console.log(data.trim() === 'modal-password-never-persist' ? 'accepted' : 'rejected'); process.exit(data.trim() === 'modal-password-never-persist' ? 0 : 9); });";
    const started = await manager.startJob({
      command: process.execPath,
      argv: ["-e", script],
      stdinText: `${secret}\n`,
      display: "privileged-fixture",
    });
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    await waitForStatus(manager, id!, ["exited", "failed"]);
    expect(manager.getJob(id!)).toMatchObject({ status: "exited", exitCode: 0 });

    const aliasTail = await manager.tailJob(started.outputPath!);
    expect(aliasTail.ok).toBe(true);
    expect(aliasTail.backgroundJob?.id).toBe(id);
    expect(aliasTail.output).toContain("accepted");

    const registry = await readFile(join(dir, "registry-v1.json"), "utf8");
    const stdout = await readFile(started.outputPath!, "utf8");
    expect(`${started.output}\n${registry}\n${stdout}`).not.toContain(secret);
    expect(started.output).toContain(`shell.tail {"id":"${id}"}`);
  });

  it("marks unverifiable persisted running records lost instead of trusting a reused pid", async () => {
    const { dir, manager } = await fixture();
    const started = await manager.startJob(`${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`);
    const id = /id=([a-f0-9]+)/.exec(started.output)?.[1]!;
    await sleep(80);
    const registryPath = join(dir, "registry-v1.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.jobs.find((job: { id: string }) => job.id === id).processIdentity = "wrong-identity";
    await import("node:fs/promises").then(({ writeFile }) => writeFile(registryPath, JSON.stringify(registry)));

    const restarted = new JobManager(dir);
    managers.push(restarted);
    expect(restarted.getJob(id)?.status).toBe("lost");
    await manager.stopJob(id, { graceMs: 200 });
  });

  it("keeps an alive persisted running job running when its identity is absent (never falsely lost)", async () => {
    const { dir, manager } = await fixture();
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
    );
    const id = /id=([a-f0-9]+)/.exec(started.output)?.[1]!;
    await sleep(80);
    const registryPath = join(dir, "registry-v1.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    const record = registry.jobs.find((job: { id: string }) => job.id === id);
    // An unreadable/absent identity must NOT be treated as a dead process: the
    // pid is alive and there is no PROVEN reuse, so the job stays running.
    delete record.processIdentity;
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(registryPath, JSON.stringify(registry)),
    );

    const restarted = new JobManager(dir);
    managers.push(restarted);
    expect(restarted.getJob(id)?.status).toBe("running");
    // Repeated liveness re-checks (as the UI polls) keep it running, never
    // flipping a live job to a premature terminal "lost".
    expect(restarted.getJob(id)?.status).toBe("running");
    expect(
      restarted.getRunningJobs().some((job) => job.id === id),
    ).toBe(true);
    await manager.stopJob(id, { graceMs: 200 });
  });
});


describe("durable job safety edges", () => {
  it("redacts a secret split across process output chunks", async () => {
    const { manager } = await fixture();
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('sk-super-'); setTimeout(() => { process.stdout.write('secret-value\\n'); }, 25)")}`;
    const started = await manager.startJob(command);
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    await waitForStatus(manager, id!, ["exited"]);
    const tailed = await manager.tailJob(id!, { stream: "stdout", offset: 0, bytes: 4096 });
    expect(tailed.output).not.toContain("sk-super-secret-value");
    expect(tailed.output).toContain("sk-••••••");
  });

  it("refuses to start a durable action after authorization expiry", async () => {
    const { manager } = await fixture();
    const result = await manager.startJob("echo should-not-run", {
      authorization: { target: "example.com", expiresAt: "2000-01-01T00:00:00.000Z" },
    });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(manager.getRecentJobs()).toHaveLength(0);
  });

  it("waits for OS spawn confirmation and returns actionable launch failures", async () => {
    const { dir, manager } = await fixture();
    const missingExecutable = join(dir, "definitely-missing-command");
    const result = await manager.startJob({
      command: missingExecutable,
      argv: [],
      display: "missing-command-fixture",
    });

    expect(result).toMatchObject({ ok: false, exitCode: 127 });
    expect(result.output).toContain("Background command launch error [ENOENT]");
    expect(result.output).toContain(`target=${JSON.stringify(missingExecutable)}`);
    expect(result.output).toContain(`cwd=${JSON.stringify(process.cwd())}`);
    expect(result.output).toContain("The command did not start");
    expect(result.backgroundJob).toMatchObject({ status: "failed", exitCode: 127 });
    expect(manager.getJob(result.backgroundJob!.id)).toMatchObject({
      status: "failed",
      exitCode: 127,
    });
  });

  it("preserves Responder ownership on OS spawn failure", async () => {
    const { dir, manager } = await fixture();
    const missingExecutable = join(dir, "missing-responder-command");
    const result = await manager.startJob(
      {
        command: missingExecutable,
        argv: [],
        display: "missing-responder-fixture",
      },
      {
        ownerSessionId: "responder-spawn-failure",
        responder: true,
        wakeOnCompletion: true,
      },
    );

    expect(result).toMatchObject({ ok: false, exitCode: 127 });
    expect(result.backgroundJob).toMatchObject({
      status: "failed",
      responder: true,
    });
    expect(result.output).toMatch(/Responder owns this terminal launch failure/i);
    expect(result.output).toMatch(/do not poll or retry/i);
    expect(result.output).not.toMatch(/use shell\.tail|shell\.jobs for status/i);
  });

  it("preserves Responder ownership when spawn throws before launch confirmation", async () => {
    const { manager } = await fixture();
    const result = await manager.startJob(
      {
        command: "invalid\0command",
        argv: [],
        display: "invalid-command-fixture",
      },
      {
        ownerSessionId: "responder-thrown-spawn",
        responder: true,
        wakeOnCompletion: true,
      },
    );

    expect(result).toMatchObject({ ok: false, exitCode: 127 });
    expect(result.backgroundJob).toMatchObject({
      status: "failed",
      responder: true,
    });
    expect(result.output).toMatch(/Background command launch error \[UNKNOWN\]/i);
    expect(result.output).toMatch(/Responder owns completion tracking/i);
    expect(result.output).toMatch(/Do not poll/i);
    expect(result.output).not.toMatch(/use shell\.tail|shell\.jobs for status/i);
  });

  it("rejects an invalid cwd before creating a phantom background job", async () => {
    const { dir, manager } = await fixture();
    const missingCwd = join(dir, "missing-cwd");
    const result = await manager.startJob("echo never-runs", { cwd: missingCwd });

    expect(result).toMatchObject({ ok: false, exitCode: 127 });
    expect(result.output).toContain("Background command launch error [INVALID_CWD]");
    expect(result.output).toContain(`cwd=${JSON.stringify(missingCwd)}`);
    expect(result.output).toContain("The command did not start");
    expect(manager.getRecentJobs()).toHaveLength(0);
  });

  it("reports a public shell string that exits 127 immediately as failed", async () => {
    const { manager } = await fixture();
    const result = await manager.startJob("definitely-missing-clai-command");

    expect(result).toMatchObject({ ok: false, exitCode: 127 });
    expect(result.output).toContain("failed immediately");
    expect(result.output).toContain("do not retry unchanged");
    expect(result.backgroundJob).toMatchObject({ status: "failed", exitCode: 127 });
  });

  it("never claims a launched process did not start when final persistence fails", async () => {
    const { manager } = await fixture();
    const internal = manager as unknown as { persist: () => Promise<void> };
    const realPersist = internal.persist.bind(manager);
    let persistCalls = 0;
    internal.persist = async () => {
      persistCalls += 1;
      if (persistCalls === 2) throw new Error("simulated registry write failure");
      await realPersist();
    };

    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`;
    const result = await manager.startJob(command);
    internal.persist = realPersist;

    expect(result.ok).toBe(true);
    expect(result.output).toContain("launched as pid=");
    expect(result.output).toContain("simulated registry write failure");
    expect(result.output).toContain("do not launch a duplicate");
    expect(result.output).not.toContain("The command did not start");
    expect(result.backgroundJob).toMatchObject({ status: "running" });
    await manager.stopJob(result.backgroundJob!.id, { graceMs: 300 });
  });

  it("emits a completion notification when the first registry write fails", async () => {
    const { dir, manager } = await fixture();
    const changes: string[] = [];
    const unsubscribe = manager.subscribe((change) => {
      if (change.type === "notification") changes.push(change.notificationId);
    });
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.exit(0), 150)"`,
      { ownerSessionId: "persist-retry", responder: true, wakeOnCompletion: true },
    );
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();

    const internal = manager as unknown as { persistSync: () => boolean };
    const persistSync = internal.persistSync.bind(manager);
    let failNext = true;
    internal.persistSync = () => {
      if (failNext) {
        failNext = false;
        return false;
      }
      return persistSync();
    };

    await waitForStatus(manager, id!, ["exited"]);
    internal.persistSync = persistSync;
    unsubscribe();
    expect(changes).toHaveLength(1);
    expect(manager.getPendingNotifications("persist-retry")).toHaveLength(1);
    await sleep(350);
    const restarted = new JobManager(dir);
    managers.push(restarted);
    expect(restarted.getJob(id!)).toMatchObject({ status: "exited", exitCode: 0 });
    expect(restarted.getPendingNotifications("persist-retry")).toHaveLength(1);
  });

  it("keeps timeout input inert and strips legacy timeoutAt on restart", async () => {
    const { dir, manager } = await fixture();
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        "setTimeout(() => process.exit(0), 1000)",
      )}`,
      { timeoutMs: 5 },
    );
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    await sleep(80);
    expect(manager.getJob(id!)).toMatchObject({ status: "running" });
    expect(manager.getJob(id!)).not.toHaveProperty("timeoutAt");

    const registryPath = join(dir, "registry-v1.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.jobs.find((job: { id: string }) => job.id === id).timeoutAt =
      "2000-01-01T00:00:00.000Z";
    await writeFile(registryPath, `${JSON.stringify(registry)}\n`);

    const restarted = new JobManager(dir);
    managers.push(restarted);
    expect(restarted.getJob(id!)).toMatchObject({ status: "running" });
    expect(restarted.getJob(id!)).not.toHaveProperty("timeoutAt");
    expect(await readFile(registryPath, "utf8")).not.toContain("timeoutAt");
  });

  it("restores authorization expiry enforcement after restart", async () => {
    const { dir, manager } = await fixture();
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        "setInterval(() => {}, 1000)",
      )}`,
      { ownerSessionId: "authorization-restart" },
    );
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();

    const registryPath = join(dir, "registry-v1.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.jobs.find((job: { id: string }) => job.id === id).authorization = {
      target: "example.com",
      expiresAt: new Date(Date.now() + 250).toISOString(),
    };
    await writeFile(registryPath, `${JSON.stringify(registry)}\n`);

    const restarted = new JobManager(dir);
    managers.push(restarted);
    await waitForStatus(restarted, id!, ["killed"]);
    expect(restarted.getJob(id!)).toMatchObject({
      status: "killed",
      signal: expect.stringMatching(/^SIG/),
    });
  });

  it("settles and retains an undelivered responder receipt after restart", async () => {
    const { dir, manager } = await fixture();
    const sessionId = `settlement-${Date.now()}-${Math.random()}`;
    planSessionIds.push(sessionId);
    const plan = createPlan({
      sessionId,
      goal: "settle responder child",
      detail: "background settlement fixture",
      taskTitles: ["foreground work"],
    });
    plan.status = "completed";
    plan.tasks[0]!.state = "done";
    plan.tasks.push({
      id: "responder-child",
      title: "background verification",
      state: "in_progress",
      dependencies: [plan.tasks[0]!.id],
      resourceLocks: [],
      responderOwned: true,
    });
    await savePlan(plan);

    const leaseId = manager.activateResponderLease(sessionId);
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        "setInterval(() => {}, 1000)",
      )}`,
      {
        ownerSessionId: sessionId,
        taskId: "responder-child",
        responder: true,
        wakeOnCompletion: true,
        responderLeaseId: leaseId,
      },
    );
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    manager.releaseResponderLease(sessionId, leaseId);
    expect(manager.getJob(id!)?.status).toBe("running");

    const registryPath = join(dir, "registry-v1.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    const record = registry.jobs.find((job: { id: string }) => job.id === id);
    record.status = "exited";
    record.exitCode = 0;
    record.endedAt = new Date().toISOString();
    await writeFile(registryPath, `${JSON.stringify(registry)}\n`);

    const restarted = new JobManager(dir);
    managers.push(restarted);
    await waitForPlanTask(sessionId, "responder-child", "done");
    await waitFor(
      () =>
        Boolean(
          restarted.getPendingNotifications(sessionId)[0]?.settledAt,
        ),
      5_000,
    );
    const notification = restarted.getPendingNotifications(sessionId)[0];
    expect(notification).toMatchObject({
      jobId: id,
      settledAt: expect.any(String),
    });
    expect(notification?.archivedAt).toBeUndefined();
    expect(notification?.deliveredAt).toBeUndefined();
    expect(notification?.analyzedAt).toBeUndefined();
    expect(manager.getJob(id!)?.status).toBe("running");
  });
});



describe("authoritative job completion", () => {
  function trackedJob(
    dir: string,
    id: string,
    status: BackgroundJob["status"],
    responder = false,
  ): BackgroundJob {
    const stdout = join(dir, `${id}.stdout.log`);
    const stderr = join(dir, `${id}.stderr.log`);
    return {
      id,
      command: "npm run build",
      commandDisplay: "npm run build",
      cwd: dir,
      pid: 999_999,
      status,
      startedAt: "2026-07-22T14:30:30.399Z",
      artifactPath: stdout,
      stdoutArtifact: stdout,
      stderrArtifact: stderr,
      artifacts: {
        stdout: {
          path: stdout,
          chunks: [],
          bytes: 0,
          droppedBytes: 0,
          redacted: false,
          sha256: "",
        },
        stderr: {
          path: stderr,
          chunks: [],
          bytes: 0,
          droppedBytes: 0,
          redacted: false,
          sha256: "",
        },
      },
      redactionProfile: "provider-secrets-v1",
      ownerSessionId: "authoritative-session",
      kind: "durable",
      responder,
      wakeOnCompletion: responder,
      ...(responder ? { taskId: "t5" } : {}),
    };
  }

  it("bounds archived responder receipts that cannot settle", async () => {
    const { dir, manager } = await fixture();
    const internal = manager as unknown as {
      jobs: Map<string, BackgroundJob>;
      notifications: Map<string, ResponderNotification>;
    };
    for (let index = 0; index < 45; index += 1) {
      const id = `archived-${index}`;
      const job = trackedJob(dir, id, "exited", true);
      const endedAt = new Date(Date.now() - index * 1000).toISOString();
      job.exitCode = 0;
      job.endedAt = endedAt;
      internal.jobs.set(id, job);
      internal.notifications.set(`completion:${id}`, {
        id: `completion:${id}`,
        ownerSessionId: job.ownerSessionId,
        jobId: id,
        status: "exited",
        exitCode: 0,
        createdAt: endedAt,
        startedAt: job.startedAt,
        endedAt,
        stdoutArtifact: { ...job.artifacts.stdout, chunks: [] },
        stderrArtifact: { ...job.artifacts.stderr, chunks: [] },
        commandDisplay: job.commandDisplay,
        wakeOnCompletion: true,
        responder: true,
        archivedAt: endedAt,
      });
    }

    manager.pruneTerminalJobs();
    expect(manager.getPendingNotifications("authoritative-session")).toHaveLength(40);
  });

  it("never declares a child lost while this manager still owns it", async () => {
    const { dir, manager } = await fixture();
    const job = trackedJob(dir, "managed1", "running");
    manager.registerJob("managed1", job, undefined, {} as never);

    expect(manager.getJob("managed1")?.status).toBe("running");
    expect(manager.listJobs("authoritative-session").output).toContain(
      "managed1] running",
    );

    manager.updateJobStatus("managed1", "exited", 0);
    await waitForStatus(manager, "managed1", ["exited"]);
  });

  it("corrects a delivered lost receipt with authoritative exit data and artifacts", async () => {
    const { dir, manager } = await fixture();
    const job = trackedJob(dir, "correct1", "lost", true);
    manager.registerJob("correct1", job);
    manager.updateJobStatus("correct1", "lost");
    const deadline = Date.now() + 2_000;
    while (
      Date.now() < deadline &&
      manager.getPendingNotifications("authoritative-session").length === 0
    ) {
      await sleep(20);
    }
    const original = manager.getPendingNotifications("authoritative-session")[0];
    expect(original).toMatchObject({ status: "lost", jobId: "correct1" });
    expect(manager.markDelivered(original!.id)).toBe(true);
    const deliveredAt = manager.getPendingNotifications(
      "authoritative-session",
    )[0]?.deliveredAt;

    const current = manager.getJob("correct1")!;
    current.artifacts.stdout.bytes = 473;
    current.artifacts.stdout.sha256 = "authoritative-sha";
    current.artifacts.stdout.chunks = [current.stdoutArtifact];
    manager.updateJobStatus("correct1", "exited", 0);
    await waitForStatus(manager, "correct1", ["exited"]);

    const corrected = manager.getPendingNotifications(
      "authoritative-session",
    )[0];
    expect(corrected).toMatchObject({
      id: original!.id,
      status: "exited",
      exitCode: 0,
      resultRevision: 2,
      stdoutArtifact: { bytes: 473, sha256: "authoritative-sha" },
    });
    // A material correction supersedes the delivered revision, so the corrected
    // result must be reviewed again instead of inheriting its markers.
    expect(corrected?.deliveredAt).toBeUndefined();
    expect(corrected?.supersededRevisions?.[0]).toMatchObject({
      resultRevision: 1,
      status: "lost",
      deliveredAt,
    });

    const restarted = new JobManager(dir);
    managers.push(restarted);
    expect(restarted.getPendingNotifications("authoritative-session")[0]).toMatchObject({
      id: original!.id,
      status: "exited",
      exitCode: 0,
      stdoutArtifact: { bytes: 473, sha256: "authoritative-sha" },
    });
  });

  it("preserves an authoritative terminal result against a later conflicting update", async () => {
    const { manager } = await fixture();
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      { ownerSessionId: "monotonic" },
    );
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    await waitForStatus(manager, id!, ["exited"]);
    expect(manager.getJob(id!)).toMatchObject({ status: "exited", exitCode: 0 });

    manager.updateJobStatus(id!, "failed", 7);
    manager.updateJobStatus(id!, "killed");
    expect(manager.getJob(id!)).toMatchObject({ status: "exited", exitCode: 0 });
  });

  it("requires analysis before acknowledgement and persists the analyzed marker across restart", async () => {
    const { dir, manager } = await fixture();
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      { ownerSessionId: "analyze-gate", responder: true, wakeOnCompletion: true },
    );
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    await waitForStatus(manager, id!, ["exited"]);
    const notificationId = manager.getPendingNotifications("analyze-gate")[0]?.id;
    expect(notificationId).toBeTruthy();

    expect(manager.acknowledge(notificationId!)).toBe(false);
    expect(manager.markDelivered(notificationId!)).toBe(true);
    expect(manager.acknowledge(notificationId!)).toBe(false);
    expect(manager.markAnalyzed(notificationId!)).toBe(true);

    const restarted = new JobManager(dir);
    managers.push(restarted);
    const recovered = restarted.getPendingNotifications("analyze-gate")[0];
    expect(recovered).toMatchObject({ id: notificationId, analyzedAt: expect.any(String) });
    expect(restarted.acknowledge(notificationId!)).toBe(true);
    expect(restarted.getPendingNotifications("analyze-gate")).toHaveLength(0);
  });
});


describe("responder receipt delivery boundaries", () => {
  it("holds a receipt within one turn and reselects it later until read", async () => {
    const { manager } = await fixture();
    const sessionId = "claim-boundary";
    const leaseId = manager.activateResponderLease(sessionId);
    const start = async () => {
      const result = await manager.startJob(
        `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
        {
          ownerSessionId: sessionId,
          responder: true,
          wakeOnCompletion: true,
          responderLeaseId: leaseId,
        },
      );
      const id = result.backgroundJob?.id;
      expect(id).toBeTruthy();
      await waitForStatus(manager, id!, ["exited"]);
      return id!;
    };

    const firstJobId = await start();
    const first = manager.claimNextResponderNotification(sessionId, leaseId);
    expect(first).toMatchObject({ jobId: firstJobId });
    expect(first?.deliveredAt).toBeUndefined();
    expect(manager.claimNextResponderNotification(sessionId, leaseId)).toBeUndefined();
    manager.releaseResponderNotificationClaim(first!.id);
    expect(
      manager.claimNextResponderNotification(sessionId, leaseId)?.id,
    ).toBe(first?.id);
    expect(
      manager.getPendingNotifications(sessionId).find((item) => item.id === first?.id)
        ?.deliveredAt,
    ).toBeUndefined();

    expect(manager.markDelivered(first!.id)).toBe(true);
    expect(manager.claimNextResponderNotification(sessionId, leaseId)).toBeUndefined();
    manager.releaseResponderNotificationClaim(first!.id);
    expect(
      manager.claimNextResponderNotification(sessionId, leaseId)?.id,
    ).toBe(first?.id);

    const secondJobId = await start();
    const second = manager.claimNextResponderNotification(sessionId, leaseId);
    expect(second).toMatchObject({ jobId: secondJobId });
    expect(second?.id).not.toBe(first?.id);
    const retainedFirst = manager
      .getPendingNotifications(sessionId)
      .find((item) => item.id === first?.id);
    expect(retainedFirst).toMatchObject({ deliveredAt: expect.any(String) });
    expect(retainedFirst?.analyzedAt).toBeUndefined();
  });
});


describe("responder delivery persistence", () => {
  it("rolls back deliveredAt when its registry write fails", async () => {
    const { manager } = await fixture();
    const sessionId = "delivery-persist-failure";
    const leaseId = manager.activateResponderLease(sessionId);
    const result = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      {
        ownerSessionId: sessionId,
        responder: true,
        wakeOnCompletion: true,
        responderLeaseId: leaseId,
      },
    );
    const jobId = result.backgroundJob?.id;
    expect(jobId).toBeTruthy();
    await waitForStatus(manager, jobId!, ["exited"]);
    const notification = manager.claimNextResponderNotification(
      sessionId,
      leaseId,
    );
    expect(notification).toBeTruthy();

    const internal = manager as unknown as { persistSync: () => boolean };
    const persistSync = internal.persistSync.bind(manager);
    internal.persistSync = () => false;
    expect(manager.markDelivered(notification!.id)).toBe(false);
    internal.persistSync = persistSync;

    expect(
      manager.getPendingNotifications(sessionId)[0]?.deliveredAt,
    ).toBeUndefined();
    manager.releaseResponderNotificationClaim(notification!.id);
    expect(
      manager.claimNextResponderNotification(sessionId, leaseId)?.id,
    ).toBe(notification?.id);
    expect(manager.markDelivered(notification!.id)).toBe(true);
  });
});


describe("responder memory and explicit read receipts", () => {
  it("pauses a noisy responder pipe when artifact persistence applies backpressure", async () => {
    const { manager } = await fixture();
    const pause = vi.spyOn(Readable.prototype, "pause");
    try {
      const script =
        "for(let i=0;i<512;i++) process.stdout.write('x'.repeat(8192));";
      const started = await manager.startJob(
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        { ownerSessionId: "backpressure", responder: true },
      );
      const id = started.backgroundJob?.id;
      expect(id).toBeTruthy();
      await waitForStatus(manager, id!, ["exited"]);
      expect(pause).toHaveBeenCalled();
      expect(manager.getJob(id!)?.artifacts.stdout.bytes).toBeGreaterThan(
        3 * 1024 * 1024,
      );
      const internal = manager as unknown as {
        processes: Map<string, unknown>;
        writers: Map<string, unknown>;
      };
      expect(internal.processes.size).toBe(0);
      expect(internal.writers.size).toBe(0);
    } finally {
      pause.mockRestore();
    }
  });

  it("atomically marks a model-read notification delivered and read across restart", async () => {
    const { dir, manager } = await fixture();
    const sessionId = "explicit-read";
    const leaseId = manager.activateResponderLease(sessionId);
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      {
        ownerSessionId: sessionId,
        responder: true,
        wakeOnCompletion: true,
        responderLeaseId: leaseId,
      },
    );
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    await waitForStatus(manager, id!, ["exited"]);
    const notification = manager.getPendingNotifications(sessionId)[0];
    expect(notification?.deliveredAt).toBeUndefined();
    expect(notification?.readAt).toBeUndefined();

    expect(manager.markRead(notification!.id, sessionId)).toBe(true);
    expect(notification).toMatchObject({
      deliveredAt: expect.any(String),
      readAt: expect.any(String),
    });
    expect(notification?.analyzedAt).toBeUndefined();
    expect(
      manager.claimNextResponderNotification(sessionId, leaseId),
    ).toBeUndefined();

    const restarted = new JobManager(dir);
    managers.push(restarted);
    expect(restarted.getPendingNotifications(sessionId)[0]).toMatchObject({
      id: notification?.id,
      deliveredAt: notification?.deliveredAt,
      readAt: notification?.readAt,
    });
  });

  it("releases runtime maps across a long responder session", async () => {
    const { manager } = await fixture();
    const sessionId = "bounded-runtime";
    const leaseId = manager.activateResponderLease(sessionId);
    for (let batch = 0; batch < 6; batch += 1) {
      await Promise.all(
        Array.from({ length: 5 }, () =>
          manager.startJob(
            `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"`,
            {
              ownerSessionId: sessionId,
              responder: true,
              wakeOnCompletion: true,
              responderLeaseId: leaseId,
            },
          ),
        ),
      );
      await waitFor(() => manager.getRunningJobs(sessionId).length === 0);
      for (const notification of manager.getPendingNotifications(sessionId)) {
        expect(manager.markRead(notification.id, sessionId)).toBe(true);
        expect(manager.markAnalyzed(notification.id)).toBe(true);
        expect(manager.acknowledge(notification.id)).toBe(true);
      }
    }

    const internal = manager as unknown as {
      jobs: Map<string, unknown>;
      notifications: Map<string, unknown>;
      processes: Map<string, unknown>;
      writers: Map<string, unknown>;
      abortControllers: Map<string, unknown>;
      settlementTimers: Map<string, unknown>;
      settlementAttempts: Map<string, unknown>;
      finalizations: Map<string, unknown>;
    };
    expect(internal.jobs.size).toBeLessThanOrEqual(80);
    expect(internal.notifications.size).toBe(0);
    expect(internal.processes.size).toBe(0);
    expect(internal.writers.size).toBe(0);
    expect(internal.abortControllers.size).toBe(0);
    expect(internal.settlementTimers.size).toBe(0);
    expect(internal.pendingSettlements.size).toBe(0);
    expect(internal.finalizations.size).toBe(0);
  }, 10_000);
});


describe("responder read persistence", () => {
  it("rolls back deliveredAt and readAt together when persistence fails", async () => {
    const { manager } = await fixture();
    const sessionId = "read-persist-failure";
    const leaseId = manager.activateResponderLease(sessionId);
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      {
        ownerSessionId: sessionId,
        responder: true,
        wakeOnCompletion: true,
        responderLeaseId: leaseId,
      },
    );
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    await waitForStatus(manager, id!, ["exited"]);
    const notification = manager.getPendingNotifications(sessionId)[0]!;
    const internal = manager as unknown as { persistSync: () => boolean };
    const persistSync = internal.persistSync.bind(manager);
    internal.persistSync = () => false;
    expect(manager.markRead(notification.id, sessionId)).toBe(false);
    internal.persistSync = persistSync;
    expect(notification.deliveredAt).toBeUndefined();
    expect(notification.readAt).toBeUndefined();
    expect(manager.markRead(notification.id, sessionId)).toBe(true);
  });
});
