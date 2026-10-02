import { basename, resolve } from "node:path";
import { readOnlyShellCommands } from "./patterns.js";
import { permissionShellSyntax, type PermissionWord } from "./shell-permission-words.js";

export interface FilesystemTarget {
  readonly path: string;
  readonly cwd: string;
  readonly dynamic: boolean;
  readonly homeExpansion?: boolean;
}

export interface ShellFilesystemEffects {
  readonly deletes: FilesystemTarget[];
  readonly writes: FilesystemTarget[];
  uncertainDelete: boolean;
  uncertainWrite: boolean;
  filesystemOnly: boolean;
}

const deleteCommands = new Set(["rm", "rmdir", "unlink", "del", "erase", "remove-item"]);
const writeCommands = new Set(["touch", "mkdir", "cp", "mv", "install", "tee", "truncate", "chmod", "chown", "chgrp"]);
const shells = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
const wrappers = new Set(["command", "exec", "env", "sudo", "nohup", "time", "stdbuf", "nice", "timeout"]);
const wrapperValueOptions = new Set(["-u", "--unset", "-g", "--group", "--user", "-i", "-o", "-e", "--input", "--output", "--error", "-n", "--adjustment", "-k", "--kill-after", "-s", "--signal"]);

function commandIndex(words: readonly PermissionWord[]): number {
  let index = 0;
  while (index < words.length) {
    while (/^[A-Za-z_]\w*=/.test(words[index]?.value ?? "")) index++;
    const command = basename(words[index]?.value ?? "").toLowerCase();
    if (!wrappers.has(command)) return index;
    index++;
    while (words[index]?.value.startsWith("-")) {
      const option = words[index++]!.value;
      if (option === "--") break;
      if (wrapperValueOptions.has(option)) index++;
    }
    if (command === "timeout") index++;
  }
  return index;
}

function operands(words: readonly PermissionWord[]): PermissionWord[] {
  const values: PermissionWord[] = [];
  let optionsEnded = false;
  for (const word of words) {
    if (!optionsEnded && word.value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.value.startsWith("-")) continue;
    values.push(word);
  }
  return values;
}

function target(word: PermissionWord, cwd: string): FilesystemTarget {
  return { path: word.value, cwd, dynamic: word.dynamic, ...(word.homeExpansion ? { homeExpansion: true } : {}) };
}

function mergeEffects(into: ShellFilesystemEffects, nested: ShellFilesystemEffects): void {
  into.deletes.push(...nested.deletes);
  into.writes.push(...nested.writes);
  into.uncertainDelete ||= nested.uncertainDelete;
  into.uncertainWrite ||= nested.uncertainWrite;
  into.filesystemOnly &&= nested.filesystemOnly;
}

function collectWriteTargets(command: string, args: readonly PermissionWord[], cwd: string, effects: ShellFilesystemEffects): void {
  const files = operands(args);
  let destinations = files;
  const directoryInstall = command === "install" && args.some(({ value }) => /^-[a-z]*d|^--directory$/.test(value));
  if ((command === "cp" || command === "mv" || command === "install") && !directoryInstall) destinations = files.slice(-1);
  if (command === "chmod" || command === "chown" || command === "chgrp") destinations = files.slice(1);
  effects.writes.push(...destinations.map((word) => target(word, cwd)));
  effects.uncertainWrite ||= destinations.length === 0 || args.some(({ dynamic, value }) => dynamic || /^-t|^--(?:target-directory|reference|size)(?:=|$)/.test(value));
}

