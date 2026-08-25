# AGENTS.md

This file is the working guide for AI coding agents contributing to `lcl`. It applies to the entire repository.

## Orientation

`lcl` is a public, language-neutral local stack runner distributed as `@cvhome/lcl`. A project keeps one
`lcl.yml`; the CLI validates it, assigns ports, starts dependency-ordered foreground processes and optional Docker
Compose services, checks readiness, records events and logs, and supervises several named stacks at once.

The package targets Node.js 22+ on macOS, Linux, and WSL2. It is TypeScript using ESM and NodeNext resolution. Keep
the runtime small and dependency-light. Do not introduce assumptions about Java, Node.js, Python, or any other
service implementation into the engine.

The core flow is:

```text
lcl.yml
  -> JSON Schema + semantic validation
  -> source/Compose catalog + dependency graph
  -> whole-stack port allocation
  -> per-stack state and generated files
  -> one supervisor process
       -> Docker Compose project
       -> foreground service process groups
       -> health, logs, events, and control socket
  -> status/logs/why/stop commands
```

## Project structure

| Path | Responsibility |
|---|---|
| `bin/lcl.js` | Stable npm executable. Loads compiled `dist/src/main.js`; never put application logic here. |
| `src/main.ts` | CLI arguments, help text, command dispatch, and private `__supervise` entry point. |
| `src/commands/` | User-facing command orchestration. Keep reusable engine behavior outside this folder. |
| `src/config.ts` | Finds and parses `lcl.yml`, applies schema and semantic validation, and handles interpolation. |
| `schema/lcl.schema.json` | Public configuration contract and editor schema. Unknown keys are rejected. |
| `src/catalog.ts` | Resolves source services, canonical Compose services, dependency closure, and topological levels. |
| `src/ports.ts` | Detects listeners and registry reservations, then allocates one offset for the whole stack. |
| `src/instance.ts` | Stack identity, `.lcl/<stack>` paths, state format, Compose project names, and global registry. |
| `src/supervisor.ts` | Long-lived owner of processes and containers; startup, readiness, monitoring, restart, and shutdown. |
| `src/control.ts` | JSON-lines protocol over a per-stack Unix socket between commands and the supervisor. |
| `src/proc.ts` | Detached process groups, process fingerprints, tree termination, and signal handling. |
| `src/compose.ts` | Docker Compose command adapter scoped to the exact stack project. |
| `src/health.ts` | HTTP and TCP probes. |
| `src/render.ts` | Variables, generated files, Compose env/override files, exported ports, and URLs. |
| `src/logs.ts`, `src/events.ts` | Log inspection and persistent JSONL event history. |
| `src/ui.ts` | CLI errors, output, colors, and formatting. |
| `src/version.ts` | CLI, state-format, and control-protocol versions. |
| `templates/` | Files produced by `lcl init`. Templates must remain immediately valid. |
| `examples/` | Runnable language-neutral examples and Compose example. |
| `test/` | Node test-runner suites compiled to `dist/test`. |
| `.github/workflows/` | Node 22/24 CI matrix and npm OIDC publishing. |
| `docs/release-checklist.md` | Maintainer release gate. |

## Skills and source of truth

Useful expertise for this repository is Node.js/TypeScript CLI development, Unix process supervision, TCP/HTTP,
Docker Compose, YAML/JSON Schema, and npm packaging. There are no required repository-local agent skills. Do not
apply framework-specific conventions from a consumer repository to this engine.

When sources disagree, use this order:

1. Runtime behavior and safety invariants in `src/`.
2. `schema/lcl.schema.json` for the public YAML shape.
3. Tests for supported observable behavior.
4. `README.md` and examples for the public user contract.
5. This file and `CONTRIBUTING.md` for contributor workflow.

For behavior that changes outside the repository—Node.js, npm publishing, GitHub Actions, or Docker Compose—verify
against current official documentation before changing compatibility or release automation.

## Development commands

Run commands from the repository root:

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

