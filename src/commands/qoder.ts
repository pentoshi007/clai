import { askChoice, askSecret } from "../noninteractive/readline-prompts.js";
import { assertProvider } from "../llm/provider.js";
import { storeQoderAccount } from "../llm/qoder/qoder-accounts.js";
import type { QoderCredential } from "../llm/qoder/qoder-credential.js";
import {
  canOpenQoderBrowser,
  importQoderAccount,
  loginQoderWithPat,
  pollQoderDeviceAuth,
  QODER_PAT_URL,
  startQoderDeviceAuth,
} from "../llm/qoder/qoder-login.js";
import { openSystemBrowser } from "../mcp/auth/loopback.js";
import { getFallbackKeysPath, getProviderKeys } from "../store/keys.js";

interface QoderAuthOptions {
  import?: boolean | undefined;
  browser?: boolean | undefined;
  headless?: boolean | undefined;
  pat?: boolean | undefined;
}

type QoderAuthMethod = "browser" | "headless" | "pat" | "import";

async function pickMethod(options: QoderAuthOptions): Promise<QoderAuthMethod | undefined> {
  if (options.import) return "import";
  if (options.pat) return "pat";
  if (options.headless) return "headless";
  if (options.browser) return "browser";
  if (!process.stdin.isTTY) return "headless";
  const choices: Array<{ name: string; value: QoderAuthMethod }> = [
    { name: "Sign in with Qoder (browser)", value: "browser" },
    { name: "Sign in with Qoder (headless / SSH)", value: "headless" },
    { name: "Use a personal access token (PAT)", value: "pat" },
    { name: "Import Qoder CLI sign-in", value: "import" },
  ];
  if (!canOpenQoderBrowser()) [choices[0], choices[1]] = [choices[1]!, choices[0]!];
  return askChoice("Qoder sign-in method:", choices);
}

async function acquireCredential(method: QoderAuthMethod, signal: AbortSignal): Promise<QoderCredential | undefined> {
  if (method === "import") return importQoderAccount();
  if (method === "pat") {
    const pat = await askSecret(`Create a PAT at ${QODER_PAT_URL}\nPaste your Qoder personal access token:`, { signal });
    return pat ? loginQoderWithPat(pat, { signal }) : undefined;
  }
  const start = await startQoderDeviceAuth({ signal });
  process.stderr.write(`Open this Qoder sign-in link on any device:\n${start.authUrl}\nWaiting for approval (3-minute timeout). Ctrl-C cancels.\n`);
  if (method === "browser" && canOpenQoderBrowser()) {
    await openSystemBrowser(start.authUrl).catch(() => {
      process.stderr.write("Could not open a browser; open the link manually.\n");
    });
  }
  return pollQoderDeviceAuth(start, { signal });
}

export async function authQoder(providerValue: string, options: QoderAuthOptions = {}): Promise<void> {
  if (assertProvider(providerValue) !== "qoder") throw new Error("Qoder authentication requires the qoder provider.");
  let method = await pickMethod(options);
  if (!method) return;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Qoder sign-in cancelled"));
  process.once("SIGINT", cancel);
  try {
    let credential: QoderCredential | undefined;
    for (;;) {
      try {
        credential = await acquireCredential(method, controller.signal);
        break;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!process.stdin.isTTY) throw error;
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        method = await pickMethod({});
        if (!method) return;
      }
    }
    if (!credential || controller.signal.aborted) return;
    await storeQoderAccount(credential);
    const multi = await getProviderKeys("qoder");
    if (multi.source === "fallback") {
      process.exitCode = 3;
      process.stderr.write(`Warning: OS keychain unavailable; stored in ${getFallbackKeysPath()} with restricted permissions.\n`);
    }
    console.log(`authenticated qoder (${credential.email ?? credential.name ?? credential.uid ?? "account"}) · ${multi.keys.length} account${multi.keys.length === 1 ? "" : "s"}`);
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}
