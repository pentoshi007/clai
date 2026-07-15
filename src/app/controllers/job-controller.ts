import type { ToolResult } from "../../types.js";
import type { BackgroundJob, JobsPort } from "../ports/jobs-port.js";
import type { Disposable } from "./disposable.js";

/**
 * Thin lifecycle wrapper over `JobsPort` (CORE-004). Jobs live in the core
 * manager and survive UI rerenders; this controller only observes and commands.
 */
export class JobController implements Disposable {
  constructor(private readonly jobs: JobsPort) {}

  list(): ToolResult {
    return this.jobs.list();
  }

  running(): BackgroundJob[] {
    return this.jobs.running();
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  tail(id: string, bytes?: number): Promise<ToolResult> {
    return this.jobs.tail(id, bytes);
  }

  stop(id: string): ToolResult {
    return this.jobs.stop(id);
  }

  start(
    command: string,
    options?: { cwd?: string | undefined; name?: string | undefined },
  ): Promise<ToolResult> {
    return this.jobs.start(command, options);
  }

  hasRunning(): boolean {
    return this.running().length > 0;
  }

  dispose(): void {
    // Jobs intentionally outlive the UI; nothing to tear down here.
  }
}
