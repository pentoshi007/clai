# Web, APIs, browsers and JavaScript

Use when HTTP/application surfaces exist. OWASP WSTG and ASVS guide tests and control expectations; API Top 10 is a risk lens, not a complete test inventory. Consult the [sources](sources.md) for current documents and deep research.

## Map the actual application

Capture a normal transaction end-to-end before mutating it: raw request, redirects/cookies, identity, object ownership, state transitions and actual result. Preserve source HTML, comments, script references and headers when they matter; readable prose extraction is not forensic coverage. HTTP 200 may be an error, login page, challenge or cached shell.

Reconcile hosts and virtual hosts, protocols, API versions, routes/methods/content types, parameters, cookies, headers, uploads, WebSockets/SSE, GraphQL/gRPC interfaces, callbacks, webhooks, workers, exports, admin/support and mobile clients. A link in JS is a candidate, not a reachable endpoint. Browser restrictions are not server-side authorization.

Use observed schemas, traffic and client code to derive test inputs before brute force. Inspect relevant JS chunks, source maps, generated API clients and service workers when available. Trace source-to-sink behavior and exposed server contracts; public endpoint names, OAuth client IDs and browser API keys are not automatically secrets.

For content discovery calibrate nonexistent-path behavior and authenticated/unauthenticated catch-alls. Preserve structured status, size and redirect evidence. Different statuses, content types, method behavior or response shapes can distinguish real surfaces; don't suppress all errors or all 403s. Choose a derived small wordlist before an enormous generic one.

## Hypothesis families and discriminating proof

| Signal/boundary | What to investigate | Proof that changes the conclusion |
| --- | --- | --- |
| IDs, tenant selectors, nested objects | Object/function/property authorization, mass assignment, bulk and indirect references | Controlled A/B identities and tenants; one unauthorized read or benign write; distinguish response shape from real access |
| Login, recovery, invitation, account linking | Identity binding, reset token lifetime, MFA/re-auth, enrollment/recovery equivalence, session fixation/revocation | Trace full takeover boundary using test accounts; check old credentials/sessions after change and rollback |
| OAuth/OIDC/SAML/JWT | Issuer/audience/client/resource binding, redirect validation, state/nonce/PKCE where applicable, signature/key selection, parser differences | Demonstrate an accepted token/assertion for the wrong context; identify exact verifier/configuration; a decoded JWT proves nothing |
| Search/filter/template/query | SQL/NoSQL/LDAP/XPath/template/command injection, unsafe evaluation | Grammar-aware differential or controlled marker/effect; a lone error or generic 500 is insufficient |
| Fetch/import/preview/webhook | SSRF, redirects, URL parser/DNS/time-of-check mismatch, method/header propagation | A uniquely correlated controlled callback with origin evidence; separately prove any internal access or downstream privilege |
| Upload/archive/converter | Type/extension/parser disagreement, filename/path handling, archive traversal, stored execution, postprocessing | A benign controlled file reaches a forbidden location/interpreter or crosses a boundary; upload acceptance alone is not execution |
| Shared caches/proxies | Cache keys versus origin inputs, tenant/auth variance, cache deception/poisoning, request framing differences | Isolated own-session/request sequence shows cross-context effect without contaminating real users |
| Wallet/checkout/approval/quota | Server-authoritative values, order/state constraints, replay/idempotency, partial failure, races | Check durable business state before/after, bounded controlled transactions, sequential versus concurrent controls |
| HTML/DOM/messages | Reflected/stored/DOM XSS, postMessage origin/source checks, DOM clobbering, prototype pollution | Actual attacker-to-sink trace and harmless execution or security-relevant effect in the supported browser context |
| WebSocket/GraphQL | Handshake and per-message auth, subscription ownership, resolver-level checks, batching/alias behavior | Same operation under changed identity/object/state; introspection and batching are features, not findings by themselves |
| Cross-origin requests | CSRF, CORS, origin handling, cookie/site semantics | Real browser proof with victim-equivalent test session and a consequential action/read; headers alone are insufficient |

## Authorization matrix that finds non-obvious bugs

Start from owned test objects and legitimate operations. For each important shared enforcement path, compare unauthenticated, owner, same-tenant non-owner, different-tenant and privileged identities as available. Separate read, create, update, delete, share, export, restore and approval. Check both the container and child object ownership.

Inspect transitions: invited to member, member to removed, admin to downgraded, active to deleted, private to shared, draft to published, sync to async. Repeat meaningful operations across alternate encodings, bulk endpoints, old API versions and background jobs only where these exist. Revoked membership may still authorize an already-queued export; object-level checks may not cover writable properties.

Avoid uncontrolled ID enumeration. A controlled cross-tenant sentinel is stronger evidence than collecting customers' records. If access is unavailable, report the exact missing principal/role rather than marking authorization covered.

## Business invariants and concurrency

Write the invariant in domain terms: a credit is consumed once; a refund cannot exceed settlement; only the approved artifact can be published; recovery cannot bypass an enrolled factor; the price paid matches the final cart.

Map both visible workflow and hidden sub-states within requests. Change ordering, replay completion, interrupt between stages, alter a referenced resource after validation, and compare worker execution time with submission time. GET requests, redirects and middleware may mutate state; single-threaded runtimes can interleave I/O and multiple instances.

For suspected races begin with a sequential baseline and the smallest bounded concurrent test. Inspect actual state, not just two success responses. Consider session locks, different sessions for the same account, multiple endpoints, idempotency scope and datastore transactions. Don't increase concurrency to compensate for an unobserved invariant, or spend real money/create production load to prove a theory.

## Parser and interpreter seams

Model transformations in order: CDN -> proxy -> router -> framework -> decoder -> validator -> serializer -> worker/sink. Test a discrepancy only when two components plausibly interpret the same value differently. Relevant dimensions include path normalization, percent/double decoding, Unicode, duplicate keys/headers, parameter precedence, content-type negotiation, JSON number/string/null semantics, host/forwarded headers and HTTP protocol conversion.

Keep transport failures separate from application errors. Desynchronization and shared-cache experiments can affect bystanders: prefer local replicas, isolated connections and own-request victim controls; don't indiscriminately poison shared sockets or caches. One timeout does not prove request smuggling.

For prototype pollution identify attacker-controlled property paths, reachability of the merge/assignment, actual prototype mutation and a consequential gadget under that runtime. An object containing `__proto__` or use of a merge library is not enough. For XSS distinguish reflection, HTML interpretation and script execution; prove exploit context rather than assuming a string sink always executes.

## Cryptography and configuration in context

Check key custody, randomness, nonce reuse, token audience/lifetime, encryption/authentication composition, insecure fallbacks and verifier error paths when those mechanisms are present. Do not “break crypto” from an algorithm name or label a JWT secret weak without evidence. Use [crypto and contracts](crypto-contracts.md) when the cryptographic protocol is central.

TLS, security headers, verbose errors and software versions may be observations or hardening gaps. Explain their actual security consequence and deployment context; don't substitute header scoring for authentication, authorization and business-flow testing.

## Deepen, then reconcile

A confirmed issue seeds root-cause variants: another resolver, serializer, import/export, batch path, worker, admin action, cached response or old deployment. A chain must have compatible identity, network, timing and data preconditions at each edge. Cross-origin behavior, SSRF and cloud permissions are separate proofs.

Before closing compare the discovered feature/identity/state matrix with tested representatives and justified exclusions. State missing credentials, tenant boundaries, callback visibility, browser/device constraints or untested management planes. No scanner can establish that this matrix is complete.
