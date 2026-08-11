import { afterEach, describe, expect, it } from "vitest";
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
