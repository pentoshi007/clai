# W15 — Packaging and platform install behavior (record)

## Scope

W15 removes Windows-only OpenTUI binaries from the npm install manifest, removes the unused
`@opentui/keymap` runtime dependency, prevents postinstall from downloading Bun on Windows,
and preserves all OpenTUI platform packages as an explicit compile-time concern for the
five-target Bun build.

## Changes

| File | Change |
| --- | --- |
| `bin/postinstall-policy.mjs` | Added the pure `shouldSkipBunInstall(platform)` policy. |
| `bin/postinstall.mjs` | Gates both Bun installation and the missing-Bun warning on the Windows skip policy. Windows no longer invokes PowerShell, curl, wget, filesystem setup, or Bun verification. |
| `package.json` | Removed `@opentui/keymap`, `@opentui/core-win32-x64`, and `@opentui/core-win32-arm64` from install-time declarations. |
| `package-lock.json` | Regenerated with npm so the root dependency and optionalDependency declarations match `package.json`. Nested Windows records remain where `@opentui/core` declares its own platform optional dependencies; those are needed by the compile-time installer. |
| `scripts/install-opentui-platforms.mjs` | Falls back to the pinned `@opentui/core` version for the explicit build-only platform list, including Windows. |
| `test/install.test.ts` | Added Windows/non-Windows postinstall policy tests and verified both Bun install/warning paths are gated. |
| `test/tui-v2/quality-guard.test.ts` | The exact-version equality guard now covers `@opentui/core` and `@opentui/react` and asserts that `@opentui/keymap` is absent. |

The compile-time platform list was not removed. `scripts/build.ts` must still materialize
all platform packages because Bun resolves OpenTUI dynamic imports while compiling each target.
The distinction is intentional: Windows binaries are no longer downloaded as npm install-time
optional dependencies, but the release build still obtains the Windows native package when a
cross-compile explicitly requests it.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run test/install.test.ts test/tui-v2/quality-guard.test.ts` | 2 files, 12 passed |
| `npx vitest run test/tui-v2 test/app` | 51 files, 331 passed |
| `npm run build` | passed |
| `npm run release:verify` | passed; exact dependencies and synchronized lockfile |
| `npm run compile` | passed; all five release targets compiled |
| `node dist/index.js --version` | `3.17.0` |
| `node dist/index.js --help` | passed |
| `npm ls @opentui/keymap --all --depth=0` | empty after `npm prune --ignore-scripts` |
| `git diff --check` | clean |

Compile output reported these bundle module counts:

| Target | Modules |
| --- | ---: |
| `bun-darwin-arm64` | 1,419 |
| `bun-darwin-x64` | 1,419 |
| `bun-linux-x64` | 1,421 |
| `bun-linux-arm64` | 1,421 |
| `bun-windows-x64` | 1,421 |

## Size measurements

Baseline values are from `classic-revamp/BASELINE.md`. The current values include the W14
non-interactive surface and all source still present before W16 deletes the line REPL, so a net
increase is expected at this stage and is recorded rather than treated as a failure.

### npm package and dist

| Metric | Baseline | W15 | Delta |
| --- | ---: | ---: | ---: |
| `npm pack --dry-run` package size | 1.8 MB | 2.0 MB | +0.2 MB |
| `npm pack --dry-run` unpacked size | 7.6 MB | 9.5 MB | +1.9 MB |
| `npm pack --dry-run` total files | 1,159 | 1,778 | +619 |
| `du -sh dist` | 9.9 M | 13 M | +3.1 M |

### Compiled binaries

| Target | Baseline bytes | W15 bytes | Delta | Baseline modules | W15 modules |
| --- | ---: | ---: | ---: | ---: | ---: |
| `clai-bun-darwin-arm64` | 78,059,234 | 78,339,938 | +280,704 | 881 | 1,419 |
| `clai-bun-darwin-x64` | 83,656,784 | 83,935,312 | +278,528 | 881 | 1,419 |
| `clai-bun-linux-x64` | 132,683,904 | 132,962,432 | +278,528 | 883 | 1,421 |
| `clai-bun-linux-arm64` | 132,294,800 | 132,556,944 | +262,144 | 883 | 1,421 |
| `clai-bun-windows-x64.exe` | 113,004,032 | 113,282,560 | +278,528 | 883 | 1,421 |

The module and size increase is a measurement, not a release approval. W16 is expected to
remove the legacy REPL, classic renderer, and dead UI modules; the final W18 report must
re-measure after that cleanup.

## Windows probe status

A real Windows runtime probe was not available on the macOS host. The Windows binary was
cross-compiled successfully, but the following remain unverified and must not be marked as
passed from this result alone:

- Windows Terminal startup without Bun.
- PowerShell 5.1 and 7 startup.
- cmd.exe/conhost startup and `unicode: false` behavior.
- VS Code Windows terminal startup.
- One-shot execution on Windows.
- Process Monitor evidence that no unsupported OpenTUI native artifact is opened during the
  classic startup path.

The split-entrypoint fallback was not applied because the required real Windows probe did not
run. This limitation belongs in W17 and the final report. Final post-cleanup package, dist,
binary, source, and dependency measurements are recorded in
[W18-RELEASE.md](W18-RELEASE.md).
