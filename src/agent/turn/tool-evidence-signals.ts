import type { ToolCall } from "../../types.js";
import {
  isEvidenceWorkTool,
  isFeatureImplementationCall,
  isPortListeningOutput,
  isScaffoldCreateCommand,
  isServerReadyOutput,
} from "../task-evidence.js";
import {
  localHttpProbeIsFailure,
  localHttpProbeIsSuccess,
} from "../tool-call-parser.js";

const MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "fs.edit",
  "fs.write",
  "fs.writeMany",
  "fs.replaceLines",
  "fs.append",
]);

const PROBE_TOOLS: ReadonlySet<string> = new Set([
  "http.fetch",
  "web.fetch",
  "shell.exec",
]);

const PENTEST_TOOLS: ReadonlySet<string> = new Set([
  "http.fetch",
  "shell.exec",
  "net.scan",
  "pentest.recon",
]);

const ACTIVE_PENTEST_PATTERN =
  /\b(sqlmap|hydra|nikto|nuclei|ffuf|gobuster|exploit|payload|idor|xss|union\s+select)\b/i;

const LOCAL_URL_PATTERN =
  /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i;

const LOCAL_CURL_PATTERN =
  /\bcurl\b[\s\S]*\b(?:localhost|127\.0\.0\.1|\[::1\])\b/i;

const INSTALL_PATTERN = /\b(?:npm|pnpm|yarn|bun)\s+i(?:nstall)?\b/i;

export interface ToolEvidenceInput {
  readonly call: ToolCall;
  readonly ok: boolean;
  readonly output: string;
  readonly pentestTurn: boolean;
  readonly activeProjectRoot: string | undefined;
}

export type LocalProbeOutcome =
  | "none"
  | "success"
  | "softSuccess"
  | "failure";

export interface ToolEvidenceSignals {
  readonly mutationLanded: boolean;
  readonly freshProbeFailure: boolean;
  readonly evidenceWorkTool: boolean;
  readonly serverStarted: boolean;
  readonly serverTailed: boolean;
  readonly activePentestTest: boolean;
  readonly localProbe: LocalProbeOutcome;
  readonly scaffoldCreated: boolean;
  readonly featureWrite: boolean;
  readonly localAppMaterialWork: boolean;
}

const stringArg = (call: ToolCall, key: string): string =>
  typeof call.args[key] === "string" ? (call.args[key] as string) : "";

const serverSignals = (
  input: ToolEvidenceInput,
): { started: boolean; tailed: boolean } => {
  if (!input.ok) return { started: false, tailed: false };
  if (input.call.name === "shell.start") return { started: true, tailed: false };
  if (input.call.name === "shell.tail") {
    return { started: isServerReadyOutput(input.output), tailed: true };
  }
  if (
    input.call.name === "shell.exec" &&
    isPortListeningOutput(stringArg(input.call, "command"), input.output)
  ) {
    return { started: true, tailed: false };
  }
  return { started: false, tailed: false };
};

const isActivePentestTest = (input: ToolEvidenceInput): boolean => {
  if (!input.ok || !input.pentestTurn) return false;
  if (!PENTEST_TOOLS.has(input.call.name)) return false;
  const blob = `${input.call.name} ${JSON.stringify(input.call.args)}`;
  if (ACTIVE_PENTEST_PATTERN.test(blob)) return true;
  const method = input.call.args.method;
  return (
    input.call.name === "http.fetch" &&
    typeof method === "string" &&
    !/^get$/i.test(method)
  );
};

const targetsLocalHttp = (call: ToolCall): boolean => {
  if (call.name === "http.fetch") {
    return LOCAL_URL_PATTERN.test(stringArg(call, "url"));
  }
  return (
    call.name === "shell.exec" &&
    LOCAL_CURL_PATTERN.test(stringArg(call, "command"))
  );
};

const localProbeOutcome = (input: ToolEvidenceInput): LocalProbeOutcome => {
  if (!input.ok || !targetsLocalHttp(input.call)) return "none";
  if (localHttpProbeIsFailure(input.output)) return "failure";
  if (localHttpProbeIsSuccess(input.output)) return "success";
  return input.call.name === "shell.exec" ? "softSuccess" : "none";
};

const materializesLocalApp = (
  input: ToolEvidenceInput,
  command: string,
): boolean => {
  if (INSTALL_PATTERN.test(command)) return true;
  if (
    input.call.name === "fs.write" ||
    input.call.name === "fs.writeMany" ||
    input.call.name === "fs.edit"
  ) {
    return true;
  }
  const pathArg = stringArg(input.call, "path");
  if (!pathArg || !input.activeProjectRoot) return false;
  return pathArg.includes(input.activeProjectRoot) || !pathArg.startsWith("/");
};

export const readToolEvidenceSignals = (
  input: ToolEvidenceInput,
): ToolEvidenceSignals => {
  const server = serverSignals(input);
  const command = input.ok ? stringArg(input.call, "command") : "";
  const scaffoldCreated = input.ok && isScaffoldCreateCommand(command);
  const featureWrite = input.ok && isFeatureImplementationCall(input.call);
  return {
    mutationLanded: input.ok && MUTATION_TOOLS.has(input.call.name),
    freshProbeFailure:
      PROBE_TOOLS.has(input.call.name) && localHttpProbeIsFailure(input.output),
    evidenceWorkTool: input.ok && isEvidenceWorkTool(input.call.name),
    serverStarted: server.started,
    serverTailed: server.tailed,
    activePentestTest: isActivePentestTest(input),
    localProbe: localProbeOutcome(input),
    scaffoldCreated,
    featureWrite,
    localAppMaterialWork:
      input.ok &&
      (scaffoldCreated || featureWrite || materializesLocalApp(input, command)),
  };
};
