# Contributing to clai

First off, thank you for considering contributing to **clai**! Every contribution — whether it's a bug report, feature request, documentation improvement, or code change — helps make this project better for everyone.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)
- [Style Guide](#style-guide)
- [Community](#community)

## Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to **[pentoshi007](https://github.com/pentoshi007)**.

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/clai.git
   cd clai
   ```
3. **Add the upstream remote**:
   ```bash
   git remote add upstream https://github.com/pentoshi007/clai.git
   ```
4. **Create a branch** for your work:
   ```bash
   git checkout -b feat/my-feature
   ```

## Development Setup

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 22 |
| npm | ≥ 9 |
| Git | ≥ 2.30 |

### Install Dependencies

```bash
npm install
```

### Useful Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start in development mode |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Run type checking without emitting files |
| `npm test` | Run the full test suite via Vitest |
| `npm run test:classic:pty` | Run the provider-independent POSIX classic PTY smoke |
| `npm run compile` | Compile the five Bun release targets |
| `npm run release:verify` | Validate release metadata and artifact declarations |
| `npm run doctor` | Run built-in diagnostics |

### Environment Variables

Copy the example environment file and fill in any required values:

```bash
cp .env.example .env
```

## Project Structure

```
clai/
├── src/            # TypeScript source code
│   ├── app/        # renderer-neutral controllers, commands, events, and ports
│   ├── ui-core/    # renderer-neutral state, actions, layout, rendering, and React hooks
│   ├── classic/    # React + Ink classic UI and terminal bootstrap
│   ├── tui-v2/     # OpenTUI full-screen renderer
│   └── noninteractive/ # stdout/stderr-split one-shot renderer
├── dist/           # Compiled JavaScript output
├── bin/            # CLI entry point (clai.mjs)
├── scripts/        # Build, release, and utility scripts
├── test/           # Test files (Vitest)
├── install/        # Platform installation scripts
├── manifests/      # Distribution manifests
├── audit/          # Security audit configuration
└── .github/        # CI workflows and templates
```

## Making Changes

1. **Keep changes focused.** One pull request should address one concern — a single bug fix, feature, or refactor.
2. **Write tests.** If you add or change behavior, add or update the corresponding tests in `test/`.
3. **Run checks locally** before pushing:
   ```bash
   npm run typecheck
   npm test
   ```
4. **Update documentation.** If your change affects user-facing behavior, update `README.md` or other relevant docs.

### Renderer boundaries

- `src/app/` and `src/ui-core/` are renderer-neutral. They may define state, actions,
  layout models, pure presenters, and explicit ports, but must not import Ink, OpenTUI,
  renderer-specific components, or write directly to the terminal.
- `src/classic/` owns the React + Ink surface and POSIX terminal lifecycle. `src/tui-v2/`
  owns OpenTUI components and native terminal integration. `src/noninteractive/` owns the
  append-only one-shot stream surface and its stdout/stderr policy.
- Raw terminal reads/writes belong only in the approved bootstrap or port modules. Keep
  renderer-neutral behavior behind app ports so both interactive frontends consume the same
  session, transcript, command, safety, and persistence contracts.
- Use strict TypeScript, explicit `.js` extensions for relative ESM imports, and small
  focused modules. Keep classic source files at or below the 400-line architecture guard.

## Commit Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <short summary>
```

### Types

| Type | Purpose |
|------|---------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only changes |
| `style` | Formatting, missing semicolons, etc. (no code change) |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `chore` | Build process, tooling, or dependency updates |
| `ci` | CI/CD configuration changes |
| `revert` | Reverts a previous commit |

### Examples

```
feat(provider): add support for Anthropic provider
fix(tools): prevent duplicate tool calls on rate-limit retry
docs(readme): add Windows installation instructions
test(compaction): add coverage for context compaction edge cases
```

## Pull Request Process

1. **Ensure your branch is up to date** with `main`:
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```
2. **Push** your branch and open a Pull Request against `pentoshi007/clai:main`.
3. **Fill out the PR template** — describe what changed and why.
4. **Link related issues** (e.g., `Closes #42`).
5. **Ensure all CI checks pass.**
6. **Respond to review feedback** promptly and push follow-up commits.
7. A maintainer will merge the PR once it is approved.

## Reporting Bugs

Use the [Bug Report issue template](https://github.com/pentoshi007/clai/issues/new?template=bug_report.yml) and include:

- **clai version** (`clai --version`)
- **Node.js version** (`node -v`)
- **Operating system** and version
- **Steps to reproduce** the issue
- **Expected behavior** vs. **actual behavior**
- **Relevant logs** or error output

## Requesting Features

Use the [Feature Request issue template](https://github.com/pentoshi007/clai/issues/new?template=feature_request.yml) and describe:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

## Style Guide

- **Language:** TypeScript (strict mode)
- **Module system:** ESM (`"type": "module"`)
- **Formatting:** Follow the existing code style in the repository
- **Naming:**
  - `camelCase` for variables and functions
  - `PascalCase` for types, interfaces, and classes
  - `UPPER_SNAKE_CASE` for constants
- **Imports:** Use explicit file extensions (`.js`) for relative imports in ESM
- **Error handling:** Prefer explicit error handling; avoid swallowing errors silently

## Community

- **Issues:** [GitHub Issues](https://github.com/pentoshi007/clai/issues)
- **Discussions:** [GitHub Discussions](https://github.com/pentoshi007/clai/discussions) *(if enabled)*

---

Thank you for helping make clai better! 🚀
