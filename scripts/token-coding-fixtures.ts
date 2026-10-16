import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TokenFixture } from "./token-overhead-fixtures.js";
import { isFixtureTestExecution, terminalTranscriptIsCursorSafe, type FixtureEvidence } from "./token-fixture-evidence.js";

const hasOutput = (evidence: FixtureEvidence, name: string, text: string): boolean =>
  evidence.executions.some((entry) => entry.name === name && entry.result.ok && entry.result.output.includes(text));

export const codingFixtures: TokenFixture[] = [
  {
    name: "persistent-feature-natural", scenarios: ["C05"], mutableFiles: ["notes.mjs"],
    files: {
      "notes.mjs": "import { readFile, writeFile } from 'node:fs/promises';\nexport async function loadNotes(path) { return JSON.parse(await readFile(path, 'utf8')); }\nexport async function saveNotes(path, notes) { await writeFile(path, JSON.stringify(notes)); }\n",
      "notes.test.mjs": "import {test} from 'node:test'; import {strict as assert} from 'node:assert'; import {mkdtemp,rm} from 'node:fs/promises'; import {tmpdir} from 'node:os'; import {join} from 'node:path'; import {loadNotes,saveNotes} from './notes.mjs'; test('new and reloaded notes',async()=>{ const root=await mkdtemp(join(tmpdir(),'notes-')); try { const path=join(root,'state.json'); assert.deepEqual(await loadNotes(path),[]); await saveNotes(path,['hello']); assert.deepEqual(await loadNotes(path),['hello']); } finally { await rm(root,{recursive:true,force:true}); }});\n",
    },
    prompts: ["Finish the existing notes persistence module, without re-scaffolding or adding dependencies. Missing files mean an empty list; saves and reloads preserve nonempty string notes including Unicode. Reject malformed JSON, non-array data, and empty or non-string notes; propagate other I/O errors. Reproduce the existing failure and verify the feature and error paths."],
    hiddenAssertions: "import {strict as assert} from 'node:assert'; import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'; import {tmpdir} from 'node:os'; import {join} from 'node:path'; import {loadNotes,saveNotes} from './notes.mjs'; const root=await mkdtemp(join(tmpdir(),'hidden-notes-')); try { const path=join(root,'state.json'); assert.deepEqual(await loadNotes(path),[]); const notes=['界','🙂','valid']; await saveNotes(path,notes); assert.deepEqual(await loadNotes(path),notes); assert.deepEqual(notes,['界','🙂','valid']); for(const invalid of ['[null]','{}','[1]','[\"\"]','broken']) { await writeFile(path,invalid); await assert.rejects(()=>loadNotes(path)); } for(const invalid of [null,{},[1],[''],['ok',null]]) await assert.rejects(()=>saveNotes(path,invalid)); await mkdir(join(root,'directory')); await assert.rejects(()=>loadNotes(join(root,'directory'))); await assert.rejects(()=>saveNotes(join(root,'missing','state.json'),['ok'])); } finally { await rm(root,{recursive:true,force:true}); }",
    verify: async (_root, _answer, evidence) => Boolean(evidence && evidence.executions.some((entry) => isFixtureTestExecution(entry) && entry.result.ok)),
  },
  {
    name: "unicode-stale-edit-natural", scenarios: ["C03"], mutableFiles: ["settings.mjs"],
    files: { "settings.mjs": "export const label = '界🙂';\r\nexport const attempts = 2;\r\n", "stale.txt": "Old implementation: export const attempts = 1;\n" },
    prompts: ["Change the actual attempts value in settings.mjs to 3. The stale.txt note is outdated; inspect the real file before editing, preserve its Unicode and exact CRLF bytes, and verify. Do not change the note."],
    verify: async (root, _answer, evidence) => await readFile(join(root, "settings.mjs"), "utf8") === "export const label = '界🙂';\r\nexport const attempts = 3;\r\n" &&
      Boolean(evidence?.executions.some((entry) => entry.result.ok &&
        ((entry.name === "fs.read" && entry.result.output.includes("attempts = 2")) ||
          (entry.name === "shell.exec" && /\bod\s+-An\s+-tx1\s+-c\s+settings\.mjs\b/.test(String(entry.args.command)) && /32\s+3b\s+0d\s+0a/i.test(entry.result.output))))),
  },
  {
    name: "partial-read-natural", scenarios: ["C06", "C10"], mutableFiles: [], readOnlyTurns: [0],
    files: { "alpha.json": "{\"port\":4123}\n", "beta.json": "{\"port\":5124}\n" },
    prompts: ["Inspect these three known files together: alpha.json, missing.json and beta.json. Report the two configured ports and honestly identify any missing file. Keep the successful evidence when one file is missing; don't repeat successful reads or change anything."],
    verify: async (_root, answer, evidence) => {
      if (!evidence || !answer.includes("4123") || !answer.includes("5124") || !/missing\.json[\s\S]*(?:missing|not found|exist)|(?:missing|not found)[\s\S]*missing\.json/i.test(answer)) return false;
      const reads = evidence.executions.filter((entry) => entry.name === "fs.read");
      return reads.length === 1 && Array.isArray(reads[0]!.args.files) &&
        ["4123", "5124", "missing.json"].every((value) => reads[0]!.result.output.includes(value));
    },
  },
  {
    name: "roadmap-continuation-natural", scenarios: ["C09"], mutableFiles: ["first.mjs", "second.mjs", "combined.mjs"],
    files: {
      "ROADMAP.md": "# All phases\n1. first(n) doubles n, preserving zero and negatives.\n2. second(n) adds three to n.\n3. combined(n) composes second(first(n)). Verify every phase.\n",
      "first.mjs": "export const first = n => n;\n", "second.mjs": "export const second = n => n;\n",
      "combined.mjs": "import {first} from './first.mjs'; import {second} from './second.mjs'; export const combined = n => n;\n",
    },
    prompts: ["Read ROADMAP.md and implement only phase 1. Verify it, retain the remaining criteria, and do not implement phases 2 or 3 yet.", "Continue: now complete every remaining phase in ROADMAP.md without stopping at another checkpoint or repeating phase 1. Verify all acceptance criteria."],
    turnAssertions: ["import {strict as assert} from 'node:assert'; import {first} from './first.mjs'; import {second} from './second.mjs'; import {combined} from './combined.mjs'; assert.equal(first(7),14); assert.equal(second(7),7); assert.equal(combined(7),7);"],
    hiddenAssertions: "import {strict as assert} from 'node:assert'; import {first} from './first.mjs'; import {second} from './second.mjs'; import {combined} from './combined.mjs'; for(const n of [-9,0,0.5,17]) { assert.equal(first(n),n*2); assert.equal(second(n),n+3); assert.equal(combined(n),n*2+3); }",
    verify: async (_root, _answer, evidence) => Boolean(evidence && !evidence.executions.some((entry) => entry.turn > 0 && entry.result.fileChanges?.some((change) => change.path.endsWith("first.mjs")))),
  },
  {
    name: "finite-foreground-natural", scenarios: ["C07"], mutableFiles: [],
    files: { "check.mjs": "console.log('FOREGROUND_CHECK: 73');\n" },
    prompts: ["Run the small finite check in check.mjs, wait for the actual result and report its exact marker. Do not launch a service or change files."],
    verify: async (_root, answer, evidence) => Boolean(evidence && /FOREGROUND_CHECK:\s*73/.test(answer) &&
      evidence.executions.filter((entry) => entry.name === "shell.exec").length === 1 &&
      evidence.executions.some((entry) => entry.name === "shell.exec" && entry.result.ok && !entry.result.backgroundJob && entry.result.output.includes("FOREGROUND_CHECK: 73"))),
  },
  {
    name: "persistent-server-natural", scenarios: ["C07"], mutableFiles: [],
    files: { "server.mjs": "import {createServer} from 'node:http'; const server=createServer((_req,res)=>{res.setHeader('content-type','text/plain');res.end('SERVER_CHECK: 91');}); server.listen(0,'127.0.0.1',()=>console.log('READY_URL: http://127.0.0.1:'+server.address().port));\n" },
    prompts: ["Start the existing server.mjs as one tracked persistent background service. Observe its ready URL, actually request it and verify SERVER_CHECK: 91, then stop that same owned service and verify termination. Do not wait for a persistent server to exit on its own or launch duplicates."],
    verify: async (_root, answer, evidence) => {
      if (!evidence || !/SERVER_CHECK:\s*91/.test(answer)) return false;
      const launches = evidence.executions.filter((entry) => entry.name === "shell.exec" && entry.result.backgroundJob);
      if (launches.length !== 1 || launches[0]!.args.background !== "always" || launches[0]!.args.responder === true) return false;
      const id = launches[0]!.result.backgroundJob!.id;
      return evidence.executions.some((entry) => entry.name === "shell.tail" && entry.args.id === id && entry.result.ok && entry.result.output.includes("READY_URL:")) &&
        evidence.executions.some((entry) => entry.name === "shell.stop" && entry.args.id === id && entry.result.ok && ["exited", "killed"].includes(entry.job?.status ?? "")) &&
        evidence.executions.some((entry) => entry.result.ok && entry.result.output.includes("SERVER_CHECK: 91") &&
          (entry.name === "http.fetch" || (entry.name === "shell.exec" && /\bcurl\b/.test(String(entry.args.command)) && !entry.result.backgroundJob))) &&
        !evidence.observedCalls.some((entry) => entry.name === "shell.wait");
    },
  },
  {
    name: "pty-secret-cancel-natural", scenarios: ["C08"], mutableFiles: [],
    files: { "prompt.mjs": "import {createInterface} from 'node:readline'; import {createHash} from 'node:crypto'; const rl=createInterface({input:process.stdin,output:process.stdout}); rl.question('Synthetic secret: ',value=>{ console.log(createHash('sha256').update(value).digest('hex')==='e563f40042d5873c916d79d30e7b64e2d027340a9db59a55b50b0e477be426e8'?'AUTHENTICATED':'REJECTED'); rl.close(); setInterval(()=>{},1000); });\n" },
    prompts: ["Open prompt.mjs in a real PTY, wait for its synthetic secret prompt, use the masked-input interaction to submit the synthetic test secret supplied by the evaluation operator, and verify AUTHENTICATED. Then cancel/close that owned session and prove cleanup. Do not put the secret in a command, ordinary text argument, output or final answer; do not resend delivered input."],
    verify: async (_root, answer, evidence) => {
      if (!evidence || answer.includes("synthetic-session-secret")) return false;
      if (evidence.executions.some((entry) => JSON.stringify(entry.args).includes("synthetic-session-secret") || entry.result.output.includes("synthetic-session-secret"))) return false;
      const starts = evidence.executions.filter((entry) => entry.name === "terminal.start" && entry.result.ok && entry.result.interactiveSession?.operation === "start");
      if (starts.length !== 1) return false;
      const start = starts[0]!.result.interactiveSession;
      if (start?.operation !== "start" || start.transport !== "pty") return false;
      const sends = evidence.executions.filter((entry) => entry.name === "terminal.send");
      const closes = evidence.executions.filter((entry) => entry.name === "terminal.close" && entry.args.id === start.sessionId);
      const closed = closes[0]?.result.interactiveSession;
      const promptObserved = evidence.executions.slice(0, evidence.executions.indexOf(sends[0]!)).some((entry) =>
        ["terminal.start", "terminal.read"].includes(entry.name) && entry.result.output.includes("Synthetic secret:"));
      return promptObserved && terminalTranscriptIsCursorSafe(evidence) && sends.length === 1 && sends[0]!.args.kind === "secret" && sends[0]!.args.id === start.sessionId &&
        (hasOutput(evidence, "terminal.send", "AUTHENTICATED") || hasOutput(evidence, "terminal.read", "AUTHENTICATED")) &&
        closes.length === 1 && closed?.operation === "close" && closed.cleanupVerified;
    },
  },
];

