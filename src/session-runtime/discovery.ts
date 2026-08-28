import { rm } from "node:fs/promises";
import { processIdentityTracker } from "../os/process-identity.js";
import { processAlive } from "../os/process-tree.js";
import { connectRuntimeSocket, readFirstFrame, sendFrame } from "./protocol.js";
import { isRuntimeSocketPath } from "./paths.js";
import {
  deleteRuntimeLock,
  deleteRuntimeMetadata,
  listRuntimeMetadata,
} from "./store.js";
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeAckFrame,
  type RuntimeMetadata,
  type RuntimeView,
} from "./types.js";

function isAck(value: unknown, sessionId: string): value is RuntimeAckFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<RuntimeAckFrame>;
  return (
    frame.version === RUNTIME_PROTOCOL_VERSION &&
    frame.type === "ack" &&
    frame.sessionId === sessionId
  );
}

export async function probeRuntime(
  metadata: RuntimeMetadata,
  timeoutMs = 500,
): Promise<boolean> {
  let socket;
  try {
    socket = await connectRuntimeSocket(metadata.socketPath, timeoutMs);
    sendFrame(socket, {
      version: RUNTIME_PROTOCOL_VERSION,
      type: "auth",
      role: "probe",
      token: metadata.token,
    });
    const first = await readFirstFrame(socket, timeoutMs);
    return isAck(first.value, metadata.sessionId);
  } catch {
    return false;
  } finally {
    socket?.destroy();
  }
}

async function reapIfStale(metadata: RuntimeMetadata): Promise<void> {
  const comparison = processIdentityTracker.compare(
    metadata.hostPid,
    metadata.hostIdentity,
  );
  const stale =
    comparison === "gone" ||
    comparison === "mismatch" ||
    (comparison === "unknown" && !processAlive(metadata.hostPid));
  if (!stale) return;
  await Promise.all([
    deleteRuntimeMetadata(metadata.sessionId),
    deleteRuntimeLock(metadata.sessionId),
    isRuntimeSocketPath(metadata.socketPath)
      ? rm(metadata.socketPath, { force: true }).catch(() => undefined)
      : Promise.resolve(),
  ]);
}

export async function listLiveRuntimeMetadata(): Promise<RuntimeMetadata[]> {
  const candidates = await listRuntimeMetadata();
  const checked = await Promise.all(
    candidates.map(async (metadata) => {
      if (await probeRuntime(metadata)) return metadata;
      await reapIfStale(metadata);
      return undefined;
    }),
  );
  const bySession = new Map<string, RuntimeMetadata>();
  for (const metadata of checked) {
    if (!metadata) continue;
    const previous = bySession.get(metadata.sessionId);
    if (!previous || previous.updatedAt < metadata.updatedAt) {
      bySession.set(metadata.sessionId, metadata);
    }
  }
  return [...bySession.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export async function findLiveRuntime(
  sessionIdOrPrefix: string,
): Promise<RuntimeMetadata | undefined> {
  const needle = sessionIdOrPrefix.trim().toLowerCase();
  if (!needle) return undefined;
  const records = await listLiveRuntimeMetadata();
  const exact = records.find(
    (record) => record.sessionId.toLowerCase() === needle,
  );
  if (exact) return exact;
  const matches = records.filter((record) =>
    record.sessionId.toLowerCase().startsWith(needle),
  );
  if (matches.length > 1) {
    throw new Error(
      `"${sessionIdOrPrefix}" matches ${matches.length} live sessions — pass a longer id`,
    );
  }
  return matches[0];
}

export async function latestLiveRuntime(
  cwd: string,
): Promise<RuntimeMetadata | undefined> {
  const normalized = cwd.replace(/[\\/]+$/, "");
  return (await listLiveRuntimeMetadata()).find(
    (record) => record.cwd.replace(/[\\/]+$/, "") === normalized,
  );
}

export async function listLiveSessionRuntimes(): Promise<RuntimeView[]> {
  return (await listLiveRuntimeMetadata()).map((record) => ({
    sessionId: record.sessionId,
    cwd: record.cwd,
    ...(record.title ? { title: record.title } : {}),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    phase: record.phase,
    busy: record.busy,
    attached: record.attached,
  }));
}
