# Android, iOS and desktop clients

Use for mobile/desktop security assessments and shipped artifacts. Separate client-local guarantees from backend enforcement and analysis-environment limitations. OWASP MASVS describes controls; MASTG supplies testing procedures. Consult current platform behavior for the target OS/SDK rather than applying legacy advice unchanged.

## Establish the exact artifact and environment

Record package/bundle ID, version/build, artifact hash, signing identity, architecture, minimum/target SDK or OS, distribution channel and relevant entitlements/permissions. Verify which device/emulator, profile and app instance the tools address. Preserve an original copy and analyze a working copy.

Map app -> OS/IPC -> local storage/key service -> network/backend -> third-party SDKs. Discover normal workflows and deep links, background services, local HTTP/IPC endpoints, extensions, notifications, update and recovery paths. Include native libraries, JavaScript bridges and WebViews. Backend APIs belong in [web and API](web-api.md), not just the mobile checklist.

Use available artifact-analysis tooling when appropriate. In clai, check REA availability and enable its shipped-artifact workflow when it applies; do not make REA a hard dependency, and do not send ordinary source repositories to a binary-analysis workflow. Otherwise choose installed unpackers, disassemblers, decompilers and instrumentation suited to the artifact.

## Android hypotheses

| Surface | Questions that distinguish a bug | Evidence to seek |
| --- | --- | --- |
| Exported activities/services/receivers/providers | Can a different unprivileged app invoke sensitive behavior? Are permissions and caller identity checked at the right stage? | Controlled second-app/IPC invocation, actual permission context and consequence |
| Intents/deep links/app links | Can URI parsing, link ownership, task behavior or nested intent forwarding cross trust? | Complete entry -> transformation -> privileged action trace on the supported OS |
| Content/file providers and URI grants | Can caller-supplied path/URI or grant lifetime expose unintended files or objects? | Own sentinel accessed beyond intended scope; distinguish temporary grant from general access |
| PendingIntent and callbacks | Can another party modify, replay or redirect a privileged pending operation? | Concrete creator/recipient privileges, mutability and accepted altered action |
| WebView/JS bridges | Which origins can load, navigate and call native methods? Are messages origin/caller-bound? | Harmless untrusted content invoking a privileged bridge, not merely JavaScript enabled |
| Storage/backup/logs/clipboard/notifications | What lower-privilege or physical attacker can obtain sensitive state? | Non-root threat-model access or explicitly labeled rooted-device scenario |
| Keystore and local authentication | Is authentication cryptographically bound to key use and sensitive action? | Show the action succeeds under the actual attacker model, not only UI bypass |
| Network and signing/update | Is trust validation correct? Can a less-trusted update/plugin become code? | Original release behavior and artifact trust chain, not behavior created only by analyst patching |

Manifest flags, exported components and embedded strings are leads. Export can be intentional; a browser API key may be public; use of a weak primitive may protect non-security data. Trace reachability and impact before reporting.

## iOS hypotheses

Inspect entitlements, keychain accessibility/access groups, data protection classes, app groups/extensions, URL schemes/universal links, pasteboard/shares, WebViews/message handlers, network trust, local auth and update/signing assumptions. Check where OS-managed identity ends and app-supplied data begins.

Validate access on the relevant OS, lock state and device class. A jailbroken device can observe data that the supported production attacker cannot; report that precondition explicitly. A missing resilience technique or successful hook is not automatically an exploitable vulnerability.

## Desktop/Electron/Tauri and local services

Map renderer/web content -> preload/bridge -> privileged main process/plugin -> OS. Inspect navigation/window creation, sandbox/context isolation, Node exposure, IPC method permissions and sender/origin binding, custom protocols, file handlers, extensions and local service authentication.

For each IPC operation ask: who can call it, what input controls path/command/URL, what validation survives serialization, and whose authority executes it? Origin checks on the main window may not cover newly opened windows, custom schemes, frames or forwarded messages. Bridge exposure alone is not exploitation; show a lower-trust caller reaching a sensitive primitive.

Trace updater and installer trust: signer, artifact integrity, channel selection, rollback, writable staging paths, extraction, privilege elevation and restart behavior. A TLS URL alone is not the whole update guarantee. Use controlled artifacts; never ship a malicious update to users.

## Dynamic proof without confusing the threat model

Observe original behavior first. Interception, pinning bypass, hooks, repackaging and debug builds can help inspect internal paths but may remove the very control being assessed. Keep analyst-created capabilities separate from attacker capabilities. Reproduce the security effect in an unmodified supported configuration, or clearly state that the conclusion is limited to the instrumented build.

Use test accounts, canary files and an isolated device/profile. Avoid logging real tokens, accessing unrelated apps' data or retaining personal device captures. A finding should name package/build, OS, caller capability, trigger, observed boundary crossing, relevant logs/traces and cleanup.

## Variant and regression paths

After a confirmed component/bridge bug examine sibling components, equivalent methods, background paths, URI variants, secondary windows and shared libraries. Compare debug/release, upgrade/new install and supported OS differences when they change enforcement.

Retest legitimate flows and the exact lower-trust caller after remediation. Mark unavailable physical devices, entitlements, hardware-backed key behavior and backend roles as gaps. Emulator success or failure does not cover all supported devices.
