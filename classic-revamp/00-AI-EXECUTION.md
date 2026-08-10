# AI Implementation Instructions

You are the implementing agent for this migration. Read this file completely before
touching source. These rules override habit, convenience, and speed.

## Mission

Deliver a React + Ink classic frontend that a senior terminal-UI engineer would ship:
correct, small, boring, obvious. No agent semantics change. No OpenTUI regression.

## Write code like a senior engineer

### Comment policy — strict

- Do **not** write explanatory comments. Not above functions, not inside them.
- Do **not** write file-header docblocks describing what the module does.
- Do **not** restate code in prose.
- Do **not** leave phase numbers, task IDs, work-package labels, migration notes,
  `TODO` essays, `NOTE:`, `FIXME:`, or "why this exists" narration in source.
- Do **not** write JSDoc unless a public type is genuinely ambiguous from its name and
  signature, and even then prefer renaming over documenting.
- A single short comment is permitted only for a non-obvious terminal control sequence,
  a security invariant, or a platform workaround that naming cannot express. One line.
  If you need two lines, the code is wrong or the explanation belongs in this directory.
- Do not churn existing comments in `src/tui-v2` or `src/app` to satisfy this rule.
  Those files keep their comments. This policy applies to code you write.

Design explanations go in `classic-revamp/*.md`. Behaviour explanations go in tests.

### Naming and structure carry the meaning

- Name modules after the single thing they own: `commit-ledger.ts`, `row-budget.ts`,
  `chord-from-key.ts`, `feed-blocks.ts`.
- One responsibility per file. If a name needs "and", split it.
- Pure functions by default. Side effects live in a named boundary (a controller, a port,
  or a bootstrap file), never scattered.
- Discriminated unions with exhaustive `switch` and a `never` fallthrough for state
  machines. No boolean pairs that can both be true.
- Stable domain IDs as React keys. Never array index.
- `readonly` on every interface field that is not mutated.
- No `any`. No `as unknown as`. No non-null `!` unless a guard immediately above proves
  it. Prefer narrowing.
- No module-level mutable singleton when a controller or port already exists. The
  existing exception `composerActionPort` is a pattern to replace, not copy.
- No barrel `index.ts` files. They hide cycles and defeat tree shaking.
- No circular imports. If two modules need each other, a third module owns the shared
  type.

### File size

Target ceiling ~350 lines. Hard review trigger at 400. Pure data catalogues may exceed
it. React components that exceed it are always wrong: extract the row renderer, the
layout math, or the key handler.

## Branch and repository safety

- Work only on `fix/classic-revamp` in this worktree.
- Never checkout, merge, rebase, push to, or commit to `main` unless the owner asks.
- Run `git status` before starting each work package. Preserve unrelated changes.
- Do not create commits unless asked. If asked, one commit per work package,
  independently reviewable.
- No destructive git commands. No `--force`, no `reset --hard`, no `clean -fd`.
- **Do not read `feature/classic-react`'s `src/`.** That branch is a failed attempt whose
  architecture produced misplaced UI and broken features. Its two useful findings are already
  transcribed into [05-INPUT.md](05-INPUT.md) §1 and [01-AUDIT.md](01-AUDIT.md) §10. Reading
  its code will pull its shape into your solution. See
  [14-PRIOR-ATTEMPT.md](14-PRIOR-ATTEMPT.md).
- Do not check that branch out over this worktree.

## Source-of-truth rules

- Authoritative for behaviour: `src/agent`, `src/app`, `src/tools`, `src/llm`,
  `src/store`, `src/safety`, `src/interactive-session`, and their tests.
- Authoritative for the product target: current OpenTUI behaviour in `src/tui-v2`.
- Authoritative for commands: the shared command registry.
- Authoritative for shortcuts: `defaultKeymap`.
- Authoritative for state transitions: `applyAppEvent` and the shared controllers.
- Authoritative for layout and visuals: [04-UI-SPEC.md](04-UI-SPEC.md) and
  [03-RENDER-MODEL.md](03-RENDER-MODEL.md) in this directory.
- Authoritative for versions and dependencies: [13-DEPENDENCIES.md](13-DEPENDENCIES.md).

## The four failure modes that killed the last attempt

If you catch yourself doing any of these, stop and read
[14-PRIOR-ATTEMPT.md](14-PRIOR-ATTEMPT.md):

1. Writing a scroll offset, a viewport slice, or anything that tracks "which rows are
   visible". The feed model has no viewport.
2. Storing or comparing a `y` screen coordinate inside a component or controller. Only
   `allocateChrome()` decides heights, and nothing records absolute positions.
