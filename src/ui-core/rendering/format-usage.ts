import {
  usageCacheHitRate,
  type SessionUsageReport,
  type SessionUsageRoute,
  type SessionUsageTotals,
} from "../../app/controllers/session-usage-ledger.js";

const MISSING = "—";

const HEADERS = [
  "PROVIDER / MODEL",
  "REQ",
  "IN",
  "OUT",
  "TOTAL",
  "CACHED",
  "RATE",
] as const;

const ALIGNS = ["---", "---:", "---:", "---:", "---:", "---:", "---:"] as const;

export interface SessionUsageContext {
  readonly sessionId: string;
  readonly title?: string | undefined;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function code(text: string): string {
  return `\`${escapeCell(text)}\``;
}

function bold(text: string): string {
  return `**${escapeCell(text)}**`;
}

function routeLabel(route: SessionUsageRoute): string {
  return `${route.provider ?? "unknown provider"} / ${route.model ?? "unknown model"}`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function optionalCount(value: number | undefined): string {
  return value === undefined ? MISSING : count(value);
}

function percent(value: number | undefined): string {
  if (value === undefined) return MISSING;
  const scaled = value * 100;
  if (scaled > 0 && scaled < 0.1) return "<0.1%";
  return `${scaled.toFixed(1)}%`;
}

function metrics(entry: SessionUsageRoute | SessionUsageTotals): readonly string[] {
  return [
    count(entry.requests),
    count(entry.promptTokens),
    count(entry.completionTokens),
    count(entry.totalTokens),
    optionalCount(entry.cachedPromptTokens),
    percent(usageCacheHitRate(entry)),
  ];
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function plural(value: number, singular: string): string {
  return `${count(value)} ${singular}${value === 1 ? "" : "s"}`;
}

function telemetry(route: SessionUsageRoute): string | undefined {
  const parts: string[] = [];
  if (route.cacheCreationTokens !== undefined) {
    parts.push(`cache write ${count(route.cacheCreationTokens)}`);
  }
  if (route.uncachedPromptTokens !== undefined) {
    parts.push(`uncached input ${count(route.uncachedPromptTokens)}`);
  }
  if (route.reasoningTokens !== undefined) {
    parts.push(`reasoning ${count(route.reasoningTokens)}`);
  }
  if (route.estimatedRequests > 0) {
    parts.push(plural(route.estimatedRequests, "estimated request"));
  }
  if (route.unmeasuredPromptRequests > 0) {
    parts.push(`${plural(route.unmeasuredPromptRequests, "request")} without an input count`);
  }
  if (parts.length === 0) return undefined;
  return `- ${code(routeLabel(route))} — ${parts.join(" · ")}`;
}

export function formatSessionUsage(
  report: SessionUsageReport,
  context: SessionUsageContext,
): string {
  const subject = context.title
    ? `${escapeCell(context.title)} · ${code(context.sessionId)}`
    : code(context.sessionId);

  if (report.routes.length === 0) {
    return [
      "# Session usage",
      "",
      subject,
      "",
      "No provider token usage has been recorded in this session yet.",
      "",
      "> Send a prompt first — every count comes from the provider's own usage report.",
    ].join("\n");
  }

  const { totals } = report;
  const summary = [
    bold(plural(totals.routes, "provider/model route")),
    bold(plural(totals.requests, "request")),
    bold(`${count(totals.totalTokens)} tokens`),
  ].join(" · ");

  const lines = [
    "# Session usage",
    "",
    `${subject} · ${summary}`,
    "",
    row(HEADERS),
    row(ALIGNS),
    ...report.routes.map((route) => row([code(routeLabel(route)), ...metrics(route)])),
    row([bold(`TOTAL · ${plural(totals.routes, "route")}`), ...metrics(totals).map(bold)]),
  ];

  const details = report.routes
    .map(telemetry)
    .filter((line): line is string => line !== undefined);
  if (details.length > 0) {
    lines.push("", "### Additional provider telemetry", "", ...details);
  }

  lines.push(
    "",
    `> ${code(MISSING)} = not reported by the provider`,
    "> cache rate = cached input ÷ measured input, counted only over requests that reported caching",
    "> every number is scoped to this session and comes from provider usage reports",
  );
  return lines.join("\n");
}
