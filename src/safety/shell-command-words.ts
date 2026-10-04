import { basename } from "node:path";

export interface CommandWord {
  readonly value: string;
}

export const deleteCommands: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "unlink",
  "del",
  "erase",
  "remove-item",
]);

const MAX_NESTING = 4;

const wrapperCommands: ReadonlySet<string> = new Set([
  "command",
  "exec",
  "env",
  "sudo",
  "doas",
  "nohup",
  "time",
  "stdbuf",
  "nice",
  "timeout",
  "busybox",
  "setsid",
  "ionice",
]);

const controlKeywords: ReadonlySet<string> = new Set([
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "!",
  "{",
]);

const wrapperValueOptions: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0", "-P"]),
  sudo: new Set([
    "-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-R", "--chroot",
    "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-T", "--command-timeout",
    "-U", "--other-user",
  ]),
  doas: new Set(["-u", "-C"]),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-k", "--kill-after", "-s", "--signal"]),
  stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
  exec: new Set(["-a"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"]),
};

const xargsValueOptions: ReadonlySet<string> = new Set([
  "-I",
  "-n",
  "-P",
  "-d",
  "-s",
  "-L",
  "-E",
  "-a",
  "--max-args",
  "--max-procs",
  "--max-chars",
  "--max-lines",
  "--delimiter",
  "--arg-file",
  "--eof",
]);

const findExecPrimaries: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

const remoteExecutors: ReadonlySet<string> = new Set(["ssh"]);

const containerExecutors: Readonly<Record<string, ReadonlySet<string>>> = {
  docker: new Set(["exec", "run"]),
  podman: new Set(["exec", "run"]),
  nerdctl: new Set(["exec", "run"]),
  kubectl: new Set(["exec"]),
  oc: new Set(["exec", "rsh"]),
};

const inlineCodeInterpreters =
  /^(?:python[\d.]*|pypy[\d.]*|node(?:js)?|deno|bun|ruby|perl|php|lua(?:jit)?[\d.]*|rscript|julia|osascript|pwsh|powershell|tclsh|fish|nu|sh|bash|dash|zsh|ksh|ash|su)$/;

const inlineCodeFlag = /^(?:-[A-Za-z]*[ceErp]|--(?:eval|print|command|execute)|-command)$/i;

const commandLookupFlag = /^-[A-Za-z]*[vV]/;

export function commandName(word: CommandWord | undefined): string {
  return basename(word?.value ?? "").toLowerCase();
}

export function commandIndex(words: readonly CommandWord[]): number {
  let index = 0;
  while (index < words.length) {
    while (/^[A-Za-z_]\w*=/.test(words[index]?.value ?? "")) index++;
    if (controlKeywords.has(words[index]?.value ?? "")) {
      index++;
      continue;
    }
    const command = commandName(words[index]);
    if (!wrapperCommands.has(command)) return index;
    index++;
    let lookupOnly = false;
    const valueOptions = wrapperValueOptions[command];
    while (words[index]?.value.startsWith("-")) {
      const option = words[index++]!.value;
      if (option === "--") break;
      if (command === "command" && commandLookupFlag.test(option)) lookupOnly = true;
      if (valueOptions?.has(option)) index++;
    }
    if (lookupOnly) return words.length;
    if (command === "timeout") index++;
  }
  return index;
}

function xargsCommandWords<T extends CommandWord>(args: readonly T[]): T[] {
  let index = 0;
  while (index < args.length) {
    const value = args[index]!.value;
    if (value === "--") {
      index++;
      break;
    }
    if (!value.startsWith("-")) break;
    index += xargsValueOptions.has(value) ? 2 : 1;
  }
  return args.slice(index);
}

function findExecutionWords<T extends CommandWord>(args: readonly T[]): T[][] {
  const executions: T[][] = [];
  for (let index = 0; index < args.length; index++) {
    if (!findExecPrimaries.has(args[index]!.value)) continue;
    const execution: T[] = [];
    for (index++; index < args.length; index++) {
      const value = args[index]!.value;
      if (value === ";" || value === "+") break;
      execution.push(args[index]!);
    }
    executions.push(execution);
  }
  return executions;
}

export function delegatedCommandWords<T extends CommandWord>(
  command: string,
  args: readonly T[],
): T[][] {
  if (command === "xargs") return [xargsCommandWords(args)];
  if (command === "find") return findExecutionWords(args);
  return [];
}

export function embeddedCommandTexts(command: string, args: readonly CommandWord[]): string[] {
  if (remoteExecutors.has(command)) return args.map(({ value }) => value);
  const verbs = containerExecutors[command];
  if (verbs) {
    const verb = args.findIndex(({ value }) => verbs.has(value));
    return verb < 0 ? [] : args.slice(verb + 1).map(({ value }) => value);
  }
  if (!inlineCodeInterpreters.test(command)) return [];
  const code: string[] = [];
  args.forEach(({ value }, index) => {
    const next = args[index + 1];
    if (next && inlineCodeFlag.test(value)) code.push(next.value);
  });
  return code;
}

function scanSegments(text: string): CommandWord[][] {
  return text
    .split(/[;&|()`'"\r\n]+/)
    .map((segment) => segment.split(/\s+/).filter(Boolean).map((value) => ({ value })))
    .filter((words) => words.length > 0);
}

export function wordsInvokeCommand(
  words: readonly CommandWord[],
  commands: ReadonlySet<string>,
  depth = 0,
): boolean {
  const head = commandIndex(words);
  const command = commandName(words[head]);
  if (commands.has(command)) return true;
  if (depth >= MAX_NESTING) return false;
  const args = words.slice(head + 1);
  return (
    delegatedCommandWords(command, args).some((nested) =>
      wordsInvokeCommand(nested, commands, depth + 1),
    ) ||
    embeddedCommandTexts(command, args).some((text) =>
      textInvokesCommand(text, commands, depth + 1),
    )
  );
}

export function textInvokesCommand(
  text: string,
  commands: ReadonlySet<string>,
  depth = 0,
): boolean {
  return scanSegments(text).some((words) => wordsInvokeCommand(words, commands, depth));
}

export function invokesDeleteCommand(text: string): boolean {
  return textInvokesCommand(text, deleteCommands);
}
