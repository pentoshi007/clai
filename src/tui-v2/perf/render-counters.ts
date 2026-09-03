import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getLogsDirRoot } from "../../store/paths.js";

const SAMPLE_INTERVAL_MS = 2000;

let enabled = process.env.CLAI_UI_PERF === "1";
const counts = new Map<string, number>();
let samplerStarted = false;
let lastSampleAt = 0;

export function setRenderCountersEnabled(value: boolean): void {
  enabled = value;
}

export function isRenderCountersEnabled(): boolean {
  return enabled;
}

export function countRender(name: string): void {
  if (!enabled) return;
  counts.set(name, (counts.get(name) ?? 0) + 1);
  startSampler();
}

export function readRenderCounts(): ReadonlyMap<string, number> {
  return counts;
}

export function resetRenderCounts(): void {
  counts.clear();
  lastSampleAt = Date.now();
}

function startSampler(): void {
  if (samplerStarted) return;
  samplerStarted = true;
  lastSampleAt = Date.now();
  const timer = setInterval(() => {
    void sample().catch(() => undefined);
  }, SAMPLE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

async function sample(): Promise<void> {
  if (counts.size === 0) return;
  const now = Date.now();
  const elapsedMs = Math.max(1, now - lastSampleAt);
  lastSampleAt = now;
  const snapshot: Record<string, number> = {};
  for (const [name, total] of counts) snapshot[name] = total;
  counts.clear();
  const line = `${JSON.stringify({ at: new Date(now).toISOString(), elapsedMs, renders: snapshot })}\n`;
  const dir = getLogsDirRoot();
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "ui-perf.log"), line, { mode: 0o600 });
}
