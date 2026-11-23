import { stripVTControlCharacters } from "node:util";
import { redactSecrets } from "../../llm/provider.js";
import type { BackgroundJob } from "./types.js";

export const JOB_TITLE_LIMIT = 48;
export const DEFAULT_JOB_TITLE = "Background job";
export const LEGACY_RESPONDER_TITLE_PREFIX = /^Responder ·(?: |$)/;

const singleLine = (value: string): string =>
  stripVTControlCharacters(redactSecrets(value)).replace(/[\s\p{Cc}\p{Bidi_Control}]+/gu, " ").trim();

export function normalizeJobTitle(value: unknown, command: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = singleLine(value).replace(LEGACY_RESPONDER_TITLE_PREFIX, "");
  if (!title || [...title].length > JOB_TITLE_LIMIT) return undefined;
  const commandText = singleLine(command).toLowerCase();
  const label = title.toLowerCase();
  if (label === commandText || (commandText.includes(" ") && label.includes(commandText))) return undefined;
  return title;
}

export function jobTitle(job: Pick<BackgroundJob, "name" | "commandDisplay"> | undefined): string {
  if (!job) return DEFAULT_JOB_TITLE;
  return normalizeJobTitle(job.name, job.commandDisplay) ?? DEFAULT_JOB_TITLE;
}
