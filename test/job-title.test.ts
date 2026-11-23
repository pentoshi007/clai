import { describe, expect, it } from "vitest";
import { JOB_TITLE_LIMIT, jobTitle, normalizeJobTitle } from "../src/tools/jobs/title.js";

const commandDisplay = "npm test -- --reporter=verbose";

describe("job titles", () => {
  it("normalizes whitespace, terminal controls, and known secret patterns", () => {
    const input = " \x1b[33mCheck \r\n\t build\u0000sk-fake-secret\x1b[0m\u202e ";
    expect(normalizeJobTitle(input, commandDisplay)).toBe("Check build sk-••••••");
  });

  it("limits the normalized title to 48 Unicode code points", () => {
    const title = "🚦".repeat(JOB_TITLE_LIMIT);
    expect(normalizeJobTitle(` ${title} `, commandDisplay)).toBe(title);
    expect(normalizeJobTitle(`${title}!`, commandDisplay)).toBeUndefined();
  });

  it.each([undefined, "", "\x1b[0m", "  NPM  test -- --reporter=verbose ", "x".repeat(JOB_TITLE_LIMIT + 1)])(
    "never uses command text as a fallback for %j",
    (name) => expect(jobTitle({ name, commandDisplay })).toBe("Background job"),
  );
});
