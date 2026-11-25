import { afterEach, describe, expect, it } from "vitest";
import { liveJob } from "./fixtures/live-pagers.js";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactPagerSource } from "../src/ui-core/rendering/artifact-pager-source.js";
import {
  createJobTailPagerSource,
  isLiveJobStatus,
  jobTailTitle,
} from "../src/ui-core/rendering/job-tail-source.js";
import { defaultKeymap, validateKeymap } from "../src/ui-core/actions/keymap.js";
import type { BackgroundJob, JobsPort } from "../src/app/ports/jobs-port.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "clai-tail-"));
  dirs.push(dir);
  return dir;
}

function receipt(path: string, chunks: string[] = []) {
  return {
    path,
    chunks,
    bytes: 0,
    droppedBytes: 0,
    redacted: false,
    sha256: "",
  };
}

function fakeJobsPort(job: BackgroundJob): {
  port: JobsPort;
  emit: () => void;
  setJob: (next: BackgroundJob) => void;
} {
  let current = job;
  const listeners = new Set<(change: { type: "job"; jobId: string }) => void>();
  const port = {
    get: (id: string) => (id === current.id ? current : undefined),
    subscribe: (listener: never) => {
      listeners.add(listener as never);
      return () => listeners.delete(listener as never);
    },
  } as unknown as JobsPort;
  return {
    port,
    emit: () => {
      for (const listener of listeners) listener({ type: "job", jobId: current.id });
    },
    setJob: (next) => {
      current = next;
    },
  };
}

function job(dir: string, overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  const stdout = join(dir, "job.out");
  return {
    id: "job-1",
    command: "npm run dev",
    commandDisplay: "npm run dev",
    cwd: dir,
    status: "running",
    startedAt: new Date().toISOString(),
    artifactPath: stdout,
    stdoutArtifact: stdout,
    stderrArtifact: join(dir, "job.err"),
    artifacts: { stdout: receipt(stdout), stderr: receipt(join(dir, "job.err")) },
    redactionProfile: "provider-secrets-v1",
    ownerSessionId: "s1",
    ...overrides,
  } as BackgroundJob;
}

describe("artifact source tail", () => {
  it("reads the newest page of a growing file", async () => {
    const dir = workspace();
    const path = join(dir, "out.log");
    writeFileSync(path, "first line\n");
    const source = createArtifactPagerSource(path, 1024);

    const initial = await source.readTail!();
    expect(initial.body).toContain("first line");
    expect(initial.totalBytes).toBe(11);

    appendFileSync(path, "second line\n");
    const grown = await source.readTail!();
    expect(grown.body).toContain("second line");
    expect(grown.totalBytes).toBeGreaterThan(initial.totalBytes);
    source.dispose();
  });

  it("keeps the window bounded on a large file", async () => {
    const dir = workspace();
    const path = join(dir, "big.log");
    writeFileSync(path, "x".repeat(200_000));
    const source = createArtifactPagerSource(path, 4096);
    const tail = await source.readTail!();
    expect(tail.body.length).toBeLessThanOrEqual(4100);
    expect(tail.totalBytes).toBe(200_000);
    source.dispose();
  });
});

