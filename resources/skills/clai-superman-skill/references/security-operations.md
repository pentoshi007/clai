# Security operations, hunting, detection and response

Use when the objective is investigate, detect, contain or validate defensive controls. Do not turn a suspected active incident into an offensive exploitation exercise. NIST SP 800-61 Rev. 3 places detection, response and recovery within broader risk management; adapt to the organization's incident authority and process.

## Classify the job

- **Threat hunt:** test a behavior hypothesis using available evidence; success includes a well-bounded negative result and visibility gaps.
- **Detection validation/purple team:** distinguish successful execution, telemetry, rule match, alert delivery, analyst action and containment.
- **Incident response/forensics:** establish what happened and current risk while preserving evidence; containment may take precedence over complete observation under the incident lead's authority.
- **Exposure/vulnerability management:** verify applicability and reachable impact; prioritize remediation, then retest actual enforcement.

Confirm objective, time window/timezone, hosts/identities, data sources, retention and response authority. Recover existing incident scope rather than scanning adjacent systems by default.

## Evidence before interpretation

Preserve raw logs/artifacts with acquisition time, source, hash where appropriate and chain of custody. Work on copies; note time skew, ingestion delay, sampling, parser changes and collection gaps. Do not erase logs or “clean up” suspicious files before preserving evidence and receiving response direction.

Build a timeline that separates event time, ingest time and analyst observation. Correlate stable identifiers: principal/session, host/process tree, request/correlation ID, source/destination, cloud resource, file hash and related transaction. An IP address alone rarely establishes actor identity.

Record known facts, alternative explanations and the next discriminating query. An alert may be a true detection of benign admin/test activity; no alert may be missing telemetry rather than absent attacker behavior.

## Hunting from behaviors

Start with a concrete claim: a lower-tier identity requested unusual privileged access; a workload identity was used outside its normal context; an update child process performed an unexpected network action. Choose telemetry that can actually observe the behavior and explicitly state what it cannot observe.

Map relevant behavior to verified current ATT&CK/ATLAS techniques, but don't let the framework suppress unmodeled activity. Query a bounded cohort/time range, inspect representative raw records and compare a legitimate baseline. Expand scope/time based on linked evidence rather than searching every index indiscriminately.

Useful pivots include identity -> sessions -> devices -> processes -> network -> resources -> resulting state. Preserve causal uncertainty: a shared service account, NAT, proxy, VPN or delayed log delivery can make a superficially compelling chain false.

## Detection validation as a pipeline

| Stage | Evidence needed | Frequent false conclusion |
| --- | --- | --- |
| Execution | Actual action/outcome in the relevant security context | Tool exit zero means technique worked |
| Sensor | Raw event with required fields/time/source | “No alert” means no event |
| Ingestion/parsing | Event reached the correct dataset with usable fields | Local log proves SIEM visibility |
| Rule/analytic | Exact rule version, conditions, window, match/suppression result | One matched event proves all variants covered |
| Alert/case | Routing, severity, dedup/suppression and delivery | Rule match means analyst saw it |
| Response | Documented analyst/control action and effective containment | An alert means the attack was blocked |

Use controlled benign emulation and agreed test windows. Verify cleanup and don't disable defensive controls or erase evidence to obtain a successful demonstration. When a test fails, localize the missing pipeline stage before changing the detection rule or rerunning the attack.

Test representative alternate procedures when they materially change observability: different parent/child process context, identity source, API, runtime or platform. Do not claim technique-wide coverage from a single known signature. Balance recall against legitimate baseline false positives and operational cost.

## Response decisions

For a live incident, state the containment decision, expected risk reduction, evidence lost, business impact and reversibility. Coordinate host isolation, session revocation, key rotation, blocking and restoration through the incident authority. Do not rotate, delete or quarantine unilaterally just because access exists.

Determine initial access, executed actions, persistence, credential/token exposure, affected assets and scope of impact to the extent evidence supports them. Avoid unsupported attribution and precise dwell-time claims beyond retention. Distinguish evidence of access, collection, staging and actual exfiltration.

## Remediation and recovery proof

Verify the defect/control was addressed on the affected build/configuration and that compromised credentials/sessions cannot still act. Confirm legitimate business behavior and required telemetry survive the fix. Recovery is not just a service becoming reachable; validate integrity, restored trust and monitoring for recurrence.

Deliver timeline, scope, confidence and alternatives, evidence references, containment/remediation actions actually taken, residual exposure, unobservable periods and next owner/actions. Use [evidence and closure](evidence-reporting.md) for concise defensible findings and retest outcomes.
