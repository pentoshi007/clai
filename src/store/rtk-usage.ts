import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { currentSessionAffinity } from "../llm/session-affinity.js";
import { getDataDir } from "./paths.js";

const unboundSession = randomUUID();
const pending = new Map<string, number>();

const executionPath = (sessionId = currentSessionAffinity() ?? unboundSession): string => {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(getDataDir(), "rtk", "usage", `${key}.log`);
};

export function rtkExecutionCount(sessionId?: string): number | undefined {
  const path = executionPath(sessionId);
  if (pending.has(path)) return undefined;
  try {
    const entries = readFileSync(path, "utf8").split("\n");
    if (entries.pop() !== "" || entries.some((entry) => entry !== "1")) return undefined;
    return entries.length;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? 0 : undefined;
  }
}

export function createRtkExecutionRecorder(sessionId?: string): () => void {
  const path = executionPath(sessionId);
  let recorded = false;
  return () => {
    if (recorded) return;
    recorded = true;
    const count = (pending.get(path) ?? 0) + 1;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, "1\n".repeat(count), { mode: 0o600 });
      pending.delete(path);
    } catch {
      pending.set(path, count);
    }
  };
}
