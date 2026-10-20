import { hash } from "node:crypto";
import type { TranscriptItem } from "../../app/ports/transcript-item.js";
import type { ChatMessage } from "../../types.js";
import { historySummary, type HistorySummary } from "../history-index.js";
import type { HistoryRecord } from "./recovery.js";

export const SESSION_FRAME_VERSION = 1;
const DELTA_BASE_RATIO = 0.5;

export type HistoryRecordHead = Omit<HistoryRecord, "messages" | "transcript">;

export interface SessionLogState {
  readonly seq: number;
  readonly head: HistoryRecordHead;
  readonly summary: HistorySummary;
  readonly messageDigests: readonly string[];
  readonly transcriptDigests: readonly string[] | undefined;
  readonly baseBytes: number;
  readonly deltaCount: number;
}

export interface PlannedFrame {
  readonly kind: "base" | "delta";
  readonly line: string;
  readonly bytes: number;
  readonly state: SessionLogState;
}

interface EncodedList {
  readonly json: readonly string[];
  readonly digests: readonly string[];
}

interface ArrayPatch<T> {
  readonly keep: number;
  readonly append: T[];
}

interface BaseFrame {
  readonly t: "base";
  readonly seq: number;
  readonly summary: HistorySummary;
  readonly record: HistoryRecord;
}

interface DeltaFrame {
  readonly t: "delta";
  readonly seq: number;
  readonly summary: HistorySummary;
  readonly head: HistoryRecordHead;
  readonly messages: ArrayPatch<ChatMessage>;
  readonly transcript: ArrayPatch<TranscriptItem> | { readonly absent: true };
}

export type SessionFrame = BaseFrame | DeltaFrame;

interface EncodedElement {
  readonly json: string;
  readonly digest: string;
}

const encodedElements = new WeakMap<object, EncodedElement>();

export function digestJson(json: string): string {
  return hash("sha1", json, "base64");
}

function encodeElement(value: unknown): EncodedElement {
  const cacheable = typeof value === "object" && value !== null;
  const cached = cacheable ? encodedElements.get(value) : undefined;
  if (cached) return cached;
  const json = JSON.stringify(value) ?? "null";
  const encoded = { json, digest: digestJson(json) };
  if (cacheable) encodedElements.set(value, encoded);
  return encoded;
}

function encodeList(values: readonly unknown[]): EncodedList {
  const encoded = values.map(encodeElement);
  return { json: encoded.map((element) => element.json), digests: encoded.map((element) => element.digest) };
}

function jsonArray(json: readonly string[]): string {
  return `[${json.join(",")}]`;
}

export function recordHead(record: HistoryRecord): HistoryRecordHead {
  const { messages: _messages, transcript: _transcript, ...head } = record;
  return head;
}

function recordJson(head: HistoryRecordHead, messages: readonly string[], transcript: readonly string[] | undefined): string {
  const body = JSON.stringify(head).slice(1, -1);
  const arrays = [`"messages":${jsonArray(messages)}`];
  if (transcript) arrays.push(`"transcript":${jsonArray(transcript)}`);
  return `{${body}${body ? "," : ""}${arrays.join(",")}}`;
}

function frameHeader(kind: "base" | "delta", seq: number, summary: HistorySummary): string {
  return `{"v":${SESSION_FRAME_VERSION},"t":"${kind}","seq":${seq},"summary":${JSON.stringify(summary)}`;
}

function commonPrefix(previous: readonly string[], next: readonly string[]): number {
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  while (index < limit && previous[index] === next[index]) index += 1;
  return index;
}

function buildBase(
  seq: number,
  record: HistoryRecord,
  messages: EncodedList,
  transcript: EncodedList | undefined,
): PlannedFrame {
  const head = recordHead(record);
  const summary = historySummary(record);
  const line = `${frameHeader("base", seq, summary)},"record":${recordJson(head, messages.json, transcript?.json)}}\n`;
  const bytes = Buffer.byteLength(line);
  return {
    kind: "base",
    line,
    bytes,
    state: {
      seq,
      head,
      summary,
      messageDigests: messages.digests,
      transcriptDigests: transcript?.digests,
      baseBytes: bytes,
      deltaCount: 0,
    },
  };
}

export function planBaseFrame(seq: number, record: HistoryRecord): PlannedFrame {
  return buildBase(seq, record, encodeList(record.messages), record.transcript ? encodeList(record.transcript) : undefined);
}

