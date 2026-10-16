import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { emptyFixtureEvidence, immutableFilesMatch, runIndependentAssertions, verifiedBackgroundCheck, type FixtureEvidence } from "./token-fixture-evidence.js";
import { getToolDefinition } from "../src/tools/definitions.js";
import { isReadOnlyShellCall } from "../src/tools/read-only-shell.js";

export interface TokenFixture {
  name: string;
  files: Record<string, string>;
  prompts: string[];
  mutableFiles: readonly string[];
  hiddenAssertions?: string;
  readOnlyTurns?: readonly number[];
  verify: (root: string, answer: string, evidence?: FixtureEvidence) => Promise<boolean>;
}

const testPassed = async (root: string): Promise<boolean> =>
  spawnSync(process.execPath, ["--test"], { cwd: root, timeout: 10_000 }).status === 0;

export const tokenFixtures: TokenFixture[] = [
  {
    name: "search-edit", mutableFiles: ["price.mjs"],
    hiddenAssertions: "import { strict as assert } from 'node:assert'; import { subtotal } from './price.mjs'; const cart = [{price:1.25,quantity:4},{price:0.5,quantity:3}]; const before=JSON.stringify(cart); assert.equal(subtotal(cart),6.5); assert.equal(subtotal([{price:9,quantity:0}]),0); assert.equal(subtotal([]),0); assert.equal(JSON.stringify(cart),before);",

    files: {
      "price.mjs": "export const subtotal = items => items.reduce((sum, item) => sum + item.price, 0);\n",
      "price.test.mjs": "import { strict as assert } from 'node:assert';\nimport { test } from 'node:test';\nimport { subtotal } from './price.mjs';\ntest('subtotal includes quantity', () => { assert.equal(subtotal([{ price: 5, quantity: 3 }, { price: 2, quantity: 2 }]), 19); assert.equal(subtotal([]), 0); });\n",
    },
    prompts: ["Find subtotal using shell.exec with rg or grep, inspect its current implementation and tests, and fix the quantity calculation with fs.edit. Preserve the empty-cart behavior and verify with node --test. This is a focused fix; do not add comments or dependencies."],
    verify: testPassed,
  },
  {
    name: "multiple-edits", mutableFiles: ["display.mjs", "receipt.mjs"],
    hiddenAssertions: "import { strict as assert } from 'node:assert'; import { displayTotal } from './display.mjs'; import { receipt } from './receipt.mjs'; for (const n of [0,-1,7.5,0.125,1234.567]) { assert.equal(displayTotal(n),n.toFixed(2)); assert.equal(receipt(n),'Total: '+n.toFixed(2)); }",

    files: {
      "display.mjs": "export const displayTotal = amount => String(amount);\n",
      "receipt.mjs": "export const receipt = amount => `Total: ${amount}`;\n",
      "display.test.mjs": "import { strict as assert } from 'node:assert';\nimport { test } from 'node:test';\nimport { displayTotal } from './display.mjs';\nimport { receipt } from './receipt.mjs';\ntest('both totals use two decimals', () => { assert.equal(displayTotal(3), '3.00'); assert.equal(displayTotal(3.25), '3.25'); assert.equal(receipt(3), 'Total: 3.00'); assert.equal(receipt(0), 'Total: 0.00'); });\n",
    },
    prompts: ["Update both displayed totals to exactly two decimals. Read the two implementations and tests, use fs.edit for the changes, preserve the receipt prefix, then run node --test. No dependencies or comments."],
    verify: testPassed,
  },
  {
    name: "debug-regression", mutableFiles: ["queue.mjs"],
    hiddenAssertions: "import { strict as assert } from 'node:assert'; import { take } from './queue.mjs'; for(const n of [-8,0,1,2,8]) { const values=['a','b','c','d']; assert.deepEqual(take(values,n),values.slice(0,Math.max(0,n))); assert.deepEqual(values,['a','b','c','d']); }",

    files: {
      "queue.mjs": "export const take = (items, count) => items.slice(0, Math.max(0, count - 1));\n",
      "queue.test.mjs": "import { strict as assert } from 'node:assert';\nimport { test } from 'node:test';\nimport { take } from './queue.mjs';\ntest('take count without mutating', () => { const items = [1, 2, 3]; assert.deepEqual(take(items, 2), [1, 2]); assert.deepEqual(take(items, 0), []); assert.deepEqual(take(items, -1), []); assert.deepEqual(take(items, 20), items); assert.deepEqual(items, [1, 2, 3]); });\n",
    },
    prompts: ["Diagnose the failing queue test with node --test, inspect the causal code, fix it with fs.edit, then re-run the regression checks. Preserve zero/negative counts and input immutability. No comments or dependencies."],
    verify: testPassed,
  },
  {
    name: "independent-reads", mutableFiles: [], readOnlyTurns: [0],
    files: {
      "alpha.json": '{"enabled":true,"port":4123,"label":"alpha"}\n',
      "beta.json": '{"enabled":false,"port":5124,"label":"beta"}\n',
    },
    prompts: ["Read alpha.json and beta.json using independent fs.read calls together in one response. Report each port and enabled value. This is read-only analysis; do not edit files or create a plan."],
    verify: async (root, answer, evidence = emptyFixtureEvidence) =>
      answer.includes("4123") && answer.includes("5124") &&
      /true|enabled/i.test(answer) && /false|disabled/i.test(answer) &&
      evidence.executions.some((entry) => entry.name === "fs.read" && entry.result.ok && entry.result.output.includes("4123")) &&
      evidence.executions.some((entry) => entry.name === "fs.read" && entry.result.ok && entry.result.output.includes("5124")) &&
      await readFile(join(root, "alpha.json"), "utf8") === '{"enabled":true,"port":4123,"label":"alpha"}\n' &&
      await readFile(join(root, "beta.json"), "utf8") === '{"enabled":false,"port":5124,"label":"beta"}\n',
  },
  {
    name: "background-wait", mutableFiles: [],
    files: {
      "check.mjs": "setTimeout(() => console.log('READY_CHECK: 42'), 200);\n",
    },
    prompts: ["Run node check.mjs as one normal pollable background job named fixture-check, wait for its completion using shell.wait, and report the exact READY_CHECK value. No Responder delegation and no file changes."],
    verify: async (_root, answer, evidence = emptyFixtureEvidence) => verifiedBackgroundCheck(answer, evidence),
  },
  {
    name: "continuation-crlf", mutableFiles: ["state.mjs"],
    files: {
      "state.mjs": "export const retryLimit = 2;\r\nexport const backoffMs = 50;\r\n",
      "check.mjs": "import { strict as assert } from 'node:assert';\nimport { retryLimit, backoffMs } from './state.mjs';\nassert.equal(retryLimit, 3); assert.equal(backoffMs, 100); console.log('state verified');\n",
    },
    prompts: [
      "Inspect state.mjs and change retryLimit from 2 to 3 with fs.edit. Preserve backoffMs and the CRLF line endings. No comments or dependencies.",
      "Continue: also change backoffMs from 50 to 100 with fs.edit, then verify both values with node check.mjs. Preserve the CRLF line endings and do not repeat completed work.",
    ],
    verify: async (root) => {
      const state = await readFile(join(root, "state.mjs"), "utf8");
      return state === "export const retryLimit = 3;\r\nexport const backoffMs = 100;\r\n" &&
        spawnSync(process.execPath, ["check.mjs"], { cwd: root, timeout: 10_000 }).status === 0;
    },
  },
];

