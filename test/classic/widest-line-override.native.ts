import assert from "node:assert/strict";
import widestLine from "widest-line";
import fastWidestLine from "../../src/classic/render/widest-line.js";

assert.equal(widestLine, fastWidestLine, "Bun resolves Ink's widest-line to the cached width implementation");
assert.equal(widestLine("\u001b[2m│\u001b[22m 日本\n✓ ok"), 6);
console.log("Widest-line override passed");
