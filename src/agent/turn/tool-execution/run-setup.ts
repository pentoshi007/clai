import { randomUUID } from "node:crypto";
import type { ToolCall } from "../../../types.js";
import type { BackgroundJob } from "../../../tools/jobs.js";
import type { EngagementScope } from "../../../store/scope.js";
import type {
  EngagementActionRecord,
  EngagementGraph,
} from "../../../store/engagement.js";
import type { EngagementAction } from "../../../safety/engagement-policy.js";
import {
  actionFromUrl,
  evaluateEngagementAction,
} from "../../../safety/engagement-policy.js";
import { formatToolArgs } from "../../tool-call-parser.js";

const emptyArtifact = () => ({
  path: "",
  chunks: [] as string[],
  bytes: 0,
  droppedBytes: 0,
  redacted: false,
  sha256: "",
});

export interface EphemeralJob {
  readonly id: string;
  readonly job: BackgroundJob;
}

export const createEphemeralToolJob = (
  call: ToolCall,
  cwd: string,
  ownerSessionId: string,
): EphemeralJob => {
  const id = randomUUID().slice(0, 8);
  const label = `${call.name} ${formatToolArgs(call)}`;
  return {
    id,
    job: {
      id,
      command: label,
      commandDisplay: label,
      cwd,
      status: "running",
      startedAt: new Date().toISOString(),
      artifactPath: "",
      stdoutArtifact: "",
      stderrArtifact: "",
      artifacts: { stdout: emptyArtifact(), stderr: emptyArtifact() },
      redactionProfile: "provider-secrets-v1",
      ownerSessionId,
      kind: "ephemeral",
    },
  };
};

export interface EngagementRunOptions {
  readonly engagementAuthorization?: {
    readonly target: string;
    readonly expiresAt?: string | undefined;
  };
  readonly authorizeNetworkHop?: (
    url: string,
    resolvedAddresses: string[],
  ) => Promise<{ allowed: boolean; reason: string }>;
}

export interface EngagementRunInput {
  readonly action: EngagementAction | undefined;
  readonly scope: EngagementScope | undefined;
  readonly normalizedTarget: string | undefined;
  readonly graph: EngagementGraph | undefined;
  readonly record: EngagementActionRecord | undefined;
  readonly audit: (
    event: string,
    payload: Readonly<
      Record<string, string | boolean | readonly string[] | undefined>
    >,
  ) => Promise<void>;
}

export const buildEngagementRunOptions = (
  input: EngagementRunInput,
): EngagementRunOptions => {
  const { action, scope } = input;
  if (!action || !scope) return {};
  return {
    engagementAuthorization: {
      target: input.normalizedTarget || action.target,
      ...(scope.expiresAt ? { expiresAt: scope.expiresAt } : {}),
    },
    authorizeNetworkHop: async (url, resolvedAddresses) => {
      const hop = actionFromUrl({
        url,
        method: action.method,
        phase: action.phase,
        capability: action.capability,
        resolvedAddresses,
      });
      const decision = evaluateEngagementAction(scope, hop);
      await input.audit("engagement.policy.hop", {
        ...(input.graph ? { engagementId: input.graph.id } : {}),
        ...(input.record ? { actionId: input.record.id } : {}),
        url,
        resolvedAddresses,
        allowed: decision.allowed,
        reason: decision.reason,
      });
      return { allowed: decision.allowed, reason: decision.reason };
    },
  };
};
