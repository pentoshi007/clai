# ADR-006 — Use the OpenTUI React adapter (supersedes the Solid recommendation)

Status: accepted
Date: 2026-07-13
Supersedes: the SolidJS binding choice in RESEARCH.md / ADR-001 for the v2 UI.

## Context

RESEARCH.md, DECISIONS.md (ADR-001), ARCHITECTURE.md, and ROADMAP V2-010 all
name SolidJS + `@opentui/solid` + `@opentui/keymap` as the v2 rendering stack.
However, the Phase 0 foundation commit (`e7a3034`) instead installed
`@opentui/react` and recorded, in `dependency-policy.md`, that the Solid adapter
was rejected on 2026-07-03 because its release pulled a deprecated transitive
`glob@9.3.5` and an incompatible Babel 7 chain.

This left the design package internally inconsistent. V2-010 required resolving
it before any UI code is written, because the adapter choice determines every
component in `src/tui-v2`.

## Decision

Adopt `@opentui/react` as the v2 rendering adapter, together with
`@opentui/core` and `@opentui/keymap`, all pinned to exact `0.4.3`.

## Alternatives considered

- `@opentui/solid` + `solid-js@1.9.12`: matches OpenCode and the original
  research. Re-checked on 2026-07-13; the registry no longer flags the adapter
  itself as deprecated, but it still carries a full Babel 7 + `babel-preset-solid`
  toolchain as runtime dependencies. Switching would also reverse an already
  committed decision and require re-tooling JSX/build for a second framework.

## Evidence (2026-07-13, this environment)

- `npm view` line for all `@opentui/*` packages: latest is `0.4.3`.
- `npm install --save-exact @opentui/core@0.4.3 @opentui/react@0.4.3
  @opentui/keymap@0.4.3` → "added 2 packages, changed 5 packages", 199 audited,
  0 vulnerabilities, no `npm warn deprecated` lines in the resulting tree.
- `@opentui/keymap` peer-optionally accepts either the React or Solid adapter,
  so keymap works with the React adapter alone.
- `npm run typecheck` clean; Node vitest suite 717/717 still green after the
  bump (nothing in `src` imports `@opentui` yet, so runtime is unaffected).

## Consequences

- clai already depends on React 19 (via Ink), so the React adapter is the
  smaller, lower-risk migration and avoids a second component framework.
- ARCHITECTURE.md's anti-patterns still apply and are MORE important under
  React: do not wrap OpenTUI renderables in React state, and do not funnel every
  streaming token through one global object that rerenders the whole tree.
  Components must subscribe to the narrowest store slice; high-volume tool/stream
  data stays in ring buffers referenced by id, never copied into React state.
- If React reconciliation later proves unable to meet the streaming/selection
  frame budgets, revisit Solid behind the same application ports (the app layer
  is renderer-independent by design, so the adapter is replaceable).

## Migration impact

- `dependency-policy.md` "Current Phase 1 selection" updated to `0.4.3` and to
  include `@opentui/keymap`.
- No `src` code imports the adapter yet; this ADR only fixes the dependency set
  and the documented direction.
