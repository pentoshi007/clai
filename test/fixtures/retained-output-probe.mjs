import assert from "node:assert/strict";
import { OutputSpool } from "../../src/app/events/event-buffer.ts";
import { LoopGuard } from "../../src/agent/loop-guard.ts";
import {
  createOutcome,
  recordToolEvidence,
} from "../../src/agent/outcomes.ts";

const count = 12;
const outputChars = 8 * 1024 * 1024;
const tailChars = 256 * 1024;
const spool = new OutputSpool(tailChars);
const guard = new LoopGuard();
const envelope = {
  schemaVersion: 1,
  outcome: createOutcome({
    sessionId: "memory-probe",
    userIntent: "read files",
    kind: "answer",
    criteria: [{ id: "answer", statement: "read files", required: true }],
  }),
  evidence: [],
  failedHypotheses: [],
};

function retainedHeap() {
  for (let attempt = 0; attempt < 3; attempt += 1) global.gc();
  return process.memoryUsage().heapUsed;
}

function populate(kind) {
  for (let index = 0; index < count; index += 1) {
    const output = `${index}:` + "x".repeat(outputChars);
    const id = `call-${index}`;
    const args = { path: `file-${index}` };
    if (kind === "spool") {
      spool.append(id, output);
    } else if (kind === "guard") {
      guard.recordAttempt(index, "fs.read", args, true, 0, output);
    } else if (kind === "evidence") {
      recordToolEvidence(envelope, {
        tool: "fs.read",
        callId: id,
        args,
        ok: true,
        output,
      });
    } else {
      throw new Error(`Unknown probe: ${kind}`);
    }
  }
}

const kind = process.argv[2];
const before = retainedHeap();
populate(kind);
const retainedBytes = retainedHeap() - before;

for (let index = 0; index < count; index += 1) {
  const prefix = `${index}:`;
  if (kind === "spool") {
    assert.equal(spool.tail(`call-${index}`), "x".repeat(tailChars));
    assert.equal(spool.state(`call-${index}`).totalBytes, outputChars + prefix.length);
  } else if (kind === "guard") {
    assert.equal(
      guard.getPriorObservation("fs.read", { path: `file-${index}` }),
      prefix + "x".repeat(8_000 - prefix.length),
    );
  } else {
    assert.equal(envelope.evidence.length, count);
    assert.equal(envelope.completedOperations.length, count);
    assert.equal(
      envelope.evidence[index].observation,
      prefix + "x".repeat(4_000 - prefix.length),
    );
    assert.equal(
      envelope.completedOperations[index].observation,
      prefix + "x".repeat(240 - prefix.length),
    );
  }
}

console.log(JSON.stringify({ retainedBytes }));
