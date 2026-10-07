import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startPtyProcess } from "../src/interactive-session/transport-node-pty.js";

const input = Buffer.from("retained_界_🙂\n".repeat(10_000));
const expected = createHash("sha256").update(input).digest("hex");
const child = `
const { createHash } = require("node:crypto");
process.stdin.setRawMode(true);
process.stdin.pause();
const parts = [];
let total = 0;
process.stdin.on("data", (bytes) => {
  parts.push(bytes);
  total += bytes.length;
  if (total >= ${input.length}) {
    process.stdin.pause();
    process.stdout.write("DIGEST " + total + " " + createHash("sha256").update(Buffer.concat(parts)).digest("hex") + "\\n");
    setInterval(() => {}, 1000);
  }
});
process.stdin.pause();
process.stdout.write("READY\\n");
setTimeout(() => process.stdin.resume(), 100);
`;
let acceptReady: () => void;
let acceptDigest: (value: { bytes: number; hash: string }) => void;
let rejectFailure: (error: Error) => void;
const ready = new Promise<void>((resolve) => { acceptReady = resolve; });
const digest = new Promise<{ bytes: number; hash: string }>((resolve) => { acceptDigest = resolve; });
const failed = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
const { transport } = await startPtyProcess({
  file: "node", args: ["-e", child], cwd: process.cwd(), dimensions: { columns: 80, rows: 24 },
});
let output = "";
const unsubscribe = transport.onOutput((event) => {
  output += Buffer.from(event.bytes).toString("utf8");
  if (output.includes("READY")) acceptReady();
  const match = /DIGEST (\d+) ([a-f0-9]{64})/.exec(output);
  if (match) acceptDigest({ bytes: Number(match[1]), hash: match[2]! });
});
const timeout = setTimeout(() => rejectFailure(new Error("Bun buffered PTY input did not drain")), 10_000);
try {
  await Promise.race([ready, failed]);
  const chunks = [input.subarray(0, 64 * 1024), input.subarray(64 * 1024, 128 * 1024), input.subarray(128 * 1024)];
  const [delivered, received] = await Promise.race([
    Promise.all([Promise.all(chunks.map((chunk) => transport.write(chunk))), digest]), failed,
  ]);
  assert.deepEqual(delivered, chunks.map((chunk) => ({ status: "delivered", deliveredBytes: chunk.length })));
  assert.equal(received.bytes, input.length);
  assert.equal(received.hash, expected);
} catch (error) {
  console.error(output);
  throw error;
} finally {
  clearTimeout(timeout);
  unsubscribe();
  await transport.requestTreeTermination("forceful");
  await transport.dispose();
}
console.log("[PASS] Bun PTY buffered input: complete UTF-8 delivery, ordered writes, no duplicate bytes");
