# lcl — local stack runner

`./extra/scripts/lcl` starts, supervises and inspects a local stack described by an **`lcl.yml`** at the project
root. The engine (this directory) is project-agnostic: it knows how to run gradle tasks, npm/exec commands and
docker compose services, allocate ports, render files, probe health, keep logs and an audit trail. What to run is
entirely in `lcl.yml` — cvhome's is at the repository root, its Spring override template in `extra/lcl-config/`.

```bash
./extra/scripts/lcl start -d              # the default stack, in the background, returns when healthy
./extra/scripts/lcl start -d --stack xxx  # a second stack next to it (its ports shift to the next free sequence)
./extra/scripts/lcl status                # state, port, pid, uptime, error count, health per service
./extra/scripts/lcl urls                  # the URLs from lcl.yml, with THIS stack's ports
./extra/scripts/lcl restart catalog       # one service; the rest keep running
./extra/scripts/lcl why catalog           # exit code, health, port owner, command, env, last errors
./extra/scripts/lcl logs catalog -f       # or: --errors, --grep RE, --since 10m
./extra/scripts/lcl events -f             # the audit trail (build/lcl/<stack>/events.jsonl)
./extra/scripts/lcl list                  # every running stack
./extra/scripts/lcl stop [--stack xxx]    # that stack only; --hard also drops the compose volumes
```

`lcl --help` lists every command and flag. `--config <file>` points at another project's `lcl.yml`.

## lcl.yml

```yaml
name: myproject                       # compose projects are lcl-<name>-<stack>
ports:
  step: 1000                          # shift size when a configured port is taken
  skip-configured: false              # true: never use the configured ports (same as --no-default-ports)
build: [make, build]                  # run by `lcl start --build`
compose:
  file: docker-compose.yml
  default: [postgres]                 # started by `lcl start`; `--infra all` / `--infra a,b` override
  env: { NAMESPACE: example.com }     # extra compose env (LCL_PORT_<SERVICE> is always provided)
env: { SOME_VAR: "${stack}" }         # for every process
files:                                # rendered per stack before anything starts
  - { path: "${stack.dir}/app.yml", template: lcl-config/app.yml.tpl }
defaults:                             # per runner type, overridden by each service
  gradle: { task: bootRun, args: [...], health: { path: /actuator/health, expect: '"status":"UP"' } }
services:
  api:      { type: gradle, module: ":api", port: 8080 }
  worker:   { type: gradle, module: ":worker", after: [api] }
  web:      { type: npm, dir: web, command: [npm, run, dev], env: { PORT: "${port}" }, after: [api] }
  db-admin: { type: exec, command: [./bin/admin, --port, "${port}"], port: 7000 }
  edge:     { type: container, compose: nginx, port: 80 }        # a configured service served by a container
hooks:
  after-up:
    - { service: api, when: "${offset} != 0", shell: "curl -X POST http://localhost:${port.api}/reconfigure" }
urls:
  - { label: app, url: "http://localhost:${port.web}" }
```

Service fields: `type` (`gradle` | `npm` | `exec` | `container`), `port`, `after`
(start order; independent services start together with `--parallel N`), `env`, `health`
(`path`, `expect`, `ready-log` regex, `timeout` seconds); gradle: `module`, `task`, `args`; npm/exec: `dir`,
`command`, `install` (where `node_modules` lives; `npm install` runs when missing), `prep` (commands before start);
container: `compose` service name, `container-port`.

Variables in any string: `${stack}` `${stack.dir}` `${root}` `${project}` `${offset}` `${service}` `${port}`
`${port.<service>}` `${port.<compose service>:<container port>}` `${env.NAME}`. Templates additionally support
`{{#each services}} … {{name}} {{port}} {{#unless last}},{{/unless}} … {{/each}}`.

## Stacks and ports

`--stack <name>` (default `default`) selects the stack every command acts on. Each stack has its own supervisor,
processes, compose project, state, logs and events under `build/lcl/<stack>/`.

Configured ports are the default. If any is taken — another stack, a stray process — the **whole stack shifts by
`ports.step`·k** to the first free sequence, and every `${port.…}` follows: generated files, env, hooks, urls,
compose (a generated `compose.override.yml` with `ports: !override` for every published port, so the compose file
needs no placeholders). `--ports configured` refuses to shift, `--ports offset=2` forces +2·step, and
`--ports shift` / `--no-default-ports` never uses the configured ports at all (first free sequence at +step) —
handy when the default stack should keep the well-known ports and every other stack must stay off them;
`ports.skip-configured: true` in `lcl.yml` makes that the project default.

## Health, crashes, audit

- `health.path` + `expect` → HTTP probe on the service port (401/403 count as reachable); otherwise "HTTP answers";
  `ready-log` accepts a log line as proof of readiness. Probed every 5 s; every transition is an event.
- A crashed service is marked `crashed` and the rest keep running (`why` explains it). `--fail-fast` brings the
  stack down instead; `--restart on-failure[:N]` restarts it with backoff.
- `build/lcl/<stack>/events.jsonl`: `instance.*`, `infra.*`, `service.starting|up|degraded|crashed|stopped|
  restarted|swept`, `hook.done|failed|skipped`, `command.*`. Logs: `build/lcl/<stack>/logs/<service>.log`
  (+ `-prep`, `-install`, `-hook`, `compose`, `build`, `supervisor`).

## cvhome specifics (all in `lcl.yml`, none in the engine)

- every service lists its port explicitly (kept equal to what the Spring services bind via `common-config.yml`);
- `extra/lcl-config/spring-instance.yml.tpl` → `build/lcl/<stack>/spring-instance.yml`, passed to every Spring
  service as `--spring.config.additional-location` (service ports, discovery URIs, datasource, MinIO, pod endpoint);
- gradle `--project-cache-dir` per stack and `NEXT_DIST_DIR` per stack (read by `storefront/next.config.ts`) so two
  stacks can run the same module from one checkout. Next rewrites `storefront/tsconfig.json` to include
  `<distDir>/types` when a non-default stack runs — a noise diff, safe to `git checkout` afterwards;
- the spg container gets `LCL_PORT_<SERVICE>` for the Caddyfile upstreams (`{$LCL_PORT_CATALOG:8122}`);
- an `after-up` hook rewrites uaa's seeded `web-app` redirect URIs on a shifted stack.

## Layout

```
extra/lcl/src
  main.ts          command line and dispatch
  config.ts        lcl.yml schema, loader, ${…} interpolation, {{#each}} templates, `when:` evaluation
  catalog.ts       lcl.yml → services in dependency levels, container services, compose ports (read from the compose file)
  instance.ts      stack name, build/lcl/<stack>/ paths, state.json, global registry (~/.cvhome/lcl)
  ports.ts         free-port probing (wildcard bind + lsof) and the offset policy
  render.ts        variables, generated files, compose.env, compose.override.yml, urls
  supervisor.ts    the per-stack daemon: levels, health loop, crash policy, hooks, control socket
  proc.ts compose.ts control.ts health.ts logs.ts events.ts ui.ts yaml.ts
  commands/        start, stop/restart, status/urls/ports/list, logs/events/why/clean, doctor
```

No dependencies: Node ≥ 23.6 runs the TypeScript directly.
