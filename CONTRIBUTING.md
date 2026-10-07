# Contributing to clai

Contributions can improve the CLI, providers, tools, terminal interfaces, tests, or documentation. Keep a change focused, explain its effect on users, and include validation appropriate to the work.

Use [Issues](https://github.com/pentoshi007/clai/issues) for reproducible bugs and feature requests, and [Discussions](https://github.com/pentoshi007/clai/discussions) for questions. Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through the process in [SECURITY.md](SECURITY.md).

## Source setup

Install Node.js 22 or later and npm. Bun is needed for OpenTUI development, native UI checks, and compiled release binaries; the [CI workflow](.github/workflows/ci.yml) specifies the version used for conformance checks. Classic development can run through Node and `tsx`.

Fork the repository, then clone your fork and install the locked dependencies:

```sh
git clone https://github.com/<your-username>/clai.git
cd clai
git remote add upstream https://github.com/pentoshi007/clai.git
git switch -c docs/session-guide
npm ci
npm run dev
```

`npm run dev` prefers Bun when available. Use `npm run dev -- --classic` for Classic, or `npm run dev:node -- --classic` to run it explicitly through Node.

The tests use fixtures and isolated storage; provider credentials are not required for the standard suites. For manual provider testing, configure a test account or export the relevant environment variables as described in [PROVIDERS.md](PROVIDERS.md).

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the source entrypoint, preferring Bun. |
| `npm run dev:bun` | Run source through Bun explicitly. |
| `npm run dev:node` | Run source through Node and `tsx`. |
| `npm run typecheck` | Check TypeScript without emitting files. |
| `npm run build` | Embed prompts and compile JavaScript to `dist/`. |
| `npm start` | Run the built entrypoint. |
| `npm run test:deterministic` | Run Vitest with the canonical locale and timezone. |
| `npm run test:host -- test/environment` | Check environment behavior under the host's locale and timezone. |
| `npm run test:classic:pty` | Run the provider-independent POSIX terminal smoke test; requires Python 3. |
| `npm run test:bun` | Run native OpenTUI smoke and parity checks through Bun. |
| `npm run embed-prompts:check` | Check that embedded prompts match their source Markdown. |
| `npm run release:verify` | Validate dependency pins, lockfile, and release metadata. |
| `npm run compile` | Build native release binaries through Bun. |
| `npm run doctor` | Inspect available tools and provider configuration. |

To run a focused test:

```sh
npm run test:deterministic -- test/session-runtime/host.integration.test.ts
```

For dependency changes, update `package.json` and `package-lock.json` together and run `npm run release:verify`. Preserve the repository's exact dependency pins.

## Architecture and boundaries

| Location | Responsibility |
| --- | --- |
| `src/index.ts` | CLI options, subcommands, and startup. |
| `src/agent/` | Agent turns, plans, compaction, and subagents. |
| `src/llm/` | Provider protocols, credentials, streaming, routing, and usage. |
| `src/app/`, `src/ui-core/` | Shared controllers, commands, state, actions, and renderer ports. |
| `src/classic/` | React and Ink UI and its terminal lifecycle. |
| `src/tui-v2/` | OpenTUI components and native terminal integration. |
| `src/noninteractive/` | One-shot output and stdout/stderr policy. |
| `src/session-runtime/` | Durable agent hosts, shared attachments, discovery, and reattachment. |
| `src/interactive-session/` | Conversation-owned terminal sessions and transports. |
| `src/store/` | Configuration, history, prompt journals, plans, and retained subagent state. |
| `src/tools/`, `src/safety/` | Tool implementation, classification, permissions, and engagement policy. |
| `src/mcp/`, `src/skills/` | MCP integration and Agent Skills. |
| `src/prompts/` | Runtime system prompts and their generated embedded representation. |
| `test/`, `scripts/`, `.github/workflows/` | Regression tests, tooling, and CI/release workflows. |
| `bin/`, `install/`, `manifests/` | npm launchers, platform installers, and distribution templates. |

Keep `src/app/` and `src/ui-core/` renderer-neutral: do not import Ink, OpenTUI, renderer-specific components, or write directly to the terminal there. Put terminal access in bootstrap or port modules so both interfaces share session, command, transcript, safety, and persistence behavior. Classic source files are subject to a 400-line architecture guard.

Use strict TypeScript, explicit `.js` extensions for relative ESM imports, and focused modules that follow the surrounding style. Handle failures explicitly. Changes to persistence, compaction, or attachment behavior must preserve conversation records and avoid starting duplicate agent writers.

Distribution manifests under `manifests/` are templates. The release workflow generates published metadata; placeholder hashes in those templates are not installation artifacts.

## Validation and pull requests

For behavior changes, add or update meaningful regression coverage and run the focused tests first. Run the relevant typecheck, build, deterministic suite, terminal checks, and release validation before submitting. UI changes should cover both renderers; process and privilege changes need the platform coverage defined in CI. Run native performance checks without competing build or full-suite workloads.

For documentation-only changes, check examples against current CLI help, validate links and formatting, and check any issue-template YAML. A full local application suite is unnecessary unless the change affects code, runtime prompts, or generated artifacts.

CI currently covers Node 22 and 24 on Linux, Bun OpenTUI conformance, Classic on macOS, and process/privilege behavior on macOS and Windows. The [workflow](.github/workflows/ci.yml) is the source of truth for required checks. All relevant remote checks must pass.

Open a pull request against `main` with:

- The concrete problem and resulting behavior, including an example when useful.
- Validation performed and any remaining limitations.
- Related issues and documentation updates where applicable.

Use descriptive commit messages; Conventional Commit prefixes such as `fix:`, `feat:`, and `docs:` are suitable. Keep generated build outputs, credentials, local history, investigation reports, and temporary files out of commits.

## Reporting bugs and requesting features

The [bug report form](https://github.com/pentoshi007/clai/issues/new?template=bug_report.yml) asks for the clai version, OS, installation method, UI, and reproduction steps. Include Node or Bun versions when running through those runtimes, plus the provider/model when relevant. For attachment bugs, describe the SSH or terminal setup and which sessions were attached.

Provide the smallest reproduction and expected versus actual behavior. Review logs, screenshots, prompts, and configuration before sharing them; remove credentials and private project data.

The [feature request form](https://github.com/pentoshi007/clai/issues/new?template=feature_request.yml) asks for the problem, proposed behavior, and alternatives. Explain the workflow the change would improve.
