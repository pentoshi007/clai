
export type BatchFailMatch = "any" | "all";

export interface BatchFailRule {
  readonly ifFailed: readonly string[];
  readonly cancel: readonly string[];
  readonly match: BatchFailMatch;
}

export type BatchFailMode =
  | { readonly kind: "continue" }
  | { readonly kind: "cancel_pending" }
  | { readonly kind: "rules"; readonly rules: readonly BatchFailRule[] };

export interface BatchCallFailMeta {
  readonly id: string;
  readonly name: string;
  readonly index1: number;
  readonly cancelOnFail: readonly string[];
}

function asStringArray(value: unknown, field: string): string[] {
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) {
      throw new Error(`tool.batch ${field} must not be empty`);
    }
    return [t];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `tool.batch ${field} must be a string or array of strings`,
    );
  }
  if (value.length === 0) {
    throw new Error(`tool.batch ${field} must not be empty`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(
        `tool.batch ${field}[${i}] must be a non-empty string`,
      );
    }
    return entry.trim();
  });
}

function pickOnFailRaw(args: Record<string, unknown>): unknown {
  if ("on_fail" in args) return args.on_fail;
  if ("onFail" in args) return args.onFail;
  if ("fail_policy" in args) return args.fail_policy;
  if ("failPolicy" in args) return args.failPolicy;
  return undefined;
}

function normalizeModeString(raw: string): BatchFailMode["kind"] | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (
    key === "continue" ||
    key === "none" ||
    key === "never" ||
    key === "keep_going"
  ) {
    return "continue";
  }
  if (
    key === "cancel_pending" ||
    key === "cancel_rest" ||
    key === "fail_fast" ||
    key === "cancel_all" ||
    key === "stop"
  ) {
    return "cancel_pending";
  }
  return null;
}

function parseRulesArray(
  rulesRaw: unknown,
  knownIds: ReadonlySet<string>,
): BatchFailRule[] {
  if (!Array.isArray(rulesRaw)) {
    throw new Error(
      'tool.batch on_fail.rules must be an array of { if_failed, cancel }',
    );
  }
  if (rulesRaw.length === 0) {
    throw new Error("tool.batch on_fail.rules must not be empty");
  }
  return rulesRaw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `tool.batch on_fail.rules[${index}] must be an object`,
      );
    }
    const rec = entry as Record<string, unknown>;
    const ifRaw =
      rec.if_failed ?? rec.ifFailed ?? rec.when ?? rec.if;
    const cancelRaw = rec.cancel ?? rec.cancel_ids ?? rec.cancelIds;
    if (ifRaw === undefined) {
      throw new Error(
        `tool.batch on_fail.rules[${index}] requires if_failed`,
      );
    }
    if (cancelRaw === undefined) {
      throw new Error(
        `tool.batch on_fail.rules[${index}] requires cancel`,
      );
    }
    const ifFailed = asStringArray(ifRaw, `on_fail.rules[${index}].if_failed`);
    const cancel = asStringArray(cancelRaw, `on_fail.rules[${index}].cancel`);
    let match: BatchFailMatch = "any";
    const matchRaw = rec.match ?? rec.require;
    if (matchRaw !== undefined) {
      if (matchRaw !== "any" && matchRaw !== "all") {
        throw new Error(
          `tool.batch on_fail.rules[${index}].match must be "any" or "all"`,
        );
      }
      match = matchRaw;
    }
    for (const id of ifFailed) {
      if (!knownIds.has(id)) {
        throw new Error(
          `tool.batch on_fail.rules[${index}] if_failed references unknown id "${id}"`,
        );
      }
    }
    for (const id of cancel) {
      if (!knownIds.has(id)) {
        throw new Error(
          `tool.batch on_fail.rules[${index}] cancel references unknown id "${id}"`,
        );
      }
    }
    return { ifFailed, cancel, match };
  });
}

