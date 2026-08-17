import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderId } from "../types.js";
import { getDataDir } from "../store/paths.js";

/**
 * Reconciles the local request estimate with provider truth.
 *
 * The estimator in `request-accounting.ts` is deliberately conservative: it
 * assumes a dense chars-per-token ratio and counts every reasoning artifact and
 * tool schema it can see, including artifacts a serializer later drops. On a
 * real route that can read 40-60% high, which pushes the context chip, the
 * compaction card and the auto-compaction trigger away from what the provider
 * actually bills.
 *
 * Every successful request reports its own prompt size, so the correction factor
 * does not need to be guessed. Each observation pairs the estimate we made for a
 * request with the count the provider returned for that same request, and the
 * ratio is smoothed per provider+model. Until a route has been observed the raw
 * conservative estimate stands unchanged.
 */

/** Below this the fixed per-message overhead dominates and the ratio is noise. */
const MIN_SAMPLE_TOKENS = 400;

/** One observation can be an outlier (a truncated stream, a partial retry). */
const MIN_TRUSTED_SAMPLES = 2;

// A learned factor corrects estimator bias; it must never be able to convince
// the fit gate that a request is dramatically smaller or larger than measured.
const MIN_RATIO = 0.35;
const MAX_RATIO = 1.5;

/** Weight of the newest observation; the route adapts without thrashing. */
const SMOOTHING = 0.4;

export interface RequestTokenCalibration {
  readonly ratio: number;
  readonly samples: number;
}

interface CalibrationEntry {
  ratio: number;
  samples: number;
}

interface CalibrationStore {
  version: 1;
  entries: Record<string, CalibrationEntry>;
}

const calibrations = new Map<string, CalibrationEntry>();
let loaded = false;

function calibrationFile(): string {
  return join(getDataDir(), "request-token-calibration.json");
}

function validEntry(value: unknown): value is CalibrationEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<CalibrationEntry>;
  return (
    typeof entry.ratio === "number" &&
    Number.isFinite(entry.ratio) &&
    entry.ratio >= MIN_RATIO &&
    entry.ratio <= MAX_RATIO &&
    typeof entry.samples === "number" &&
    Number.isInteger(entry.samples) &&
    entry.samples > 0
  );
}

function loadCalibrations(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(calibrationFile(), "utf8")) as Partial<CalibrationStore>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") return;
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (validEntry(value)) calibrations.set(key, value);
    }
  } catch {}
}

function persistCalibrations(): void {
  const file = calibrationFile();
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(getDataDir(), { recursive: true });
    const entries = Object.fromEntries([...calibrations.entries()].slice(-128));
    writeFileSync(temp, `${JSON.stringify({ version: 1, entries })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temp, file);
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {}
  }
}

function calibrationKey(
  provider: ProviderId | undefined,
  model: string | undefined,
): string {
  return `${provider ?? "unknown"}::${model ?? "unknown"}`;
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/**
 * Pair the estimate made for one request with the prompt size the provider
 * reported for it. Callers must pass the uncalibrated estimate, otherwise the
 * correction compounds against itself.
 */
export function recordRequestTokenObservation(input: {
  readonly provider: ProviderId | undefined;
  readonly model: string | undefined;
  readonly estimatedRequestTokens: number;
  readonly actualPromptTokens: number;
}): void {
  const estimated = input.estimatedRequestTokens;
  const actual = input.actualPromptTokens;
  if (!Number.isFinite(estimated) || !Number.isFinite(actual)) return;
  if (estimated < MIN_SAMPLE_TOKENS || actual < MIN_SAMPLE_TOKENS) return;
  loadCalibrations();
  const observed = clampRatio(actual / estimated);
  const key = calibrationKey(input.provider, input.model);
  const previous = calibrations.get(key);
  calibrations.set(key, {
    ratio: previous
      ? clampRatio(previous.ratio + (observed - previous.ratio) * SMOOTHING)
      : observed,
    samples: (previous?.samples ?? 0) + 1,
  });
  persistCalibrations();
}

/** The learned factor for a route, once it has enough observations to trust. */
export function requestTokenCalibration(
  provider: ProviderId | undefined,
  model: string | undefined,
): RequestTokenCalibration | undefined {
  loadCalibrations();
  const entry = calibrations.get(calibrationKey(provider, model));
  if (!entry || entry.samples < MIN_TRUSTED_SAMPLES) return undefined;
  return { ratio: entry.ratio, samples: entry.samples };
}

/** Apply the learned factor, or return the estimate unchanged when untrained. */
export function calibratedRequestTokens(
  provider: ProviderId | undefined,
  model: string | undefined,
  estimatedTokens: number,
): number {
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return 0;
  const calibration = requestTokenCalibration(provider, model);
  if (!calibration) return Math.round(estimatedTokens);
  return Math.max(1, Math.round(estimatedTokens * calibration.ratio));
}

export function resetRequestTokenCalibration(options?: {
  removePersisted?: boolean;
}): void {
  calibrations.clear();
  loaded = true;
  if (options?.removePersisted) {
    try {
      rmSync(calibrationFile(), { force: true });
    } catch {}
  }
}
