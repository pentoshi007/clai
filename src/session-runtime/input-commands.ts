export type RuntimeInputCommand = "claim-input";

const commands = new Map<string, RuntimeInputCommand>();
commands.set("\x1d", "claim-input");
for (const [code, command] of [[93, "claim-input"]] as const) {
  for (const event of ["", ":1", ":2"]) commands.set(`\x1b[${code};5${event}u`, command);
  commands.set(`\x1b[27;5;${code}~`, command);
}

export function runtimeInputCommand(input: string): RuntimeInputCommand | undefined {
  return commands.get(input);
}
