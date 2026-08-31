import type { EngagementScope } from "../store/scope.js";
import type { ToolCall } from "../types.js";
import {
  isLoopbackScopeTarget,
  normalizeScopeTarget,
  targetInScope,
} from "../store/scope.js";

export type ActionCapability =
  | "passive"
  | "active-enumeration"
  | "authentication"
  | "exploitation"
  | "persistence"
  | "destructive";

export type EngagementPhase =
  | "recon"
  | "enumeration"
  | "authentication"
  | "exploitation"
  | "post-exploitation";

export interface EngagementAction {
  target: string;
  url?: string | undefined;
  port?: number | undefined;
  path?: string | undefined;
  method?: string | undefined;
  phase: EngagementPhase;
  capability: ActionCapability;
  redirectChain?: string[] | undefined;
  resolvedAddresses?: string[] | undefined;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  normalizedTarget: string;
  capability: ActionCapability;
  phase: EngagementPhase;
}

const methodAllowed = (method: string, scope: EngagementScope): boolean => {
  if (!scope.allowedMethods?.length) return true;
  return scope.allowedMethods.some((allowed) => allowed.toUpperCase() === method.toUpperCase());
};

const pathAllowed = (path: string, scope: EngagementScope): boolean => {
  if (!scope.allowedPaths?.length) return true;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return scope.allowedPaths.some((allowed) => {
    const prefix = allowed.startsWith("/") ? allowed : `/${allowed}`;
    return normalized === prefix || normalized.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
  });
};

