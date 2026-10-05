export type RuntimeInputCommand = "claim-input" | "detach";

const commands = new Map<string, RuntimeInputCommand>();
commands.set("\x1d", "claim-input");
commands.set("\x03", "detach");
for (const [code, command] of [[93, "claim-input"], [99, "detach"], [67, "detach"]] as const) {
  for (const event of ["", ":1", ":2"]) commands.set(`\x1b[${code};5${event}u`, command);
  commands.set(`\x1b[27;5;${code}~`, command);
}

export function runtimeInputCommand(input: string): RuntimeInputCommand | undefined {
  return commands.get(input);
}

export function pendingRuntimeInputCommand(input: string): boolean {
  if (!input) return false;
  for (const command of commands.keys()) {
    if (command.startsWith(input) && command !== input) return true;
  }
  return false;
}
