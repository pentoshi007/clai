import type { AppServices } from "../bootstrap/composition-root.js";
import type { KeysEditorAnswer } from "../controllers/overlay-controller.js";
import {
  getSubagentModelChain,
  setSubagentModelChain,
  MAX_SUBAGENT_MODELS,
  type SubagentModelEntry,
} from "../../store/config.js";
import { collectAllModels, CATALOG_SEPARATOR } from "./picker-commands.js";

interface DraftRow {
  readonly slotId?: string | undefined;
  readonly value: string;
  readonly disabled?: boolean | undefined;
}

function editorRows(rows: readonly DraftRow[]): readonly { id: string; masked: string; disabled?: boolean }[] {
  return rows.map((row, index) => ({
    id: row.slotId ?? `draft-${index}-${row.value}`,
    masked: row.value,
    ...(row.disabled ? { disabled: true } : {}),
  }));
}

function routeFromRow(row: DraftRow): SubagentModelEntry | undefined {
  const id = row.slotId ?? "";
  const separator = id.indexOf(CATALOG_SEPARATOR);
  if (separator <= 0) return undefined;
  const provider = id.slice(0, separator).trim();
  const model = id.slice(separator + CATALOG_SEPARATOR.length).trim();
  return provider && model ? { provider, model, ...(row.disabled ? { disabled: true } : {}) } : undefined;
}

async function pickModel(
  services: AppServices,
  rows: readonly DraftRow[],
): Promise<string | undefined> {
  const fetching = services.toast.info("collecting models from all providers…", {
    key: "subagent-models-fetch",
    sticky: true,
  });
  const result = await collectAllModels();
  services.toast.dismiss(fetching);
  if (result.failed.length > 0) {
    services.session.notice("warn", `could not refresh ${result.failed.join(", ")} · showing known models`);
  }
  if (result.entries.length === 0) {
    services.session.notice("warn", "no models found — configure a provider key with /set first");
    return undefined;
  }
  const existing = new Set(rows.map((row) => row.slotId).filter((id): id is string => Boolean(id)));
  return new Promise((resolve) => {
    let settled = false;
    let stop = (): void => undefined;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      stop();
      resolve(value);
    };
    stop = services.overlay.subscribe(() => {
      if (services.overlay.getState().kind === "none") finish(undefined);
    });
    const opened = services.overlay.openPicker(
      {
        title: "Subagent models · catalogue",
        twoLine: true,
        searchDescription: true,
        options: result.entries.map((entry) => ({
          value: `${entry.provider}${CATALOG_SEPARATOR}${entry.model}`,
          label: `${entry.provider} / ${entry.model}`,
          description: entry.live ? "live catalogue" : "known models",
          active: existing.has(`${entry.provider}${CATALOG_SEPARATOR}${entry.model}`),
        })),
      },
      (value) => {
        finish(value);
        services.overlay.close();
      },
    );
    if (!opened) finish(undefined);
  });
}

function summary(chain: ReturnType<typeof getSubagentModelChain>): string {
  if (!chain?.entries.length) return "not set · subagents follow the session route";
  const active = chain.entries[chain.activeIndex] ?? chain.entries[0]!;
  return `main ${active.provider}/${active.model} · ${Math.max(0, chain.entries.length - 1)} fallback${chain.entries.length === 2 ? "" : "s"}`;
}

export async function openSubagentModelEditor(services: AppServices): Promise<void> {
  const configured = getSubagentModelChain();
  let rows: DraftRow[] = configured?.entries.map((entry) => ({
    slotId: `${entry.provider}${CATALOG_SEPARATOR}${entry.model}`,
    value: `${entry.provider} / ${entry.model}`,
    ...(entry.disabled ? { disabled: true } : {}),
  })) ?? [];
  let activeIndex = configured?.activeIndex ?? 0;
  for (;;) {
    const answer = await services.overlay.openKeysEditor({
      provider: "subagents",
      initialKeys: editorRows(rows),
      activeIndex,
      itemLabel: "model",
      heading: "SUBAGENT MODELS",
      addViaPicker: true,
      maxRows: MAX_SUBAGENT_MODELS,
    });
    if (!answer) return;
    if (answer.action === "reset") {
      setSubagentModelChain([]);
      services.session.notice("info", "subagent models reset · subagents follow the session route");
      return;
    }
    if (answer.action === "refresh") return;
    if (answer.action === "pick") {
      rows = answer.rows.map((row) => ({ ...row }));
      activeIndex = answer.activeIndex ?? activeIndex;
      const picked = await pickModel(services, rows);
      if (picked && !rows.some((row) => row.slotId === picked)) {
        const separator = picked.indexOf(CATALOG_SEPARATOR);
        const label = `${picked.slice(0, separator)} / ${picked.slice(separator + CATALOG_SEPARATOR.length)}`;
        rows = [...rows, { slotId: picked, value: label }];
      }
      continue;
    }
    rows = answer.rows.map((row) => ({ ...row }));
    activeIndex = answer.activeIndex ?? 0;
    const entries = rows.flatMap((row) => {
      const entry = routeFromRow(row);
      return entry ? [entry] : [];
    });
    const saved = setSubagentModelChain(entries, activeIndex);
    if (!saved) {
      services.session.notice("info", "subagent models cleared · subagents follow the session route");
      return;
    }
    services.session.notice("info", `subagent models → ${summary(saved)} · applies to new attempts`);
    return;
  }
}