- `npm run check` performs strict TypeScript checking without emitting files.
- `npm test` rebuilds and runs `node --test dist/test/*.test.js`.
- Docker-backed tests run when Docker is available. On a machine intentionally without Docker, use
  `CI_NO_DOCKER=1 npm test`; do not claim Compose behavior was verified.
- `npm pack --dry-run` executes `prepack`, so it rebuilds and reruns tests before printing the package contents.
- For direct CLI development, run `npm run build` and then `node bin/lcl.js ...`. The bin intentionally depends on
  compiled `dist/`; do not make it execute TypeScript at runtime.

Tests must isolate their files and registry. Use a temporary project root plus a temporary `LCL_HOME`; always stop
any started stack in `finally` before removing that exact temporary directory. Never let a test operate on the
developer's real `~/.lcl` registry or an unrelated project.

Test ownership:

- `test/config.test.ts` — schema/parser/semantic validation and interpolation.
- `test/ports.test.ts` — named ports, offset math, and TCP range boundaries.
- `test/lifecycle.test.ts` — packaged CLI dependency start, state, status, shutdown, and version alignment.
- `test/compose.test.ts` — real Docker Compose lifecycle and isolation.
- `test/safety.test.ts` — process identity and checkout-scoped Compose ownership.
- `test/examples.test.ts` — every checked-in example remains valid.

Add focused tests in the owning suite. A lifecycle, cleanup, Compose, or process-control change needs an integration
style test; a parser-only assertion is not enough.

## Configuration contract

`lcl.yml` is the only project configuration owned by the CLI. Runtime artifacts belong under the ignored
`.lcl/<stack>/` directory.

When adding or changing a configuration field, update all of these in one change:

1. `schema/lcl.schema.json`.
2. Public and raw types plus parsing/normalization in `src/config.ts`.
3. Semantic validation in `src/config.ts` or `src/catalog.ts`.
4. Runtime consumers.
5. `README.md`.
6. Parser and behavior tests.
7. Relevant examples and `lcl init` templates.

External YAML uses kebab-case where established; normalized TypeScript uses camelCase. Preserve strict unknown-key
rejection. Reject invalid combinations before starting a process or container. A breaking YAML change requires a
new top-level `version` and an explicit migration story; do not silently reinterpret schema v1.

`docker compose config --format json` is the canonical Compose model. Do not implement a partial Compose YAML
parser. Source service names and Compose service names must remain unambiguous, and their published host ports must
not collide in the configured catalog.

Interpolation must remain explicit and fail on unknown variables. `${env.NAME}` is the only implicit host
environment lookup. Prefer argv-array `command` values; `shell` is an explicit opt-in for shell expansion.

## Runtime invariants

### Named stacks and state

- Each stack is identified by its normalized `--stack` value plus a checkout hash.
- Project state is `.lcl/<stack>/`; the cross-checkout registry is `${LCL_HOME:-~/.lcl}/instances`.
- State writes are atomic. Do not leave partially written `state.json` files.
- Compose project names include the checkout hash so equal stack names in different clones cannot collide.
- Unix sockets stay in the OS temporary directory because macOS has a short socket-path limit.
- Incompatible persisted state requires incrementing `STATE_VERSION`. Incompatible control messages require
  incrementing `CONTROL_PROTOCOL_VERSION`. Add compatibility/error tests with either change.

### Ports

- Port assignment is whole-stack: every named source port and selected Compose host port receives the same offset.
- Never independently shift one service; stable relationships between services are a core promise.
- Allocation must consider live listeners and ports reserved by other registered live stacks.
- A selected subset still reserves all source ports so a later service start cannot collide inside that stack.
- Validate the upper TCP bound of 65535 and retain deterministic offset selection.
- A port listener is diagnostic information only. It is never proof that `lcl` owns a process.

### Dependencies and readiness

- Source services start in topological levels. Selecting a service starts its transitive source and Compose
  dependencies.
- A source service cannot start until its source dependencies are `up`.
- Readiness supports HTTP, TCP, log regex, and process-alive checks. Keep timeout failures visible as degraded or
  crashed state rather than silently succeeding.
