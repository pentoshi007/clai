# Security policy

## Supported releases

Security fixes are delivered in the latest maintained release. Update to the [latest release](https://github.com/pentoshi007/clai/releases/latest) before reproducing an issue when practical. Older releases do not have a guaranteed backport schedule.

## Reporting a vulnerability

GitHub private vulnerability reporting is currently disabled for this repository, and no dedicated security email address is published. To arrange a private reporting channel, open a [security contact request](https://github.com/pentoshi007/clai/issues/new?template=security_contact.yml) directed to [pentoshi007](https://github.com/pentoshi007). Include only a general description of the affected component and a request for private contact. Do not post exploit details, credentials, or private data in that issue.

Once a private channel is established, include:

- The clai version, OS, installation method, and affected component.
- Reproduction steps or a minimal proof of concept.
- Expected behavior, actual behavior, and potential impact.
- Relevant configuration, permission mode, or engagement scope with secrets removed.
- A suggested fix, if available.

Coordinate disclosure with the maintainer while the report is validated and a fix is prepared. Response and remediation times depend on severity and maintainer availability. Reporters can request attribution or remain anonymous.

## Execution and storage boundaries

clai executes tools with the privileges of the user running it. Tool classification, confirmation prompts, mode restrictions, and engagement scope are application policies; they are not an OS sandbox.

Fresh configurations use **full-access** permissions. Confirmation behavior varies between `default`, `auto-allow`, and `full-access`; deletion is not universally subject to a prompt. See [modes and permissions](guides/usage.md#modes-and-permissions) for the user-facing policy. Hard safety blocks and configured scope checks still apply.

Saved API credentials and account tokens are retained in **plaintext** at `~/.clai/keys.json`, with restricted permissions (`0600` on POSIX). The OS keyring is also used when available, but the recovery file remains on disk. Access by the same user or a privileged process is outside that file's protection boundary.

The separate `/creds` vault uses authenticated AES-256-GCM encryption. On Linux/macOS, its master key is a local `0600` file in a `0700` credential directory; this does not defend against an attacker who can read both files, the same account, or root. On Windows the master key is sealed with current-user DPAPI. Losing the key makes the vault unreadable; corruption and key failures do not silently replace stored data. Backups must include the matching key, and Windows DPAPI recovery also depends on the account's protection material.

`creds.list` returns metadata only. `creds.get` deliberately sends a selected freeform credential to the configured model provider, according to the chosen permission policy; its result is excluded from normal UI, hooks, audit bodies, and output artifacts. Known values are registered for persistence redaction, but arbitrary freeform content and transformations cannot be exhaustively identified. Machine sudo passwords cannot be retrieved by the model and are sent only through the local secret-input path. Native Windows UAC remains an OS boundary.

History, prompt journals, logs, and tool artifacts can contain project data and command results. Private mode and `--no-history` disable chat persistence but do not erase previously saved data or prevent necessary provider requests. Recognized secrets are redacted in supported paths; this is not a guarantee that every arbitrary secret is removed.

Hosted providers receive the request context and relevant tool results. MCP servers, shell commands, and installed skills can interact with external services according to their configuration. OmniRush's optional metadata upload is described in [PROVIDERS.md](PROVIDERS.md#omnirush-lifecycle-uploads).

Use [GitHub Issues](https://github.com/pentoshi007/clai/issues) for ordinary bugs that do not disclose a vulnerability. Review any diagnostic material before publishing it.
