import { describe, expect, it } from "vitest";
import { isReadOnlyShellCall } from "../../src/tools/read-only-shell.js";
import { isCompletedReadOperation } from "../../src/agent/outcomes.js";

describe("read-only shell research", () => {
  it.each([
    "rg -n -i -g '*.ts' -- 'answer' src",
    "rg -F -n -- '--flaglike' .",
    "rg -P -n -- 'source(?=\\.stream)' .",
    "grep -R -n -E -- 'subtotal|quantity' src",
    "rg -n -- 'find -delete; $(rm) & literal' src",
    "ls -la && command -v node npm",
    "find /tmp -type f -name '*.txt'",
    "where node",
    "Get-ChildItem -Recurse -File | Select-String -Pattern 'answer'",
    "rg -n -- 'answer' . | head -20",
    "rg -n -F -- '--pre' src | sort | uniq",
    "uniq --skip-fields 1 input.txt",
  ])("allows local inspection: %s", (command) => {
    expect(isReadOnlyShellCall({ name: "shell.exec", args: { command } })).toBe(true);
  });

  it.each([
    "rm -rf src",
    "rg answer . && touch marker",
    "rg answer . > result.txt",
    "rg answer . 2>/dev/null",
    "find . -exec touch marker ';'",
    "find . -delete",
    "find . -fprint result.txt",
    "rg --pre 'touch marker' answer .",
    "rg --hostname-bin=evil answer .",
    "sort -o result.txt input.txt",
    "sort /O result.txt input.txt",
    "sort --compress-program='touch marker' input.txt",
    "tree -ao result.txt",
    "file -C -m magic.txt",
    "file --compile -m magic.txt",
    "uniq input.txt output.txt",
    "rg answer $(touch marker)",
    "rg answer . &",
    "node -e 'require(\"fs\").writeFileSync(\"marker\",\"x\")'",
    "powershell -Command 'Remove-Item src'",
    "curl https://example.test",
    "/tmp/rg answer .",
  ])("rejects execution outside local inspection: %s", (command) => {
    expect(isReadOnlyShellCall({ name: "shell.exec", args: { command } })).toBe(false);
  });

  it("rejects jobs and other tools", () => {
    for (const args of [{ command: "rg answer .", background: "always" }, { command: "rg answer .", responder: true }]) {
      expect(isReadOnlyShellCall({ name: "shell.exec", args })).toBe(false);
    }
    expect(isReadOnlyShellCall({ name: "fs.read", args: { command: "rg answer ." } })).toBe(false);
    expect(isReadOnlyShellCall({ name: "shell.exec", args: {} })).toBe(false);
  });

  it("preserves completed read classification without treating writes as observations", () => {
    expect(isCompletedReadOperation("shell.exec", { command: "rg -n -- 'answer' src" })).toBe(true);
    expect(isCompletedReadOperation("shell.exec", { command: "command -v node" })).toBe(true);
    expect(isCompletedReadOperation("shell.exec", { command: "touch marker" })).toBe(false);
  });
});