export function planSessionFrame(
  previous: SessionLogState | undefined,
  record: HistoryRecord,
  options: { readonly forceBase?: boolean } = {},
): PlannedFrame {
  const messages = encodeList(record.messages);
  const transcript = record.transcript ? encodeList(record.transcript) : undefined;
  if (!previous || options.forceBase) return buildBase(previous ? previous.seq + 1 : 0, record, messages, transcript);

  const seq = previous.seq + 1;
  const head = recordHead(record);
  const summary = historySummary(record);
  const messageKeep = commonPrefix(previous.messageDigests, messages.digests);
  const transcriptKeep = transcript ? commonPrefix(previous.transcriptDigests ?? [], transcript.digests) : 0;
  const transcriptPatch = transcript
    ? `{"keep":${transcriptKeep},"append":${jsonArray(transcript.json.slice(transcriptKeep))}}`
    : `{"absent":true}`;
  const line =
    `${frameHeader("delta", seq, summary)},"head":${JSON.stringify(head)},` +
    `"messages":{"keep":${messageKeep},"append":${jsonArray(messages.json.slice(messageKeep))}},` +
    `"transcript":${transcriptPatch}}\n`;
  const bytes = Buffer.byteLength(line);
  const baseEstimate = messages.json.reduce((total, json) => total + json.length, 0) +
    (transcript?.json.reduce((total, json) => total + json.length, 0) ?? 0);
  if (bytes > baseEstimate * DELTA_BASE_RATIO && bytes > 4096) return buildBase(seq, record, messages, transcript);
  return {
    kind: "delta",
    line,
    bytes,
    state: {
      seq,
      head,
      summary,
      messageDigests: messages.digests,
      transcriptDigests: transcript?.digests,
      baseBytes: previous.baseBytes,
      deltaCount: previous.deltaCount + 1,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPatch(value: unknown): value is ArrayPatch<unknown> {
  return isObject(value) && isSeq(value.keep) && Array.isArray(value.append);
}

function isSummary(value: unknown, id: string): value is HistorySummary {
  return isObject(value) && value.id === id;
}

export function parseSessionFrame(text: string, sessionId: string): SessionFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value.v !== SESSION_FRAME_VERSION || !isSeq(value.seq) || !isSummary(value.summary, sessionId)) return undefined;
  if (value.t === "base") {
    const record = value.record;
    if (!isObject(record) || record.id !== sessionId || !Array.isArray(record.messages)) return undefined;
    if (record.transcript !== undefined && !Array.isArray(record.transcript)) return undefined;
    return value as unknown as BaseFrame;
  }
  if (value.t === "delta") {
    const head = value.head;
    if (!isObject(head) || head.id !== sessionId || !isPatch(value.messages)) return undefined;
    const transcript = value.transcript;
    if (!(isObject(transcript) && transcript.absent === true) && !isPatch(transcript)) return undefined;
    return value as unknown as DeltaFrame;
  }
  return undefined;
}

export interface ReplayedSession {
  readonly record: HistoryRecord;
  readonly seq: number;
  readonly summary: HistorySummary;
  readonly baseBytes: number;
  readonly deltaCount: number;
}

export class SessionReplay {
  private messages: ChatMessage[] = [];
  private transcript: TranscriptItem[] | undefined;
  private head: HistoryRecordHead | undefined;
  private summary: HistorySummary | undefined;
  private seq = -1;
  private baseBytes = 0;
  private deltaCount = 0;
  private stopped = false;

  constructor(private readonly sessionId: string) {}

  get halted(): boolean {
    return this.stopped;
  }

  accept(text: string, bytes: number): boolean {
    if (this.stopped) return false;
    const frame = parseSessionFrame(text, this.sessionId);
    if (!frame || !this.applies(frame)) {
      this.stopped = true;
      return false;
    }
    if (frame.t === "base") {
      const { messages, transcript } = frame.record;
      this.head = recordHead(frame.record);
      this.messages = messages;
      this.transcript = transcript;
      this.baseBytes = bytes;
      this.deltaCount = 0;
    } else {
      this.head = frame.head;
      this.messages = this.messages.slice(0, frame.messages.keep).concat(frame.messages.append);
      if ("absent" in frame.transcript) this.transcript = undefined;
      else this.transcript = (this.transcript ?? []).slice(0, frame.transcript.keep).concat(frame.transcript.append);
      this.deltaCount += 1;
    }
    this.summary = frame.summary;
    this.seq = frame.seq;
    return true;
  }

  private applies(frame: SessionFrame): boolean {
    if (this.seq < 0) return frame.t === "base";
    if (frame.seq !== this.seq + 1) return false;
    if (frame.t === "base") return true;
    if (frame.messages.keep > this.messages.length) return false;
    if ("absent" in frame.transcript) return true;
    return frame.transcript.keep <= (this.transcript?.length ?? 0);
  }

  result(): ReplayedSession | undefined {
    if (!this.head || !this.summary) return undefined;
    return {
      record: {
        ...this.head,
        messages: this.messages,
        ...(this.transcript ? { transcript: this.transcript } : {}),
      } as HistoryRecord,
      seq: this.seq,
      summary: this.summary,
      baseBytes: this.baseBytes,
      deltaCount: this.deltaCount,
    };
  }
}

export function stateFromReplay(replayed: ReplayedSession): SessionLogState {
  const { record } = replayed;
  return {
    seq: replayed.seq,
    head: recordHead(record),
    summary: replayed.summary,
    messageDigests: encodeList(record.messages).digests,
    transcriptDigests: record.transcript ? encodeList(record.transcript).digests : undefined,
    baseBytes: replayed.baseBytes,
    deltaCount: replayed.deltaCount,
  };
}
