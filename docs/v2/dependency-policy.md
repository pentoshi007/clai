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

Registry metadata checked on 2026-07-03:

| Package | Selected | Latest checked | Deprecation | Reason |
|---|---:|---:|---|---|
| `@opentui/core` | `0.4.2` | `0.4.2` | none returned | Latest OpenTUI core. |
| `@opentui/react` | `0.4.2` | `0.4.2` | none returned | Latest React binding; no deprecated transitive packages. |
| `react` | `19.2.7` | `19.2.7` | none returned | Latest stable; satisfies Ink and OpenTUI. |
| `ink` | `6.8.0` | `7.1.0` | none returned | Newest Node 20-compatible release; 7.x requires Node 22. |
| `commander` | `14.0.3` | `15.0.0` | none returned | Newest Node 20-compatible release; 15.x requires Node 22.12. |

The Solid adapter and keymap package were rejected because their latest release
pulls `glob@9.3.5`, which npm marks deprecated, and an affected Babel 7 release
with no compatible patched version. CLAI already uses React, so the React
adapter is also the smaller migration.

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
