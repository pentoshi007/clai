
import { randomUUID } from "node:crypto";
import { MAX_LIST_SUMMARIES } from "./config.js";
import { AsyncMutex } from "./runtime.js";
import {
  isTerminalState,
  toSummary,
  type InteractiveSessionRecord,
  type ProcessOutcome,
  type SessionState,
  type SessionSummary,
  type TerminationReason,
} from "./types.js";

const SESSION_ID_PREFIX = "its_";
const MAX_TERMINAL_RECORDS_PER_OWNER = MAX_LIST_SUMMARIES;

const ALLOWED_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  starting: ["running", "exited", "failed"],
  running: ["closing", "exited", "failed"],
  closing: ["closed", "exited", "failed"],
  exited: [],
  failed: [],
  closed: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class SessionRegistry {
  private readonly records = new Map<string, InteractiveSessionRecord>();
  private readonly byOwner = new Map<string, Set<string>>();
  private readonly issuedIds = new Set<string>();
  private readonly ownerLocks = new Map<string, AsyncMutex>();
  private readonly fencedOwners = new Set<string>();

  withOwnerLock<T>(ownerId: string, fn: () => Promise<T> | T): Promise<T> {
    let lock = this.ownerLocks.get(ownerId);
    if (!lock) {
      lock = new AsyncMutex();
      this.ownerLocks.set(ownerId, lock);
    }
    return lock.run(fn);
  }

  mintId(): string {
    for (;;) {
      const candidate = `${SESSION_ID_PREFIX}${randomUUID()}`;
      if (this.issuedIds.has(candidate)) continue;
      this.issuedIds.add(candidate);
      return candidate;
    }
  }

  liveCount(ownerId: string): number {
    let count = 0;
    for (const id of this.byOwner.get(ownerId) ?? []) {
      const record = this.records.get(id);
      if (record && !isTerminalState(record.state)) count += 1;
    }
    return count;
  }

  insert(record: InteractiveSessionRecord): void {
    this.records.set(record.id, record);
    let owned = this.byOwner.get(record.ownerId);
    if (!owned) {
      owned = new Set();
      this.byOwner.set(record.ownerId, owned);
    }
    owned.add(record.id);
  }

  get(ownerId: string, id: string): InteractiveSessionRecord | undefined {
    const record = this.records.get(id);
    return record && record.ownerId === ownerId ? record : undefined;
  }

  getUnscoped(id: string): InteractiveSessionRecord | undefined {
    return this.records.get(id);
  }

  liveRecords(ownerId: string): InteractiveSessionRecord[] {
    return [...(this.byOwner.get(ownerId) ?? [])]
      .map((id) => this.records.get(id))
      .filter(
        (record): record is InteractiveSessionRecord =>
          record !== undefined && !isTerminalState(record.state),
      );
  }

  allLiveRecords(): InteractiveSessionRecord[] {
    return [...this.records.values()].filter(
      (record) => !isTerminalState(record.state),
    );
  }

  owners(): string[] {
    return [...this.byOwner.keys()];
  }

  list(ownerId: string): SessionSummary[] {
    const records = [...(this.byOwner.get(ownerId) ?? [])]
      .map((id) => this.records.get(id))
      .filter((record): record is InteractiveSessionRecord => record !== undefined);
    records.sort((a, b) => {
      const aLive = isTerminalState(a.state) ? 1 : 0;
      const bLive = isTerminalState(b.state) ? 1 : 0;
      if (aLive !== bLive) return aLive - bLive;
      return b.startedAt - a.startedAt;
    });
    return records.slice(0, MAX_LIST_SUMMARIES).map(toSummary);
  }

  transition(
    record: InteractiveSessionRecord,
    to: SessionState,
    patch: {
      terminationReason?: TerminationReason | undefined;
      processOutcome?: ProcessOutcome | undefined;
      cleanupVerified?: boolean | undefined;
      now?: number | undefined;
    } = {},
  ): boolean {
    if (!canTransition(record.state, to)) {
      if (isTerminalState(record.state)) this.enrich(record, patch);
      return false;
    }
    record.state = to;
    if (isTerminalState(to)) {
      record.endedAt = patch.now ?? record.endedAt ?? Date.now();
      if (patch.terminationReason) record.terminationReason = patch.terminationReason;
      if (patch.processOutcome) record.processOutcome = patch.processOutcome;
      if (patch.cleanupVerified !== undefined) {
        record.cleanupVerified = patch.cleanupVerified;
      }
      this.pruneTerminal(record.ownerId);
    } else {
      this.enrich(record, patch);
    }
    return true;
  }

  enrich(
    record: InteractiveSessionRecord,
    patch: {
      terminationReason?: TerminationReason | undefined;
      processOutcome?: ProcessOutcome | undefined;
      cleanupVerified?: boolean | undefined;
    },
  ): void {
    record.terminationReason ??= patch.terminationReason;
    record.processOutcome ??= patch.processOutcome;
    if (record.cleanupVerified === undefined && patch.cleanupVerified !== undefined) {
      record.cleanupVerified = patch.cleanupVerified;
    }
  }

  fenceOwner(ownerId: string): void {
    this.fencedOwners.add(ownerId);
  }

  unfenceOwner(ownerId: string): void {
    this.fencedOwners.delete(ownerId);
  }

  isFenced(ownerId: string): boolean {
    return this.fencedOwners.has(ownerId);
  }

  private pruneTerminal(ownerId: string): void {
    const owned = this.byOwner.get(ownerId);
    if (!owned) return;
    const terminal = [...owned]
      .map((id) => this.records.get(id))
      .filter(
        (record): record is InteractiveSessionRecord =>
          record !== undefined && isTerminalState(record.state),
      )
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    for (const record of terminal.slice(MAX_TERMINAL_RECORDS_PER_OWNER)) {
      this.records.delete(record.id);
      owned.delete(record.id);
    }
  }
}
