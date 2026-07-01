import type { ToolResult } from "../types.js";

export interface ToolRunOptions {
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
  requestSecret?: ((request: { title: string; prompt: string }) => Promise<string | undefined>) | undefined;
  confirmed?: boolean | undefined;
  userPrompt?: string | undefined;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  options?: ToolRunOptions,
) => Promise<ToolResult>;
