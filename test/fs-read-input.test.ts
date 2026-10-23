import { describe, expect, it } from "vitest";
import { parseFsReadInput } from "../src/tools/fs/read-input.js";

const path = "src/app.ts";
const other = "src/config.ts";

describe("fs.read input normalization", () => {
  it.each([undefined, null, []].map((files) => ({ files })))("keeps a single path when files is unused: $files", ({ files }) => {
    expect(parseFsReadInput({ path, files, offset: "2", limit: "1" })).toEqual({
      ok: true,
      files: [{ path, offset: 2, limit: 1 }],
      multiple: false,
    });
  });

  it.each([undefined, null, "", "  \t"])("ignores an unused path beside a valid batch: %j", (unusedPath) => {
    expect(parseFsReadInput({ path: unusedPath, files: [{ path }, { path: other }] })).toEqual({
      ok: true,
      files: [{ path }, { path: other }],
      multiple: true,
    });
  });

  it("accepts a redundant top-level path without reading it twice", () => {
    expect(parseFsReadInput({ path, files: [{ path }] })).toEqual({
      ok: true,
      files: [{ path }],
      multiple: true,
    });
  });

  it("keeps batch order when the redundant path is not the first entry", () => {
    expect(parseFsReadInput({ path, files: [{ path: other }, { path }] })).toEqual({
      ok: true,
      files: [{ path: other }, { path }],
      multiple: true,
    });
  });

  it("ignores null optional fields emitted for the unused single-file form", () => {
    expect(parseFsReadInput({
      path: null, files: [{ path }], offset: null, limit: null, startLine: null,
      endLine: null, pattern: null, context: null, maxMatches: null,
      caseInsensitive: null, maxBytes: null,
    })).toEqual({ ok: true, files: [{ path }], multiple: true });
  });

  it("moves top-level filters into an unambiguous single batch entry", () => {
    expect(parseFsReadInput({ files: [{ path }], offset: "2", limit: "3" })).toEqual({
      ok: true,
      files: [{ path, offset: 2, limit: 3 }],
      multiple: true,
    });
  });

  it("merges filters only into the entry selected by a redundant path", () => {
    expect(parseFsReadInput({
      path, offset: "2", limit: "3", caseInsensitive: false,
      files: [{ path: other }, { path, offset: 2, pattern: "export" }],
    })).toEqual({
      ok: true,
      files: [{ path: other }, { path, offset: 2, limit: 3, pattern: "export", caseInsensitive: false }],
      multiple: true,
    });
  });

  it("keeps repeated paths with distinct read windows", () => {
    const files = [{ path, offset: 1, limit: 10 }, { path, offset: 100, limit: 10 }];
    expect(parseFsReadInput({ path, files })).toEqual({ ok: true, files, multiple: true });
  });

  it("does not mutate the original model arguments", () => {
    const files = Object.freeze([Object.freeze({ path, offset: "2" })]);
    const args = Object.freeze({ path, files, limit: "3" });
    expect(parseFsReadInput(args)).toEqual({
      ok: true,
      files: [{ path, offset: 2, limit: 3 }],
      multiple: true,
    });
    expect(args).toEqual({ path, files: [{ path, offset: "2" }], limit: "3" });
  });

  it.each([
    { path, files: [{ path: other }] },
    { path: other, files: [{ path }] },
  ])("rejects a distinct top-level path instead of silently dropping it: %j", (args) => {
    expect(parseFsReadInput(args)).toMatchObject({ ok: false, error: expect.stringContaining("conflicts with files") });
  });

  it.each([
    { path, limit: 1, files: [{ path, limit: 2 }] },
    { path, pattern: "first", files: [{ path, pattern: "second" }] },
    { path, caseInsensitive: false, files: [{ path, caseInsensitive: true }] },
    { files: [{ path, maxBytes: 100 }], maxBytes: 200 },
    { path, offset: 1, files: [{ path, startLine: 2 }] },
    { path, startLine: 2, files: [{ path, offset: 1 }] },
  ])("rejects conflicting filters without overriding either value: %j", (args) => {
    expect(parseFsReadInput(args)).toMatchObject({ ok: false, error: expect.stringContaining("conflicting") });
  });

  it.each([
    { files: [{ path }, { path: other }], limit: 10 },
    { path, files: [{ path }, { path }], limit: 10 },
  ])("rejects filters with more than one possible target: %j", (args) => {
    expect(parseFsReadInput(args)).toMatchObject({ ok: false, error: expect.stringContaining("Move limit") });
  });

  it.each([
    {}, { files: [] }, { path: "", files: [] }, { path, files: "invalid" },
    { path, files: {} }, { path: 123, files: [{ path }] },
    { path, files: [null] }, { path, files: ["src/app.ts"] },
    { path, files: [{ path: "" }] }, { path, files: [{ path, limit: -1 }] },
    { path, files: [{ path }], options: null },
    { files: [{ path }], limit: false }, { path, files: [{ path }], pattern: "" },
    { files: [{ path, options: { limit: 10 } }] },
    { path, files: Array.from({ length: 11 }, () => ({ path })) },
  ])("preserves validation for malformed inputs: %j", (args) => {
    const result = parseFsReadInput(args);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Use {"path"') });
  });

  it("retains all ten entries when accepting a redundant path", () => {
    const files = Array.from({ length: 10 }, (_, index) => ({ path: `src/${index}.ts` }));
    expect(parseFsReadInput({ path: files[9]!.path, files })).toEqual({ ok: true, files, multiple: true });
  });
});
