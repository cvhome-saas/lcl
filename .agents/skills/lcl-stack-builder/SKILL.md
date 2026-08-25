---
name: lcl-stack-builder
description: Inspect a project and create, extend, explain, validate, or troubleshoot a language-neutral lcl.yml for a complete local development stack with foreground services, optional Docker Compose infrastructure, dependency-ordered readiness, and stable cross-service ports. Use when onboarding a repository to @cvhome-saas/lcl or operating an existing LCL stack; do not use for unrelated Docker Compose-only work.
---

# LCL Stack Builder

Produce an LCL stack that follows the target repository's real development commands and can be understood and operated by another contributor. Treat `lcl.yml` as orchestration, not as a place to redesign applications or invent new build systems.

## Route the request

- Before creating or changing `lcl.yml`, read [references/configuration.md](references/configuration.md).
- For polyglot services, Compose infrastructure, cross-service communication, workers, or generated configuration, also read [references/complex-stacks.md](references/complex-stacks.md).
- For starting, verifying, diagnosing, or stopping a stack, read [references/operations.md](references/operations.md).
- For explanation or review requests, remain read-only unless the user also requests changes.

## Understand the target project

Follow its repository instructions first. Inspect an existing `lcl.yml`, README and contributor docs, package/build manifests, Compose files, example environment files, service entrypoints, and health endpoints. Avoid reading secret-bearing environment files when examples or documented variable names are enough.

Build a service inventory before editing: service name, working directory, foreground command, named ports, own-port binding mechanism, readiness signal, dependencies, and cross-service addresses. Distinguish:

- application processes that should remain foreground LCL `services`;
- existing databases, queues, caches, and similar infrastructure already represented by Docker Compose;
- one-shot setup that belongs in `prepare`, a hook, or the optional top-level `build` command.

Do not dockerize a source service merely to make the configuration uniform. LCL is intentionally language-neutral.

## Design and author the stack

Model an acyclic readiness graph. `depends-on` means “must be up before this service starts,” not merely “communicates with.” Peers that need each other's addresses can use the complete preallocated port map without depending on each other. If mutually coupled peers must start together, keep them at the same dependency level, make connection logic retry, and use suitable `--parallel N` operation; never introduce a dependency cycle.

Prefer argv-array `command` values and use `shell` only for actual shell syntax. Every declared source port must be passed to the application through a supported argument or environment variable; declaration alone does not bind the program. Use `${port.<service>.<name>}` for both own and peer ports so named stacks and shifted allocations remain coherent.

Choose readiness that proves the service is usable: HTTP or TCP when available, a stable log marker for a long-starting tool, and process-alive only for workers with no stronger signal. Give slow compilers and JVM services realistic timeouts.

Preserve existing Compose behavior and let LCL consume its canonical published-port model. Use generated files and hooks only when they simplify real project behavior. Use `prepare` when failure must prevent a service from starting.

## Validate proportionally

Run `lcl validate` after every configuration change when the CLI is available, then `lcl doctor` for environment and port diagnostics. Do not install a global CLI or dependencies without user authorization.

Start processes or containers only when the user asks for runtime verification. Prefer a unique named stack for a temporary verification run, inspect status and logs, and stop that exact stack in a cleanup step unless the user requested it remain running. Never use `lcl stop --hard`, delete volumes, clean broad state, or stop an existing user stack without explicit authorization.

Report the dependency order, assigned variable relationships, files changed, commands run, and anything not runtime-verified.

## Preserve LCL invariants

- Keep one strict schema-v1 `lcl.yml`; unknown keys are errors.
- Keep configured source and published Compose host ports unique.
- Never hardcode an effective shifted port in commands, environment, URLs, or generated files.
- Keep supervised commands in the foreground; do not add daemon flags.
- Do not put credentials in ordinary LCL environment values when avoidable: `lcl why` exposes resolved diagnostics.
- Treat a listener as a conflict, never as proof that LCL owns the process.
