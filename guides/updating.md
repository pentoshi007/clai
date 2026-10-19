# Updating clai

[← Back to README](../README.md)

Run `/update` inside clai, or `clai update` from your terminal. The updater identifies the installation that launched the running process, including symlinks and Node-to-Bun handoffs; it does not choose another copy from `PATH`. Repeated `where clai` entries pointing to the same file do not create separate installations. A path such as `/opt/homebrew/bin/clai` alone does not establish Homebrew ownership.

| Installation | Update behavior |
| --- | --- |
| Official native binary or install script | Downloads for the running OS/architecture, checks SHA256 and executable version, then replaces the canonical executable. Failed post-install verification restores the previous executable. |
| Homebrew on macOS/Linux | Uses the owning Homebrew prefix, refreshes formulas, upgrades clai and verifies its stable executable path. |
| Identifiable global/local npm, Bun, pnpm or Yarn Classic package | Uses the owning package directory and manager, pins the requested version and verifies that installation's launcher. Local packages stay local. pnpm isolated bundles retain their installed sibling versions. |
| Scoop on Windows | Refreshes manifests and updates the owning user/global installation, then verifies it. |
| Source checkout | Requires a clean, upstream-tracking checkout of the official repository. Builds in an isolated worktree, fast-forwards and verifies; application failure restores the old checkout and build. |

Native assets support macOS, Linux and Windows on x64/ARM64. Homebrew and Scoop can install a newer formula/manifest version than the release initially checked; the updater verifies and reports the actual version. Unknown ownership, dirty/divergent source checkouts, unsupported custom pnpm bundle dependencies and unsafe percent-containing paths through unidentified Windows `.cmd` wrappers are refused with guidance rather than modifying a guessed installation. Package-manager updates follow that manager's installation semantics.

Configuration, history and stored credentials are not replaced. Protected POSIX installations use the masked administrator prompt or cached/noninteractive sudo; the plain CLI reports guidance instead of hanging for a hidden password. Cancellation is supported before native promotion; an atomic replacement already underway finishes verification or rollback.

Windows updates are **staged**, not reported as already installed. Close the running installation and reopen clai afterwards. The worker waits up to two minutes for that process and, for native binaries, other holders of the exact executable. It verifies the result and writes the persistent JSON receipt path shown by `/update` or `clai update`. Inspect that receipt for `applied` or `failed`; if waiting times out, close all instances and retry. Protected Windows installations may request UAC approval.

These updater changes describe the current `main` branch; an older packaged release does not acquire them until a new release is published.