export function parseBatchFailPolicy(
  args: Record<string, unknown>,
  knownIds: ReadonlySet<string>,
): BatchFailMode {
  const raw = pickOnFailRaw(args);
  if (raw === undefined || raw === null) {
    return { kind: "continue" };
  }
  if (typeof raw === "string") {
    const kind = normalizeModeString(raw);
    if (!kind) {
      throw new Error(
        `tool.batch on_fail must be "continue", "cancel_pending", or { rules: [...] } (got "${raw}")`,
      );
    }
    return kind === "continue"
      ? { kind: "continue" }
      : { kind: "cancel_pending" };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    if (
      rec.if_failed !== undefined ||
      rec.ifFailed !== undefined ||
      rec.when !== undefined
    ) {
      const rules = parseRulesArray([rec], knownIds);
      return { kind: "rules", rules };
    }
    if (rec.rules !== undefined) {
      return { kind: "rules", rules: parseRulesArray(rec.rules, knownIds) };
    }
    if (typeof rec.mode === "string") {
      const kind = normalizeModeString(rec.mode);
      if (!kind) {
        throw new Error(
          `tool.batch on_fail.mode must be "continue" or "cancel_pending" (got "${rec.mode}")`,
        );
      }
      if (kind === "rules") {
      }
      return kind === "continue"
        ? { kind: "continue" }
        : { kind: "cancel_pending" };
    }
    throw new Error(
      'tool.batch on_fail object must be { rules: [...] }, { if_failed, cancel }, or { mode: "continue"|"cancel_pending" }',
    );
  }
  throw new Error(
    'tool.batch on_fail must be "continue", "cancel_pending", or an object with rules',
  );
}

export function compileBatchFailMode(
  topLevel: BatchFailMode,
  calls: readonly BatchCallFailMeta[],
  knownIds: ReadonlySet<string>,
): BatchFailMode {
  const fromCalls: BatchFailRule[] = [];
  for (const call of calls) {
    for (const target of call.cancelOnFail) {
      if (!knownIds.has(target)) {
        throw new Error(
          `tool.batch call id="${call.id}" cancel_on_fail references unknown id "${target}"`,
        );
      }
    }
    if (call.cancelOnFail.length > 0) {
      fromCalls.push({
        ifFailed: [call.id],
        cancel: call.cancelOnFail,
        match: "any",
      });
    }
  }

  if (topLevel.kind === "cancel_pending") {
    return topLevel;
  }

  const topRules = topLevel.kind === "rules" ? [...topLevel.rules] : [];
  const rules = [...topRules, ...fromCalls];
  if (rules.length === 0) {
    return { kind: "continue" };
  }
  return { kind: "rules", rules };
}

export function evaluateCancelTargets(
  mode: BatchFailMode,
  failedIds: ReadonlySet<string>,
  allIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  if (failedIds.size === 0) return out;

  if (mode.kind === "continue") {
    return out;
  }

  if (mode.kind === "cancel_pending") {
    for (const id of allIds) {
      if (!failedIds.has(id)) out.add(id);
    }
    return out;
  }

  for (const rule of mode.rules) {
    const hit =
      rule.match === "all"
        ? rule.ifFailed.every((id) => failedIds.has(id))
        : rule.ifFailed.some((id) => failedIds.has(id));
    if (!hit) continue;
    for (const id of rule.cancel) {
      if (!failedIds.has(id)) out.add(id);
    }
  }
  return out;
}

export function formatBatchCancelReason(
  triggerIds: readonly string[],
  metaById: ReadonlyMap<string, BatchCallFailMeta>,
): string {
  if (triggerIds.length === 0) {
    return "Cancelled — not run because a sibling call failed";
  }
  const parts = triggerIds.map((id) => {
    const meta = metaById.get(id);
    if (!meta) return id;
    return `#${meta.index1} ${meta.name}`;
  });
  if (parts.length === 1) {
    return `Cancelled — not run because ${parts[0]} failed`;
  }
  if (parts.length === 2) {
    return `Cancelled — not run because ${parts[0]} and ${parts[1]} failed`;
  }
  const last = parts[parts.length - 1];
  const head = parts.slice(0, -1).join(", ");
  return `Cancelled — not run because ${head}, and ${last} failed`;
}

export function parseCancelOnFailField(
  entry: Record<string, unknown>,
  callLabel: string,
): string[] {
  const raw = entry.cancel_on_fail ?? entry.cancelOnFail;
  if (raw === undefined || raw === null) return [];
  return asStringArray(raw, `${callLabel}.cancel_on_fail`);
}

export function resolveBatchCallId(
  entry: Record<string, unknown>,
  index0: number,
  seen: Set<string>,
): string {
  const raw = entry.id;
  let id: string;
  if (raw === undefined || raw === null) {
    id = String(index0 + 1);
  } else if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(
      `tool.batch call #${index0} id must be a non-empty string when provided`,
    );
  } else {
    id = raw.trim();
  }
  if (seen.has(id)) {
    throw new Error(
      `tool.batch duplicate call id "${id}" — ids must be unique within a batch`,
    );
  }
  seen.add(id);
  return id;
}
