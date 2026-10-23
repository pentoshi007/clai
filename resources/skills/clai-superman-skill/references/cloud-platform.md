# Cloud, containers and multi-tenant platforms

Use when cloud infrastructure, control planes, managed services or orchestration are actually present. A provider name, private IP or metadata URL is not evidence of exploitable cloud access. Consult provider rules and current policy semantics for the observed service.

## Map authority before resources

Record provider/account/project/subscription/tenant, region, principal/session, trust policy, permission boundary, organizational guardrails, resource policy and network context. Separate an identity's listed grants from effective authorization and the credential's actual session context. Label production, test, third-party and provider-managed resources.

Map ingress -> workload -> identity -> privileged API -> data, plus deployment and secret-delivery paths. Include serverless triggers, queues, object events, build agents, registries, workload identity federation, management APIs and the logging plane. A read-only inventory can reveal a path; it does not authorize exercising all actions it describes.

## Hypothesis families

| Boundary | Look for | Prove or reject with |
| --- | --- | --- |
| Identity -> role/service | Overbroad role trust, cross-account confused deputy, weak conditions, unintended role passing/impersonation | Exact caller/resource/context and effective policy evaluation; bounded identity/capability proof |
| Workload -> credential | Metadata/service token exposure, excessive workload identity, mounted credentials | Controlled workload path and identity evidence; separately validate downstream permission without collecting secrets unnecessarily |
| Storage -> tenant/public | Resource policy/ACL/signing mistakes, predictable shares, cross-tenant object access | Known canary object under controlled principals; public listing is distinct from object read/write |
| Kubernetes RBAC -> workload | Privileged verbs, impersonate/bind/escalate, workload creation, secret or exec access | Effective authorization plus admission policy and namespace context; dry-run when it accurately models the real check |
| Pod -> node/cluster | Dangerous capabilities, host mounts/namespaces, socket exposure, token reach | Exact runtime security context, reachable mount/socket and bounded effect; UID 0 in a container isn't host root |
| Network -> internal service | Security group/firewall/network policy/mesh gaps, DNS and egress ambiguity | Test both authorized and denied routes from the relevant origin; a declared NetworkPolicy may not be enforced by the CNI |
| Tenant -> shared platform | Shared caches, volumes, queues, admin endpoints, control/data plane coupling | Two controlled tenants and distinct sentinels; demonstrate the actual boundary crossing |
| CI/deployment -> production | Mutable artifact, federated token trust, shared runner/cache, secret leakage | Trace untrusted input to privileged job and deployed artifact; don't run untrusted pipelines with live secrets |

## Effective permissions are contextual

For AWS distinguish identity/resource policy combinations, explicit denies, session policies, permission boundaries, SCPs/RCPs and role trust. For Azure distinguish directory roles, app permissions, resource RBAC and managed identities; for GCP distinguish bindings/conditions, service-account impersonation and organization constraints. Do not flatten these into a generic “allow means exploit.” Research the principal type and exact request evaluation before asserting escalation.

Policy simulators, static scanners and graph tools produce hypotheses. They may omit live conditions, resource policies or runtime identity. Validate decisive conclusions against controlled actual calls when permitted, or label them as configuration-derived rather than exploitation-confirmed.

Do not test a potentially destructive permission by deleting a real resource. Use read-only identity verification, a canary resource, an accurate dry-run or a reversible change in the agreed test boundary. Dry-run is evidence of only the checks it actually performs.

## Kubernetes and container specifics

Inventory namespaces, service accounts, Role/ClusterRole bindings, admission mode, pod security context, network policy/CNI, node metadata exposure, image provenance, secret distribution and cluster-admin interfaces. Workload creation can imply access to node-level resources unless admission restricts it; RBAC on API verbs alone does not constrain all PodSpec fields.

Check control-plane and data-plane isolation separately. A namespace isn't a complete security boundary. An apparent restriction may be warn/audit rather than enforce; a private cluster endpoint may remain reachable through a workload. Follow actual configuration to the runtime effect.

For a container finding record image digest, runtime, host/kernel version, effective capabilities, mounts and seccomp/LSM context. Escape claims require a demonstrated host boundary crossing. A generic vulnerable kernel version is not sufficient, especially with vendor backports and disabled features.

## SSRF chains and temporary credentials

First establish a server-side controlled fetch; then separately establish target reachability, metadata protocol/version requirements, credential availability and effective permissions. A callback from an egress proxy proves less than a callback tied to the intended workload. A blocked metadata request refutes that request, not all SSRF.

Use the minimum identity/capability proof. Do not dump credential sets, enumerate unrelated accounts or retain tokens unnecessarily. Redact raw captures and record expiry/rotation/cleanup obligations by secure reference.

## Close both planes

Reconcile tested principals, tenants, regions, service families, deployment paths and denied contexts. Explicitly list untested organizational policy, cross-account trust, management interfaces, regions or accounts. After remediation verify the original operation, legitimate access, sibling policies and credential revocation; “policy changed” alone is not proof of effective denial.
