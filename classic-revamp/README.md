# Classic Frontend Revamp — React + Ink

This directory is the implementation contract for replacing clai's former classic line REPL
(`src/repl.ts`) with a modern React + Ink terminal UI. The line REPL has now been removed;
the classic Ink UI is selected on Windows, on smaller POSIX terminals, or explicitly, while
OpenTUI remains the default for sufficiently large interactive POSIX terminals.

Branch: `fix/classic-revamp`. Worktree: `/Users/aniketpandey/Desktop/clai-classic-revamp`.
All work happens here. Nothing is merged into `main` without the owner asking.

## Objective

One backend, one application state, three presentation surfaces:

| Surface | Renderer | Where it runs |
|---|---|---|
| `tui` | OpenTUI (`@opentui/*` + Bun FFI) | macOS/Linux TTY, unchanged |
| `classic` | React + Ink + Yoga | Windows by platform default; macOS/Linux on request, when smaller, or as fallback |
| `noninteractive` | plain stream writer | one-shot prompts, pipes, CI |

The classic surface must feel like Claude Code / Codex CLI: a scrollback-native feed of
committed output with a live chrome block pinned at the bottom. It must carry clai's
identity: the aqua `#2EEBFF` frame, the CLAI wordmark intro card, the amber `YOU` plate,
magenta assistant bullet, violet reasoning, green replies.

## Technology

The same four pillars Claude Code is built on, all four genuinely load-bearing here.
Full rationale, peer checks, and the security audit are in
[13-DEPENDENCIES.md](13-DEPENDENCIES.md).

| Pillar | Package | Version | Role here |
|---|---|---|---|
| **TypeScript** | `typescript` | `6.0.3` | all application logic, strict mode |
| **React** | `react` | `19.2.8` | component model, `useSyncExternalStore` bindings to shared controllers |
| **Ink** | `ink` | `7.1.1` | the terminal renderer: `<Box>`, `<Text>`, `<Static>`, borders, frame diffing |
| **Yoga** | `yoga-layout` | `3.2.1` (Ink dependency) | all box geometry, border frames, responsive reflow on resize |
| **Bun** | existing toolchain | — | `bun build --compile` for five release binaries, `bun run`, `test:bun` gate |
| testing | `ink-testing-library` | `4.0.0` (dev) | frame capture in unit tests |

Three decisions worth stating up front:

- **`engines.node` moves from `>=20` to `>=22`.** Node 20 reached end of life on
  30 April 2026 and receives no security patches. Shipping a `>=20` engine range advertises
  support for an unpatched runtime. Raising it is correct on its own merits and it unblocks
  the current Ink. This is a breaking change for Node 20 users and belongs in the release
  notes.
- **Ink 7.1.1, not 6.x.** The only reason to stay on the 6 line was the Node 20 floor.
  Ink 7 declares `yoga-layout ~3.2.1` explicitly and requires `react >=19.2.0`, which the
  repo already exceeds.
- **Yoga owns geometry; we own text row counts.** Not a rejection of Yoga — a division of
  labour. The commit ledger must know a block's height *before* layout runs, because that
  height decides what commits to scrollback. See [13-DEPENDENCIES.md](13-DEPENDENCIES.md) §1.

No `ink-*` widget libraries (`ink-spinner`, `ink-text-input`, `ink-select-input`). Every
widget is ours: fewer transitive dependencies, smaller binary, no upstream drift, and full
control over the layout this plan specifies to the column.

Bun is **not** required to run the classic frontend on any OS. Yoga is WebAssembly, not a
native addon — that is the entire reason this works on Windows where OpenTUI's Zig FFI does
not.

## Security posture

The W00 audit record reports zero advisories for the current dependency tree. The
`cheerio/slim` import keeps the runtime path free of the unused HTML-parser dependency edge;
see [13-DEPENDENCIES.md](13-DEPENDENCIES.md) §4 for the recorded audit and deprecation
findings.

## Non-negotiable outcomes

1. `src/agent`, `src/tools`, `src/llm`, `src/store`, `src/safety`,
   `src/interactive-session`, and `src/app` remain the only runtime implementation of
   product behaviour. No renderer reimplements any of it.
2. OpenTUI does not regress. Every existing `test/tui-v2` and `test/app` test passes
   unchanged at every work-package boundary. A red OpenTUI test is a blocker, never a
   "fix later".
3. The Ink frontend is `classic`: the platform selector chooses it by default on Windows
   and uses it for explicit, small-terminal, and OpenTUI-fallback paths. A Windows runtime
   probe is still required before claiming release support on specific terminal hosts.
4. `src/repl.ts`, `src/repl/prompt-line.ts`, and `src/agent/classic-renderer.ts` are
   deleted from the runtime, not left dormant.
5. The `writesDirectly` branch inside `src/agent/runner.ts` is deleted. One-shot output
   is produced by a dedicated renderer consuming the same `AppEvent` stream.
