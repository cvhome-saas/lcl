# LCL configuration model

Read this reference before creating or changing `lcl.yml`. The schema is strict: use only fields described here or confirmed by the installed package's `schema/lcl.schema.json`.

## Minimal shape

```yaml
version: 1
name: project-name

ports:
  step: 1000
  skip-configured: false

services:
  api:
    cwd: services/api
    command: [python, -m, uvicorn, app:app, --port, "${port.api.http}"]
    ports: { http: 8080 }
    health: { type: http, port: http, path: /health, timeout: 60 }

urls:
  - { label: api, url: "http://localhost:${port.api.http}" }
```

Required top-level fields are `version`, `name`, and `services`. Optional fields are `ports`, `build`, `hosts`, `environment`, `defaults`, `compose`, `files`, `hooks`, and `urls`. External YAML uses the established kebab-case spellings.

## Service contract

Each service has exactly one of:

- `command`: a non-empty argv array, preferred for predictable quoting;
- `shell`: a POSIX shell string, reserved for pipes, redirects, globbing, or shell expansion.

Optional service fields:

- `cwd`: directory relative to `lcl.yml`.
- `description`: contributor-facing purpose.
- `prepare`: commands run to completion before each service start. Each entry is an argv array or `{command|shell, cwd}` object. A failed prepare prevents that service from starting.
- `depends-on`: source or Compose service names that must be ready first.
- `ports`: unique named TCP base ports. Names match `^[A-Za-z0-9][A-Za-z0-9_-]*$`.
- `environment`: string, number, or boolean values converted to strings after interpolation.
- `health`: readiness and ongoing health configuration.

`defaults` can provide `environment`, `prepare`, and `health`; service values override or replace them according to the field. Avoid a default `prepare` unless every service genuinely needs it.

The process must remain in the foreground. Do not use daemon/background flags, because the supervisor owns the process group and its descendants.

## Project `.env` defaults

When `.env` exists beside `lcl.yml`, LCL parses it with Node's dotenv rules and injects its values into source services, `prepare`, the optional build command, and hooks. Use this for programs that do not load dotenv files themselves. It does not require or accept an `lcl.yml` field.

Treat `.env` as defaults. Existing host values win over it, while generated `LCL_*` values and explicit global or service `environment` values win over both. `${env.NAME}` still reads only the host environment passed to LCL. LCL does not expand references inside `.env`, and it does not add these values to the Compose environment. A running supervisor retains the values loaded at stack start; use a full stop and start to reload changes.

`lcl why` can show resolved environment diagnostics, including `.env` values. Avoid reporting secrets and do not assume `.env` contents are hidden from explicit diagnostics.

## Ports and interpolation

On a new stack start, LCL chooses one offset before starting anything and calculates every effective port as `base + offset`. All source ports are considered together; selected Compose published ports also participate. The final map is fixed for that running stack.

Use these variables rather than effective numbers:

- `${port.api.http}`: named source port.
- `${port.postgres.5432}`: published port for Compose service `postgres`, container port `5432`.
- `${port}`: current service's primary port (`http` when present, otherwise its first declared port).
- `${stack}`, `${stack.dir}`, `${root}`, `${project}`, `${offset}`, `${service}`.
- `${env.NAME}`: value inherited from LCL's host environment; an unset value resolves to an empty string.

Every source process receives the entire assigned map as uppercase variables such as `LCL_PORT_API_HTTP` and `LCL_PORT_WORKER_GRPC`. A primary-port alias such as `LCL_PORT_API` is also provided. Compose ports use names such as `LCL_PORT_POSTGRES_5432`. Prefer explicit project-facing environment keys in `lcl.yml` so application configuration remains clear.

Port modes are selected at start:

- default/`--ports auto`: configured offset `0`, then a reusable previous offset, then free `step` multiples;
- `--ports configured`: require offset `0`;
- `--ports shift`: skip offset `0`;
- `--ports offset=k`: require `k × ports.step`.

Never assign ports independently or interpolate raw base ports into runtime values.

## Dependencies and health

Dependencies are transitive and must be acyclic. Source services start in topological levels and only after source dependencies are `up`. Selecting one service also selects its dependency closure.

Health forms:

```yaml
health: { type: http, port: http, path: /health, expect: UP, timeout: 180 }
health: { type: tcp, port: grpc, timeout: 60 }
health: { type: log, ready-log: "server ready", timeout: 120 }
health: { type: process, timeout: 10 }
```

Without an explicit type, a service with ports uses TCP on its primary port; a portless service uses process-alive. HTTP probes use `127.0.0.1`; statuses below 500 count as reachable, including secured 401/403 responses. `expect` additionally requires the response body to contain the given text.

Do not make a readiness check depend on a peer that cannot start until this service is ready.

## Compose infrastructure

```yaml
compose:
  files: [compose.yml, compose.local.yml]
  default: [postgres, redis]
  environment:
    POSTGRES_TAG: 17-alpine
```

LCL delegates parsing to `docker compose config --format json`. Compose service names must not duplicate source service names. Published host ports must be numeric and unique relative to every source base port. LCL generates an override that shifts host ports while preserving container ports and uses an isolated Compose project per named stack and checkout.

Source processes reach Compose services through the published host address, for example `postgresql://127.0.0.1:${port.postgres.5432}/app`. Compose-to-Compose traffic should continue using Compose DNS and container ports. A container cannot generally reach a host source service through its own `localhost`; handle that explicitly and portably when the project requires that direction.

Compose containers with healthchecks must become healthy. Those without healthchecks wait for every published port. Put infrastructure required by a source service in its `depends-on`; LCL includes it even if it is outside `compose.default`.

## Build, generated files, and hooks

- Top-level `build` is an argv command run only with `lcl start --build`.
- `files` renders a template into a path before startup. Both path and content can use LCL variables. Templates may iterate primary source ports with `{{#each services}}...{{name}}...{{port}}...{{#unless last}}...{{/unless}}...{{/each}}`.
- `hooks.before-start` runs after selected Compose infrastructure is ready and before source services.
- `hooks.after-up` entries require `service` and run after that source service becomes ready.
- `hooks.after-stop` runs during stack shutdown.
- Hook entries accept `command` or `shell`, plus optional `cwd` and `when`; `when` supports interpolated `a == b` or `a != b` comparisons.

A non-zero hook exit is recorded but does not abort the lifecycle. Put mandatory migrations or generation in a service's `prepare` or in the top-level `build` command instead of relying on a hook to fail the stack.
