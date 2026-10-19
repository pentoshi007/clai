# Configuration and privacy

[← Back to README](../README.md)

`clai config` prints the configuration and its location. Use `clai mode`, `clai model`, and `clai use` to change defaults. History, prompt journals, logs, and runtime data normally live under `~/.clai/`; saved chat records include `history.jsonl`. Large outputs may also use per-session temporary directories.

```sh
clai privacy status
clai privacy on
clai privacy off
clai privacy retention 0
```

Private mode disables chat and prompt persistence and durable background attachment; `--no-history` applies to a single invocation. Retention defaults to `0` (unlimited saved sessions). These settings do not erase previously saved data. `clai privacy clear-history`, `clear-logs`, `clear-artifacts`, and `clear-all` explicitly delete retained data; the corresponding `/privacy` actions are available in the UI.

Credentials saved with `clai set` or account sign-in are retained in `~/.clai/keys.json`, a **plaintext** file with restricted permissions (`0600` on POSIX). clai also attempts to store them in the OS keyring when available; the local file is retained for recovery. Recognized secrets are masked or redacted in supported displays and storage paths, but review logs and transcripts before sharing them.

`/creds` is a separate encrypted store under `~/.clai/credentials/`. Add a nonsecret title and arbitrary multiline text (including SSH keys and tabs); Ctrl+S saves and Esc cancels in either UI. Entries can be edited, renamed, or deleted. `creds.list` exposes titles and IDs; `creds.get` deliberately discloses a selected freeform entry to the configured model provider, subject to the selected permission policy. Long entries are paged. Credential contents are not added to the system/tool prefix or written as tool-output artifacts. For a password-only entry, `terminal.send kind:"secret" credentialId:<id>` sends it directly without revealing it to the model.

The fixed **Machine sudo password** entry is never returned by `creds.get`. Privileged shell commands supply it directly to sudo stdin, including background commands and sessions with no attached UI. Rejected stored passwords fail without opening another prompt; update or remove the entry in `/creds`. An explicit local sudo terminal prompt can use `secretSource:"sudo"`. Windows administrator elevation still uses native UAC; a stored password cannot bypass Windows consent or account boundaries.

The vault uses AES-256-GCM. Its local master key is permission-restricted on Linux/macOS and protected with current-user DPAPI on Windows. Back up the vault and its matching key together; a missing or damaged key does not reset the store. On Linux/macOS, access to the account or both files defeats this at-rest protection. Arbitrary text can contain secrets that automatic redaction cannot infer, so do not share transcripts or logs without reviewing them. See [SECURITY.md](../SECURITY.md).

Cloud requests send the model's context and relevant tool results to the selected provider. Provider-specific metadata uploads, including OmniRush's optional lifecycle upload, are described in the [provider guide](../PROVIDERS.md#omnirush-lifecycle-uploads).
