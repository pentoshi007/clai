# Wireless, embedded devices, IoT and OT

Use for radio, firmware and physical/process-connected systems. The test boundary is not just an IP address: include devices, radio identifiers, frequencies, physical location, ownership and process impact. NIST WLAN guidance supplies lifecycle context, not modern WPA3 implementation details; research the observed chipset/firmware/protocol.

## Wireless: observe the real deployment

Establish available adapters, bands, driver/mode support, capture quality, channel/time coverage and target BSSIDs or equivalent device IDs. Passive visibility is incomplete; an empty capture can mean wrong channel, missing hardware capability, weak signal or sleeping clients. Do not call that absence of wireless exposure.

Separate intended network policy from negotiated behavior. Inventory APs/clients, SSIDs/BSSIDs, security/authentication suites, management-frame protection, enterprise certificate validation, roaming, provisioning, captive portal and guest-to-internal segmentation. SSID names and physical proximity do not establish ownership.

| Observed design | Hypothesis | Bounded proof |
| --- | --- | --- |
| Enterprise Wi-Fi/EAP | Client trusts incorrect server identity, weak enrollment/profile delivery | Controlled test client/profile and agreed test AP; confirm credential/auth boundary without capturing others' secrets |
| Mixed/transition security | Downgrade or legacy behavior contradicts intended guarantees | Capture actual negotiated suite and reproduce on the relevant client/AP firmware |
| Guest/captive portal | Portal bypass, client isolation or wired-network boundary failure | Own controlled hosts and service access; portal UI behavior alone isn't segmentation proof |
| AP management/provisioning | Default/reused credentials, unauthenticated enrollment, exposed management plane | Identify exact device and authorized benign admin/canary operation |
| BLE/GATT/pairing | Sensitive operation not bound to pairing/encryption/authenticated peer; replay/state ambiguity | Controlled peripherals/clients, characteristic operation and observed device effect |

Active radio tests may disrupt or reach unintended neighbors. Keep deauthentication, rogue APs, jamming, authentication coercion and high-volume traffic out of default non-destructive testing; use the explicit rules of engagement and an isolated lab where needed. A captured handshake is not a recovered password; a recovered password is not proof of all network privileges.

## Firmware and IoT: multiple linked surfaces

Record device model/revision, firmware version/hash, architecture, update format, boot/signing scheme and acquisition method. Preserve original firmware and chain of custody. Treat vendor firmware, extracted filesystem and runtime as distinct evidence.

Adapt the analysis to what is available:

- Documentation/firmware extraction: identify partitions, filesystems, configs, manifests, binaries, libraries and update logic. Strings and an outdated component name are leads, not confirmed vulnerabilities.
- Static analysis: trace network/IPC/physical inputs to privileged services, credential storage, parser logic, debug features, startup scripts and update verification.
- Emulation: reproduce relevant services with controlled networking and fixtures; document missing hardware, peripherals and boot assumptions.
- Device runtime: observe actual bindings, authentication, IPC, filesystem permissions, update/recovery and boot enforcement under the target revision.
- Physical interfaces: inspect UART/JTAG/SWD/debug/storage access only when hardware and actions are in scope; opening, flashing or probing a device may change evidence or brick it.

A shell in an emulation image isn't proof of access on the device. A hardcoded test key in source isn't proof it ships or is accepted. Signature verification must be traced through update parsing, key selection, downgrade/recovery and installation; verifying only the transport misses the trust boundary.

IoT often spans device, companion mobile app, local radio/LAN, cloud API, provisioning and fleet management. Use controlled devices and accounts to test whether possession of one device/credential authorizes another tenant/device. Don't assume success at one plane implies fleet compromise.

## OT/ICS: safety changes the proof strategy

Identify process owners, safety/reliability constraints, maintenance window, approved passive/active methods, engineering stations, controller/HMI/historian boundaries, vendor dependencies and emergency stop authority. If these are not established, do passive analysis and resolve the missing operational boundary before active device tests.

Prefer captures, configuration review, architecture verification, testbeds and vendor-approved safe queries. Do not fuzz a live controller, write registers/logic, change process state, restart equipment or stress a fragile service merely to demonstrate impact. The objective is a defensible control/path assessment without causing the harm being modeled.

For a path from enterprise access to OT, prove network and identity edges using designated benign endpoints or a representative lab, and label unexercised process consequences as inferred. Reachability to an OT subnet is not control of a process; an engineering workstation vulnerability doesn't prove safety-system compromise.

Map relevant observed behavior to the correct ATT&CK domain and current technique definitions. Do not transplant every enterprise tactic into industrial environments. Record visibility and live-validation limits prominently.

## Reconcile and restore

Return test devices, profiles, APs, pairing state, firmware and networking to the agreed state. Preserve captures securely and limit retention of incidental third-party traffic. Report tested channels/devices/revisions/vantages and gaps from absent hardware, encrypted visibility, inaccessible firmware or prohibited process interactions.
