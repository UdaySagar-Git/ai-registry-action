# Agent instructions

This file is canonical; `CLAUDE.md` is a relative symlink to it. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the shared workflow and [the architecture](docs/ARCHITECTURE.md) before changing the action.

ai-registry Action is a Node 24 GitHub Action (`action.yml`, `dist/index.mjs`) that previews and publishes an [ai-registry](https://github.com/atlanai/ai-registry) manifest's exports with `aireg`. It is vendor-neutral: examples use the synthetic `acme`, and nothing may assume a particular registry host or adapter.

## Commands

Use Node 24 (`.node-version`) and the committed lockfile.

```bash
npm ci --ignore-scripts
npm run typecheck
npm test            # node:test with coverage thresholds
npm run build       # rebuilds dist/; commit the result
npm run check       # all of the above, then fails if dist/ differs from source
```

## Where changes belong

- Inputs, outputs and Marketplace metadata: `action.yml`, with the matching README change. Input defaults live only there.
- One concern per module in `src/`: routing (`run.ts`), Action IO (`action.ts`), the GitHub client (`github.ts`), workspace and git checks (`workspace.ts`), installing aireg (`install.ts`), running aireg and reading its answers (`aireg.ts`), tokens, preview, publish and reports (`report.ts`). Limits, endpoints and aireg's release keys: `src/constants.ts`. Don't split a module until a second caller needs part of it.
- Tests: `test/<module>.test.ts`, mirroring `src/`, with shared helpers in `test/helpers/`.
- Build mechanics only: `scripts/build.ts`. Never edit `dist/` by hand.
- Behaviour of aireg itself, adapters and the manifest format belongs upstream in ai-registry.

Search every caller before changing a shared function, and fix validation once at the trust boundary.

## Invariants

- Only `src/main.ts` reads `process.env`; everything else takes an explicit environment.
- `pull_request_target` is refused. Registry tokens reach only `aireg publish`. Subprocesses run without a shell, with a fixed `PATH` and an allowlisted environment.
- Fixed install and API origins, response-size limits, path validation and token isolation are security boundaries; do not make them caller-configurable.
- There are no runtime dependencies. New dependencies of any kind, dependency upgrades, and install scripts need maintainer approval.
- Linux and macOS only; do not claim Windows support.

## Code and tests

- Strict TypeScript with `.ts` imports and erasable syntax only (no enums, namespaces or parameter properties), because Node strips types to run tests.
- Comments explain why, in at most two lines. No section banners, history or restated code. Use sentence case and avoid em dashes.
- Each non-trivial branch, parser, security boundary or failure path gets one focused test. Tests are hermetic: synthetic data, temporary directories cleaned up with `t.after`, git run without global config or hooks, and no network. Never make a test contact GitHub, a registry or `aireg.sh`.
- Rendered comments are snapshot-tested; review snapshot diffs like code.

## Approval boundaries

Do not push, merge, publish, tag, release, rewrite history, rotate credentials or change repository settings without explicit approval. Ask before editing workflows, `CODEOWNERS`, release automation or dependency configuration. Never print secret values or scan logs that may contain them.
