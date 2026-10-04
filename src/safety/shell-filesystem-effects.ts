import { resolve } from "node:path";
import { readOnlyShellCommands } from "./patterns.js";
import {
  commandIndex,
  commandName,
  deleteCommands,
  delegatedCommandWords,
  embeddedCommandTexts,
  invokesDeleteCommand,
  wordsInvokeCommand,
} from "./shell-command-words.js";
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

const writeCommands = new Set(["touch", "mkdir", "cp", "mv", "install", "tee", "truncate", "chmod", "chown", "chgrp"]);
const shells = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
const gitValueOptions = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);
const gitRelocatingOptions = /^(?:-C|--git-dir|--work-tree)(?:=|$)/;
const gitNonDestructiveRemoval = /^(?:--cached|--dry-run|-[a-z]*n[a-z]*)$/;

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

function gitSubcommandIndex(args: readonly PermissionWord[]): number {
  let index = 0;
  while (index < args.length && args[index]!.value.startsWith("-")) {
    index += gitValueOptions.has(args[index]!.value) ? 2 : 1;
  }
  return index < args.length ? index : -1;
}

function recordGitRemoval(args: readonly PermissionWord[], cwd: string, effects: ShellFilesystemEffects): boolean {
  const subcommand = gitSubcommandIndex(args);
  if (subcommand < 0 || args[subcommand]!.value !== "rm") return false;
  const removalArgs = args.slice(subcommand + 1);
  if (removalArgs.some(({ value }) => gitNonDestructiveRemoval.test(value))) return true;
  recordDeletion("rm", args.slice(0, subcommand), removalArgs, cwd, effects);
  effects.uncertainDelete ||= args.slice(0, subcommand).some(({ value }) => gitRelocatingOptions.test(value));
  return true;
}

function recordDeletion(
  command: string, head: readonly PermissionWord[], args: readonly PermissionWord[], cwd: string, effects: ShellFilesystemEffects,
): void {
  const files = operands(args);
  effects.deletes.push(...files.map((word) => target(word, cwd)));
  effects.uncertainDelete ||= head.some(({ dynamic }) => dynamic) || files.length === 0 || args.some(({ dynamic }) => dynamic)
    || (command === "rmdir" && args.some(({ value }) => /^-[a-z]*p|^--parents$/.test(value)));
}

function analyzeSegment(
  words: readonly PermissionWord[], cwd: string, effects: ShellFilesystemEffects, depth: number,
): void {
  const head = commandIndex(words);
  const command = commandName(words[head]);
  const args = words.slice(head + 1);
  if (deleteCommands.has(command)) {
    recordDeletion(command, words.slice(head, head + 1), args, cwd, effects);
    return;
  }
  if (command === "git" && recordGitRemoval(args, cwd, effects)) return;
  const files = operands(args);
  const delegated = delegatedCommandWords(command, args);
  const delegatedDeletion = delegated.some((nested) => wordsInvokeCommand(nested, deleteCommands));
  if (command === "xargs" && delegatedDeletion) {
    effects.uncertainDelete = true;
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
    const deleting = delegatedDeletion || args.some(({ value }) => value === "-delete");
    if (deleting) {
      const roots = args.slice(0, args.findIndex(({ value }) => value.startsWith("-")));
      effects.deletes.push(...roots.map((word) => target(word, cwd)));
      effects.uncertainDelete ||= roots.length === 0 || args.some(({ value }) => value !== "-delete" && /^(?:-L|-exec|-execdir|-ok|-okdir)$/.test(value));
      return;
    }
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
  if (words.some(({ value, dynamic }) => dynamic && invokesDeleteCommand(value))) effects.uncertainDelete = true;
  if (embeddedCommandTexts(command, args).some(invokesDeleteCommand)) effects.uncertainDelete = true;
  if (delegated.some((nested) => wordsInvokeCommand(nested, writeCommands))) effects.uncertainWrite = true;
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
    const base = commandName(withoutRedirects[head]);
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
    effects.uncertainDelete ||= effects.deletes.length > 0 || invokesDeleteCommand(command);
    effects.uncertainWrite ||= effects.writes.length > 0;
    effects.filesystemOnly = false;
  }
  return effects;
}
