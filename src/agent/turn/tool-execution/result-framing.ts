import type { ChatMessage, ToolCall, ToolResult } from "../../../types.js";
import type { SessionPlan, TaskEvidence } from "../../../store/plan.js";
import type { LooseWorkReceipt, TaskWorkLedger } from "../../task-evidence.js";
import { isEvidenceWorkTool } from "../../task-evidence.js";
import { readTaskWorkSignals } from "../task-work-signals.js";
import { creditSuccessfulWork } from "../task-credit.js";

export interface ResultFramingPorts {
  readonly step: number;
  readonly saveArtifact: (
    call: ToolCall,
    output: string,
  ) => Promise<string | undefined>;
  readonly setJobArtifact: (path: string) => void;
  readonly formatContext: (call: ToolCall, result: ToolResult) => string;
  readonly emitToolResult: (
    result: ToolResult,
    contextOutput: string,
    artifactPath: string | undefined,
  ) => void;
  readonly onToolResult: ((call: ToolCall, result: ToolResult) => void) | undefined;
  readonly audit: (
    event: string,
    payload: Readonly<Record<string, string | number | boolean | ToolCall | undefined>>,
  ) => Promise<void>;
  readonly recordEngagementOutcome: (
    artifactPath: string | undefined,
  ) => Promise<void>;
  readonly recordLedgerCall: (
    call: ToolCall,
    ok: boolean,
    artifactPath: string | undefined,
  ) => void;
}

export interface FramedResult {
  readonly result: ToolResult;
  readonly contextOutput: string;
  readonly artifactPath: string | undefined;
}

export const frameToolResult = async (
  ports: ResultFramingPorts,
  call: ToolCall,
  result: ToolResult,
): Promise<FramedResult> => {
  const output = result.output.trim();
  const artifactPath =
    result.outputPath ??
    (output ? await ports.saveArtifact(call, output) : undefined);
  const framed: ToolResult = {
    ...result,
    outputPath: artifactPath,
    truncated: result.truncated ?? Boolean(artifactPath),
  };
  if (artifactPath) ports.setJobArtifact(artifactPath);
  const contextOutput = ports.formatContext(call, framed);
  ports.emitToolResult(framed, contextOutput, artifactPath);
  ports.onToolResult?.(call, framed);
  await ports.audit("tool.result", {
    call,
    ok: result.ok,
    exitCode: result.exitCode,
    output: result.output.slice(0, 4_000),
  });
  await ports.recordEngagementOutcome(artifactPath);
  ports.recordLedgerCall(call, result.ok, artifactPath);
  return { result: framed, contextOutput, artifactPath };
};

export interface WorkCreditPorts {
  readonly getLedger: () => TaskWorkLedger | null;
  readonly setLedger: (ledger: TaskWorkLedger | null) => void;
  readonly bankLooseWork: (receipt: LooseWorkReceipt) => void;
  readonly persistTaskEvidence: (
    taskId: string,
    evidence: TaskEvidence,
  ) => Promise<void>;
  readonly loadPlan: () => Promise<SessionPlan | undefined>;
  readonly creditId: () => string | undefined;
}

export const creditToolWork = async (
  ports: WorkCreditPorts,
  call: ToolCall,
  result: ToolResult,
): Promise<SessionPlan | undefined> => {
  if (!result.ok || !isEvidenceWorkTool(call.name)) return undefined;
  const plan = await ports.loadPlan();
  await creditSuccessfulWork(
    {
      getLedger: ports.getLedger,
      setLedger: ports.setLedger,
      bankLooseWork: ports.bankLooseWork,
      persistTaskEvidence: ports.persistTaskEvidence,
    },
    {
      call,
      signals: readTaskWorkSignals(call, result.output ?? ""),
      creditId: ports.creditId(),
      plan,
    },
  );
  return plan;
};

export interface FailureReflectionPorts {
  readonly reflection: () => string | null | undefined;
  readonly failureCount: () => number;
  readonly deferMessage: (message: ChatMessage) => void;
  readonly notify: (level: "info" | "warn", message: string) => void;
}

export const reportToolFailure = (
  ports: FailureReflectionPorts,
  ok: boolean,
): void => {
  if (ok) return;
  const reflection = ports.reflection();
  if (!reflection) return;
  ports.deferMessage({ role: "system", content: reflection });
  ports.notify(
    "warn",
    `${ports.failureCount()} consecutive failures — model evaluating approach`,
  );
};
