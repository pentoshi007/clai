import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolResult } from "../types.js";
import { safeCwd } from "../os/cwd.js";
import { getJobsDir } from "../store/paths.js";

export type JobStatus = "running" | "exited" | "killed" | "failed";

export interface BackgroundJob {
  id: string;
  command: string;
  cwd: string;
  pid?: number | undefined;
  status: JobStatus;
  startedAt: string;
  endedAt?: string | undefined;
  exitCode?: number | undefined;
  artifactPath: string;
}

export class JobManager {
  private jobs = new Map<string, BackgroundJob>();
  private processes = new Map<string, ChildProcess>();
  private streams = new Map<string, WriteStream>();
  private abortControllers = new Map<string, AbortController>();

  registerJob(
    id: string,
    job: BackgroundJob,
    ac?: AbortController | undefined,
    process?: ChildProcess | undefined,
  ): void {
    this.jobs.set(id, job);
    if (ac) {
      this.abortControllers.set(id, ac);
    }
    if (process) {
      this.processes.set(id, process);
    }
  }

  updateJobStatus(
    id: string,
    status: JobStatus,
    exitCode?: number | undefined,
  ): void {
    const job = this.jobs.get(id);
    if (job) {
      job.status = status;
      if (exitCode !== undefined) {
        job.exitCode = exitCode;
      }
      job.endedAt = new Date().toISOString();
      this.abortControllers.delete(id);
      this.processes.delete(id);
    }
  }

  async startJob(
    command: string,
    options?: { cwd?: string | undefined; name?: string | undefined } | undefined,
  ): Promise<ToolResult> {
    const id = randomUUID().slice(0, 8);
    const cwd = options?.cwd ?? safeCwd();
    const dir = getJobsDir();
    await mkdir(dir, { recursive: true });
    const artifactPath = join(
      dir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}.txt`,
    );

    const stream = createWriteStream(artifactPath, { flags: "w" });
    stream.write(`$ ${command}\n\n`);

    try {
      const detached = process.platform !== "win32";
      const child = spawn(command, {
        cwd,
        detached,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const job: BackgroundJob = {
        id,
        command,
        cwd,
        pid: child.pid,
        status: "running",
        startedAt: new Date().toISOString(),
        artifactPath,
      };

      this.jobs.set(id, job);
      this.processes.set(id, child);
      this.streams.set(id, stream);

      child.stdout?.on("data", (chunk: Buffer) => {
        stream.write(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stream.write(chunk);
      });

      child.on("close", (code) => {
        job.status = "exited";
        job.exitCode = code ?? undefined;
        job.endedAt = new Date().toISOString();
        stream.end();
        this.processes.delete(id);
        this.streams.delete(id);
      });
      child.on("error", () => {
        job.status = "failed";
        job.endedAt = new Date().toISOString();
        stream.end();
        this.processes.delete(id);
        this.streams.delete(id);
      });

      // Detach so the child outlives the parent if needed
      child.unref();

      return {
        ok: true,
        output: `Background job started: id=${id} pid=${child.pid ?? "?"}\nCommand: ${command}\nOutput: ${artifactPath}`,
      };
    } catch (error) {
      stream.end();
      return {
        ok: false,
        output: `Failed to start job: ${error instanceof Error ? error.message : String(error)}`,
        exitCode: 1,
      };
    }
  }

  listJobs(): ToolResult {
    if (this.jobs.size === 0) {
      return { ok: true, output: "No background jobs." };
    }
    const lines: string[] = [];
    for (const job of this.jobs.values()) {
      const status = job.status === "running" ? "▶ running" : `${job.status} (exit=${job.exitCode ?? "?"})`;
      const elapsed = job.endedAt
        ? `${Math.round((new Date(job.endedAt).getTime() - new Date(job.startedAt).getTime()) / 1000)}s`
        : `${Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000)}s ago`;
      lines.push(`[${job.id}] ${status} ${elapsed}  ${job.command.slice(0, 60)}`);
    }
    return { ok: true, output: lines.join("\n") };
  }

  getJob(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  async tailJob(id: string, bytes?: number | undefined): Promise<ToolResult> {
    const job = this.jobs.get(id);
    if (!job) {
      return { ok: false, output: `Job "${id}" not found.`, exitCode: 1 };
    }
    const tailBytes = bytes ?? 8_000;
    try {
      const content = await readFile(job.artifactPath, "utf8");
      const tail = content.length > tailBytes
        ? `... (showing last ${tailBytes.toLocaleString()} bytes)\n${content.slice(-tailBytes)}`
        : content;
      return {
        ok: true,
        output: `[${job.id}] ${job.status}:\n${tail}`,
        outputPath: job.artifactPath,
      };
    } catch (error) {
      return {
        ok: false,
        output: `Failed to read job output: ${error instanceof Error ? error.message : String(error)}`,
        exitCode: 1,
      };
    }
  }

  stopJob(id: string, signal?: NodeJS.Signals | undefined): ToolResult {
    const job = this.jobs.get(id);
    if (!job) {
      return { ok: false, output: `Job "${id}" not found.`, exitCode: 1 };
    }
    if (job.status !== "running") {
      return {
        ok: false,
        output: `Job "${id}" is already ${job.status}.`,
        exitCode: 1,
      };
    }
    const ac = this.abortControllers.get(id);
    if (ac) {
      ac.abort();
    }
    const child = this.processes.get(id);
    if (!child?.pid) {
      job.status = "killed";
      job.endedAt = new Date().toISOString();
      this.abortControllers.delete(id);
      return { ok: true, output: `Job "${id}" killed.` };
    }
    try {
      const sig = signal ?? "SIGTERM";
      if (process.platform !== "win32") {
        process.kill(-child.pid, sig);
      } else {
        child.kill(sig);
      }
      job.status = "killed";
      job.endedAt = new Date().toISOString();
      this.abortControllers.delete(id);
      return { ok: true, output: `Job "${id}" sent ${sig}.` };
    } catch {
      return {
        ok: false,
        output: `Failed to stop job "${id}".`,
        exitCode: 1,
      };
    }
  }

  getRunningJobs(): BackgroundJob[] {
    return [...this.jobs.values()].filter((j) => j.status === "running");
  }
}

export const jobManager = new JobManager();
