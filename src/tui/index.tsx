import { render } from "ink";
import { createElement } from "react";
import type { Mode, ProviderId } from "../types.js";
import { getConfig, getProviderModel } from "../store/config.js";
import { getCurrentVersion } from "../commands/update.js";
import { App } from "./App.js";

export interface StartTuiOptions {
  mode?: Mode | undefined;
  provider?: ProviderId | undefined;
  model?: string | undefined;
  noHistory?: boolean | undefined;
}

export async function startTui(opts: StartTuiOptions = {}): Promise<void> {
  const config = getConfig();
  const provider = opts.provider ?? config.defaultProvider;
  const model = opts.model ?? getProviderModel(provider);
  const mode = opts.mode ?? config.defaultMode;

  const app = render(
    createElement(App, {
      version: getCurrentVersion(),
      initialMode: mode,
      provider,
      initialModel: model,
    }),
    {
      // We own Ctrl+C handling (abort vs. exit), so Ink must not exit on it.
      exitOnCtrlC: false,
    },
  );

  await app.waitUntilExit();
}
