import type { AppServices } from "../bootstrap/composition-root.js";
import {
  deleteCredential,
  getCredential,
  listCredentials,
  machineSudoId,
  saveCredential,
  setMachineSudoPassword,
  type CredentialSummary,
} from "../../store/credentials.js";
import { evictSudoSession } from "../../tools/sudo-session.js";

type Services = { readonly overlay: AppServices["overlay"]; readonly session: Pick<AppServices["session"], "notice"> };

async function safely(services: Services, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    services.session.notice("warn", error instanceof Error ? error.message : "Credential operation failed; no credentials were changed.");
  }
}

async function editEntry(services: Services, id?: string): Promise<void> {
  const previous = id ? await getCredential(id) : undefined;
  if (id && !previous) throw new Error("Credential no longer exists.");
  const title = previous?.title ?? await services.overlay.openTextEditor({
    title: "Credential title",
    prompt: "Enter a short, nonsecret title. Ctrl+S continues; Esc cancels.",
    submitLabel: "continue",
  });
  if (title === undefined) return;
  const content = await services.overlay.openTextEditor({
    title: `Credential · ${title.trim()}`,
    prompt: "Freeform private text: login details, SSH keys, notes. Ctrl+S saves locally; Esc cancels.",
    initialValue: previous?.content,
    placeholder: "username, password, host, SSH key, or any multiline text",
    preserveTabs: true,
  });
  if (content === undefined) return;
  await saveCredential({ id, title, content });
  services.session.notice("info", "credential saved · explicit agent retrieval may send it to your configured model provider");
}

async function renameEntry(services: Services, entry: CredentialSummary): Promise<void> {
  const previous = await getCredential(entry.id);
  if (!previous) throw new Error("Credential no longer exists.");
  const title = await services.overlay.openTextEditor({
    title: "Rename credential", prompt: "Enter a nonsecret, single-line title.", initialValue: previous.title,
  });
  if (title !== undefined) await saveCredential({ id: entry.id, title, content: previous.content });
}

async function removeEntry(services: Services, id: string): Promise<void> {
  if (!await services.overlay.openConfirm({ kind: "reset", prompt: "Delete this stored credential? This cannot be undone." })) return;
  await deleteCredential(id);
  if (id === machineSudoId()) evictSudoSession();
  services.session.notice("info", "credential deleted");
}

async function editSudo(services: Services): Promise<void> {
  const password = await services.overlay.openSecret({
    title: "Machine sudo password",
    prompt: process.platform === "win32"
      ? "Stored privately for explicit sudo-compatible prompts. Windows administrator elevation still uses native UAC; this does not bypass it. Esc cancels."
      : "Stored encrypted for this machine and supplied directly to sudo without prompting. It is never revealed to the model. Esc cancels.",
  });
  if (password === undefined) return;
  await setMachineSudoPassword(password);
  evictSudoSession();
  services.session.notice("info", "machine sudo password saved");
}

function entryActions(services: Services, entry: CredentialSummary): void {
  services.overlay.openPicker({
    title: entry.title,
    options: [
      { value: "edit", label: "Edit private text" },
      { value: "rename", label: "Rename title" },
      { value: "delete", label: "Delete credential" },
    ],
  }, (action) => {
    services.overlay.close();
    void safely(services, async () => {
      if (action === "edit") await editEntry(services, entry.id);
      if (action === "rename") await renameEntry(services, entry);
      if (action === "delete") await removeEntry(services, entry.id);
    });
  });
}

export async function handleCreds(services: Services): Promise<void> {
  await safely(services, async () => {
    const entries = await listCredentials();
    const sudoSet = entries.some((entry) => entry.id === machineSudoId());
    services.overlay.openPicker({
      title: "Credentials · encrypted local store",
      twoLine: true,
      options: [
        { value: "add", label: "Add credential", description: "A title and arbitrary multiline private text" },
        { value: "sudo", label: "Machine sudo password", description: sudoSet ? "Configured · replace password" : "Not configured · set password" },
        ...(sudoSet ? [{ value: "delete-sudo", label: "Remove machine sudo password" }] : []),
        ...entries.filter((entry) => entry.kind === "freeform").map((entry) => ({ value: entry.id, label: entry.title, description: "Edit, rename, or delete · private text hidden" })),
      ],
    }, (value) => {
      services.overlay.close();
      void safely(services, async () => {
        if (value === "add") return editEntry(services);
        if (value === "sudo") return editSudo(services);
        if (value === "delete-sudo") return removeEntry(services, machineSudoId());
        const entry = entries.find((candidate) => candidate.id === value);
        if (entry) entryActions(services, entry);
      });
    });
  });
}