6. The Windows compiled binary must not load, initialize, or bundle OpenTUI native
   modules, and must never exit silently; these claims require the Windows binary and
   Process Monitor probes listed in W15/W17 before release.
7. No file becomes a monolith. Components stay presentational; behaviour lives in small
   pure modules or shared controllers. Target ceiling ~350 lines per file; a file over
   400 lines needs a written justification in the completion report.
8. Binary and install size are measured and reported against the baseline; no decrease is
   assumed before the final measurements.
9. Source carries no explanatory comments. See [00-AI-EXECUTION.md](00-AI-EXECUTION.md).

## Frontend selection matrix (final state)

| Invocation / environment | Result |
|---|---|
| macOS/Linux TTY, no flag | OpenTUI |
| Windows TTY, no flag | Ink classic — no Bun probe, no OpenTUI import |
| OpenTUI unavailable, FFI failure, terminal < 60x14 | Ink classic with one dim diagnostic line |
| `--classic`, `--ui classic`, `--ui legacy`, `--ui ink`, `CLAI_CLASSIC=1`, `CLAI_TUI=0`, `CLAI_UI=classic\|legacy\|ink` | Ink classic |
| `--tui`, `--ui tui`, `--ui v2`, `CLAI_UI=tui\|v2\|opentui` | OpenTUI where supported, otherwise Ink classic |
| `clai "prompt"`, `clai --mode agent "prompt"` | noninteractive stream renderer |
| stdin or stdout not a TTY | noninteractive stream renderer, plain text, no ANSI |

## Document index — read in this order

| # | Document | What it settles |
|---|---|---|
| 00 | [AI-EXECUTION](00-AI-EXECUTION.md) | how the implementing agent works, comment policy, per-package loop |
| 01 | [AUDIT](01-AUDIT.md) | verified current state with file:line evidence; what is shared vs classic-only vs dead |
| 02 | [ARCHITECTURE](02-ARCHITECTURE.md) | target module layout, `src/ui-core` extraction manifest, dependency guards |
| 03 | [RENDER-MODEL](03-RENDER-MODEL.md) | the feed renderer: `<Static>` commit ledger, live tail, row-budget allocator |
| 04 | [UI-SPEC](04-UI-SPEC.md) | every element, glyph, colour, placement, state, density tier, fallback |
| 05 | [INPUT](05-INPUT.md) | raw stdin decoder, chord table, focus routing, paste, secrets, mouse policy |
| 06 | [ONESHOT](06-ONESHOT.md) | non-interactive renderer and removal of runner direct writes |
| 07 | [PLATFORM-PACKAGING](07-PLATFORM-PACKAGING.md) | OS behaviour, launch selection, Windows, build targets, size budget |
| 08 | [ROADMAP](08-ROADMAP.md) | work packages W00–W17 with files, dependencies, acceptance gates |
| 09 | [PARITY](09-PARITY.md) | parity contract and the list of approved deviations |
| 10 | [TESTING](10-TESTING.md) | unit, contract, PTY, platform, performance, release gates |
| 11 | [CLEANUP](11-CLEANUP.md) | exact deletion and move list, dependency removals, size measurement |
| 12 | [TASKS](12-TASKS.md) | checkbox tracker; the only place progress is recorded |
| 13 | [DEPENDENCIES](13-DEPENDENCIES.md) | stack rationale, version pins, Node engine decision, vulnerability remediation, deprecation sweep |
| 14 | [PRIOR-ATTEMPT](14-PRIOR-ATTEMPT.md) | why the earlier Ink attempt failed, and the rule that prevents each cause |

Read [14-PRIOR-ATTEMPT.md](14-PRIOR-ATTEMPT.md) before writing any component. An Ink
frontend was attempted before and abandoned for misplaced UI and broken features; that
document identifies seven root causes and maps each to an enforced rule. Its most important
instruction: **do not read that branch's source.**

## Definition of done

A release is complete only when every box in [12-TASKS.md](12-TASKS.md) has recorded evidence,
including the target-host gates. W18 documentation may be authored before that point, but it
must leave Windows, unavailable Linux/manual walkthroughs, native probes, and any unmeasured
size/performance claims unchecked. The final release record in `W18-RELEASE.md` is the source
for what this checkout actually proved.

The automated baseline remains:

- `npm run typecheck`, `npm test`, `npm run build`, `npm run compile`, and `npm run test:bun`
  must pass for a release.
- [09-PARITY.md](09-PARITY.md) may contain only approved deviations.
- POSIX PTY smoke and the target-host Windows/manual gates must be recorded separately; a
  macOS run or cross-compile does not substitute for Windows or Linux evidence.
- `src/repl.ts`, `src/repl/prompt-line.ts`, `src/agent/classic-renderer.ts`, and the
  runner's `writesDirectly` branch remain deleted.
- Installed package size and each compiled binary are measured before and after, with any
  increase explained rather than silently presented as a reduction.
