import type { ToolCall } from "../../types.js";
import type { TaskWorkSignals } from "../task-evidence.js";
import {
  isDevServerCall,
  isFeatureImplementationCall,
  isPackageInstallCommand,
  isPortListeningOutput,
  isRemoteActiveTestCall,
  isRemoteReconToolCall,
  isScaffoldCreateCommand,
  isServerReadyOutput,
} from "../task-evidence.js";
import { localHttpProbeIsSuccess } from "../tool-call-parser.js";

const SOURCE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "fs.write",
  "fs.writeMany",
  "fs.edit",
  "fs.replaceLines",
  "fs.append",
]);

const isShellLaunch = (name: string): boolean =>
  name === "shell.exec" || name === "shell.start";

const mentionsLoopback = (call: ToolCall, command: string): boolean =>
  /\b(localhost|127\.0\.0\.1)\b/i.test(
    `${call.name} ${command} ${JSON.stringify(call.args)}`,
  );

export const readTaskWorkSignals = (
  call: ToolCall,
  output: string,
): TaskWorkSignals => {
  const command = typeof call.args.command === "string" ? call.args.command : "";
  const signals: TaskWorkSignals = {};
  if (isFeatureImplementationCall(call)) signals.featureWrite = true;
  if (SOURCE_WRITE_TOOLS.has(call.name)) signals.sourceWrite = true;
  if (isShellLaunch(call.name) && isPackageInstallCommand(command)) {
    signals.installOk = true;
  }
  if (isShellLaunch(call.name) && isScaffoldCreateCommand(command)) {
    signals.scaffoldOk = true;
  }
  if (isDevServerCall(call)) signals.devServerStart = true;
  if (
    (call.name === "shell.tail" || call.name === "shell.start") &&
    isServerReadyOutput(output)
  ) {
    signals.serverReady = true;
  }
  if (call.name === "shell.exec" && isPortListeningOutput(command, output)) {
    signals.portListening = true;
  }
  if (
    localHttpProbeIsSuccess(output) &&
    mentionsLoopback(call, command)
  ) {
    signals.localHttpProbeOk = true;
  }
  if (isRemoteReconToolCall(call)) signals.remoteReconOk = true;
  if (isRemoteActiveTestCall(call)) signals.remoteActiveTestOk = true;
  return signals;
};