describe("job tail source", () => {
  it("observes writes after job events, rotations, and the final status, then releases its watchers", async () => {
    const dir = workspace();
    const path = join(dir, "job.log");
    const rotated = `${path}.1`;
    writeFileSync(path, "boot\n");
    const job = liveJob(path);
    const source = createJobTailPagerSource({ jobs: job.port, jobId: "job-1" })!;
    let body = "";
    const unwatch = source.watch!(() => {
      void source.readTail!().then((page) => { body = page.body; }).catch(() => undefined);
    });
    try {
      job.emit();
      await expect.poll(() => body).toBe("boot\n");
      appendFileSync(path, "delayed write\n");
      await expect.poll(() => body).toContain("delayed write");
      job.update({ artifacts: { stdout: receipt(path, [path, rotated]), stderr: receipt(join(dir, "job.err")) } });
      writeFileSync(rotated, "rotated output\n");
      await expect.poll(() => body).toBe("rotated output\n");
      job.update({ status: "exited", exitCode: 0 });
      expect(source.isGrowing?.()).toBe(false);
      appendFileSync(rotated, "last flushed line\n");
      await expect.poll(() => body).toContain("last flushed line");
      source.dispose();
      expect(job.listeners()).toBe(0);
      expect(() => source.readTail!()).toThrow("disposed");
      unwatch();
      expect(job.listeners()).toBe(0);
    } finally { source.dispose(); }
  });

  it("follows a job artifact and reports growth", async () => {
    const dir = workspace();
    const target = job(dir);
    writeFileSync(target.stdoutArtifact, "boot\n");
    const { port, emit } = fakeJobsPort(target);
    const source = createJobTailPagerSource({ jobs: port, jobId: "job-1", pageBytes: 2048 });
    expect(source).toBeDefined();
    if (!source) return;

    expect(source.isGrowing?.()).toBe(true);
    const first = await source.readTail!();
    expect(first.body).toContain("boot");

    let notified = 0;
    const unwatch = source.watch!(() => {
      notified += 1;
    });
    emit();
    expect(notified).toBe(1);

    appendFileSync(target.stdoutArtifact, "listening on 3000\n");
    const second = await source.readTail!();
    expect(second.body).toContain("listening on 3000");
    unwatch();
    emit();
    expect(notified).toBe(1);
    source.dispose();
  });

  it("follows a rotation to the newest chunk", async () => {
    const dir = workspace();
    const base = join(dir, "job.out");
    const rotated = `${base}.1`;
    const target = job(dir);
    writeFileSync(base, "old chunk\n");
    writeFileSync(rotated, "new chunk\n");
    target.artifacts.stdout.chunks = [base, rotated];
    const { port } = fakeJobsPort(target);
    const source = createJobTailPagerSource({ jobs: port, jobId: "job-1", pageBytes: 2048 });
    const page = await source!.readTail!();
    expect(page.body).toContain("new chunk");
    expect(page.body).not.toContain("old chunk");
    source!.dispose();
  });

  it("reports a finished job as not growing", () => {
    const dir = workspace();
    const target = job(dir, { status: "exited", exitCode: 0 });
    writeFileSync(target.stdoutArtifact, "done\n");
    const { port } = fakeJobsPort(target);
    const source = createJobTailPagerSource({ jobs: port, jobId: "job-1" });
    expect(source?.isGrowing?.()).toBe(false);
    source?.dispose();
  });

  it("returns undefined when a job has no artifact", () => {
    const { port } = fakeJobsPort({ id: "job-1" } as BackgroundJob);
    expect(createJobTailPagerSource({ jobs: port, jobId: "job-1" })).toBeUndefined();
    expect(createJobTailPagerSource({ jobs: port, jobId: "missing" })).toBeUndefined();
  });

  it("ignores notifications for other jobs", () => {
    const dir = workspace();
    const target = job(dir);
    writeFileSync(target.stdoutArtifact, "x\n");
    const { port } = fakeJobsPort(target);
    const source = createJobTailPagerSource({ jobs: port, jobId: "job-1" })!;
    let hits = 0;
    const unwatch = source.watch!(() => {
      hits += 1;
    });
    port.subscribe(() => undefined);
    unwatch();
    expect(hits).toBe(0);
    source.dispose();
  });

  it("exposes status-colored command content without changing log offsets or exports", async () => {
    const dir = workspace();
    const target = job(dir, { command: "private raw command", commandDisplay: "printf first\n\nprintf second" });
    writeFileSync(target.stdoutArtifact, "first output\nsecond output\n");
    const { port, setJob } = fakeJobsPort(target);
    const source = createJobTailPagerSource({ jobs: port, jobId: target.id })!;
    try {
      expect(source.commandText?.()).toBe("printf first\n\nprintf second");
      expect(source.commandTone?.()).toBe("running");
      const page = await source.readPage(0);
      expect(page.body).toBe("first output\nsecond output\n");
      expect(page.offset).toBe(0);
      expect(page.nextOffset).toBe(Buffer.byteLength(page.body));
      expect(await source.readAll()).toBe(page.body);
      expect((await source.search("second output"))?.body).toContain("second output");
      setJob({ ...target, status: "exited", exitCode: 0 });
      expect(source.commandTone?.()).toBe("success");
      setJob({ ...target, status: "exited", exitCode: 1 });
      expect(source.commandTone?.()).toBe("failed");
      expect(source.commandText?.()).not.toContain("private");
    } finally { source.dispose(); }
  });

  it("omits the generated stdout prelude from pages and search, but not the full copy", async () => {
    const commandDisplay = `printf 'αβ'\n${"λ".repeat(600)}`;
    const prelude = `$ ${commandDisplay}\n\n`;
    const target = job(workspace(), { commandDisplay });
    const { port } = fakeJobsPort(target);
    const source = createJobTailPagerSource({ jobs: port, jobId: target.id, pageBytes: 1024, hideCommandEcho: true })!;
    const output = `first output\n${"x".repeat(1100)}\nlast output\n`;
    try {
      writeFileSync(target.stdoutArtifact, prelude);
      expect(await source.readTail!()).toMatchObject({ body: "", offset: 0, nextOffset: 0, totalBytes: 0 });
      appendFileSync(target.stdoutArtifact, output);
      expect(await source.readPage(0)).toMatchObject({ body: output.slice(0, 1024), offset: 0, nextOffset: 1024 });
      expect(await source.readTail!()).toMatchObject({ body: output.slice(-1024), offset: output.length - 1024, totalBytes: output.length });
      expect(await source.search("αβ")).toBeUndefined();
      expect((await source.search("last output"))?.body).toContain("last output");
      expect((await source.search("first output", 0, true))?.body).toContain("first output");
      expect(await source.readAll()).toBe(prelude + output);
      appendFileSync(target.stdoutArtifact, prelude);
      expect((await source.search("αβ"))?.body).toContain("$ printf 'αβ'");
    } finally { source.dispose(); }
  });

  it("preserves command-like output in unprefixed logs, rotated chunks, and stderr", async () => {
    const target = job(workspace());
    const rotated = `${target.stdoutArtifact}.1`;
    const lookalike = `$ ${target.commandDisplay}\n\n`;
    writeFileSync(target.stdoutArtifact, `boot\n${lookalike}`);
    writeFileSync(rotated, lookalike);
    writeFileSync(target.stderrArtifact, lookalike);
    const { port, setJob } = fakeJobsPort(target);
    const options = { jobs: port, jobId: target.id, hideCommandEcho: true };
    const stdout = createJobTailPagerSource(options)!;
    const stderr = createJobTailPagerSource({ ...options, stream: "stderr" })!;
    try {
      expect((await stdout.readPage(0)).body).toBe(`boot\n${lookalike}`);
      expect((await stdout.readPage(5)).body).toBe(lookalike);
      expect((await stderr.readPage(0)).body).toBe(lookalike);
      setJob({ ...target, artifacts: { ...target.artifacts, stdout: receipt(target.stdoutArtifact, [target.stdoutArtifact, rotated]) } });
      expect((await stdout.readTail!()).body).toBe(lookalike);
    } finally { stdout.dispose(); stderr.dispose(); }
  });

  it("follows both files as they appear and keeps existing combined offsets through rotation", async () => {
    const target = job(workspace());
    const { port, setJob, emit } = fakeJobsPort(target);
    const source = createJobTailPagerSource({ jobs: port, jobId: target.id, stream: "combined", pageBytes: 1024, hideCommandEcho: true })!;
    const first = `${"line on stderr\n".repeat(100)}early match\n`;
    let observed = "";
    const unwatch = source.watch!(() => {
      void source.readTail!().then((page) => { observed = page.body; }).catch(() => undefined);
    });
    try {
      expect((await source.readTail!()).body).toBe("");
      writeFileSync(target.stderrArtifact, first);
      await expect.poll(() => observed).toContain("early match");
      const saved = (await source.search("early match"))!;
      expect(saved.offset).toBeGreaterThan(0);
      writeFileSync(target.stdoutArtifact, `$ ${target.commandDisplay}\n\n`);
      appendFileSync(target.stdoutArtifact, "new stdout\n");
      await expect.poll(() => observed).toContain("new stdout");
      const rotated = `${target.stderrArtifact}.1`;
      writeFileSync(rotated, "rotated stderr\n");
      setJob({ ...target, artifacts: { ...target.artifacts, stderr: receipt(target.stderrArtifact, [target.stderrArtifact, rotated]) } });
      emit();
      await expect.poll(() => observed).toContain("rotated stderr");
      expect(await source.readAll()).toBe(`${first}new stdout\nrotated stderr\n`);
      expect((await source.readPage(saved.offset)).body.startsWith(saved.body)).toBe(true);
    } finally { unwatch(); source.dispose(); }
  });

  it("titles live and finished views differently", () => {
    expect(jobTailTitle("npm run dev", true)).toBe("npm run dev · live");
    expect(jobTailTitle("npm run dev", false)).toBe("npm run dev · output");
    expect(jobTailTitle("x".repeat(90), true).length).toBeLessThan(75);
    expect(isLiveJobStatus("running")).toBe(true);
    expect(isLiveJobStatus("exited")).toBe(false);
  });
});

describe("keymap stays conflict-free with the new bindings", () => {
  it("has no duplicate chords per context", () => {
    expect(validateKeymap(defaultKeymap)).toEqual([]);
  });

  it("binds v and enter to the live view and keeps t as a snapshot", () => {
    const jobsBindings = defaultKeymap.filter((b) => b.context === "jobs");
    expect(jobsBindings.find((b) => b.chord === "v")?.action).toBe("jobs.view-live");
    expect(jobsBindings.find((b) => b.chord === "enter")?.action).toBe("jobs.view-live");
    expect(jobsBindings.find((b) => b.chord === "t")?.action).toBe("jobs.tail");
    expect(jobsBindings.find((b) => b.chord === "k")?.action).toBe("jobs.stop");
  });

  it("binds l to follow in the pager without shadowing existing keys", () => {
    const pagerBindings = defaultKeymap.filter((b) => b.context === "pager");
    expect(pagerBindings.find((b) => b.chord === "l")?.action).toBe(
      "pager.toggle-follow",
    );
    expect(pagerBindings.find((b) => b.chord === "j")?.action).toBe("pager.line-down");
    expect(pagerBindings.find((b) => b.chord === "k")?.action).toBe("pager.line-up");
  });
});
