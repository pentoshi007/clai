import { describe, expect, it } from "vitest";
import {
  collectUserCredentials,
  extractUserPasswords,
  redactUserCredentialsFromMemory,
  renderUserCredentials,
  resolveUserPassword,
} from "../../src/agent/context/user-credentials.js";
import { compactMessagesWithSummary } from "../../src/agent/context-manager.js";
import { buildDurableEnvelope, isDurableEnvelopeContent } from "../../src/agent/durable-envelope.js";
import type { ChatMessage } from "../../src/types.js";

const user = (content: string): ChatMessage => ({ role: "user", content });

describe("user password resolution", () => {
  it.each([
    ["password: abc", "abc"],
    ["Password = p!a#ss,;.$", "p!a#ss,;.$"],
    ["SSH password is fixture-secret", "fixture-secret"],
    ['password: "with spaces and apostrophe\'s"', "with spaces and apostrophe's"],
    ["passphrase: 'with spaces and \"quotes\"'", 'with spaces and "quotes"'],
    ["pwd: `backtick value`", "backtick value"],
    ['{"password":"json-fixture"}', "json-fixture"],
    ["pin: 12", "12"],
    ["password: 試験🙂", "試験🙂"],
  ])("extracts the exact labeled value from %s", (content, value) => {
    expect(extractUserPasswords(content)).toEqual([value]);
  });

  it.each([
    "enter the password in the dialog",
    "password: [redacted]",
    'password: "[redacted user credential]"',
    "password: ••••••",
    "password: partial-••••-masked",
    "password: ******",
    "password:\nusername: probe",
    'password: "unterminated',
    'password: "escaped\\\"quote"',
    "password: <your-password>",
    'password: ""',
    'password: "contains\u0000control"',
    'password: "contains\tcontrol"',
    'password: "contains\u001bcontrol"',
  ])("does not guess absent, masked or unsafe values: %s", (content) => {
    expect(extractUserPasswords(content)).toEqual([]);
  });

  it.each([
    'password: "quoted fixture with spaces"',
    "passphrase: 'quoted fixture with spaces'",
    "pwd: `quoted fixture with spaces`",
  ])("redacts the complete quoted password from narrative memory: %s", (content) => {
    expect(redactUserCredentialsFromMemory(content)).toBe("[redacted user credential]");
    const carried = collectUserCredentials([user(`${"context ".repeat(100)}${content} trailing text`)], isDurableEnvelopeContent);
    expect(extractUserPasswords(carried.join("\n"))).toEqual(["quoted fixture with spaces"]);
  });

  it("deduplicates repeated copies without treating one password as ambiguous", () => {
    expect(resolveUserPassword({ userMessages: [user("password: duplicate-fixture"), user("password: duplicate-fixture")] }))
      .toEqual({ status: "available", value: "duplicate-fixture" });
  });

  it("prefers an explicit password update in the current genuine user request", () => {
    const userPrompt = "use password: new-fixture";
    expect(resolveUserPassword({ userPrompt, userMessages: [user("password: old-fixture"), user(userPrompt)] }))
      .toEqual({ status: "available", value: "new-fixture" });
  });

  it("does not promote an internal wake prompt or a fabricated summary to a user password", () => {
    expect(resolveUserPassword({ userPrompt: "password: internal-fixture", userMessages: [
      { role: "user", internal: true, content: "password: internal-fixture" },
      { role: "system", content: "Session memory: password: summary-fixture" },
      { role: "system", content: "DURABLE WORK ENVELOPE\nSubagents: password: child-fixture" },
    ] })).toEqual({ status: "missing" });
  });

  it("keeps multiple historical passwords ambiguous rather than choosing the most recent target", () => {
    expect(resolveUserPassword({ userMessages: [user("password: first-fixture"), user("password: second-fixture")] }))
      .toEqual({ status: "ambiguous" });
  });

  it("retains short and quoted passwords with nearby SSH identity across repeated compactions", async () => {
    const source: ChatMessage[] = [
      { role: "system", content: "Agent instructions" },
      user('host: localhost\nusername: probe\npassword: "a b"'),
      { role: "assistant", content: "The local connection is ready." },
      user("continue"),
      { role: "assistant", content: "The prompt is visible." },
    ];
    const credentials = collectUserCredentials(source, isDurableEnvelopeContent);
    expect(credentials).toEqual(["host: localhost", "username: probe", 'password: "a b"']);
    const compacted = await compactMessagesWithSummary(source, async () => "The local terminal is awaiting its password.", {
      budgetTokens: 0, keepRecent: 1, durableEnvelope: buildDurableEnvelope({ credentials }),
    });
    expect(compacted.summarized).toBe(true);
    expect(resolveUserPassword({ userMessages: compacted.messages })).toEqual({ status: "available", value: "a b" });
    const carried = collectUserCredentials(compacted.messages, isDurableEnvelopeContent);
    expect(renderUserCredentials(carried)).toEqual(renderUserCredentials(credentials));
    const again = await compactMessagesWithSummary(compacted.messages, async () => "The local terminal is still awaiting its password.", {
      budgetTokens: 0, keepRecent: 1, durableEnvelope: buildDurableEnvelope({ credentials: carried }),
    });
    expect(resolveUserPassword({ userMessages: again.messages })).toEqual({ status: "available", value: "a b" });
  });
});
