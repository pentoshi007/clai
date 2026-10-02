import { describe, expect, it } from "vitest";
import {
  formatOperationReview,
  reviewDisplayText,
} from "../../src/app/operation-review.js";
import type { ToolCall } from "../../src/types.js";

describe("operation review formatting", () => {
  it("shows complete edit details while masking sensitive values", () => {
    const call: ToolCall = {
      name: "fs.edit",
      args: {
        path: "src/example.ts",
        oldText: "const previous = true;\n",
        newText: "const next = false;\n",
        authorization: "Bearer hidden-value",
        nested: { api_key: "sk-proj-secret-value" },
      },
    };
    const original = structuredClone(call);

    const review = formatOperationReview(call);

    expect(review.title).toBe("Review operation · fs.edit");
    expect(review.body).toContain("Operation: fs.edit");
    expect(review.body).toContain("Resolved path:");
    expect(review.body).toContain("const previous = true;");
    expect(review.body).toContain("const next = false;");
    expect(review.body).toContain('"authorization": "[redacted]"');
    expect(review.body).toContain('"api_key": "[redacted]"');
    expect(review.body).not.toContain("hidden-value");
    expect(review.body).not.toContain("sk-proj-secret-value");
    expect(call).toEqual(original);
  });

  it("shows all batch paths and makes control characters visible", () => {
    const review = formatOperationReview({
      name: "fs.writeMany",
      args: {
        files: [
          { path: "one.txt", content: "first" },
          { path: "two.txt", content: "second" },
        ],
        note: "before\u001bafter",
      },
    });

    expect(review.body).toContain("Resolved path:");
    expect(review.body).toContain("one.txt");
    expect(review.body).toContain("two.txt");
    expect(review.body).toContain("before\\\\u001bafter");
    expect(reviewDisplayText("a\u0001b")).toBe("a\\u0001b");
  });
});
