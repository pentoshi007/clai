import {
  appendProviderKey,
  getProviderKeys,
  markProviderKeySuccess,
  MAX_PROVIDER_KEYS,
  replaceProviderKey,
  setProviderKeyDisabled,
  setProviderKeys,
} from "../../store/keys.js";
import {
  encodeQoderCredential,
  parseQoderCredential,
  qoderCredentialMetadata,
  type QoderCredential,
} from "./qoder-credential.js";

let pendingMutation: Promise<void> = Promise.resolve();

export function withQoderAccountMutation<T>(run: () => Promise<T>): Promise<T> {
  const result = pendingMutation.then(run);
  pendingMutation = result.then(() => {}, () => {});
  return result;
}

export async function storeQoderAccount(credential: QoderCredential, activate = false): Promise<void> {
  await withQoderAccountMutation(async () => {
    const current = await getProviderKeys("qoder");
    const existing = current.source === "env" ? undefined : current.keys.find((slot) => {
      try {
        return Boolean(credential.uid) && parseQoderCredential(slot.value).uid === credential.uid;
      } catch {
        return false;
      }
    });
    const value = encodeQoderCredential(credential);
    const metadata = qoderCredentialMetadata(credential);
    if (existing) await replaceProviderKey("qoder", existing.value, value, metadata);
    else await appendProviderKey("qoder", value, metadata);
    if (!activate) return;
    await setProviderKeyDisabled("qoder", value, false);
    const updated = await getProviderKeys("qoder");
    const index = updated.keys.findIndex((slot) => slot.value === value);
    if (index >= 0) await markProviderKeySuccess("qoder", index);
  });
}

export interface QoderAccountRow {
  readonly slotId?: string | undefined;
  readonly value: string;
  readonly disabled?: boolean | undefined;
}

export async function saveQoderAccounts(rows: readonly QoderAccountRow[], activeIndex: number): Promise<void> {
  await withQoderAccountMutation(async () => {
    const current = await getProviderKeys("qoder");
    const byId = new Map(current.keys.map((slot) => [slot.id, slot.value]));
    const selectedIndex = Math.max(0, Math.min(activeIndex, rows.length - 1));
    const resolved = rows.flatMap((row, index) => {
      const value = row.slotId ? byId.get(row.slotId) : row.value.trim();
      if (!value) return [];
      parseQoderCredential(value);
      return [{ value, disabled: row.disabled === true, active: index === selectedIndex }];
    });
    if (resolved.length > MAX_PROVIDER_KEYS) throw new Error(`At most ${MAX_PROVIDER_KEYS} Qoder accounts.`);
    const resolvedActiveIndex = Math.max(0, resolved.findIndex((row) => row.active));
    await setProviderKeys("qoder", resolved.map((row) => row.value), resolvedActiveIndex,
      resolved.filter((row) => row.disabled).map((row) => row.value));
  });
}