export function isLocalDevProbeAction(action: EngagementAction): boolean {
  const host = normalizeScopeTarget(action.target) || action.target;
  if (!isLoopbackScopeTarget(host)) return false;
  const method = (action.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

export function evaluateEngagementAction(
  scope: EngagementScope | undefined,
  action: EngagementAction,
  now = Date.now(),
): PolicyDecision {
  const target = normalizeScopeTarget(action.target);
  const deny = (reason: string): PolicyDecision => ({
    allowed: false,
    reason,
    normalizedTarget: target,
    capability: action.capability,
    phase: action.phase,
  });
  if (isLocalDevProbeAction(action)) {
    const resolved = action.resolvedAddresses ?? [];
    const escaped = resolved.some((addr) => !isLoopbackScopeTarget(addr));
    if (!escaped) {
      return {
        allowed: true,
        reason: "local loopback probe — engagement scope does not apply",
        normalizedTarget: target || "localhost",
        capability: action.capability,
        phase: action.phase,
      };
    }
  }
  if (!scope || !scope.authorizedTargets?.length) {
    return {
      allowed: true,
      reason: "engagement scope disabled (no authorized targets)",
      normalizedTarget: target,
      capability: action.capability,
      phase: action.phase,
    };
  }
  if (!isScopeActiveAt(scope, now)) {
    return deny("engagement scope is outside its time window");
  }
  if (!targetInScope(target, scope)) return deny(`target is excluded or not authorized: ${target}`);
  if (scope.allowedPhases?.length && !scope.allowedPhases.includes(action.phase)) {
    return deny(`phase is not authorized: ${action.phase}`);
  }
  if (action.port !== undefined && scope.allowedPorts?.length && !scope.allowedPorts.includes(action.port)) {
    return deny(`port is not authorized: ${action.port}`);
  }
  if (action.url) {
    if (!methodAllowed(action.method ?? "GET", scope)) return deny(`HTTP method is not authorized: ${action.method}`);
    if (!pathAllowed(action.path ?? "/", scope)) return deny(`path is not authorized: ${action.path}`);
  }

  for (const redirect of action.redirectChain ?? []) {
    if (!targetInScope(redirect, scope)) return deny(`redirect destination is excluded or out of scope: ${normalizeScopeTarget(redirect)}`);
  }
  for (const address of action.resolvedAddresses ?? []) {
    if (!targetInScope(address, scope)) return deny(`DNS resolution escaped authorized assets: ${address}`);
  }
  return {
    allowed: true,
    reason: "authorized by engagement scope",
    normalizedTarget: target,
    capability: action.capability,
    phase: action.phase,
  };
}

function isScopeActiveAt(scope: EngagementScope, now: number): boolean {
  if (!scope.authorizedTargets?.length) return false;
  if (!scope.expiresAt) return true;
  const expires = Date.parse(scope.expiresAt);
  return Number.isNaN(expires) || now <= expires;
}

export interface PolicyLease {
  decision: PolicyDecision;
  release: () => void;
}

export class EngagementPolicyEngine {
  private tokens = 0;
  private lastRefill = 0;
  private active = 0;
  private scopeIdentity = "";

  constructor(private readonly now: () => number = Date.now) {}

  acquire(scope: EngagementScope | undefined, action: EngagementAction): PolicyLease {
    const decision = evaluateEngagementAction(scope, action, this.now());
    if (!decision.allowed || !scope) return { decision, release: () => undefined };
    const identity = JSON.stringify([scope.name, scope.updatedAt, scope.authorizedTargets, scope.maxRate, scope.maxConcurrency]);
    const rate = Math.max(0, scope.maxRate ?? Number.POSITIVE_INFINITY);
    const concurrency = Math.max(1, Math.floor(scope.maxConcurrency ?? Number.MAX_SAFE_INTEGER));
    const now = this.now();
    if (identity !== this.scopeIdentity) {
      this.scopeIdentity = identity;
      this.tokens = Number.isFinite(rate) ? rate : Number.MAX_SAFE_INTEGER;
      this.lastRefill = now;
      this.active = 0;
    }
    if (this.active >= concurrency) {
      return { decision: { ...decision, allowed: false, reason: "engagement concurrency limit reached" }, release: () => undefined };
    }
    if (Number.isFinite(rate)) {
      const elapsedSeconds = Math.max(0, now - this.lastRefill) / 1_000;
      this.tokens = Math.min(rate, this.tokens + elapsedSeconds * rate);
      this.lastRefill = now;
      if (this.tokens < 1) {
        return { decision: { ...decision, allowed: false, reason: "engagement rate limit reached" }, release: () => undefined };
      }
      this.tokens -= 1;
    }
    this.active += 1;
    let released = false;
    return {
      decision,
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
      },
    };
  }
}

export function actionFromUrl(input: {
  url: string;
  method?: string | undefined;
  phase?: EngagementPhase | undefined;
  capability?: ActionCapability | undefined;
  redirectChain?: string[] | undefined;
  resolvedAddresses?: string[] | undefined;
}): EngagementAction {
  const parsed = safeParseUrl(input.url);
  const target = parsed?.hostname ?? hostnameFromLoose(input.url) ?? input.url;
  return {
    target,
    url: input.url,
    port: parsed?.port ? Number(parsed.port) : parsed?.protocol === "https:" ? 443 : 80,
    path: parsed?.pathname || "/",
    method: input.method ?? "GET",
    phase: input.phase ?? "enumeration",
    capability: input.capability ?? (/^(?:GET|HEAD|OPTIONS)$/i.test(input.method ?? "GET") ? "passive" : "active-enumeration"),
    redirectChain: input.redirectChain,
    resolvedAddresses: input.resolvedAddresses,
  };
}

function safeParseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function hostnameFromLoose(raw: string): string | undefined {
  const match = /https?:\/\/([a-z0-9.-]+)/i.exec(raw);
  return match?.[1]?.toLowerCase();
}

interface BareTarget {
  readonly target: string;
  readonly port?: number;
}

function bareTargets(command: string): BareTarget[] {
  return [...command.matchAll(
    /(?:^|[\s'"=(,])((?:[a-z0-9-]+\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?(?=[\s'"),;]|$)/gi,
  )]
    .map((match) => {
      const target = match[1];
      if (!target) return undefined;
      const port = match[2] ? Number(match[2]) : undefined;
      return { target, ...(port !== undefined ? { port } : {}) };
    })
    .filter((candidate): candidate is BareTarget => candidate !== undefined);
}

export interface InteractiveEngagementState {
  readonly target?: string | undefined;
  readonly port?: number | undefined;
  readonly phase?: EngagementPhase | undefined;
  readonly capability?: ActionCapability | undefined;
}

export interface InteractiveEngagementAssessment {
  readonly state: InteractiveEngagementState;
  readonly effectful: boolean;
  readonly decision?: PolicyDecision | undefined;
}

function interactivePhase(text: string): Pick<InteractiveEngagementState, "phase" | "capability"> {
  if (/\b(?:rm\s+-rf|mkfs|hashdump|migrate|portfwd|persistence|autoroute)\b/i.test(text)) {
    return { phase: "post-exploitation", capability: "destructive" };
  }
  if (/\b(?:use\s+(?:exploit|payload)\/|exploit|payload|meterpreter|reverse.shell|shell\b)\b/i.test(text)) {
    return { phase: "exploitation", capability: "exploitation" };
  }
  if (/\b(?:login|auth|password|credential|hydra)\b/i.test(text)) {
    return { phase: "authentication", capability: "authentication" };
  }
  if (/\b(?:msfconsole|use\s+auxiliary\/|scanner|nmap|masscan|check\b)\b/i.test(text)) {
    return { phase: "enumeration", capability: "active-enumeration" };
  }
  return {};
}

export function advanceInteractiveEngagementState(
  current: InteractiveEngagementState,
  text: string,
): InteractiveEngagementState {
  const rhost = /\bset\s+RHOSTS?\s+([^\s;]+)/i.exec(text)?.[1];
  const explicitTarget = rhost?.replace(/^https?:\/\//i, "").replace(/:\d+$/, "");
  const candidate = bareTargets(text).at(-1);
  const rport = /\bset\s+RPORT\s+(\d{1,5})\b/i.exec(text)?.[1];
  const explicitPort = rport ? Number(rport) : candidate?.port;
  const inferred = interactivePhase(text);
  return {
    ...(current.target ? { target: current.target } : {}),
    ...(current.port !== undefined ? { port: current.port } : {}),
    ...(current.phase ? { phase: current.phase } : {}),
    ...(current.capability ? { capability: current.capability } : {}),
    ...(candidate?.target ? { target: candidate.target } : {}),
    ...(explicitTarget ? { target: explicitTarget } : {}),
    ...(explicitPort !== undefined && explicitPort >= 1 && explicitPort <= 65_535
      ? { port: explicitPort }
      : {}),
    ...inferred,
  };
}

export function evaluateInteractiveEngagementInput(
  scope: EngagementScope | undefined,
  current: InteractiveEngagementState,
  text: string,
  now = Date.now(),
): InteractiveEngagementAssessment {
  const state = advanceInteractiveEngagementState(current, text);
  const effectful = /^(?:run|exploit|check|connect|open|sessions?\s+-i|shell|execute|download|upload|hashdump|migrate|route|portfwd)\b/i.test(
    text.trim(),
  );
  if (!effectful || !scope?.authorizedTargets?.length) return { state, effectful };
  if (!state.target) {
    return {
      state,
      effectful,
      decision: {
        allowed: false,
        reason: "interactive effect has no bound authorized target",
        normalizedTarget: "",
        capability: state.capability ?? "exploitation",
        phase: state.phase ?? "exploitation",
      },
    };
  }
  const action: EngagementAction = {
    target: state.target,
    ...(state.port !== undefined ? { port: state.port } : {}),
    path: "/",
    method: "GET",
    phase: state.phase ?? "exploitation",
    capability: state.capability ?? "exploitation",
  };
  return {
    state,
    effectful,
    decision: evaluateEngagementAction(scope, action, now),
  };
}

export function engagementActionForToolCall(call: ToolCall): EngagementAction | undefined {
  if (call.name === "pentest.webDiscover") {
    const url = String(call.args.baseUrl ?? "");
    return url ? actionFromUrl({ url, phase: "enumeration", capability: "active-enumeration" }) : undefined;
  }
  if (call.name === "pentest.apiEnumerate") {
    const url = String(call.args.specUrl ?? "");
    return url ? actionFromUrl({ url, phase: "enumeration", capability: "active-enumeration" }) : undefined;
  }
  if (call.name === "pentest.authCompare") {
    const url = String(call.args.url ?? "");
    return url ? actionFromUrl({ url, phase: "authentication", capability: "authentication" }) : undefined;
  }
  if (call.name === "pentest.scanStatus") {
    const target = String(call.args.target ?? "");
    return target ? { target, path: "/", method: "GET", phase: "recon", capability: "passive" } : undefined;
  }
  if (call.name === "http.fetch") {
    const url = typeof call.args.url === "string" ? call.args.url : "";
    if (!url) return undefined;
    try {
      const host = new URL(url).hostname;
      const method = typeof call.args.method === "string" ? call.args.method : "GET";
      if (
        isLoopbackScopeTarget(host) &&
        /^(?:GET|HEAD|OPTIONS)$/i.test(method)
      ) {
        return undefined;
      }
    } catch {
    }
    return actionFromUrl({
      url,
      method: typeof call.args.method === "string" ? call.args.method : "GET",
      phase: /^(?:GET|HEAD|OPTIONS)$/i.test(String(call.args.method ?? "GET")) ? "enumeration" : "exploitation",
    });
  }
  if (call.name === "net.scan" || call.name === "pentest.recon") {
    const target = String(call.args.target ?? call.args.host ?? "");
    if (!target) return undefined;
    const port = typeof call.args.port === "number" ? call.args.port : undefined;
    return { target, port, path: "/", method: "GET", phase: "recon", capability: "active-enumeration" };
  }
  if (
    call.name !== "shell.exec" &&
    call.name !== "shell.start" &&
    call.name !== "terminal.start" &&
    call.name !== "terminal.send"
  ) {
    return undefined;
  }
  const command = String(
    call.name === "terminal.send" ? call.args.text ?? "" : call.args.command ?? "",
  );
  const urlToken = command.match(/https?:\/\/[^\s'"<>]+/i)?.[0];
  const parsedUrl = urlToken ? safeParseUrl(urlToken) : undefined;
  const namesRemoteTarget =
    Boolean(parsedUrl) ||
    call.name === "terminal.send" ||
    /\b(?:curl|wget|httpie|nmap|masscan|nikto|nuclei|ffuf|gobuster|sqlmap|hydra|metasploit|msfconsole|dig|nslookup|host|ping|traceroute|tracepath|nc|netcat|telnet|ssh|ftp|openssl\s+s_client|rm\s+-rf|mkfs|shutdown|reboot|crontab|launchctl|systemctl\s+enable|schtasks|reverse.shell|exploit|payload)\b/i.test(command);

  const candidates = namesRemoteTarget ? bareTargets(command) : [];
  const bareTarget = candidates.at(-1);
  const url = parsedUrl ? urlToken : undefined;
  const host = parsedUrl ? parsedUrl.hostname : bareTarget?.target;
  if (!host) return undefined;
  const method =
    /\bcurl\b[^\n]*\s-X\s+([A-Z]+)/i.exec(command)?.[1] ?? "GET";
  if (
    isLoopbackScopeTarget(host) &&
    /^(?:GET|HEAD|OPTIONS)$/i.test(method) &&
    candidates.every((candidate) => isLoopbackScopeTarget(candidate.target))
  ) {
    return undefined;
  }
  const destructive = /\b(?:rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|drop\s+(?:database|table)|delete\s+from)\b/i.test(command);
  const persistence = /\b(?:crontab|launchctl|systemctl\s+enable|schtasks|authorized_keys|startup|persistence)\b/i.test(command);
  const exploitation = /\b(?:sqlmap|hydra|metasploit|msfconsole|exploit|payload|reverse.shell|csrf|xss|union\s+select)\b/i.test(command);
  const authentication = /\b(?:login|auth|password|credential|jwt|session|hydra)\b/i.test(command);
  const phase: EngagementPhase = destructive || persistence
    ? "post-exploitation"
    : exploitation
      ? "exploitation"
      : authentication
        ? "authentication"
        : "enumeration";
  const capability: ActionCapability = destructive
    ? "destructive"
    : persistence
      ? "persistence"
      : exploitation
        ? "exploitation"
        : authentication
          ? "authentication"
          : "active-enumeration";
  return {
    target: host,
    ...(parsedUrl
      ? {
          url: url,
          port: Number(parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80)),
          path: parsedUrl.pathname,
        }
      : bareTarget?.port !== undefined
        ? { port: bareTarget.port }
        : {}),
    method,
    phase,
    capability,
  };
}

export function engagementActionsForToolCall(
  call: ToolCall,
): EngagementAction[] {
  const primary = engagementActionForToolCall(call);
  if (!primary) return [];
  if (
    call.name !== "shell.exec" &&
    call.name !== "shell.start" &&
    call.name !== "terminal.start" &&
    call.name !== "terminal.send"
  ) {
    return [primary];
  }
  const command = String(
    call.name === "terminal.send" ? call.args.text ?? "" : call.args.command ?? "",
  );
  const urlTargets = [...command.matchAll(/https?:\/\/[^\s'"<>]+/gi)]
    .map((match): BareTarget | undefined => {
      const parsed = safeParseUrl(match[0]);
      if (!parsed) return undefined;
      return {
        target: parsed.hostname,
        port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
      };
    })
    .filter((candidate): candidate is BareTarget => candidate !== undefined);
  const acceptsMultipleBareTargets =
    call.name === "terminal.send" ||
    /\b(?:nmap|masscan|nuclei|nikto|ffuf|gobuster|dig|nslookup|ping|traceroute|tracepath)\b/i.test(command);
  const candidates = acceptsMultipleBareTargets ? bareTargets(command) : [];
  const distinct = new Map<string, BareTarget>();
  for (const candidate of [
    ...urlTargets,
    ...candidates,
    {
      target: primary.target,
      ...(primary.port !== undefined ? { port: primary.port } : {}),
    },
  ]) {
    const normalized = candidate.target.trim();
    if (!normalized) continue;
    const key = `${normalized}\u0000${candidate.port ?? ""}`;
    distinct.set(key, { ...candidate, target: normalized });
  }
  return [...distinct.values()].map((candidate) =>
    candidate.target === primary.target && candidate.port === primary.port
      ? primary
      : {
          ...primary,
          target: candidate.target,
          url: undefined,
          port: candidate.port,
          path: "/",
        },
  );
}
