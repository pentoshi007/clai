import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runToolCall } from "../../src/tools/registry.js";
import { TOOL_DEFINITIONS } from "../../src/tools/definitions.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function file(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "clai-fs-edit-runtime-"));
  dirs.push(dir);
  const path = join(dir, "file.txt");
  writeFileSync(path, content);
  return path;
}
const edit = (args: Record<string, unknown>) => runToolCall({ id: "edit", name: "fs.edit", args }, { confirmed: true });

describe("fs.edit runtime contract", () => {
  it.each([
    { before: "keep\nremove\nlast\n", oldText: "remove\n", after: "keep\nlast\n" },
    { before: "keep\r\nremove\r\nlast\r\n", oldText: "remove\n", after: "keep\r\nlast\r\n" },
    { before: "hello 界🙂 world", oldText: "界🙂 ", after: "hello world" },
    { before: "entire file", oldText: "entire file", after: "" },
  ])("accepts an empty replacement through dispatch and deletes the exact match", async ({ before, oldText, after }) => {
    const path = file(before);
    const result = await edit({ path, oldText, newText: "" });
    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(after);
    expect(result.fileChanges?.[0]?.stats.removed).toBeGreaterThan(0);
  });

  it("preserves match-count and no-match protections for deletions", async () => {
    const path = file("drop keep drop");
    expect((await edit({ path, oldText: "missing", newText: "" })).ok).toBe(false);
    expect((await edit({ path, oldText: "drop", newText: "" })).ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("drop keep drop");
    expect((await edit({ path, oldText: "drop", newText: "", expectedReplacements: 2 })).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(" keep ");
  });

  it.each(["existing content", ""])("rejects an empty search safely with actionable guidance", async (content) => {
    const path = file(content);
    const result = await edit({ path, oldText: "", newText: "insert" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("non-empty oldText");
    expect(result.output).toContain("fs.read");
    expect(result.output).toContain("fs.write");
    expect(result.output).toContain("fs.append");
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it.each([undefined, null, 42])("still requires a string replacement instead of treating %j as deletion", async (newText) => {
    const path = file("keep");
    await expect(edit({ path, oldText: "keep", newText })).rejects.toThrow('"newText" must be a string');
    expect(readFileSync(path, "utf8")).toBe("keep");
  });

  it("distinguishes empty search and empty replacement in model-facing descriptions and schema", () => {
    const definition = TOOL_DEFINITIONS.find((entry) => entry.name === "fs.edit")!;
    expect(definition.description).toContain("non-empty exact oldText");
    expect(definition.description).toContain('may be "" to delete');
    expect(definition.description).toContain("fs.append");
    expect(definition.parameters.properties.oldText).toMatchObject({ type: "string", minLength: 1 });
    expect(definition.parameters.properties.newText).toMatchObject({ type: "string", description: expect.stringContaining('"" to delete') });
    expect(definition.parameters.properties.newText).not.toHaveProperty("minLength");
    expect(definition.parameters.required).toEqual(["path", "oldText", "newText"]);
  });
});
