# Operating and verifying LCL stacks

Read this reference when asked to validate, start, inspect, troubleshoot, restart, or stop a stack.

## Establish the executable

Use `lcl` when it is already on `PATH`. In the LCL source repository itself, build first and invoke `node bin/lcl.js`. Do not silently install the global npm package or project dependencies. If the executable is unavailable and installation was not requested, finish the configuration work and report that runtime validation was not performed.

Node.js 22+ is required. LCL targets macOS, Linux, and WSL2, not native Windows. Docker is required only when `compose` is configured, but even `lcl validate` loads the canonical Compose model and therefore needs a working Docker/Compose command for such a project.

## Safe workflow

From the project root:

```bash
lcl validate
lcl doctor
lcl ports
lcl start -d --stack codex-check
lcl status --stack codex-check
lcl urls --stack codex-check
```

Before startup, `lcl ports` displays configured base ports; final allocation occurs during `start`. After startup it displays the persisted assigned map.

For a temporary runtime verification, choose a collision-resistant stack name, record whether it existed before the task, and stop only the stack created by the verification:

```bash
lcl stop --stack codex-check
```

Normal stop preserves Compose volumes. Do not add `--hard` unless the user explicitly authorizes deletion of that stack's volumes. Do not run `clean --all` as routine verification.

## Starting subsets and controlling allocation

```bash
lcl start web -d                    # web plus transitive dependencies
lcl start -d --infra all            # all configured Compose services
lcl start -d --infra postgres,redis
lcl start -d --no-infra
lcl start -d --parallel 4
lcl start -d --ports configured     # fail rather than shift
lcl start -d --ports shift          # skip configured offset zero
lcl start -d --ports offset=2       # exactly 2 × ports.step
lcl start -d --fail-fast
lcl start -d --restart on-failure:3
```

An existing live stack retains its original port map when additional services are started or restarted. A new stack start allocates afresh; when prior stopped state is loaded, auto mode may reuse its previous nonzero offset if it remains free.

Use `--parallel N` for independent services in the same dependency level, especially mutually aware peers whose applications retry connections. It does not bypass `depends-on` readiness ordering.

## Diagnose failures

Use the narrowest diagnostic first:

```bash
lcl status --json
lcl why api
lcl logs api -n 100
lcl logs api --errors
lcl events --service api --since 10m
lcl ports --env
lcl doctor
```

Interpret common outcomes:

- Validation errors: correct the strict YAML shape, unknown field, bad reference, duplicate port, or dependency cycle before starting anything.
- Command exits: run the resolved command from its declared `cwd`; check missing runtimes and wrappers without rewriting the project's toolchain.
- Port occupied after allocation: identify the foreign listener. LCL will not kill it or reallocate an already-running stack.
- TCP/HTTP timeout: confirm the application consumed its effective assigned port and bound a reachable host interface.
- Log readiness timeout: verify the exact stable marker appears after successful startup.
- Dependency blocked: diagnose the upstream service first.
- Compose failure: use the exact configured Compose files and inspect `.lcl/<stack>/logs/compose.log`; do not run an unscoped `docker compose down`.

`lcl why` includes resolved environment diagnostics. Avoid reproducing credential values in reports.

## Handoff

State whether each of these was completed: schema validation, environment diagnostics, runtime start, service readiness, and cleanup. Include the stack name and effective URLs when it remains running. If Docker was unavailable, say explicitly that Compose lifecycle and health were not verified.
