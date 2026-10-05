import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { getFallbackKeysPath, getProviderKeys } from "../../src/store/keys.js";
import { parseQoderCredential } from "../../src/llm/qoder/qoder-credential.js";
import { getConfig } from "../../src/store/config.js";
import { getProvider, providerAuth } from "../../src/llm/router.js";
import type { installQoderRuntimeFetch } from "./qoder-runtime-fetch.js";

export type QoderUiKey = "escape" | "enter" | "up" | "down" | "activate" | "disable" | "remove" | "save" | "reset" | "refresh" | "add";
export interface QoderUiDriver {
  services: AppServices;
  frame(): Promise<string>;
  key(key: QoderUiKey): Promise<void>;
  paste(text: string): Promise<void>;
}

export async function exerciseQoderUi(driver: QoderUiDriver, fixture: ReturnType<typeof installQoderRuntimeFetch>): Promise<void> {
  const app = driver.services;
  const commands: Promise<boolean>[] = [];
  const invoke = (name: string) => { commands.push(app.commands.dispatch({ name, args: "qoder" })); };
  async function wait(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt++) {
      await driver.frame();
      if (await check()) return;
      await delay(10);
    }
    throw new Error(`Qoder UI did not reach ${label}: ${await driver.frame()}`);
  }
  async function waitOverlay(kind: string): Promise<void> {
    await wait(() => app.overlay.getState().kind === kind, kind);
    const state = app.overlay.getState();
    if (state.kind === "picker" || state.kind === "secret") await waitText(state.request.title);
    if (state.kind === "pager") await waitText(state.title);
    if (state.kind === "keys-editor") await waitText("account");
  }
  async function waitText(text: string): Promise<void> {
    await wait(async () => (await driver.frame()).toLowerCase().includes(text.toLowerCase()), text);
  }
  async function choose(text: string): Promise<void> {
    await waitOverlay("picker"); await driver.paste(text); await driver.key("enter");
  }
  async function authenticatePat(id: "a" | "b"): Promise<void> {
    await choose("PAT"); await waitOverlay("secret");
    const state = app.overlay.getState();
    assert.ok(state.kind === "secret" && !state.request.reveal);
    const pat = `fixture-pat-${id}`;
    await driver.paste(pat);
    assert.ok(!(await driver.frame()).includes(pat), "PAT must never be echoed");
    await driver.key("enter");
  }

  const defaultProvider = getConfig().defaultProvider;
  assert.equal((await getProviderKeys("qoder")).keys.length, 0);
  invoke("providers"); await waitOverlay("picker");
  let state = app.overlay.getState();
  assert.ok(state.kind === "picker" && state.request.options[0]?.value === "headless");
  const methods = await driver.frame();
  for (const text of ["browser", "headless", "PAT", "Import"]) assert.ok(methods.includes(text), methods);
  await choose("headless"); await waitOverlay("pager");
  await wait(() => fixture.observed.polls === 1, "pending device poll");
  state = app.overlay.getState();
  assert.ok(state.kind === "pager" && state.body.includes("https://qoder.com/device/selectAccounts"));
  await driver.key("escape"); await waitOverlay("picker");
  assert.equal(fixture.observed.abortedPolls, 1);
  await authenticatePat("a");
  await wait(() => app.session.getState().provider === "qoder", "provider activation");
  await wait(() => {
    const overlay = app.overlay.getState();
    return overlay.kind === "picker" && overlay.request.title.startsWith("Models");
  }, "signed model picker");
  await getProvider("qoder").ping?.(await providerAuth("qoder"));
  assert.equal(fixture.observed.profiles, 1); assert.ok(fixture.observed.models >= 2);
  await driver.key("escape"); await waitOverlay("none");
  let stored = await getProviderKeys("qoder");
  assert.equal(stored.keys.length, 1);
  const first = stored.keys[0]!;
  assert.equal(parseQoderCredential(first.value).uid, "account-a");
  assert.equal(getConfig().defaultProvider, defaultProvider);

  invoke("set"); await waitOverlay("keys-editor");
  const accountsFrame = await driver.frame();
  assert.ok(accountsFrame.includes("account-a@test.invalid"), accountsFrame);
  assert.ok(!accountsFrame.includes("fixture-access"));
  assert.ok(!accountsFrame.includes("from models"));
  await driver.key("add"); await waitOverlay("picker");
  await authenticatePat("b"); await waitOverlay("keys-editor");
  stored = await getProviderKeys("qoder");
  assert.equal(stored.keys.length, 2);
  const sibling = stored.keys[1]!;
  assert.equal(parseQoderCredential(sibling.value).uid, "account-b");
  await driver.key("down"); await driver.key("activate");
  await driver.key("up"); await driver.key("disable"); await driver.key("save");
  await waitOverlay("none");
  await wait(async () => {
    const saved = await getProviderKeys("qoder");
    return saved.activeIndex === 1 && saved.keys[0]?.disabled === true;
  }, "active and disabled account persistence");
  stored = await getProviderKeys("qoder");
  assert.equal(stored.activeIndex, 1); assert.equal(stored.keys[0]?.disabled, true);

  invoke("set"); await waitOverlay("keys-editor"); await driver.key("refresh");
  await wait(() => fixture.exchanges.a === 2, "manual PAT refresh"); await waitOverlay("keys-editor");
  stored = await getProviderKeys("qoder");
  assert.equal(stored.keys[0]?.id, first.id); assert.equal(stored.keys[0]?.createdAt, first.createdAt);
  assert.equal(stored.keys[0]?.disabled, true); assert.equal(stored.activeIndex, 1);
  assert.notEqual(parseQoderCredential(stored.keys[0]!.value).accessToken, parseQoderCredential(first.value).accessToken);
  assert.equal(stored.keys[1]?.value, sibling.value);
  await driver.key("remove"); await driver.key("save"); await waitOverlay("none");
  stored = await getProviderKeys("qoder");
  assert.equal(stored.keys.length, 1); assert.equal(stored.keys[0]?.id, sibling.id); assert.equal(stored.activeIndex, 0);

  invoke("set"); await waitOverlay("keys-editor"); await driver.key("escape"); await waitOverlay("none");
  assert.equal((await getProviderKeys("qoder")).keys.length, 1);
  assert.equal((await stat(getFallbackKeysPath())).mode & 0o777, 0o600);
  invoke("set"); await waitOverlay("keys-editor"); await driver.key("reset"); await waitOverlay("none");
  assert.equal((await getProviderKeys("qoder")).keys.length, 0);
  assert.equal(app.focus.activeContext(), "composer");
  await driver.paste("still responsive");
  await waitText("still responsive");
  await Promise.all(commands);
}
