import { clearActiveProjectRoot } from "../../agent/project-root.js";
import {
  getSession,
  listSessionSummaries,
  type HistoryRecord,
} from "../../store/history.js";
import { safeCwd } from "../../os/cwd.js";
import { getProviderModel } from "../../store/config.js";
import { loadModelForSession } from "../../store/session-model.js";
import {
  boundSessionVisualInput,
  hydrateSessionVisual,
  transcriptLooksIncomplete,
} from "../state/transcript-hydrate.js";
import { conversationItemCount } from "../state/transcript-types.js";
import type { AppServices } from "./composition-root.js";

export type ResumeTarget =
  | { readonly kind: "latest" }
  | { readonly kind: "id"; readonly id: string };

export interface ResumeResolution {
  readonly record: HistoryRecord | undefined;
  readonly error: string | undefined;
}

export interface ResumeOutcome {
  readonly sessionId: string;
  readonly title: string | undefined;
  readonly itemCount: number;
  readonly hasPlan: boolean;
  readonly planTasks: number;
  readonly incomplete: boolean;
  readonly omitted: number;
}

const CANDIDATE_LIMIT = 500;

function sameDirectory(left: string, right: string): boolean {
  if (left === right) return true;
  return left.replace(/[\\/]+$/, "") === right.replace(/[\\/]+$/, "");
}

async function resolveLatest(): Promise<ResumeResolution> {
  const summaries = await listSessionSummaries(CANDIDATE_LIMIT, {
    recovery: "blocking",
  });
  if (summaries.length === 0) {
    return { record: undefined, error: "no saved sessions yet" };
  }
  const cwd = safeCwd();
  const here = summaries.find((summary) => sameDirectory(summary.cwd, cwd));
  const chosen = here ?? summaries[0];
  if (!chosen) {
    return { record: undefined, error: "no saved sessions yet" };
  }
  const record = await getSession(chosen.id);
  return record
    ? { record, error: undefined }
    : { record: undefined, error: `session ${chosen.id} could not be read` };
}

async function resolveById(id: string): Promise<ResumeResolution> {
  const trimmed = id.trim();
  if (!trimmed) {
    return { record: undefined, error: "a session id is required" };
  }
  const exact = await getSession(trimmed);
  if (exact) return { record: exact, error: undefined };

  const summaries = await listSessionSummaries(CANDIDATE_LIMIT, {
    recovery: "blocking",
  });
  const lower = trimmed.toLowerCase();
  const matches = summaries.filter((summary) =>
    summary.id.toLowerCase().startsWith(lower),
  );
  if (matches.length === 0) {
    return {
      record: undefined,
      error: `no session matches "${trimmed}" — run \`clai history\` to list saved sessions`,
    };
  }
  if (matches.length > 1) {
    const shown = matches
      .slice(0, 5)
      .map((summary) => summary.id)
      .join(", ");
    return {
      record: undefined,
      error: `"${trimmed}" matches ${matches.length} sessions (${shown}${matches.length > 5 ? ", …" : ""}) — pass a longer id`,
    };
  }
  const record = await getSession(matches[0]!.id);
  return record
    ? { record, error: undefined }
    : { record: undefined, error: `session ${matches[0]!.id} could not be read` };
}

export async function resolveResumeTarget(
  target: ResumeTarget,
): Promise<ResumeResolution> {
  try {
    return target.kind === "latest"
      ? await resolveLatest()
      : await resolveById(target.id);
  } catch (error) {
    return {
      record: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function applySessionResume(
  services: AppServices,
  record: HistoryRecord,
): Promise<ResumeOutcome> {
  clearActiveProjectRoot();
  services.plan.clear();
  const fallback = await loadModelForSession(record.id);
  const provider = record.provider ?? fallback.provider;
  const model =
    record.model ??
    (record.provider && record.provider !== fallback.provider
      ? getProviderModel(record.provider)
      : fallback.model);
  services.session.loadHistory(record.messages, {
    sessionId: record.id,
    title: record.name,
    persistenceRevision: record.revision,
    provider,
    model,
    ...(record.previousTurn ? { previousTurn: record.previousTurn } : {}),
    ...(record.contextUsage ? { contextUsage: record.contextUsage } : {}),
    ...(record.workspaceFolder
      ? {
          workspaceFolder: record.workspaceFolder,
          workspaceCode: record.workspaceCode,
        }
      : {}),
  });

  const visual = boundSessionVisualInput(record.transcript, record.messages);
  const hydrated = hydrateSessionVisual(visual.transcript, visual.messages);
  services.transcript.hydrate(hydrated.state, {
    persistBase: record.transcript,
  });
  for (const [toolCallId, output] of hydrated.toolOutputs) {
    services.session.spool.replace(toolCallId, output);
  }

  const plan = await services.plan.load(record.id).catch(() => undefined);
  services.session.setPlanApproved(
    plan?.status === "approved" || plan?.status === "in_progress",
  );

  const itemCount = conversationItemCount(hydrated.state);
  const toolCards = [...hydrated.state.byId.values()].filter(
    (item) => item.kind === "tool",
  ).length;
  const incomplete =
    transcriptLooksIncomplete(record.transcript?.length ?? 0, record.messages) ||
    (Boolean(plan?.tasks?.length) &&
      toolCards === 0 &&
      (record.transcript?.length ?? 0) < 8);

  return {
    sessionId: record.id,
    title: record.name,
    itemCount,
    hasPlan: Boolean(plan),
    planTasks: plan?.tasks?.length ?? 0,
    incomplete,
    omitted: Math.max(visual.omittedItems, visual.omittedMessages),
  };
}

export function resumeNotices(
  outcome: ResumeOutcome,
): readonly { readonly level: "info" | "warn"; readonly text: string }[] {  const notices: { level: "info" | "warn"; text: string }[] = [];
  if (outcome.omitted > 0) {
    notices.push({
      level: "info",
      text: `Loaded recent history view; ${outcome.omitted} older item(s) remain available to the model on continue.`,
    });
  }
  const title = outcome.title?.trim();
  const shortTitle = title
    ? ` · ${title.length > 28 ? `${title.slice(0, 27)}…` : title}`
    : "";
  notices.push({
    level: "info",
    text: `resumed${shortTitle}${outcome.hasPlan ? " · plan" : ""} · ${outcome.itemCount} items`,
  });
  if (outcome.incomplete) {
    notices.push({
      level: "warn",
      text:
        outcome.planTasks > 0
          ? "thin history · plan OK · /implement to continue"
          : "thin history · some tools may be missing",
    });
  }
  return notices;
}

export async function applyResumeResolution(
  services: AppServices,
  resolution: ResumeResolution | undefined,
): Promise<void> {
  if (!resolution) return;
  if (!resolution.record) {
    if (resolution.error) services.session.notice("warn", resolution.error);
    return;
  }
  try {
    const outcome = await applySessionResume(services, resolution.record);
    for (const entry of resumeNotices(outcome)) {
      services.session.notice(entry.level, entry.text);
    }
  } catch (error) {
    services.session.notice(
      "warn",
      `could not resume session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
