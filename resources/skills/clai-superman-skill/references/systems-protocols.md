# Hosts, services, native code and protocols

Use for host/network assessments, service implementations, native parsers and binary research. Avoid defaulting every engagement to a web scan. Select a technique from the observed protocol and attacker capability.

## Model vantage and execution

Record asset/address/virtual host, transport, negotiated protocol, service/build, network origin and available identity. For local work record OS/kernel, architecture, effective user/groups/token, sandbox/container and filesystem/mount context. Resolve process/service identity rather than assuming the login principal owns everything.

Inventory meaningful services and management planes using approved discovery. Observe handshake, protocol capabilities and actual authentication/authorization before choosing a scanner or exploit. Include UDP/IPv6, alternate bindings and discovery protocols when supported by the environment and scope—not because every port must always be sprayed.

A banner is a version claim. Confirm build, vendor backports, enabled feature, compile/runtime mitigations and the vulnerable path. A package advisory may apply while the reachable deployment path does not; conversely a recent banner doesn't prove every component is fixed.

## Network/service families

| Observed interface | High-value boundaries | Minimal discriminating proof |
| --- | --- | --- |
| SSH/RDP/WinRM/management API | Auth methods, role enforcement, forwarding/session features, weak recovery/default configuration | Test identity's actual allowed operation and denied equivalent, without lockout or broad guessing |
| SMB/NFS/file shares | Effective share plus filesystem ACL, identity mapping, symlinks/path translation, signing | Controlled file under owner/non-owner principals; separate read/write from execution |
| DNS/mail/directory | Recursion/zone/relay policy, parser/binding ambiguities, auth forwarding, tenant isolation | Protocol-correct controlled transaction with origin and destination evidence |
| Database/cache/queue | Auth/role isolation, dangerous extension/admin features, publish/consume permissions | Read/write or receive a canary in the permitted test namespace; open port isn't data access |
| Backup/orchestration/monitoring | Privileged agents, credential delivery, job definitions, restore path, management trust | Low-trust actor influences a controlled privileged operation, not just reads its UI |
| RPC/custom binary protocol | Message framing, length/count checks, state transitions, identity binding, version negotiation | Reproducible protocol input tied to a rejected invariant or bounded crash in a safe harness |

Don't treat an exposed service as a vulnerability unless exposure violates an expected boundary or enables a demonstrated unsafe capability. Do not test fragile services with unconstrained malformed traffic on production.

## Host privilege boundaries

Trace a lower-privileged actor's controllable data to a higher-privileged interpreter or resource. Relevant surfaces include services/tasks, scheduled jobs, startup hooks, package/install/update paths, policy helpers, writable search/config/library paths, filesystem permissions, sockets, device interfaces, named pipes and token/credential delegation.

For Linux inspect effective sudo policy, setuid/capabilities, service units, timers, mounts/namespaces and LSM restrictions as relevant. For Windows inspect service/task/object ACLs, token rights, service accounts, path/DLL resolution, named-pipe impersonation and UAC/integrity context. For macOS consider launch services/agents/daemons, helpers/XPC, entitlements, TCC and code-signing boundaries. Research the specific build's semantics rather than applying a generic command list.

A world-writable file is not privilege escalation without a privileged consumer. A privileged process reading attacker-controlled config may be more valuable than a known-kernel exploit that cannot reach the affected feature. Prove the minimum benign privileged effect when allowed; don't modify core system state just to obtain an impressive shell.

## Native-code research

Begin with reachable attacker inputs and lifetime/ownership assumptions. Inspect sizes/counts/offsets, arithmetic conversion, signedness, alignment, object lifetime, use-after-free, out-of-bounds accesses, format strings, parsing/state errors, race/locking, FFI and safe/unsafe boundaries. Trace validation across wrappers, not just dangerous function names.

For a crash establish input, exact build/hash, harness, sanitizer/stack/exception and repeatability. A crash may be a harness error, assertion, expected rejection, resource exhaustion or memory corruption. Determine the primitive and attacker reachability before claiming code execution. Mitigations and exploitability remain separate questions from bug existence.

Use [novel research](novel-research.md) for harness design, structured mutation, differential testing, minimization and variants. Prefer a safe local replica for memory-corruption or availability-sensitive work. A local proof establishes that build/configuration only; remote applicability still needs evidence.

## Protocol/state-machine analysis

Write the legal states and transitions, identities bound to the session, framing/canonicalization rules and required replay/freshness properties. Compare specification, reference implementation and observed deployment.

Potential seams include partial reads/writes, fragmentation/reassembly, duplicate/out-of-order messages, retransmission, cross-protocol tunneling, negotiation downgrade, length/encoding disagreement, compression/decompression and renegotiation. Mutate one layer while keeping lower layers valid so the intended code executes. Never attribute a firewall reset to a parser vulnerability without a downstream oracle.

## Evidence and closure

Record the exact network origin, identity, protocol negotiation and security context of the successful operation. Verify permission and state boundaries using a second channel where feasible: owned file content, service-side logs, runtime trace or sanitizer—not just tool success text.

Follow a confirmed shared helper/configuration into sibling services, protocol versions, platforms and privileged callers. Reconcile management planes, alternate address families and untested authentication roles with scope. Track and clean up only test-created files, accounts, listeners and processes; preserve audit trails.