- HTTP 401/403 currently counts as reachable secured health; HTTP 5xx fails. Changing this is public behavior and
  requires tests and documentation.
- Containers with a healthcheck must become `healthy`; containers without one wait for all published ports.
  Exited, dead, unhealthy, and timed-out containers must fail startup clearly.

### Ownership and cleanup

These are security boundaries, not implementation details:

- Spawn each service in its own process group so descendants cannot survive normal shutdown.
- Record a process fingerprint with every PID. Orphan recovery may signal a PID only when both still match.
- Never kill a process merely because it owns an expected port. Report a foreign listener and refuse to signal it.
- `lcl clean` may recursively remove only an exact `.lcl/<stack>` directory whose `state.json` sentinel contains
  the expected registry key. Never broaden this deletion target.
- Every Compose operation must carry the recorded project name, files, env file, and generated override.
- Normal stop preserves volumes. Only explicit `--hard` may request Compose volume deletion, and only for that
  stack's project.
- Do not weaken these checks to make stale-state recovery more convenient.

## Implementation conventions

- Keep TypeScript strict. ESM imports use `.js` suffixes even in `.ts` sources because output uses NodeNext.
- Prefer Node built-ins and existing dependencies before adding a package. Any new runtime dependency affects a
  globally installed CLI and needs a clear reason, lockfile update, and package-size review.
- Put reusable behavior in the focused engine module; command modules should mostly validate flags, obtain context,
  call the engine, and present results.
- Use `CliError`/`die` for expected user failures. Unexpected failures retain their stack through `src/main.ts`.
- Commands must be safe when repeated and must give actionable errors containing the stack/service involved.
- Do not log secrets. `lcl why` exposes resolved environment for diagnostics, so new environment handling must avoid
  introducing credentials into normal logs or events.
- Keep cross-platform assumptions explicit. Native Windows is not a target; macOS, Linux, and WSL2 are.
- Avoid generated files in commits: `dist/`, `*.tgz`, and every `**/.lcl/` are build/runtime output.

## Common change maps

For a new CLI command:

- Add parsing, dispatch, and help text in `src/main.ts`.
- Put orchestration in `src/commands/`; reuse engine modules.
- Document it in `README.md` and add CLI-level tests.

For lifecycle or supervision behavior:

- Trace `commands/start.ts` or `commands/stop.ts` through `supervisor.ts`, `control.ts`, `proc.ts`, and state writes.
- Test foreground/background behavior, state transitions, failure reporting, and cleanup.

For port or Compose behavior:

- Review `catalog.ts`, `ports.ts`, `render.ts`, `compose.ts`, status/doctor output, and multi-checkout isolation.
- Exercise real Docker Compose where relevant; mocks cannot prove project or volume isolation.

For versioning or publishing:

- Keep `package.json` and `src/version.ts` versions identical; `test/lifecycle.test.ts` enforces this.
- Update `CHANGELOG.md`, review the npm file allowlist, and run the release checklist.
- The package `files` allowlist and `.npmignore` must never include runtime `.lcl` state.
- Do not publish, tag, create a GitHub release, or change npm trust without explicit maintainer authorization.
- Trusted publishing uses `.github/workflows/publish.yml`, GitHub-hosted runners, and npm OIDC. The package must exist
  before its trusted publisher can be configured; follow `CONTRIBUTING.md` for the one-time bootstrap.

## Completion gates

Before saying a change is done:

- [ ] `npm run check` passes.
- [ ] `npm test` passes, with Docker for Compose/lifecycle changes.
- [ ] `npm pack --dry-run` succeeds and the file list contains no state, logs, credentials, or unrelated files.
- [ ] New behavior has an owning test and user-facing documentation.
- [ ] Schema, parser, runtime, examples, and templates agree when configuration changed.
- [ ] Process ownership, stack isolation, port shifting, and safe deletion remain intact.
- [ ] `git diff --check` is clean and unrelated working-tree changes are untouched.

Work on a feature branch unless the maintainer explicitly requests another workflow. Do not commit or push on the
user's behalf unless asked.
