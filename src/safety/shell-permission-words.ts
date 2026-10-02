export interface PermissionWord {
  readonly value: string;
  readonly dynamic: boolean;
  readonly homeExpansion?: boolean;
  readonly operator?: boolean;
}

export interface PermissionSegment {
  readonly words: readonly PermissionWord[];
  readonly piped: boolean;
}

export interface PermissionSyntax {
  readonly segments: readonly PermissionSegment[];
  readonly uncertain: boolean;
  readonly successChain: boolean;
}

export function permissionShellSyntax(command: string): PermissionSyntax {
  const segments: PermissionSegment[] = [];
  let words: PermissionWord[] = [];
  let word = "";
  let started = false;
  let dynamic = false;
  let homeExpansion = false;
  let quote = "";
  let uncertain = false;
  let successChain = true;
  let piped = false;
  const pushWord = () => {
    if (started) words.push({ value: word, dynamic, ...(homeExpansion ? { homeExpansion: true } : {}) });
    word = "";
    started = false;
    dynamic = false;
    homeExpansion = false;
  };
  const pushSegment = (nextPiped: boolean) => {
    pushWord();
    if (words.length) segments.push({ words, piped });
    words = [];
    piped = nextPiped;
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    const next = command[i + 1];
    if (char === "\\" && quote !== "'") {
      started = true;
      if (next === undefined) uncertain = true;
      else if (next !== "\n") word += next;
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else {
        word += char;
        if (quote === '"' && (char === "$" || char === "`")) dynamic = true;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      started = true;
      quote = char;
      continue;
    }
    if (char === "#" && !started) {
      while (i < command.length && command[i] !== "\n") i++;
      successChain = false;
      pushSegment(false);
      continue;
    }
    if (char === ";" || char === "\n" || char === "|" || char === "&") {
      if (char !== "&" || next !== "&") successChain = false;
      pushSegment(char === "|" && next !== "|");
      if (next === char || (char === "|" && next === "&")) i++;
      continue;
    }
    if (/\s/.test(char)) {
      pushWord();
      continue;
    }
    if (char === ">" || char === "<") {
      pushWord();
      let operator = char;
      if (next === char || next === "&" || next === "|") operator += command[++i];
      if (char === "<" && operator === "<<") uncertain = true;
      words.push({ value: operator, dynamic: false, operator: true });
      continue;
    }
    if ("(){}".includes(char)) uncertain = true;
    if (char === "~" && !started) {
      homeExpansion = true;
      if (next && next !== "/" && !/\s/.test(next)) dynamic = true;
    }
    if (char === "$" || char === "`") dynamic = true;
    if ("*?[".includes(char)) dynamic = true;
    started = true;
    word += char;
  }
  if (quote) uncertain = true;
  pushSegment(false);
  return { segments, uncertain, successChain };
}