codingFixtures.push({
  name: "responder-lifecycle-natural", scenarios: ["C07"], mutableFiles: [], settleResponders: true,
  files: { "check.mjs": "setTimeout(()=>console.log('RESPONDER_CHECK: 58'),200);\n", "independent.json": "{\"review\":\"independent\"}\n" },
  prompts: ["Delegate node check.mjs as one finite Responder job and independently inspect independent.json while it runs. Do not poll, tail, wait on or duplicate the delegated job, and do not claim its outcome before delivery.", "Continue after the owned Responder delivery. Analyze its actual result, acknowledge that receipt as read, and report RESPONDER_CHECK. Do not relaunch completed work."],
  verify: async (_root, answer, evidence) => {
    if (!evidence || !/RESPONDER_CHECK:\s*58/.test(answer)) return false;
    const launches = evidence.executions.filter((entry) => entry.name === "shell.exec");
    if (launches.length !== 1 || launches[0]!.args.responder !== true || !launches[0]!.result.backgroundJob?.responder) return false;
    const id = launches[0]!.result.backgroundJob.id;
    return evidence.responderReceipts?.some((entry) => entry.jobId === id && entry.read && entry.status === "exited" && entry.exitCode === 0) === true &&
      evidence.observedCalls.some((entry) => entry.name === "job.read") &&
      evidence.executions.some((entry) => entry.name === "fs.read" && entry.result.ok && entry.result.output.includes('"review":"independent"')) &&
      !evidence.observedCalls.some((entry) => ["shell.wait", "shell.tail", "shell.jobs"].includes(entry.name));
  },
});
