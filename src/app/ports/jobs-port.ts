import type { BackgroundJob } from "../../tools/jobs.js";
import type { ToolResult } from "../../types.js";

export type { BackgroundJob };

/**
 * Background job control (CORE-004, F-004). Jobs survive UI rerenders because
 * they live in the core job manager; the UI only observes and commands them.
 */
export interface JobsPort {
  list(): ToolResult;
  running(): BackgroundJob[];
  get(id: string): BackgroundJob | undefined;
  tail(id: string, bytes?: number): Promise<ToolResult>;
  stop(id: string): ToolResult;
  start(
    command: string,
    options?: { cwd?: string | undefined; name?: string | undefined },
  ): Promise<ToolResult>;
}
