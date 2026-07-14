# UI v2 dependency policy

Date: 2026-07-03

## Rule

Use the latest non-deprecated package versions by default, but never force an
invalid dependency tree. Peer dependency contracts are part of the package
selection.

For v2 UI packages:

- Query registry metadata before adding or upgrading a dependency.
- Confirm the selected package has no `deprecated` metadata.
- Pin exact versions for OpenTUI renderer and core packages.
- Prefer the latest package set whose peer dependencies resolve cleanly.
- Select the newest release compatible with the supported Node.js baseline;
  do not silently raise that baseline during a package refresh.
- Do not use `--force` or `--legacy-peer-deps` to hide an invalid tree.
- Record version, peer dependency, deprecation, and reason in the PR or phase
  evidence.

## Current Phase 1 selection

Registry metadata re-checked on 2026-07-13 (V2-010). See ADR-006 for the
adapter decision and ADR-007 for the runtime/spike evidence.

| Package | Selected | Latest checked | Deprecation | Reason |
|---|---:|---:|---|---|
| `@opentui/core` | `0.4.3` | `0.4.3` | none returned | Latest OpenTUI core. |
| `@opentui/react` | `0.4.3` | `0.4.3` | none returned | React binding (ADR-006). |
| `@opentui/keymap` | `0.4.3` | `0.4.3` | none returned | Action/key bindings; peer-optionally accepts the React adapter alone. |
| `react` | `19.2.7` | `19.2.7` | none returned | Latest stable; satisfies Ink and OpenTUI. |
| `ink` | `6.8.0` | `7.1.0` | none returned | Newest Node 20-compatible release; 7.x requires Node 22. |
| `commander` | `14.0.3` | `15.0.0` | none returned | Newest Node 20-compatible release; 15.x requires Node 22.12. |

Installing the `0.4.3` set produced no `npm warn deprecated` lines and 0
vulnerabilities. The `@opentui/solid` adapter (re-checked 2026-07-13) is no
longer flagged deprecated at the top level but still carries a full Babel 7 +
`babel-preset-solid` runtime toolchain; combined with clai already using React
(via Ink), the React adapter remains the smaller migration. Decision recorded in
ADR-006.

## Upgrade process

Before any dependency upgrade:

```text
npm view <package> version deprecated peerDependencies dependencies
npm install --save-exact <resolved-compatible-package-set>
npm ls --all --depth=0
npm run typecheck
npm test
npm run build
```

If the latest package is deprecated or has incompatible peers, document the
blocker and select the newest compatible non-deprecated version.
