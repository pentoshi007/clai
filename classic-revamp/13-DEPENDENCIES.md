# Dependencies, Versions, and Security

All version data in this document was read from the live npm registry and from
`npm audit` against the current lockfile. Re-verify in W00 before installing; registry
state moves.

## 1. The stack, and where each piece is used

Claude Code's published stack is TypeScript, React + Ink, Yoga, Bun. clai's classic
frontend uses all four. Explicitly:

| Layer | What we use | Where |
|---|---|---|
| **TypeScript** | `typescript` 6.0.3 | all application logic; strict mode; `src/classic`, `src/ui-core`, `src/noninteractive` |
| **React** | `react` 19.2.8 | component model, reconciliation, `useSyncExternalStore` bindings to the shared controllers |
| **Ink** | `ink` 7.1.1 | the terminal renderer: `<Box>`, `<Text>`, `<Static>`, border styles, frame diffing, stdout ownership |
| **Yoga** | `yoga-layout` 3.2.1, a direct dependency of Ink | every box in the chrome and every panel: flexbox sizing, `borderStyle` frames, responsive reflow on resize |
| **Bun** | existing toolchain | `bun build --compile` for the five release binaries, `bun run` for dev and the `test:bun` gate |

### Why Yoga is doing the work even though we pre-wrap text

[00-AI-EXECUTION.md](00-AI-EXECUTION.md) says "pre-wrap text to explicit line arrays; do not
rely on Yoga's wrapping". That is not a rejection of Yoga. The division is:

- **Yoga owns geometry.** Box widths, heights, flex distribution, padding, and every
  `borderStyle="round"` frame. On resize, Yoga reflows the whole chrome tree. We never
  compute a box edge by hand — that is exactly the mistake that produced the misplaced UI in
  the previous attempt (§4).
- **We own text row counts.** The commit ledger and the row allocator need to know a block's
  height *before* Yoga measures it, because a block's height decides whether older blocks
  commit to scrollback. Asking Yoga, then reacting to the answer, is a feedback loop with a
  one-frame lag — and a one-frame lag in a commit decision is an unrecoverable duplicated or
  lost row.

So: we hand Yoga pre-measured content and let it place it. Both engines do the part they are
good at, and neither guesses.

### Where Bun is and is not required

| Path | Bun needed? |
|---|---|
| `npm i -g @pentoshi/clai` + `clai --classic` on any OS | **no** — Ink runs on Node; Yoga is WebAssembly |
| `clai` on Windows | **no** — this is why classic works there at all |
| `clai` with OpenTUI on macOS/Linux | yes — OpenTUI's Zig FFI is Bun-only |
| release binaries | yes — `bun build --compile`, all five targets |
| `npm run test:bun` | yes — existing CI gate |

Consequence for Windows: `bin/postinstall.mjs` must stop installing Bun there
([07-PLATFORM-PACKAGING.md](07-PLATFORM-PACKAGING.md) §4). Today every Windows install
downloads a runtime it can never use.

## 2. Node engine decision — raise the floor to 22

