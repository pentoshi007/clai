# Cryptographic boundaries and smart contracts

Use when cryptographic construction, key management, protocol proofs or on-chain state is central. Do not infer algorithm weakness from unfamiliarity, and do not invent a cryptographic proof. Consult primary specifications, audited library contracts and chain/runtime semantics.

## Cryptographic investigation

Identify the exact security property: authenticity, confidentiality, freshness, peer identity, key separation or non-repudiation. Record attacker knowledge/control, chosen-message/ciphertext/oracle access, key custody, randomness sources and the component performing verification.

Trace construction and composition, not just primitive names. Investigate nonce reuse, entropy, domain separation, key derivation/context, serialization ambiguity, signature canonicalization, key/algorithm selection, error/timing oracles, state rollback and downgrade/fallback paths when the implementation supports them.

Useful discriminating questions:

- Is the verified byte string exactly the one later interpreted, including canonicalization and optional fields?
- Can one protocol/tenant/purpose accept a token/signature from another context?
- Are nonce/counter uniqueness and replay state preserved across crashes, replicas and restore?
- Does failure leave unauthenticated plaintext or partially trusted state usable downstream?
- Is a local authentication UI actually bound to cryptographic key use and the sensitive operation?
- Can an attacker choose a key/issuer/algorithm or influence the verifier's lookup without possessing signing authority?

Demonstrate the violated property with synthetic keys and controlled data where possible. An obsolete primitive's presence, a timing fluctuation or a decoded token isn't automatically an exploit. Prove oracle observability and control; use statistical reasoning appropriate to the measurement and don't run load-heavy side-channel experiments on production by default.

## Smart-contract system model

Record chain/network, block/fork context, deployed code/address, proxy/implementation/admin, compiler settings, dependencies, roles, upgradeability and external protocol assumptions. Verified source may differ from the actual implementation at the tested block; reconcile it.

Map assets and state invariants: conservation of balances/shares, authorization to mint/burn/upgrade, solvency, settlement order, withdrawal entitlement and trusted price/message sources. Include token behavior, callbacks, fee/rebasing assets, bridges, off-chain signers, sequencers and admin powers when present.

| Observed mechanism | Hypotheses and useful proof |
| --- | --- |
| External calls/callbacks | Reentrancy/cross-function state assumptions; a controlled callback breaks a balance/authorization invariant |
| Vault/share/accounting | Rounding, precision/unit mismatch, donation/first-depositor effects; a minimized state sequence yields unauthorized value or insolvency |
| Oracle/liquidity dependency | Stale/manipulable price, wrong units/window, trust/circuit-breaker assumptions; realistic controlled state and economic feasibility |
| Signature-based operations | Domain/chain/contract/nonce binding, replay, malleability, signer role; accepted unintended action using synthetic test signatures |
| Bridge/cross-chain messages | Source identity/finality/proof, replay, receiver context; distinguish local validation failure from assumed external compromise |
| Upgrades/initialization | Uninitialized proxy/implementation, storage collision, role/admin confusion; lower-privilege actor demonstrably changes controlled authority |
| Transaction ordering | Front-running/sandwich/MEV and time assumptions; executable sequence with stated capital, fees and market preconditions |

Use forked/local test environments and controlled assets for active proofs. Never move other users' funds, manipulate a live market or exercise a production governance change merely to prove an issue. Clearly distinguish a test-harness capability such as arbitrary storage modification from capabilities an external attacker has.

## Properties, feasibility and closure

Use stateful property tests and differential accounting models for sequences ordinary unit tests miss. Preserve the seed, initial state, transaction ordering and exact failing invariant. Minimize failing sequences and remove artificial harness privileges.

A profitable-looking trace may depend on impossible liquidity, an unavailable role, invalid token behavior or omitted fees. Challenge those assumptions before claiming theft. A design-centralized admin capability can be a trust assumption rather than an unintended exploit; state the promised boundary.

Report concrete violated properties, affected versions/deployments, preconditions, reproduction, impact and remediation. State unverified external protocol, hardware side-channel, economic and chain-finality assumptions instead of claiming universal security.