export async function seedTokenFixture(root: string, fixture: TokenFixture): Promise<void> {
  await writeFile(join(root, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}\n');
  for (const [name, content] of Object.entries(fixture.files)) {
    await writeFile(join(root, name), content);
  }
}

export async function verifyTokenFixture(fixture: TokenFixture, root: string, answer: string, evidence: FixtureEvidence = emptyFixtureEvidence): Promise<boolean> {
  const files = { ...fixture.files, "package.json": '{"type":"module","scripts":{"test":"node --test"}}\n' };
  if (!await immutableFilesMatch(root, files, fixture.mutableFiles)) return false;
  const readOnlyTurns = new Set(fixture.readOnlyTurns ?? []);
  for (const call of evidence.observedCalls.filter((entry) => readOnlyTurns.has(entry.turn))) {
    const executions = evidence.executions.filter((entry) => entry.name === call.name && entry.turn === call.turn);
    if (call.name === "shell.exec") {
      if (executions.length === 0 || executions.some((entry) => !isReadOnlyShellCall({ name: call.name, args: { ...entry.args } }))) return false;
      continue;
    }
    if (getToolDefinition(call.name)?.readOnly !== true) return false;
  }
  if (fixture.hiddenAssertions && !runIndependentAssertions(root, fixture.hiddenAssertions)) return false;
  try { return await fixture.verify(root, answer, evidence); }
  catch { return false; }
}

const naturalPrompts: Readonly<Record<string, readonly string[]>> = {
  "search-edit": ["The subtotal ignores item quantities. Fix it in this existing project, preserve empty and fractional carts, and verify the regression. No dependencies or comments."],
  "multiple-edits": ["Both the standalone amount and receipt total should show exactly two decimals, including zero, negative and fractional amounts. Preserve the prefix and verify all callers."],
  "debug-regression": ["The queue returns too few items. Reproduce the failure, fix its cause, and prove zero/negative/oversized counts and input immutability still work."],
  "independent-reads": ["What are the port and enabled values in alpha.json and beta.json? This is a read-only question; do not change files or create a plan."],
  "background-wait": ["Run node check.mjs once as a normal tracked background job named fixture-check, wait until it exits, and report the exact READY_CHECK line. Do not delegate or change files."],
  "continuation-crlf": ["Inspect state.mjs and change only retryLimit to 3, keeping its exact CRLF line endings.", "Continue: change backoffMs to 100 without repeating the first edit. Verify both values and preserve CRLF."],
};
const contractFixtures = [...tokenFixtures];
for (const fixture of contractFixtures) {
  const prompts = naturalPrompts[fixture.name];
  if (prompts) tokenFixtures.push({ ...fixture, name: `${fixture.name}-natural`, prompts: [...prompts] });
}
const repair = contractFixtures.find((fixture) => fixture.name === "search-edit")!;
tokenFixtures.push({
  ...repair, name: "question-after-build", readOnlyTurns: [1],
  prompts: [naturalPrompts["search-edit"]![0]!, "Why does this implementation handle an empty cart and zero quantity correctly? Explain the current behavior only; do not make further changes."],
});
