# Changelog

## Unreleased

- Load an optional `.env` beside `lcl.yml` as default environment for supervised source processes and lifecycle
  commands, while preserving host and explicit configuration precedence.

## 0.1.0

- Extract the runner from cvhome as a standalone public package.
- Introduce configuration schema v1 with generic commands, named ports, automatic dependency closure, and optional
  Docker Compose infrastructure.
- Add multiple named stacks, supervision, health checks, logs, events, diagnostics, safe cleanup, `init`, and
  `validate`.
