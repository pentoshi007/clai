import type { PlanTask, SessionPlan } from "../../store/plan.js";
import type { BackgroundJob, ResponderNotification } from "../../tools/jobs.js";

const hasLiveResponderJob = (
  child: PlanTask,
  runningJobs: readonly BackgroundJob[],
): boolean =>
  runningJobs.some(
    (job) =>
      job.responder &&
      (job.taskId === child.id || (!!child.jobId && job.id === child.jobId)),
  );

const hasPendingResponderResult = (
  child: PlanTask,
  notifications: readonly ResponderNotification[],
  currentNotificationId: string | undefined,
): boolean =>
  notifications.some(
    (notification) =>
      notification.responder &&
      !notification.archivedAt &&
      !notification.readAt &&
      !notification.analyzedAt &&
      (!currentNotificationId || notification.id !== currentNotificationId) &&
      (notification.taskId === child.id ||
        (!!child.jobId && notification.jobId === child.jobId)),
  );

const isLiveChild = (
  child: PlanTask,
  runningJobs: readonly BackgroundJob[],
  notifications: readonly ResponderNotification[],
  currentNotificationId: string | undefined,
): boolean => {
  if (
    child.state === "done" ||
    child.state === "skipped" ||
    child.state === "failed"
  ) {
    return false;
  }
  if (hasLiveResponderJob(child, runningJobs)) return true;
  return hasPendingResponderResult(
    child,
    notifications,
    currentNotificationId,
  );
};

export function shouldYieldForDeclaredResponderDependency(
  plan: SessionPlan | undefined,
  runningJobs: readonly BackgroundJob[],
  notifications: readonly ResponderNotification[],
  currentNotificationId?: string | undefined,
): boolean {
  if (!plan) return false;
  const unfinished = plan.tasks.filter(
    (task) =>
      !task.responderOwned &&
      (task.state === "pending" || task.state === "in_progress"),
  );
  if (unfinished.length === 0) return false;

  const childById = new Map(
    plan.tasks
      .filter((task) => task.responderOwned)
      .map((task) => [task.id, task]),
  );

  return unfinished.every((task) =>
    (task.dependencies ?? []).some((dependency) => {
      const child = childById.get(dependency);
      return (
        !!child &&
        isLiveChild(child, runningJobs, notifications, currentNotificationId)
      );
    }),
  );
}