**Node 20 reached end of life on 30 April 2026.** It receives zero security patches, and the
Node project's own guidance is that EOL lines are affected by every subsequent advisory and
will never be fixed. Sources:
[endoflife.date/nodejs](https://endoflife.date/nodejs),
[New Relic EOL notice](https://docs.newrelic.com/jp/eol/2026/07/eol-07-09-26-nodejs-20-runtime/),
[Supabase discussion](https://github.com/orgs/supabase/discussions/45715),
[Node.js EOL guidance](https://nodejs.org/en/blog/announcements/node-18-eol-support).
Content was rephrased for compliance with licensing restrictions.

`package.json` currently declares `engines.node: ">=20"`, which advertises support for an
unpatched runtime.

**Change `engines.node` to `">=22"`.** This is required for security hygiene on its own
merits, and it happens to unblock the current Ink.

CI matrix moves from `node-version: 20` to `[22, 24]`. Node 22 is in maintenance LTS,
Node 24 is Active LTS, and both are patched.

This is a user-visible breaking change for anyone still on Node 20 and belongs in the release
notes as such.

## 3. Ink version decision — 7.1.1, not 6.x

| | `ink@6.8.0` | `ink@7.1.1` |
|---|---|---|
| latest in line | yes | **yes, latest overall** |
| `engines.node` | `>=20` | `>=22` |
| peer `react` | `>=19.0.0` | `>=19.2.0` |
| peer `@types/react` | `>=19.0.0` | `>=19.2.0` |
| peer `react-devtools-core` | `>=6.1.2` | `>=6.1.2` |
| `yoga-layout` | bundled | `~3.2.1`, declared explicitly |

The earlier draft of this plan pinned `ink@6.3.1`, inherited from a spike run a year ago.
That pin is stale on two counts: 6.3.1 is not even the latest 6.x (6.8.0 is), and the only
reason to stay on the 6 line was the Node 20 floor — which §2 removes.

**Pin `ink@7.1.1`.** Rationale: it is current, it declares Yoga 3.2.1 explicitly, and the
Node constraint that blocked it is a constraint we should not have been honouring.

Peer satisfaction check against the repo:

| Peer | Required by ink 7.1.1 | Repo has | Action |
|---|---|---|---|
| `react` | `>=19.2.0` | 19.2.7 | bump to 19.2.8 (latest) |
| `@types/react` | `>=19.2.0` | 19.2.17 | bump to 19.2.18 (latest) |
| `react-devtools-core` | `>=6.1.2` | 7.0.1 | satisfied; the `overrides.ink` hack the old branch needed is unnecessary |

Ink 7 is a major release relative to 6. W00 spike **S1** must therefore also confirm:

- `render(element, { exitOnCtrlC: false, patchConsole: false, stdin, stdout })` still accepts
  those options with those names.
- `<Static items>` still exists with the same append semantics — this is the load-bearing
  API for [03-RENDER-MODEL.md](03-RENDER-MODEL.md).
- `borderStyle` accepts `"round"` and `"classic"`.
- `useStdout`, `useApp`, and `measureElement` are still exported if used.
- No deprecation warning is emitted on mount.

If any of those changed, record the actual API in the spike notes and adapt the spec — do not
guess from the Ink 6 shape.

## 4. Existing vulnerabilities in the tree

`npm audit` against the current lockfile reports **4 high-severity** advisories. Three are
dev-only; one ships.

| Package | Severity | Reached through | Ships? | Fix |
|---|---|---|---|---|
| `undici` 7.28.0 | high (5 advisories) | `cheerio` → `undici` | **yes** | §4.1 |
| `postcss` 8.5.16 | high | `vite` → `postcss` | no (dev) | bump `vitest` to 4.1.10 |
| `nanoid` 3.3.15 | high | `vite` → `postcss` → `nanoid` | no (dev) | same |
| `fast-uri` 3.1.3 | high | `ajv` → `fast-uri` | no (dev) | same |

`npm audit fix` resolves the three dev-chain ones. Verify with `npm audit --omit=dev` that
the runtime graph is clean afterwards.

### 4.1 The `undici` advisory is real and needs a code change, not a bump

`cheerio` 1.2.0 is the latest release and declares `undici: ^7.19.0`. The advisories cover
undici `7.0.0 – 7.28.0`, and **the 7.x line ends at 7.28.0** — the fix landed in 8.x
(current 8.10.0). So no version inside cheerio's declared range is safe, and bumping cheerio
cannot help.

clai does not need it. Verified usage:

- `src/tools/web/readable.ts:13,70` — `import * as cheerio` then `cheerio.load(html)` plus
  types.
- `src/tools/web/providers/duckduckgo.ts:28,271` — same.
- `grep -rn "fromURL" src` returns nothing.

undici exists in cheerio only to power `cheerio.fromURL()`, the network helper. clai fetches
through its own `src/tools/web/fetch-core.ts` and only ever parses strings.

**Fix: import `cheerio/slim`.** The package exports a `./slim` entry that omits the
fetch machinery. Change both import sites to `import * as cheerio from "cheerio/slim"`,
confirm `undici` leaves the graph (`npm ls undici` empty), and keep the existing web-tool
tests as the behaviour proof.

If `cheerio/slim` turns out to lack an API those two files use, the fallback is
`overrides: { undici: "8.10.0" }` — but prefer removing the dependency edge over pinning
through an override, because an override silently re-breaks whenever cheerio's expectations
change.

This is a pre-existing shipped vulnerability, unrelated to the UI work. Fix it in **W00**,
not at the end.

## 5. Target dependency set

Versions confirmed against the registry while writing this plan. Treat as the intent;
re-read the registry in W00 and record what you actually installed.

### `dependencies`

| Package | Current | Target | Reason |
|---|---|---|---|
| `ink` | — | `7.1.1` | new |
| `react` | `19.2.7` | `19.2.8` | latest; ink 7 peer floor |
| `chalk` | `5.6.2` | `5.6.2` | current |
| `cheerio` | `1.2.0` | `1.2.0`, imported via `/slim` | §4.1 |
| `commander` | `14.0.3` | latest 14.x | verify |
| `conf` | `15.1.0` | latest 15.x | verify |
| `execa` | `9.6.1` | latest 9.x | verify |
| `string-width` | `8.2.1` | `8.2.1` | also an ink dep; will dedupe |
| `@inquirer/prompts` | `8.5.2` | **removed** | W14, replaced by `node:readline/promises` |
| `@opentui/keymap` | `0.4.5` | **removed** | unreferenced in `src/` |
| `@opentui/core`, `@opentui/react` | `0.4.5` | unchanged | OpenTUI frontend |

### `optionalDependencies`

| Package | Action |
|---|---|
| `@opentui/core-win32-x64`, `@opentui/core-win32-arm64` | **removed** — unreachable on Windows |
| the six POSIX `@opentui/core-*` | unchanged |
| `@napi-rs/keyring`, `node-pty` | unchanged |

### `devDependencies`

| Package | Current | Target | Reason |
|---|---|---|---|
| `ink-testing-library` | — | `4.0.0` | new; latest, peer `@types/react >=18` |
| `vitest` | `4.1.9` | `4.1.10` | clears the three dev-chain advisories |
| `@types/react` | `19.2.17` | `19.2.18` | ink 7 peer floor |
| `@types/node` | `26.1.0` | `26.2.0` | latest |
| `typescript` | `6.0.3` | `6.0.3` | already the latest stable 6.x — see §6 |
| `fast-check` | `4.8.0` | `4.9.0` | latest; used by the new property tests |
| `tsx` | `4.22.5` | `4.23.12` | latest |
| `react-devtools-core` | `7.0.1` | `7.0.1` | satisfies both renderers |

### `overrides`

`encoding-sniffer: 1.0.2` — keep, it is an existing deliberate pin. The
`overrides.ink.react-devtools-core` entry the previous branch added is **not** needed:
`react-devtools-core` 7.0.1 already satisfies ink 7's `>=6.1.2`.

## 6. TypeScript: stay on 6.0.3

`typescript@7.0.2` is the current latest, but 6.0.3 is the latest **stable 6.x** — the repo
is not behind within its line. A compiler major on a 114,000-line codebase, in the middle of
a renderer migration, mixes two large risks and makes any resulting failure hard to
attribute.

Recommendation: keep 6.0.3 for this migration. Evaluate TypeScript 7 as its own change
afterwards, with its own baseline and its own gate. If the owner wants it inside this work,
it goes in W00 as an isolated commit that must leave `npm run typecheck` and the full suite
green before anything else starts.

## 7. Deprecation sweep — a W00 gate

Latest-and-clean is a state to verify, not a claim to make once:

1. `npm install` and capture every `npm WARN deprecated` line. Zero direct dependencies may
   be deprecated. A deprecated transitive is acceptable only if no maintained parent exists;
   record which parent pulls it.
2. `npm audit` — zero advisories.
3. `npm audit --omit=dev` — zero advisories, which is the stricter bar for shipped code.
4. `npm outdated` — record it. Every direct dependency is either at latest or has a written
   reason (§6 is the template).
5. `node --throw-deprecation` on a scripted classic session and a one-shot run — zero Node
   runtime deprecations.
6. Ink mount emits no console deprecation (§3).

Re-run 2 and 3 in W18 and put the output in the final report.

## 8. Supply-chain hygiene

- Exact pins for every direct dependency. No `^`, no `~`. The lockfile is the record.
- New dependencies only with owner approval. The default answer is no: this plan adds exactly
  two packages, one of them dev-only, and deliberately writes its own spinner, text input,
  picker, and pager rather than pulling `ink-*` widget libraries.
- Update the lockfile through npm only. Never hand-edit.
- Before adding anything, check the name for a typosquat and check that it is actively
  maintained.
