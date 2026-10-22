import { AsyncLocalStorage } from "node:async_hooks";

const submission = new AsyncLocalStorage<{ readonly acknowledge: () => void; submitted: boolean }>();

export function withGenerationSubmission<T>(acknowledge: () => void, run: () => T): T {
  return submission.run({ acknowledge, submitted: false }, run);
}

export function acknowledgeGenerationSubmission(): void {
  const current = submission.getStore();
  if (!current || current.submitted) return;
  current.acknowledge();
  current.submitted = true;
}
