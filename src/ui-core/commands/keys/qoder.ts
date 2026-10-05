import { ProviderError } from "../../../llm/http.js";
import { QoderAuthError } from "../../../llm/qoder/qoder-auth.js";
import {
  saveQoderAccounts,
  storeQoderAccount,
  withQoderAccountMutation,
} from "../../../llm/qoder/qoder-accounts.js";
import {
  parseQoderCredential,
  qoderAccountLabel,
  type QoderCredential,
} from "../../../llm/qoder/qoder-credential.js";
import {
  canOpenQoderBrowser,
  importQoderAccount,
  loginQoderWithPat,
  pollQoderDeviceAuth,
  QODER_PAT_URL,
  startQoderDeviceAuth,
} from "../../../llm/qoder/qoder-login.js";
import { refreshQoderAccount } from "../../../llm/qoder/qoder-refresh.js";
import { openSystemBrowser } from "../../../mcp/auth/loopback.js";
import { getProviderKeys, MAX_PROVIDER_KEYS, unsetProviderSecret } from "../../../store/keys.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { PickerOption } from "../../rendering/picker-filter.js";
import { pickAuthMethod } from "./auth-picker.js";
import { notice } from "./editors.js";

function authOptions(): PickerOption[] {
  const browser: PickerOption = {
    value: "browser",
    label: "Sign in with Qoder (browser)",
    description: "open the Qoder account selector in your local browser",
  };
  const headless: PickerOption = {
    value: "headless",
    label: "Sign in with Qoder (headless)",
    description: "open a secure link on any device — works over SSH",
  };
  const options = canOpenQoderBrowser() ? [browser, headless] : [headless, browser];
  return [...options, {
    value: "pat",
    label: "Use a personal access token (PAT)",
    description: "paste a token from qoder.com/account/integrations",
  }, {
    value: "import",
    label: "Import an existing Qoder CLI sign-in",
    description: "reuse qodercli credentials on this machine",
  }];
}

