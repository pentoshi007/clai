# Identity, Active Directory and enterprise trust

Use for AD DS, Windows domains, hybrid identity, IdPs and federated SaaS. Separate exposure, effective permissions and demonstrated escalation. Technique prerequisites change with server updates and policy; consult current Microsoft/vendor documentation rather than assuming an old exploit still works.

## Build the identity and trust graph

Record domains/forests/tenants, principals and groups, nested membership, delegation, trust directions, management tiers, enrollment authorities, sync/federation paths, service identities and administrative interfaces. Label edges by who controls what, from which host, using which authentication protocol. Include local versus domain privileges and SaaS control versus data-plane permissions.

Establish the current principal, logon type, token/group membership, network vantage, authentication method, domain policy and relevant builds. Clock skew, name resolution, SPNs, proxy behavior and SMB/LDAP negotiation can invalidate a test before it touches the target mechanism. Preserve that distinction.

An attack-graph edge is a candidate permission relationship, not an executed path. Validate important edges against effective permissions, deny entries, inheritance, object protection, network reachability and current server behavior. Do not assume every diagrammed shortest path is feasible.

## High-value families

| Observed capability | Hypothesis | Discriminating validation |
| --- | --- | --- |
| Low-privileged authenticated domain identity | Excessive directory/object ACLs, group ownership, writable GPO or service configuration | Resolve inherited/effective rights and object scope; use a controlled reversible object change only when allowed |
| Kerberos service accounts/delegation | Weak service credential protection, constrained/unconstrained/resource-based delegation, incorrect SPN/trust binding | Verify exact principal, flags, service reachability and policy; bounded approved ticket/credential handling, not indiscriminate collection |
| NTLM-capable services | Relay/coercion prerequisites, missing signing/channel binding/EPA | Identify a compatible source/destination and actual enforcement; TLS alone does not prove binding; don't coerce arbitrary users |
| AD CS enrollment/control | Subject/SAN control, template ACLs, agent/signing/EKU misuse, enrollment endpoint relay | Trace requester -> template/CA permissions -> issuance -> mapping -> accepted identity; certificate issuance alone is not domain takeover |
| Local foothold | Privileged service/task/autorun paths, weak ACLs, credential exposure, token boundary mistakes | Show a lower-privilege principal can influence a privileged execution or access path; admin inspecting admin secrets is not escalation |
| Hybrid identity/sync/federation | Sync account rights, app consent, federation key/control, cross-tenant trust | Establish which authority can mint/accept identities and the exact tenant/resource boundary |
| SaaS support/admin interfaces | Delegated admin, role switching, invitation and recovery bypasses | Test principal/tenant/resource binding and revocation with controlled accounts |

## Authentication is a stateful protocol

For Kerberos, NTLM, LDAP, SMB, WinRM, RDP and HTTP negotiate the actual protocol and protections. A service banner or policy's intended default is not proof of enforcement. Test downgrade/fallback only within the agreed method; distinguish credential rejection, unavailable service and transport failure.

For certificate services evaluate template permissions, enrollment/approval requirements, purpose restrictions, authorized signatures, certificate-to-account mapping, endpoint protection and patch-level behavior together. ESC names are research labels that evolve: verify the specific current prerequisites rather than treating every certificate template as vulnerable.

For federation evaluate signature validation, issuer/audience/resource binding, destination/recipient, freshness/replay, key rollover, claim transformation and token exchange. Distinguish identity provider guarantees from the application's authorization. A valid identity token for one audience need not authorize another service.

## Credentials: a capability, not a collection objective

Use secure credential references; never paste hashes, tickets, passwords, certificates or recovery material into ordinary prompts and logs. Discovering a secret does not authorize using it on unrelated services. Identify owner, scope, lifetime and rotation needs without exposing the value.

Establish lockout/MFA/rate limits before any credential testing. Password spraying, ticket requests, coercion, credential dumping, replication, persistence and account changes have operational consequences; do them only when needed for the authorized objective and allowed impact. Prefer a test principal or minimal capability proof over extracting the domain's secrets.

A successful low-privilege login establishes only that login. “Domain admin” requires verified effective privilege under that identity; membership-like strings and graph predictions are not enough. If a benign proof satisfies the objective, further collection adds risk without evidence value.

## Chain reasoning

Example candidate chain: writable group edge -> enrollment right -> certificate issuance -> accepted elevated identity. For each edge record prerequisite, supporting evidence, negative control, impact and cleanup. Validate current protections between edges. Don't report the final privilege if only the first permission was observed.

After a confirmed root cause, examine the policy/permission family: equivalent templates, delegated OU trees, nested groups, sibling applications, service accounts and trust relationships. Reconcile identities and management planes left untested instead of declaring the whole directory assessed from a single foothold.

## Detection and cleanup

For emulation, agree whether the goal is path feasibility, prevention, telemetry generation or alert/response validation. Record principal, host, time, source, technique and expected telemetry; use [security operations](security-operations.md) for the detection pipeline. An alert means neither blocked execution nor successful containment.

Track every created account, certificate, group/ACL/policy modification, task, service, process, ticket and test artifact. Revoke or remove only engagement-created state using an agreed cleanup procedure; don't erase audit trails. Retest original and alternate paths after remediation with the same principal and build context.
