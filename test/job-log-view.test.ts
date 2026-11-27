import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactByteView } from "../src/ui-core/rendering/artifact-pager-source.js";
import { createJobLogView, type JobLogFile } from "../src/ui-core/rendering/job-log-view.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("job log view", () => {
  it("does not hand a read requested mid-snapshot the stale in-flight snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-log-view-"));
    dirs.push(dir);
    const stdout = join(dir, "stdout.log");
    const stderr = join(dir, "stderr.log");
    writeFileSync(stdout, "out\n");
    writeFileSync(stderr, "err\n");
    let files: JobLogFile[] = [{ path: stdout }];
    let during: Promise<ArtifactByteView> | undefined;
    const read = createJobLogView(() => files, () => {
      if (!during) {
        files = [{ path: stdout }, { path: stderr }];
        during = read();
      }
      return [];
    });
    const before = await read();
    const after = await during!;
    expect((await before.read(0, before.size)).toString()).toBe("out\n");
    expect((await after.read(0, after.size)).toString()).toBe("out\nerr\n");
  });
});