async function runLoginWithPager(
  services: AppServices,
  run: (signal: AbortSignal, show: (body: string) => void) => Promise<QoderCredential>,
): Promise<QoderCredential | undefined> {
  const title = "Qoder sign-in";
  if (!services.overlay.openPager(title, "Preparing Qoder sign-in…", undefined, undefined, "plain")) return undefined;
  const controller = new AbortController();
  const ownsPager = () => {
    const state = services.overlay.getState();
    return state.kind === "pager" && state.title === title;
  };
  const unsubscribe = services.overlay.subscribe(() => {
    if (!ownsPager()) controller.abort();
  });
  const waiting = services.toast.info("waiting for Qoder authentication…", { sticky: true });
  try {
    const credential = await run(controller.signal, (body) => {
      if (ownsPager() && !controller.signal.aborted) services.overlay.replacePagerBody(body);
    });
    controller.signal.throwIfAborted();
    notice(services, "info", `Qoder authenticated · ${credential.email ?? credential.name ?? credential.uid ?? "account"}`);
    return credential;
  } catch (error) {
    if (!controller.signal.aborted) {
      notice(services, "warn", `Qoder sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  } finally {
    unsubscribe();
    services.toast.dismiss(waiting);
    if (ownsPager()) services.overlay.close();
  }
}

async function runDeviceLogin(services: AppServices, browser: boolean): Promise<QoderCredential | undefined> {
  return runLoginWithPager(services, async (signal, show) => {
    const start = await startQoderDeviceAuth({ signal });
    show([
      browser ? "Opening Qoder sign-in in your browser…" : "Open this secure Qoder link on any device:",
      "",
      start.authUrl,
      "",
      "Choose your Qoder account and approve access.",
      "clai will continue automatically after approval (3-minute timeout).",
      "",
      "Close this pager to go back and use a personal access token instead.",
    ].join("\n"));
    if (browser && !signal.aborted) {
      void openSystemBrowser(start.authUrl).catch(() => {
        if (!signal.aborted) notice(services, "info", "Could not open a browser. Open the displayed link manually, or go back to use a PAT.");
      });
    }
    return pollQoderDeviceAuth(start, { signal });
  });
}

export async function runQoderAuthForUI(services: AppServices): Promise<QoderCredential | undefined> {
  for (;;) {
    const method = await pickAuthMethod(services, { title: "Qoder sign-in method", options: authOptions() });
    if (!method) return undefined;
    if (method === "browser" || method === "headless") {
      const credential = await runDeviceLogin(services, method === "browser");
      if (credential) return credential;
      continue;
    }
    if (method === "pat") {
      const pat = await services.overlay.openSecret({
        title: "Qoder personal access token",
        prompt: `Create a PAT at ${QODER_PAT_URL}\nPaste your personal access token below:`,
      });
      if (!pat?.trim()) continue;
      const credential = await runLoginWithPager(services, (signal) => loginQoderWithPat(pat, { signal }));
      if (credential) return credential;
      continue;
    }
    const credential = await runLoginWithPager(services, async (_signal, show) => {
      show("Importing your existing Qoder CLI sign-in…\nClose this pager to cancel and choose another sign-in method.");
      return importQoderAccount();
    });
    if (credential) return credential;
  }
}

async function refreshAccountForUI(services: AppServices, slotId: string): Promise<void> {
  const current = await getProviderKeys("qoder");
  const slot = current.keys.find((key) => key.id === slotId);
  if (!slot) throw new QoderAuthError("Qoder account was not found.");
  const stored = parseQoderCredential(slot.value);
  try {
    notice(services, "info", "refreshing Qoder account…");
    const fresh = await refreshQoderAccount(slotId);
    notice(services, "info", `refreshed Qoder account · ${fresh.email ?? fresh.name ?? fresh.uid ?? "account"}`);
    return;
  } catch (error) {
    const rejected = (error instanceof QoderAuthError || error instanceof ProviderError) && error.status === 401;
    if (!rejected) throw error;
    notice(services, "info", "Qoder requires a new sign-in for this account.");
  }
  const fresh = await runQoderAuthForUI(services);
  if (!fresh) return;
  if (!stored.uid || fresh.uid !== stored.uid) {
    throw new QoderAuthError("Signed in as a different Qoder account. Use Add account instead; the selected account was not changed.");
  }
  await storeQoderAccount(fresh);
  notice(services, "info", "Qoder account sign-in refreshed");
}

export async function openQoderKeysFlow(services: AppServices): Promise<void> {
  for (;;) {
    const multi = await getProviderKeys("qoder");
    const keys = multi.source === "env" ? [] : multi.keys;
    const activeIndex = multi.source === "env" ? 0 : multi.activeIndex;
    const answer = await services.overlay.openKeysEditor({
      provider: "qoder",
      heading: "QODER ACCOUNTS",
      itemLabel: "account",
      addViaPicker: true,
      refreshable: true,
      maxRows: MAX_PROVIDER_KEYS,
      initialKeys: keys.map((key) => ({ id: key.id, masked: qoderAccountLabel(key.value), disabled: key.disabled === true })),
      activeIndex,
    });
    if (!answer) return;
    try {
      if (answer.action === "reset") {
        await withQoderAccountMutation(() => unsetProviderSecret("qoder"));
        notice(services, "info", "removed all Qoder accounts");
        return;
      }
      if (answer.action === "pick") {
        await saveQoderAccounts(answer.rows, answer.activeIndex ?? activeIndex);
        const credential = await runQoderAuthForUI(services);
        if (credential) await storeQoderAccount(credential);
        continue;
      }
      if (answer.action === "refresh") {
        if (answer.rows) await saveQoderAccounts(answer.rows, answer.activeIndex ?? activeIndex);
        await refreshAccountForUI(services, answer.slotId);
        continue;
      }
      await saveQoderAccounts(answer.rows, answer.activeIndex ?? activeIndex);
      notice(services, "info", "saved Qoder accounts");
      return;
    } catch (error) {
      notice(services, "warn", error instanceof Error ? error.message : String(error));
    }
  }
}
