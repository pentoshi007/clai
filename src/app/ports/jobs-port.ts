import type {
  BackgroundJob,
  JobLinkMetadata,
  JobManagerListener,
  ResponderNotification,
  StartJobOptions,
} from "../../tools/jobs.js";
import type { ToolResult } from "../../types.js";

export type {
  BackgroundJob,
  JobLinkMetadata,
  JobManagerChange,
  JobManagerListener,
  JobMonitorMetadata,
  ResponderNotification,
  StartJobOptions,
} from "../../tools/jobs.js";

export interface JobsPort {
  list(sessionId?: string): ToolResult;
  running(sessionId?: string): BackgroundJob[];
  recent?(limit?: number, sessionId?: string): BackgroundJob[];
  get(id: string): BackgroundJob | undefined;
  tail(id: string, bytes?: number): Promise<ToolResult>;
  stop(id: string): Promise<ToolResult>;
  start(command: string, options?: StartJobOptions): Promise<ToolResult>;
  pendingNotifications(sessionId?: string): ResponderNotification[];
  activateResponderLease(sessionId: string): string;
  getResponderLeaseId(sessionId: string): string | undefined;
  releaseResponderLease(sessionId: string, leaseId?: string): void;
  claimNextResponderNotification(
    sessionId: string,
    leaseId: string,
    mode?: "foreground" | "wake",
  ): ResponderNotification | undefined;
  releaseResponderNotificationClaim?(notificationId: string): void;
  markDeliveryStarted(notificationId: string, sessionId?: string): boolean;
  markDelivered(notificationId: string, sessionId?: string): boolean;
  markRead(notificationId: string, sessionId: string): boolean;
  markAnalyzed(notificationId: string, sessionId?: string): boolean;
  acknowledge(notificationId: string, sessionId?: string): boolean;
  subscribe(listener: JobManagerListener): () => void;
  linkJob(jobId: string, metadata: JobLinkMetadata): BackgroundJob | undefined;
  cancelAll(sessionId: string): Promise<ToolResult>;
}