3. Letting a file pass 400 lines. Split it before you add the next behaviour.
4. Writing a second implementation of something `src/ui-core` already owns — a composer
   controller, an overlay controller, a reducer, a command switch.

## Prohibited patterns

- A second agent runner, session policy, or event bus.
- A renderer-local slash-command switch.
- `src/classic` importing `@opentui/*` or anything under `src/tui-v2`.
- `src/tui-v2` importing anything under `src/classic`.
- `src/ui-core` importing `ink`, `@opentui/*`, or writing terminal bytes.
- `src/app` importing React, Ink, OpenTUI, or inquirer.
- Any component importing the agent runner, tool registry, provider router, stores,
  safety classifier, or jobs manager directly.
- Copying the transcript reducer, persistence, or plan lifecycle.
- Raw `process.stdout.write` outside the one dedicated terminal adapter in
  `src/classic/bootstrap/`.
- Ink's `useInput` anywhere. Input comes from our decoder only.
- A new runtime dependency without owner approval, or any dependency range.
- Skipping, `.skip`-ing, or loosening a failing test to make a package pass.
- Changing prompts in `src/prompts/` or tool behaviour.

## Work-package loop

For each package in [08-ROADMAP.md](08-ROADMAP.md), in order:

1. `git status`. Read the relevant source and its existing tests.
2. Confirm the dependency boundaries the package must respect.
3. Write the failing tests for the behaviour first.
4. Implement the smallest coherent change that makes them pass.
5. Run the package's targeted tests.
6. `npm run typecheck`.
7. If anything shared or under `src/tui-v2` changed: run `npx vitest run test/tui-v2 test/app`
   immediately. Any failure is a blocker for this package.
8. Fix every regression before starting the next package.
9. Check the matching boxes in [12-TASKS.md](12-TASKS.md) — only for items whose
   validation command you actually ran.
10. Report: files changed, behaviour delivered, tests added, exact commands and their
    outcomes, OpenTUI regression evidence, Windows evidence when applicable, deviations
    recorded in [09-PARITY.md](09-PARITY.md), next unlocked package.

Never stack work on a red baseline. If a failure predates your package, record it before
starting and prove it is unrelated.

## Extraction discipline

`src/ui-core` extraction (W02) is a pure move. Rules:

- Move one coherent cluster at a time; rewrite imports; run `test/tui-v2` and `test/app`;
  only then move the next cluster.
- Behaviour-preserving. Zero styling or logic changes inside an extraction commit.
- Move the module's tests with it, keeping coverage.
- Temporary re-export shims are allowed to shrink a diff, must contain no behaviour, and
  must be removed in the same work package that migrates the last caller.
- Never weaken a type to make a move compile. Split renderer-specific types out instead.
- Use `git mv` so history follows the file.

## Ink discipline

- Pin `ink@7.1.1`. Verify `engines` and `peerDependencies` against the registry before
  installing, and confirm the Ink 7 API surface in spike S1 — `<Static>`, `render` options,
  and `borderStyle` values must all still be what [03-RENDER-MODEL.md](03-RENDER-MODEL.md)
  and [04-UI-SPEC.md](04-UI-SPEC.md) assume.
- Let Yoga do geometry. Never compute a box edge, a border position, or a column offset by
  hand. Pre-wrap *text* so row counts are known; let Yoga place everything.
- One React version in the tree.
- Route every key through `chordFromKey` → `ActionRouter.resolve(chord, context)`.
- Paste is a distinct event type from keys. Pasted bytes never resolve to actions.
- Pre-wrap text to explicit line arrays before rendering. Do not rely on Yoga's wrapping
  for anything whose row count must be known — the row budget depends on exact heights.
- One `<Text>` per visual row. No nested wrapping `<Text>` inside a measured box.
- Subscribe to shared state with `useSyncExternalStore`. Never mirror service state into
  `useState`.
- Preserve the 16 ms coalescing in `TranscriptStore`. Never render per token.
- Memoize rows by item identity plus expansion state.
- Secrets live in a dedicated buffer and component. Never in transcript, logs, frames,
  snapshots, or error messages.

## Handling uncertainty

Do not guess about Ink internals, `<Static>` interleaving, Bun compile behaviour, Windows
console key delivery, or terminal protocols. Build a throwaway spike under
`classic-revamp/spikes/`, observe real output, convert the finding into a test, then
implement. Delete the spike, keep the test.

If a requirement cannot be met on Ink or Node 20, stop that package and write the options
with evidence into [09-PARITY.md](09-PARITY.md) as a proposed deviation. Do not silently
reduce parity, and do not silently invent a substitute.

## Completion

The migration is complete only when every gate in [10-TESTING.md](10-TESTING.md) has
passed with recorded output. Code inspection and confidence are not evidence.