function analyzeSegment(
  words: readonly PermissionWord[], cwd: string, effects: ShellFilesystemEffects, depth: number,
): void {
  const head = commandIndex(words);
  const command = basename(words[head]?.value ?? "").toLowerCase();
  const args = words.slice(head + 1);
  const files = operands(args);
  if (deleteCommands.has(command)) {
    effects.deletes.push(...files.map((word) => target(word, cwd)));
    effects.uncertainDelete ||= words[head]?.dynamic === true || files.length === 0 || args.some(({ dynamic }) => dynamic)
      || (command === "rmdir" && args.some(({ value }) => /^-[a-z]*p|^--parents$/.test(value)));
    return;
  }
  if (shells.has(command)) {
    const commandFlag = args.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word.value));
    const script = args[commandFlag + 1];
    if (commandFlag >= 0 && script && !script.dynamic && depth < 4) {
      mergeEffects(effects, shellFilesystemEffects(script.value, cwd, depth + 1));
      if (args.length > commandFlag + 2) effects.uncertainDelete ||= effects.deletes.length > 0;
    } else {
      effects.filesystemOnly = false;
      effects.uncertainDelete = true;
    }
    return;
  }
  if (command === "find") {
    const deleting = args.some(({ value }) => value === "-delete" || deleteCommands.has(basename(value)));
    if (deleting) {
      const roots = args.slice(0, args.findIndex(({ value }) => value.startsWith("-")));
      effects.deletes.push(...roots.map((word) => target(word, cwd)));
      effects.uncertainDelete ||= roots.length === 0 || args.some(({ value }) => value !== "-delete" && /^(?:-L|-exec|-execdir|-ok|-okdir)$/.test(value));
      return;
    }
  }
  if (command === "xargs" && args.some(({ value }) => deleteCommands.has(basename(value)))) {
    effects.uncertainDelete = true;
    return;
  }
  if (writeCommands.has(command)) {
    collectWriteTargets(command, args, cwd, effects);
    return;
  }
  if (command === "sed" && args.some(({ value }) => /^-i|^--in-place/.test(value))) {
    effects.writes.push(...files.slice(1).map((word) => target(word, cwd)));
    effects.uncertainWrite ||= files.length < 2;
    return;
  }
  const literalOutput = command === "echo" || command === "printf";
  if (words[head]?.dynamic || ["eval", "source", "."].includes(command)) effects.uncertainDelete = true;
  if (words.some(({ value, dynamic }) => dynamic && /\b(?:rm|unlink|rmdir)\b/.test(value))) effects.uncertainDelete = true;
  if (!literalOutput && args.some(({ value }) => deleteCommands.has(basename(value)) || /\b(?:rm|unlink|rmdir)\s/.test(value))) effects.uncertainDelete = true;
  if (!literalOutput && args.some(({ value }) => writeCommands.has(basename(value)))) effects.uncertainWrite = true;
  effects.filesystemOnly &&= literalOutput || command === "true" || readOnlyShellCommands.has(command);
}

export function shellFilesystemEffects(command: string, cwd: string, depth = 0): ShellFilesystemEffects {
  const effects: ShellFilesystemEffects = { deletes: [], writes: [], uncertainDelete: false, uncertainWrite: false, filesystemOnly: true };
  const syntax = permissionShellSyntax(command);
  let currentCwd = cwd;
  let uncertainCwd = false;
  for (const segment of syntax.segments) {
    const words = segment.words;
    const withoutRedirects: PermissionWord[] = [];
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      if (word.operator && [">", ">>", ">|", ">&"].includes(word.value)) {
        const destination = words[++i];
        if (destination && !/^\d+$/.test(destination.value) && destination.value !== "/dev/null") effects.writes.push(target(destination, currentCwd));
        else if (!destination) effects.uncertainWrite = true;
        continue;
      }
      if (word.operator && (word.value === "<" || word.value === "<&")) { i++; continue; }
      withoutRedirects.push(word);
    }
    const head = commandIndex(withoutRedirects);
    const base = basename(withoutRedirects[head]?.value ?? "").toLowerCase();
    if (base === "cd" || base === "pushd" || base === "popd") {
      const directory = withoutRedirects[head + 1];
      if (base === "cd" && directory && !directory.dynamic && withoutRedirects.length === head + 2 && !segment.piped && syntax.successChain) {
        currentCwd = resolve(currentCwd, directory.value);
      } else uncertainCwd = true;
      continue;
    }
    analyzeSegment(withoutRedirects, currentCwd, effects, depth);
    if (segment.piped && shells.has(base)) effects.uncertainDelete = true;
  }
  const changesEnvironment = /\b(?:env\s+[^;|]*(?:--(?:chdir|split-string)(?:=|\s)|-[A-Za-z]*[CS])|sudo\s+[^;|]*(?:--(?:chdir|chroot)(?:=|\s)|-[A-Za-z]*[DR]))/.test(command)
    || /\bCDPATH\s*=/.test(command)
    || syntax.segments.some(({ words }) => ["eval", "source", ".", "function"].includes(words[0]?.value ?? ""));
  if (syntax.uncertain || uncertainCwd || changesEnvironment) {
    effects.uncertainDelete ||= effects.deletes.length > 0 || /\b(?:rm|unlink|rmdir)\b/.test(command);
    effects.uncertainWrite ||= effects.writes.length > 0;
    effects.filesystemOnly = false;
  }
  return effects;
}
