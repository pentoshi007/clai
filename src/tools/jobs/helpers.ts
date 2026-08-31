import type { BackgroundJob, BackgroundSpawnSpec } from "../jobs.js";

export function formatJobElapsed(
  job: Pick<BackgroundJob, "startedAt" | "endedAt">,
  now = Date.now(),
): string {
  const startedAt = Date.parse(job.startedAt);
  const endedAt = job.endedAt ? Date.parse(job.endedAt) : now;
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return "unknown";
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

function displayArg(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value)
    ? value
    : JSON.stringify(value);
}

export function commandDisplay(command: string | BackgroundSpawnSpec): string {
  if (typeof command === "string") return command;
  return command.display ?? [command.command, ...command.argv].map(displayArg).join(" ");
}

export function launchFollowUp(id: string, responder: boolean): string {
  return responder
    ? "Responder owns completion tracking for this self-completing job. " +
        "Do not poll it with shell.tail/shell.jobs, sleep, or read its artifact. " +
        "Continue other work; if not already delivered, its terminal result will be delivered automatically."
    : "OS launch does not prove application readiness or continued liveness. " +
        `If this command is finite, block once with shell.wait {"id":"${id}"} rather than polling for status; ` +
        "repeated identical polls return no new information and are refused. " +
        `If it is a persistent server or watcher, run an application readiness probe and read new output with shell.tail {"id":"${id}"} using nextOffset. ` +
        "Do not launch a duplicate.";
}

export function trailingIncompleteBytes(buf: Buffer): number {
  const len = buf.length;
  for (let back = 1; back <= 3 && back <= len; back++) {
    const byte = buf[len - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    let expectedLen = 1;
    if ((byte & 0xe0) === 0xc0) expectedLen = 2;
    else if ((byte & 0xf0) === 0xe0) expectedLen = 3;
    else if ((byte & 0xf8) === 0xf0) expectedLen = 4;
    return expectedLen > back ? back : 0;
  }
  return 0;
}

export function looksLikeEphemeralToolTrack(job: BackgroundJob): boolean {
  if (job.kind === "ephemeral") return true;
  const cmd = (job.commandDisplay || job.command || "").trim();
  if (/^(fs|shell|tool|web|http|net|pdf|image|pkg|dns|whois|plan|task|pentest|sysinfo)\.[a-zA-Z]+(\s|$)/.test(cmd)) {
    return true;
  }
  if (!job.stdoutArtifact && !job.artifactPath && !job.pid) return true;
  return false;
}
