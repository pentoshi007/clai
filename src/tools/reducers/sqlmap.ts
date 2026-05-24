import type { Reducer, ReducerOutput } from "./types.js";

const INJECTABLE_RE = /Parameter:\s*([^\s(]+)\s*\(([^)]+)\)/g;
const DBMS_RE = /back-end DBMS:\s*(.+)/i;
const PAYLOAD_RE = /Payload:\s*(.+)/g;

export const sqlmapReducer: Reducer = (raw): ReducerOutput => {
  const injectables: Array<{ parameter: string; place: string }> = [];
  let dbms: string | undefined;
  const payloads: string[] = [];
  for (const match of raw.matchAll(INJECTABLE_RE)) {
    injectables.push({ parameter: match[1]!, place: match[2]! });
  }
  const dbmsMatch = DBMS_RE.exec(raw);
  if (dbmsMatch) dbms = dbmsMatch[1]!.trim();
  for (const match of raw.matchAll(PAYLOAD_RE)) {
    payloads.push(match[1]!.trim());
    if (payloads.length >= 5) break;
  }
  if (injectables.length === 0 && !dbms) {
    return { summary: "# sqlmap — no injectable parameters or DBMS detected" };
  }
  const lines: string[] = [
    `# sqlmap reduced summary — ${injectables.length} injectable parameter(s)${dbms ? `, DBMS=${dbms}` : ""}`,
  ];
  for (const inj of injectables) {
    lines.push(`- ${inj.parameter} (${inj.place})`);
  }
  if (payloads.length > 0) {
    lines.push("");
    lines.push("## Sample payloads");
    for (const payload of payloads) lines.push(`- ${payload}`);
  }
  return {
    summary: lines.join("\n"),
    findings: { injectables, dbms, samplePayloads: payloads },
  };
};
