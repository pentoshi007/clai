// Feature: web-search-and-fetch, Property 16: Key masking
//
// Validates: Requirements 3.6
//
// For arbitrary secret strings of length 0..256:
//   maskSecret(s) === '*'.repeat(n)                          when n < 8
//   maskSecret(s) === '*'.repeat(n - 4) + s.slice(-4)        when n >= 8

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { maskSecret } from "../../src/llm/provider.js";

describe("Property 16: Key masking (Requirement 3.6)", () => {
  it("matches the masking rule for arbitrary secrets of length 0..256", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 256 }),
        (s) => {
          const n = s.length;
          const expected =
            n < 8 ? "*".repeat(n) : "*".repeat(n - 4) + s.slice(-4);
          return maskSecret(s) === expected;
        },
      ),
      { numRuns: 100 },
    );
  });
});
