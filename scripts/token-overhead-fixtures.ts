import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface TokenFixture {
  name: string;
  files: Record<string, string>;
  prompts: string[];
  verify: (root: string, answer: string) => Promise<boolean>;
}

const testPassed = async (root: string): Promise<boolean> =>
  spawnSync(process.execPath, ["--test"], { cwd: root, timeout: 10_000 }).status === 0;

export const tokenFixtures: TokenFixture[] = [
  {
    name: "search-edit",
    files: {
      "price.mjs": "export const subtotal = items => items.reduce((sum, item) => sum + item.price, 0);\n",
      "price.test.mjs": "import { strict as assert } from 'node:assert';\nimport { test } from 'node:test';\nimport { subtotal } from './price.mjs';\ntest('subtotal includes quantity', () => { assert.equal(subtotal([{ price: 5, quantity: 3 }, { price: 2, quantity: 2 }]), 19); assert.equal(subtotal([]), 0); });\n",
    },
    prompts: ["Find subtotal using fs.search, inspect its current implementation and tests, and fix the quantity calculation with fs.edit. Preserve the empty-cart behavior and verify with node --test. This is a focused fix; do not add comments or dependencies."],
    verify: testPassed,
  },
  {
    name: "multiple-edits",
    files: {
      "display.mjs": "export const displayTotal = amount => String(amount);\n",
      "receipt.mjs": "export const receipt = amount => `Total: ${amount}`;\n",
      "display.test.mjs": "import { strict as assert } from 'node:assert';\nimport { test } from 'node:test';\nimport { displayTotal } from './display.mjs';\nimport { receipt } from './receipt.mjs';\ntest('both totals use two decimals', () => { assert.equal(displayTotal(3), '3.00'); assert.equal(displayTotal(3.25), '3.25'); assert.equal(receipt(3), 'Total: 3.00'); assert.equal(receipt(0), 'Total: 0.00'); });\n",
    },
    prompts: ["Update both displayed totals to exactly two decimals. Read the two implementations and tests, use fs.edit for the changes, preserve the receipt prefix, then run node --test. No dependencies or comments."],
    verify: testPassed,
  },
  {
    name: "debug-regression",
    files: {
      "queue.mjs": "export const take = (items, count) => items.slice(0, Math.max(0, count - 1));\n",
      "queue.test.mjs": "import { strict as assert } from 'node:assert';\nimport { test } from 'node:test';\nimport { take } from './queue.mjs';\ntest('take count without mutating', () => { const items = [1, 2, 3]; assert.deepEqual(take(items, 2), [1, 2]); assert.deepEqual(take(items, 0), []); assert.deepEqual(take(items, -1), []); assert.deepEqual(take(items, 20), items); assert.deepEqual(items, [1, 2, 3]); });\n",
    },
    prompts: ["Diagnose the failing queue test with node --test, inspect the causal code, fix it with fs.edit, then re-run the regression checks. Preserve zero/negative counts and input immutability. No comments or dependencies."],
    verify: testPassed,
  },
  {
    name: "independent-reads",
    files: {
      "alpha.json": '{"enabled":true,"port":4123,"label":"alpha"}\n',
      "beta.json": '{"enabled":false,"port":5124,"label":"beta"}\n',
    },
    prompts: ["Read alpha.json and beta.json using independent fs.read calls together in one response. Report each port and enabled value. This is read-only analysis; do not edit files or create a plan."],
    verify: async (root, answer) =>
      answer.includes("4123") && answer.includes("5124") &&
      /true|enabled/i.test(answer) && /false|disabled/i.test(answer) &&
      await readFile(join(root, "alpha.json"), "utf8") === '{"enabled":true,"port":4123,"label":"alpha"}\n' &&
      await readFile(join(root, "beta.json"), "utf8") === '{"enabled":false,"port":5124,"label":"beta"}\n',
  },
  {
    name: "background-wait",
    files: {
      "check.mjs": "setTimeout(() => console.log('READY_CHECK: 42'), 200);\n",
    },
    prompts: ["Run node check.mjs as one normal pollable background job named fixture-check, wait for its completion using shell.wait, and report the exact READY_CHECK value. No Responder delegation and no file changes."],
    verify: async (_root, answer) => /42/.test(answer),
  },
  {
    name: "continuation-crlf",
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
