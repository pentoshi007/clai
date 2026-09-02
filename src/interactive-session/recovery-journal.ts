
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../store/paths.js";
import {
  processIdentityTracker,
  type ProcessIdentityComparison,
} from "../os/process-identity.js";
import {
  terminateProcessTree,
  type TreeSignalOutcome,
} from "../os/process-tree.js";

const JOURNAL_FILE = "registry-v1.json";
const JOURNAL_PREFIX = "registry-v1-";
const SCHEMA_VERSION = 1;
const DEFAULT_DIRECTORY = join(getDataDir(), "interactive-sessions");

export interface JournalRecord {
  readonly id: string;
  readonly ownerHash: string;
  readonly pid: number | undefined;
  readonly processGroupId: number | undefined;
  readonly identity: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly startedAt: number;
  readonly artifactPath: string;
  readonly launchConfirmed: boolean;
}

interface JournalManager {
  readonly pid: number;
  readonly identity: string | undefined;
}

interface PersistedJournal {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly manager?: JournalManager | undefined;
  readonly sessions: JournalRecord[];
}

export type ReconciliationOutcome =
  | "terminated"
  | "gone"
  | "identity-mismatch"
  | "unverified"
  | "launch-failed";

export interface ReconciliationEntry {
  readonly id: string;
  readonly outcome: ReconciliationOutcome;
}

export function hashOwner(ownerId: string): string {
  return createHash("sha256").update(ownerId).digest("hex").slice(0, 16);
}

export interface RecoveryJournalProcessDeps {
  readonly compareIdentity: (
    pid: number | undefined,
    identity: string | undefined,
  ) => ProcessIdentityComparison;
  readonly terminateTree: (
    pid: number,
    options: { signal: NodeJS.Signals; processGroupId?: number | undefined },
  ) => TreeSignalOutcome;
}

const defaultProcessDeps: RecoveryJournalProcessDeps = {
  compareIdentity: (pid, identity) => processIdentityTracker.compare(pid, identity),
  terminateTree: terminateProcessTree,
};

export class RecoveryJournal {
  private readonly path: string;
  private readonly process: RecoveryJournalProcessDeps;
  private readonly sharedDirectory: boolean;
  private readonly manager: JournalManager | undefined;
  private records = new Map<string, JournalRecord>();

  constructor(
    private readonly directory = DEFAULT_DIRECTORY,
    processDeps: Partial<RecoveryJournalProcessDeps> = {},
  ) {
    this.sharedDirectory = directory === DEFAULT_DIRECTORY;
    this.manager = this.sharedDirectory
      ? {
          pid: process.pid,
          identity: processIdentityTracker.capture(process.pid, {
            refresh: true,
          }),
        }
      : undefined;
    this.path = this.sharedDirectory
      ? join(
          this.directory,
          `${JOURNAL_PREFIX}${process.pid}-${randomUUID()}.json`,
        )
      : join(this.directory, JOURNAL_FILE);
    this.process = { ...defaultProcessDeps, ...processDeps };
  }

  upsert(record: JournalRecord): void {
    this.records.set(record.id, record);
    this.persist();
  }

  upsertDurable(record: JournalRecord): boolean {
    this.records.set(record.id, record);
    return this.persist();
  }

  remove(id: string): void {
    if (!this.records.delete(id)) return;
    this.persist();
  }

  load(): JournalRecord[] {
    return this.readPersisted(this.path)?.sessions ?? [];
  }

  reconcile(): ReconciliationEntry[] {
    const results: ReconciliationEntry[] = [];
    for (const path of this.reconciliationPaths()) {
      const persisted = this.readPersisted(path);
      if (!persisted) continue;
      if (persisted.manager) {
        const managerState = this.process.compareIdentity(
          persisted.manager.pid,
          persisted.manager.identity,
        );
        if (managerState === "match" || managerState === "unknown") continue;
      }
      const retained: JournalRecord[] = [];
      for (const record of persisted.sessions) {
        const outcome = this.reconcileOne(record);
        results.push({ id: record.id, outcome });
        if (outcome === "unverified") retained.push(record);
      }
      this.writePersisted(path, persisted.manager, retained);
    }
    this.records = new Map(this.load().map((record) => [record.id, record]));
    return results;
  }

  private reconciliationPaths(): string[] {
    if (!this.sharedDirectory) return [this.path];
    try {
      return readdirSync(this.directory, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            (entry.name === JOURNAL_FILE ||
              (entry.name.startsWith(JOURNAL_PREFIX) &&
                entry.name.endsWith(".json"))),
        )
        .map((entry) => join(this.directory, entry.name));
    } catch {
      return [];
    }
  }

  private readPersisted(path: string): PersistedJournal | undefined {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedJournal;
      if (
        parsed?.schemaVersion !== SCHEMA_VERSION ||
        !Array.isArray(parsed.sessions)
      ) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private reconcileOne(record: JournalRecord): ReconciliationOutcome {
    if (!record.launchConfirmed || !record.pid) return "unverified";
    const comparison = this.process.compareIdentity(record.pid, record.identity);
    if (comparison === "gone") return "gone";
    if (comparison === "mismatch") return "identity-mismatch";
    if (comparison === "unknown") return "unverified";
    const outcome = this.process.terminateTree(record.pid, {
      signal: "SIGKILL",
      ...(record.processGroupId !== undefined
        ? { processGroupId: record.processGroupId }
        : {}),
    });
    if (outcome === "failed") return "unverified";
    return outcome === "gone" ? "gone" : "terminated";
  }

  private persist(): boolean {
    return this.writePersisted(this.path, this.manager, [...this.records.values()]);
  }

  private writePersisted(
    path: string,
    manager: JournalManager | undefined,
    sessions: JournalRecord[],
  ): boolean {
    try {
      if (sessions.length === 0) {
        rmSync(path, { force: true });
        return true;
      }
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const payload: PersistedJournal = {
        schemaVersion: SCHEMA_VERSION,
        ...(manager ? { manager } : {}),
        sessions,
      };
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      renameSync(temp, path);
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    this.records.clear();
    try {
      rmSync(this.path, { force: true });
    } catch {}
  }
}
