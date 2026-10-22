import { describe, expect, it } from "vitest";
import { reportFatalError } from "../../../src/ui-core/bootstrap/fatal-diagnostics.js";
import { getLogsDirRoot } from "../../../src/store/paths.js";

describe("fatal terminal diagnostics", () => {
  it("prints the cause, recovery step, and log location outside the console guard", async () => {
    const writes: string[] = [];
    const error = Object.assign(new Error("unknown error, write"), { code: "EDQUOT" });
    await reportFatalError(error, (text) => { writes.push(text); });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("clai stopped: Storage quota exceeded (EDQUOT)");
    expect(writes[0]).toContain("TMPDIR");
    expect(writes[0]).toContain(getLogsDirRoot());
    expect(writes[0]).toContain("tui-console.log");
    expect(writes[0]).not.toContain("\x1b");
  });
});
