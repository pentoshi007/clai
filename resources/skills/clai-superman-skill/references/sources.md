# Research sources and framework use

Research baseline: 2026-10-23. These are primary sources and comparative skills examined while designing this library. This is original clai guidance, not a vendored copy of their manuals or skill bodies. External material retains its own license and attribution; linked projects do not endorse clai. No comparative model-performance claim has been established.

Use the source that resolves the current uncertainty. A framework's presence in this list is not a requirement to load it or test every listed technique. Fetch current primary documentation for changed versions, identifiers, policy semantics and advisories. Record edition/version and retrieval date for mappings in a report.

## Standards and implementation references

| Source | Why/when to use it | Boundary |
| --- | --- | --- |
| [NIST SP 800-115](https://csrc.nist.gov/pubs/sp/800/115/final) | Assessment planning, technical methods, evidence and mitigation context | Published 2008; foundational process, not a modern exploit catalog or exhaustive program |
| [MITRE ATT&CK usage guidance](https://attack.mitre.org/resources/) | Threat modeling, adversary emulation, behavioral/detection mapping | MITRE explicitly warns against treating full matrix coverage or one procedure as completion |
| [ATT&CK Enterprise matrix](https://attack.mitre.org/matrices/enterprise/) | Relevant platform/technique selection and current identifiers | Verify the version and technique definition; do not assume labels/IDs never change |
| [OWASP WSTG business logic](https://wstg.owasp.org/latest/4-Web_Application_Security_Testing/10-Business_Logic/) | Workflow, integrity, timing, abuse and payment hypotheses | `latest` is mutable; use a versioned test reference when reporting |
| [OWASP API Top 10, 2023](https://api-security.owasp.org/editions/2023/en/0x11-t10/) | Object/function/property authorization, sensitive flows, inventory, resource and downstream trust risks | Risk categories, not complete API test coverage |
| [OWASP ASVS](https://owasp.org/projects/asvs) | Technical control expectations and verification requirements | Project page identified 5.0.0 stable at research time; verify current control IDs |
| [OWASP MASTG project](https://github.com/OWASP/mastg/blob/master/README.md) and [MASTG](https://mas.owasp.org/MASTG/) | Mobile tests/reverse engineering aligned with MASVS and MASWE | Check current platform/test status; some older tests are deprecated |
| [Microsoft AD CS relay mitigation](https://support.microsoft.com/en-us/servicing/os/windows-server/2021/07/kb5005413-mitigating-ntlm-relay-attacks-on-active-directory-certificate-services-ad-cs) | NTLM relay prerequisites and EPA/signing protection context | Specific service/configuration and update behavior matter; not every AD CS deployment is exploitable |
| [AWS IAM policy evaluation](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html) | Effective grants, explicit deny, boundaries and organization policies | Follow principal/resource/cross-account rules; don't reduce everything to policy text containing Allow |
| [Kubernetes security checklist](https://kubernetes.io/docs/concepts/security/security-checklist/) | Control/data-plane boundaries, CNI policy, pod admission, credentials | Official guidance itself warns checklist-only security is insufficient; enforcement mode matters |
| [OWASP LLM Top 10, 2026](https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/) | Current LLM application risks and mappings | Resource page dated August 3, 2026; do not reuse 2025 numbering without checking |
| [OWASP Agentic Top 10, 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) | Autonomous tool, identity, memory, supply-chain and workflow risk context | Complement to LLM guidance, not proof that prompt following crossed a security boundary |
| [Trail of Bits Testing Handbook](https://appsec.guide/docs/fuzzing/) | Harnesses, feedback, sanitizers, properties and coverage-driven refinement | Fuzzing isn't a silver bullet; throughput and proxy coverage do not establish absence of bugs |
| [PortSwigger state-machine race research](https://portswigger.net/research/smashing-the-state-machine) | Hidden sub-states, concurrency, anomalous workflows and session-lock blind spots | Derive bounded tests for the actual application; don't use uncontrolled concurrency |
| [OWASP IoT testing/FSTM overview](https://github.com/OWASP/www-project-internet-of-things/blob/master/tab_validate_and_test.md) | Device/firmware acquisition, static, emulated and runtime analysis relationships | Device revisions and live safety constraints change what can be proved |
| [NIST SP 800-153](https://csrc.nist.gov/pubs/sp/800/153/final) | WLAN component/lifecycle and monitoring context | Published 2012; use current protocol/vendor sources for WPA3, modern EAP and chipsets |
| [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use) | Untrusted expressions/code, privileged jobs, token permissions, runner and artifact trust | Follow the workflow's actual event/permission context, not just a grep rule |
| [OpenZeppelin upgradeable contracts](https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable) | Initialization, proxy and storage-layout assumptions | Use current chain/EVM and library semantics; examples may target older compiler versions |
| [NIST SP 800-61 Rev. 3](https://csrc.nist.gov/pubs/sp/800/61/r3/final) | Detection, response/recovery and risk-management context | Incident authority and evidence preservation differ from pentest goals |
| [FIRST CVSS v4.0 User Guide](https://www.first.org/cvss/v4.0/user-guide) | Severity versus risk, metric groups, scoring/vector publication | CVSS is owned by FIRST and used by permission; a Base score alone is not business risk |

## Comparable skills examined

| Skill/source | Useful design observation | What this library deliberately does differently |
| --- | --- | --- |
| [Trail of Bits variant analysis](https://trailofbits.com/skills/variant-analysis/) | Root-cause families, seed validation, controlled generalization and candidate triage | Integrates variant search with black-box/runtime boundaries and ongoing engagement coverage; doesn't treat candidates as findings |
| [Trail of Bits differential review](https://github.com/trailofbits/skills/blob/main/plugins/differential-review/skills/differential-review/SKILL.md) | Context/history, callers, concrete adversarial scenarios and declared limits | Preserves requested answer/file boundary; missing tests don't automatically raise vulnerability severity; no universal mandatory phase sequence |
| [Akira engagement planning](https://github.com/kalpmodi/akira/blob/main/skills/plan-engagement/SKILL.md) | Explicit hypotheses, live graph/state, deduplication and incremental evidence | No invented percentage priors/threshold boosts, automatic credential-spray chain, global client memory, fixed scanner sequence or orchestration assumptions |
| [Agent Skills directory](https://www.skills.sh/) | Metadata-first discovery of ecosystem skill packages | Popularity is not evidence of security quality; external skills are not installed or trusted automatically |

This is a design comparison, not an execution benchmark or a claim those projects are generally inferior. Their environments, goals and licenses differ.

## Keeping research current

For a specific issue verify product/build/configuration and attacker prerequisites, read the original advisory/patch/specification, inspect credible reproductions and resolve conflicting sources. Use CVE/advisory databases for discovery, but don't treat a search miss as novelty or a version match as exploitability.

Keep mappings live during the investigation. At framing, identify applicable current stable frameworks and official sources; at a new boundary or evidence change, verify the relevant control/technique definition and update the ledger with edition, source/retrieval date, observation, mapping rationale and disposition. Use this to detect missing applicable surfaces and alternate procedures before closure. Don't fetch an entire catalog repeatedly, freeze an old Top 10 into a universal checklist, or attach a familiar ID to behavior it doesn't describe. Record unclassified behavior explicitly. When offline, mark freshness and identifiers unverified rather than inventing a latest version; preserve useful causal testing and revisit mapping when sources become available.

For an apparently novel issue, search semantic root-cause neighbors, vendor history, prior fixes and affected versions before making novelty claims. Coordinate disclosure under the engagement's agreed process; the skill does not publish findings or contact vendors by itself.

Review this library when standards change materially, when a reproduced investigation exposes a decision failure, or when controlled evaluations show a regression. Prefer a small evidence-backed correction to adding another mandatory checklist. The evaluation protocol is in the repository's `guides/security-skill.md`, outside the model's operational core.
