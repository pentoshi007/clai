import { ProviderError } from "../http.js";
import { asRecord, pickString } from "./qoder-auth.js";

export interface QoderQueueStatus {
  isQueued?: boolean | undefined;
  serviceAvailable?: boolean | undefined;
  modelKey?: string | undefined;
  queueType?: string | undefined;
  queueCount?: number | undefined;
  retryAfterSeconds?: number | undefined;
  waitTime?: number | undefined;
}

function responseRecords(raw: string): Record<string, unknown>[] {
  const pending: unknown[] = [raw];
  const records: Record<string, unknown>[] = [];
  for (let index = 0; index < pending.length && index < 64; index++) {
    let value = pending[index];
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { continue; }
    }
    const record = asRecord(value);
    if (!record) continue;
    records.push(record);
    for (const key of ["data", "result", "message", "body", "error"]) {
      if (record[key] !== undefined) pending.push(record[key]);
    }
  }
  return records;
}

function nonnegativeNumber(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : undefined;
}

function queueStatus(records: Record<string, unknown>[]): QoderQueueStatus | undefined {
  const record = records.find((entry) => typeof entry.isQueued === "boolean" || typeof entry.serviceAvailable === "boolean");
  if (!record) return undefined;
  return {
    isQueued: typeof record.isQueued === "boolean" ? record.isQueued : undefined,
    serviceAvailable: typeof record.serviceAvailable === "boolean" ? record.serviceAvailable : undefined,
    modelKey: pickString(record, "modelKey"),
    queueType: pickString(record, "queueType"),
    queueCount: nonnegativeNumber(record.queueCount),
    retryAfterSeconds: nonnegativeNumber(record.retryAfterSeconds),
    waitTime: nonnegativeNumber(record.waitTime),
  };
}

export function parseQoderQueueStatus(raw: string): QoderQueueStatus | undefined {
  return queueStatus(responseRecords(raw));
}

export class QoderModelQueuedError extends ProviderError {
  constructor(readonly wireStatus: number, body: string, readonly queue: QoderQueueStatus) {
    super(`Qoder model request queued (code 10605; HTTP ${wireStatus}). Waiting for model capacity.`, 503, body, queue.retryAfterSeconds);
    this.name = "QoderModelQueuedError";
  }
}

export function qoderModelQueuedError(status: number, raw: string): QoderModelQueuedError | undefined {
  const records = responseRecords(raw);
  const queue = queueStatus(records);
  const queuedCode = records.some((record) => String(record.code) === "10605");
  if (!queuedCode && queue?.isQueued !== true && !(queue?.serviceAvailable === false && queue.isQueued !== false)) return undefined;
  return new QoderModelQueuedError(status, raw, queue ?? {});
}

export function qoderResponseError(status: number, raw: string): ProviderError {
  const queued = qoderModelQueuedError(status, raw);
  if (queued) return queued;
  let detail = raw;
  for (const record of responseRecords(raw)) {
    detail = pickString(record, "message", "errorMessage", "error", "detail") ?? detail;
  }
  return new ProviderError(`Qoder request failed (HTTP ${status})${detail ? `: ${detail.slice(0, 2000)}` : "."}`, status, raw);
}

export function extractQoderStreamBody(payload: string): string | undefined {
  let wrapper: Record<string, unknown> | undefined;
  try { wrapper = asRecord(JSON.parse(payload)); } catch { return undefined; }
  if (!wrapper) return undefined;
  const body = typeof wrapper.body === "string" ? wrapper.body : undefined;
  const status = nonnegativeNumber(wrapper.statusCodeValue) ?? 200;
  const raw = body ?? payload;
  if (status !== 200) throw qoderResponseError(status, raw);
  const queued = qoderModelQueuedError(status, raw);
  if (queued) throw queued;
  if (body !== undefined) return body;
  return wrapper.choices !== undefined || wrapper.usage !== undefined ? payload : undefined;
}
