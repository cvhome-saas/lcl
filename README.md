# lcl

`lcl` runs a complex local stack from one `lcl.yml`. It allocates a stable set of ports, starts dependencies in
readiness order, supervises foreground processes, manages optional Docker Compose infrastructure, and keeps logs and
state for several named stacks at once.

The runner is language-neutral. If a service can be launched as a foreground command, `lcl` can supervise it.

## Install

Node.js 22 or newer is required. macOS, Linux, and WSL2 are supported.

```bash
npm install -g @cvhome/lcl
lcl --version
```

Create a starter configuration:

```bash
lcl init --template empty
# also available: node, python, java, compose
lcl validate
```

`lcl init` adds `.lcl/` to `.gitignore`. The only project configuration owned by the CLI is `lcl.yml`; runtime
state stays under `.lcl/<stack>/`.

## A small stack

```yaml
version: 1
name: shop

ports:
  step: 1000

compose:
  files: [compose.yml]
  default: [postgres]

services:
  catalog:
    cwd: services/catalog
    command: [python, -m, uvicorn, app:app, --port, "${port.catalog.http}"]
    depends-on: [postgres]
    ports:
      http: 8080
    health:
      type: http
      port: http
      path: /health

  storefront:
    cwd: apps/storefront
    prepare:
      - [npm, run, build:libs]
    command: [npm, run, dev, "--", --port, "${port.storefront.http}"]
    depends-on: [catalog]
    ports:
      http: 3000
    environment:
      CATALOG_URL: "http://localhost:${port.catalog.http}"
    health:
      type: http
      port: http
      path: /

urls:
  - { label: storefront, url: "http://localhost:${port.storefront.http}" }
```

```bash
lcl start -d                         # start everything and return when ready
lcl start storefront -d              # also starts catalog and postgres
lcl status
lcl urls
lcl logs catalog -f
lcl why catalog
lcl restart catalog
lcl stop
```

## Generic service contract

Each entry in `services` is a foreground process:

| Key | Meaning |
|---|---|
| `command` | Argument array executed without a shell. Preferred because quoting is unambiguous. |
| `shell` | Explicit POSIX shell command for pipelines or shell expansion. Mutually exclusive with `command`. |
| `cwd` | Working directory relative to `lcl.yml`. Defaults to the configuration directory. |
| `prepare` | Commands run to completion before each service start. Entries may be argv arrays or command objects. |
| `depends-on` | Source or Compose services that must be ready first. Transitive dependencies start automatically. |
| `ports` | Any number of named TCP ports. All are shifted together when the configured sequence is occupied. |
| `environment` | Environment values, with variable interpolation. |
| `health` | `http`, `tcp`, `log`, or `process`; defaults to TCP for a service with ports and process-alive otherwise. |

Examples for common ecosystems use the same fields:

```yaml
services:
  spring:
    command: [./gradlew, :api:bootRun, "--args=--server.port=${port.spring.http}"]
    ports: { http: 8080 }

  maven:
    command: [./mvnw, -pl, billing, spring-boot:run, "-Dspring-boot.run.arguments=--server.port=${port.maven.http}"]
    ports: { http: 8081 }

  go:
    command: [go, run, ./cmd/api]
    environment: { PORT: "${port.go.http}" }
    ports: { http: 8082 }

  rust:
    command: [cargo, run, --bin, worker]
    environment: { PORT: "${port.rust.http}" }
    ports: { http: 8083 }

  worker:
    command: [python, worker.py]
    health: { type: log, ready-log: "worker ready", timeout: 30 }
```

The complete configuration contract is [`schema/lcl.schema.json`](schema/lcl.schema.json). Unknown keys and invalid
combinations fail during `lcl validate`, before any process or container is started.

## Named stacks and ports

The configured ports are used when available. If one is occupied, the whole stack moves by `ports.step` until every
declared source port and selected Compose port is free.

```bash
lcl start -d
lcl start -d --stack feature-x
lcl ports --stack feature-x
lcl urls --stack feature-x
lcl stop --stack feature-x
```

Useful policies:

- `--ports configured`: require the configured ports and fail on a collision.
- `--ports shift`: always start at the first shifted sequence.
- `--ports offset=2`: force `2 × ports.step`.
- `ports.skip-configured: true`: make shifted ports the project default.

Variables available in commands, environment, hooks, generated files, and URLs include:

- `${stack}`, `${stack.dir}`, `${root}`, `${project}`, `${offset}`, `${service}`, `${port}`
- `${port.<service>.<name>}` for source services
- `${port.<compose-service>.<container-port>}` for Compose services
- `${env.NAME}` for an environment value supplied to the `lcl` process

Every assigned port is also exported as an uppercase `LCL_PORT_*` environment variable. `lcl ports --env` prints the
exact variables and resolved URLs for shell use.

## Docker Compose

Compose is optional. When configured, `lcl` asks `docker compose config` for the canonical service and port model,
creates a per-stack port override, and uses an isolated project name. Containers with health checks wait for
`healthy`; other containers wait for their published ports.

```yaml
compose:
  files: [compose.yml, compose.local.yml]
  default: [postgres, redis]
  environment:
    POSTGRES_TAG: 17-alpine
```

Use `--infra all`, `--infra postgres,redis`, or `--no-infra` to override the default. `lcl stop --hard` also removes
volumes belonging to that exact Compose project.

## Commands

```text
lcl start [service...] [-d] [--build] [--parallel N] [--fail-fast]
lcl stop [service...] [--hard]
lcl restart [service...]
lcl status [--json]
lcl urls
lcl ports [--json|--env]
lcl logs [service...] [-f] [-n N] [--since 10m] [--grep REGEX] [--errors]
lcl events [-f] [--since 1h] [--service NAME] [--json]
lcl why SERVICE
lcl doctor
lcl validate [--json]
lcl list
lcl clean [--all]
```

`lcl` only signals process groups it launched and can identify. A stale recorded port owned by another process is
reported, never killed. Foreground programs should not daemonize themselves.

## Development

```bash
npm install
npm run check
npm test
npm pack --dry-run
```

CI tests Node.js 22 and 24 on Ubuntu and macOS. Docker-backed Compose tests run on Ubuntu. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the release workflow.

## License

Apache License 2.0.
