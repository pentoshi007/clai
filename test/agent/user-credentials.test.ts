import { describe, expect, it } from "vitest";
import {
  USER_CREDENTIALS_HEADING,
  collectUserCredentials,
  renderUserCredentials,
} from "../../src/agent/context/user-credentials.js";
import { isDurableEnvelopeContent } from "../../src/agent/durable-envelope.js";
import type { ChatMessage } from "../../src/types.js";

const fragments = (...parts: string[]): string => parts.join("");

const stripeKey = fragments("sk", "_test_", "51Habcdefghijklmnop");
const stagingKey = fragments("7f3a9c2e", "41b8d6f0");
const webhookSecret = fragments("whsec", "9f8e7d6c5b4a");
const stagingPassword = fragments("Hunter2", "-Staging", "!");
const firstToken = fragments("tok_first_", "000000000001");
const secondPassword = fragments("pw_second_", "000000000002");

const user = (content: string): ChatMessage => ({ role: "user", content });

const collect = (...messages: ChatMessage[]): string[] =>
  collectUserCredentials(messages, isDurableEnvelopeContent);

describe("user credential carry-over", () => {
  it("keeps provider-shaped keys, env assignments and spoken keys verbatim", () => {
    const harbor = `thk_live_${"Ab3dEf6h".repeat(8)}`;
    const found = collect(
      user(`use this for the integration run: ${harbor}`),
      user(`export STRIPE_KEY=${stripeKey}`),
      user(`The staging API key: ${stagingKey} — don't commit it`),
      user("my test key is abcdefghijkl"),
      user(`webhook secret = ${webhookSecret}`),
    );
    expect(found).toContain(`use this for the integration run: ${harbor}`);
    expect(found).toContain(`export STRIPE_KEY=${stripeKey}`);
    expect(found).toContain(`The staging API key: ${stagingKey} — don't commit it`);
    expect(found).toContain(`webhook secret = ${webhookSecret}`);
    expect(found).not.toContain("my test key is abcdefghijkl");
  });

  it("ignores prose that merely mentions keys and tokens", () => {
    expect(
      collect(
        user("how do I rotate the api key: please explain"),
        user("the access token is short"),
        user("make the key lookup faster"),
      ),
    ).toEqual([]);
  });

  it("carries the login details written next to a secret so the credential stays usable", () => {
    const found = collect(
      user(
        [
          "Test account for the dashboard:",
          "url: https://staging.example.com/login",
          "username: qa-bot",
          `password: ${stagingPassword}`,
          "region: eu-west-1",
          "please keep going with the checkout flow",
        ].join("\n"),
      ),
    );
    expect(found).toEqual([
      "url: https://staging.example.com/login",
      "username: qa-bot",
      `password: ${stagingPassword}`,
      "region: eu-west-1",
    ]);
  });

  it("does not pull in identity lines that are not adjacent to a secret", () => {
    expect(
      collect(user(["username: qa-bot", "", "unrelated notes", `password: ${stagingPassword}`].join("\n"))),
    ).toEqual([`password: ${stagingPassword}`]);
  });

  it("forwards credentials through later compactions, newest last, capped", () => {
    const first = collect(user(`API_TOKEN=${firstToken}`));
    const envelope: ChatMessage = {
      role: "system",
      content: [
        "DURABLE WORK ENVELOPE (canonical; authoritative over summarized narrative)",
        ...renderUserCredentials(first),
      ].join("\n"),
    };
    const second = collectUserCredentials(
      [envelope, user(`DB_PASSWORD=${secondPassword}`)],
      isDurableEnvelopeContent,
    );
    expect(second).toEqual([
      `API_TOKEN=${firstToken}`,
      `DB_PASSWORD=${secondPassword}`,
    ]);

    const many = collect(
      ...Array.from({ length: 20 }, (_, index) => user(`SERVICE_TOKEN_${index}=value_${String(index).padStart(12, "0")}`)),
    );
    expect(many).toHaveLength(16);
    expect(many.at(-1)).toContain("SERVICE_TOKEN_19");
  });

  it("never carries masked values or internal prompts", () => {
    expect(
      collect(
        user("API_KEY=sk_live_••••••••abcd"),
        user("API_KEY=[redacted]"),
        { role: "user", content: "SECRET_TOKEN=internal_value_000001", internal: true },
      ),
    ).toEqual([]);
  });

  it("renders the heading only when there is something to carry", () => {
    expect(renderUserCredentials([])).toEqual([]);
    expect(renderUserCredentials(["A=1b2c3d4e5f"])).toEqual([
      USER_CREDENTIALS_HEADING,
      "- A=1b2c3d4e5f",
    ]);
  });
});
