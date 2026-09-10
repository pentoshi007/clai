import assert from "node:assert/strict";
import { styleAnsiLine } from "../../src/tui-v2/rendering/styled-markdown.ts";

function retainedHeap() {
  for (let attempt = 0; attempt < 3; attempt += 1) global.gc();
  return process.memoryUsage().heapUsed;
}

const before = retainedHeap();
for (let index = 0; index < 200; index += 1) {
  styleAnsiLine(`${index}:` + "x".repeat(10_000), "#ffffff");
}
const retainedBytes = retainedHeap() - before;
for (let index = 0; index < 200; index += 1) {
  const line = `${index}:` + "x".repeat(10_000);
  assert.equal(styleAnsiLine(line, "#ffffff").chunks.map((chunk) => chunk.text).join(""), line);
}
console.log(JSON.stringify({ retainedBytes }));
