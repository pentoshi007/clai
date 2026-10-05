import assert from "node:assert/strict";
import { join } from "node:path";
import { getFallbackKeysPath } from "../../src/store/keys.js";

export function installQoderRuntimeFetch() {
  const home = process.env.CLAI_QODER_FIXTURE_HOME;
  assert.ok(home);
  assert.equal(process.env.HOME, home);
  assert.equal(process.env.CLAI_DISABLE_KEYCHAIN, "1");
  assert.equal(getFallbackKeysPath(), join(home, ".clai", "keys.json"));
  const original = globalThis.fetch;
  const exchanges = { a: 0, b: 0 };
  const observed = { polls: 0, abortedPolls: 0, profiles: 0, models: 0 };
  const json = (body: object) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, "https://openapi.qoder.sh", "runtime fixture must not access external services");
    if (url.pathname === "/api/v1/deviceToken/poll") {
      observed.polls++;
      assert.ok(init?.signal);
      const signal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        const cancel = () => { observed.abortedPolls++; reject(signal.reason); };
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
    }
    if (url.pathname === "/api/v1/jobToken/exchange") {
      const payload: { personal_token: string } = JSON.parse(String(init?.body));
      assert.match(payload.personal_token, /^fixture-pat-[ab]$/);
      const id = payload.personal_token.endsWith("a") ? "a" : "b";
      const revision = ++exchanges[id];
      return json({ token: `fixture-access-${id}-${revision}`, expires_in: 3600 });
    }
    if (url.pathname === "/api/v1/userinfo") {
      observed.profiles++;
      const token = new Headers(init?.headers).get("Authorization") ?? "";
      const match = /^Bearer fixture-access-([ab])-\d+$/.exec(token);
      assert.ok(match, "profile verification must only use fixture credentials");
      return json({ id: `account-${match[1]}`, email: `account-${match[1]}@test.invalid`, data_policy_agreed: true });
    }
    if (url.pathname === "/algo/api/v2/model/list") {
      observed.models++;
      return json({ chat: [{ key: "qfmodel", is_free: true }] });
    }
    throw new Error(`Unexpected Qoder runtime fixture request: ${url.pathname}`);
  };
  return { exchanges, observed, restore: () => { globalThis.fetch = original; } };
}
