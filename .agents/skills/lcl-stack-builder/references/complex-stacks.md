# Complex and polyglot stacks

Use this reference when a stack combines languages, tools, multiple ports, workers, or Compose infrastructure. Adapt commands to the repository's actual manifests and wrappers; the examples are patterns, not defaults.

## Language-neutral command patterns

The essential contract is a foreground command plus an explicit way to consume the assigned port.

| Runtime/tool | Typical pattern |
|---|---|
| Node/Vite/etc. | `command: [npm, run, dev, --, --port, "${port.web.http}"]` |
| Python/Uvicorn | `command: [python, -m, uvicorn, app:app, --port, "${port.api.http}"]` |
| Gradle/Spring | `command: [./gradlew, bootRun, "--args=--server.port=${port.api.http}"]` |
| Maven/Spring | `command: [./mvnw, spring-boot:run, "-Dspring-boot.run.arguments=--server.port=${port.api.http}"]` |
| Go or Rust | Pass an application-supported `PORT`/address environment value or CLI flag. |
| Worker/watcher | Declare no port and use log or process health. |

Prefer repository wrappers such as `./gradlew`, `./mvnw`, package scripts, virtual-environment runners, or task runners already documented by the project. Do not invent dependency-install steps in `prepare` unless that is the project's established workflow.

## Cross-service communication

Every service receives the complete final port map before any service starts. Mutual address knowledge is therefore safe and does not imply a dependency cycle:

```yaml
services:
  gateway:
    command: [./bin/gateway]
    ports: { http: 8080 }
    environment:
      LISTEN_PORT: "${port.gateway.http}"
      SEARCH_URL: "http://127.0.0.1:${port.search.http}"

  search:
    command: [./bin/search]
    ports: { http: 8081 }
    environment:
      LISTEN_PORT: "${port.search.http}"
      GATEWAY_URL: "http://127.0.0.1:${port.gateway.http}"
```

If `gateway` merely calls `search`, add `depends-on: [search]` only when gateway startup genuinely requires search to be ready. If both must boot before connecting, leave them at the same level, make both retry, and start with enough parallelism. A health check should prove local readiness rather than requiring an unstarted peer.

## Adaptable polyglot example

The following demonstrates host processes, multiple named ports, infrastructure dependencies, cross-service addresses, mandatory preparation, and a portless worker:

```yaml
version: 1
name: polyglot-shop

ports: { step: 1000 }

compose:
  files: [compose.yml]
  default: [postgres, redis]

services:
  notifications:
    cwd: services/notifications
    command: [go, run, ./cmd/server]
    depends-on: [postgres]
    ports: { grpc: 9091 }
    environment:
      GRPC_PORT: "${port.notifications.grpc}"
      API_URL: "http://127.0.0.1:${port.api.http}"
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:${port.postgres.5432}/shop"
    health: { type: tcp, port: grpc, timeout: 90 }

  api:
    cwd: services/api
    prepare:
      - [python, -m, alembic, upgrade, head]
    command: [python, -m, uvicorn, app:app, --port, "${port.api.http}"]
    depends-on: [postgres, redis, notifications]
    ports: { http: 8080, metrics: 9090 }
    environment:
      PORT: "${port.api.http}"
      METRICS_PORT: "${port.api.metrics}"
      NOTIFICATIONS_ADDR: "127.0.0.1:${port.notifications.grpc}"
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:${port.postgres.5432}/shop"
      REDIS_URL: "redis://127.0.0.1:${port.redis.6379}"
    health: { type: http, port: http, path: /health, expect: UP, timeout: 120 }

  web:
    cwd: apps/web
    command: [npm, run, dev, --, --host, 127.0.0.1, --port, "${port.web.http}"]
    depends-on: [api]
    ports: { http: 3000 }
    environment:
      API_URL: "http://127.0.0.1:${port.api.http}"
    health: { type: http, port: http, path: /, timeout: 60 }

  events-worker:
    cwd: services/events-worker
    command: [cargo, run, --bin, events-worker]
    depends-on: [postgres, redis]
    environment:
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:${port.postgres.5432}/shop"
      REDIS_URL: "redis://127.0.0.1:${port.redis.6379}"
    health: { type: log, ready-log: "worker ready", timeout: 180 }

urls:
  - { label: web, url: "http://localhost:${port.web.http}" }
  - { label: api, url: "http://localhost:${port.api.http}" }
```

An accompanying Compose file must publish the base host ports so LCL can discover and shift them:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: shop
    ports: ["5432:5432"]
    healthcheck:
      test: [CMD-SHELL, pg_isready -U postgres]
      interval: 2s
      timeout: 2s
      retries: 30

  redis:
    image: redis:8-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: [CMD, redis-cli, ping]
      interval: 2s
      timeout: 2s
      retries: 30
```

The example's `notifications` process knows the future API port but must not require API connectivity to pass its own readiness, because API waits for notifications. Replace placeholder commands, endpoints, credentials, and readiness text with verified project behavior.

## Review checklist

- Every service command is foreground and works from its declared `cwd`.
- Every application consumes all ports it declares.
- Base source and Compose published host ports are unique and below 65536 after expected shifts.
- Cross-service host URLs use interpolated named ports.
- Dependency edges describe readiness ordering and contain no cycle.
- Slow services have realistic health timeouts; log patterns are stable and specific.
- One-shot commands are not modeled as permanently supervised services.
- Compose healthchecks test real dependency readiness.
- Local credentials in examples are clearly non-production; secrets are not exposed through diagnostics.
- `.lcl/` is ignored and generated runtime state is not committed.
