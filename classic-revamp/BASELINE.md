# W00 Baseline

Captured before any dependency or source change. Machine: macOS darwin arm64,
Node v26.4.0, npm 12.0.1, Bun 1.3.14. Tree at `4e5cd74` on `fix/classic-revamp`.

## Gates

| Command | Result |
|---|---|
| `npm run typecheck` | clean, exit 0 |
| `npx vitest run` | 350/351 files, 2787/2788 tests — **1 pre-existing failure**, see below |
| `npm run build` | ok |
| `npm run compile` | ok, 5 targets |
| `npm run test:bun` | 83 files, 651 tests, all pass |

### Pre-existing failure (not caused by this migration)

`test/tui-v2/app/command-parity.test.ts > command parity (V2-080) > /update checks the
updates port without throwing` — times out at 5000 ms.

The test performs a real network call to the npm registry; its own inline comment says
so (`// The check is a real network call now, so the notice can land a tick later.`).
It is environment-dependent, predates any change here, and touches no file this
migration modifies. Recorded so later regressions remain attributable.

## Size and volume

| Metric | Value |
|---|---|
| `npm pack --dry-run` package size | 1.8 MB |
| `npm pack --dry-run` unpacked size | 7.6 MB |
| `npm pack --dry-run` total files | 1159 |
| `du -sh dist` | 9.9 M |
| `src` total lines (`*.ts` + `*.tsx`) | 114,545 |
| `npm ls --all --parseable \| wc -l` | 172 |

### Compiled binaries

| Target | Bytes | Modules bundled |
|---|---|---|
| `clai-bun-darwin-arm64` | 78,059,234 | 881 |
| `clai-bun-darwin-x64` | 83,656,784 | 881 |
| `clai-bun-linux-x64` | 132,683,904 | 883 |
| `clai-bun-linux-arm64` | 132,294,800 | 883 |
| `clai-bun-windows-x64.exe` | 113,004,032 | 883 |

## Security

`npm audit`: 4 high-severity advisories — `undici`, `postcss`, `nanoid`, `fast-uri`.

`npm audit --omit=dev`: **2 high-severity advisories reach production**:

| Package | Version | Path | Note |
|---|---|---|---|
| `undici` | 7.28.0 | `cheerio@1.2.0 → undici` | matches 13-DEPENDENCIES §4.1 |
| `fast-uri` | 3.1.3 | `conf@15.1.0 → ajv@8.20.0 → fast-uri` | **deviates from the plan**, which recorded `fast-uri` as dev-only via `ajv`; it is reached in production through `conf` |

`npm outdated` at baseline: `@opentui/*` 0.4.5 → 0.5.1 (deliberately pinned),
`@types/node` 26.1.0, `@types/react` 19.2.17, `chalk` 5.6.2 → 6.0.0,
`commander` 14.0.3 → 15.0.0, `execa` 9.6.1 → 10.0.1, `fast-check` 4.8.0,
`react` 19.2.7, `string-width` 8.2.1 → 8.2.2, `tsx` 4.22.5, `typescript` 6.0.3 → 7.0.2,
`vitest` 4.1.9.

No `npm WARN deprecated` line was emitted by a clean `npm install`.

## Environment note

npm 12 blocks lifecycle scripts unless allow-listed, so `esbuild`, `fsevents`, and
`node-pty` were approved via `npm install-scripts approve`, which npm 12 records as an
`allowScripts` block in `package.json`. Without it `esbuild` has no binary and vitest
cannot run. This is a toolchain requirement of npm 12, not a migration change.
