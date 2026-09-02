import type { ProviderId, ToolResult } from "../types.js";
import type { JobMonitorMetadata } from "./jobs.js";

export interface ToolRunOptions {
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
  llmProvider?: ProviderId | undefined;
  llmModel?: string | undefined;
  requestSecret?: ((request: { title: string; prompt: string }) => Promise<string | undefined>) | undefined;
  confirmed?: boolean | undefined;
  userPrompt?: string | undefined;
  sessionId?: string | undefined;
  taskId?: string | undefined;
  parentTaskId?: string | undefined;
  delegationId?: string | undefined;
  wakeOnCompletion?: boolean | undefined;
  monitor?: JobMonitorMetadata | undefined;
  authorizeNetworkHop?: ((url: string, resolvedAddresses: string[]) => Promise<{ allowed: boolean; reason: string }> | { allowed: boolean; reason: string }) | undefined;
  engagementAuthorization?: { target: string; expiresAt?: string | undefined } | undefined;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  options?: ToolRunOptions,
) => Promise<ToolResult>;
