# QA — lcl CLI

The `lcl` command line: `lcl init` produces a valid `lcl.yml`, `lcl validate` checks it, `lcl start` allocates
ports for the whole stack, starts dependencies in order, checks readiness and supervises processes and Compose
containers, and `status`/`urls`/`ports`/`logs`/`why`/`stop`/`clean` act on one named stack at a time.

- **Scope** — the packaged CLI (`bin/lcl.js` over compiled `dist/`), its templates and examples, named stacks,
  whole-stack port shifting, process ownership and safe deletion. Not the internals of a supervised service.
- **Runs on** — a build of this repo (`npm ci && npm run build`, then `node bin/lcl.js …`; or
  `npm install -g @cvhome-saas/lcl` for a published version). Docker Desktop/Engine for the Compose cases.
  Node.js 22+, macOS/Linux/WSL2.
- **Cases** — 12 (0 verified, 12 not verified)
- **Also see** — `../cvhome` `qa/` for the application stack that `lcl.yml` there describes; `test/*.test.ts`
  for the automated equivalents (`lifecycle`, `compose`, `safety`, `examples`).

Each case is tagged **[verified]** (run end to end and passed) or **[not verified]** (never run by anyone —
where the bugs are).

## 00 — Before you start

- `node --version` is 22 or newer; `docker info` answers (only for 03.x and the `compose` template).
- From the repo root: `npm ci && npm run build`. Below, `lcl` means `node <repo>/bin/lcl.js` unless installed.
- Every case uses a throwaway project directory and a throwaway registry: `export LCL_HOME=$(mktemp -d)` and
  `cd $(mktemp -d)`. Never run these against your real `~/.lcl` or a checkout you care about. Stop every stack
  you started (`lcl stop`, `lcl list` shows none) before deleting the directory.

## 01 — init and validate

### 01.1 init a template project [not verified]
- Setup: empty temp directory, `LCL_HOME` set.
- Steps: `lcl init --template node`; `cat lcl.yml`; `cat .gitignore`; `lcl validate`; repeat for `python`, `java`,
  `compose`, `empty`.
- Expect: `lcl.yml` written and immediately valid — `lcl validate` exits 0 and prints the resolved catalog (services,
  ports, dependency levels). `.gitignore` gained `.lcl/`. Every template validates without edits.

### 01.2 init refuses to overwrite [not verified]
- Setup: directory from 01.1 with an `lcl.yml`.
- Steps: `lcl init --template empty`; then `lcl init --template empty --force`.
- Expect: the first run fails with an error naming `lcl.yml` and `--force`; the file is unchanged. The second run
  overwrites it.

### 01.3 validate rejects unknown keys and bad combinations [not verified]
- Setup: a valid `lcl.yml` (01.1).
- Steps: add `colour: red` under a service, run `lcl validate`; revert, give one service both `command` and
  `shell`, run `lcl validate`; revert, reference `${port.nosuch.http}` in an `environment` value, run `lcl validate`.
- Expect: each run exits non-zero with a message naming the service and the offending key/variable; nothing is
  started and no `.lcl/` directory appears. `lcl validate --json` gives the same verdict as JSON.

### 01.4 validate another checkout with --root [not verified]
- Setup: a sibling `../cvhome` checkout with its `lcl.yml`.
- Steps: from this repo, `node bin/lcl.js validate --root ../cvhome`; also `lcl validate --root ../cvhome --json`.
- Expect: the cvhome catalog is resolved from that directory (service names, Compose services from its compose
  files, port map) with exit 0, without changing the current directory's state; the JSON form lists the same
  services. A `--root` that has no `lcl.yml` fails with an error naming the path.

## 02 — one stack: start, inspect, stop

### 02.1 start, status, urls, ports [not verified]
- Setup: `cp -r <repo>/examples/minimal/* .` (a Node server with an http health check), `LCL_HOME` set.
- Steps: `lcl start -d`; `lcl status`; `lcl status --json`; `lcl urls`; `lcl ports`; `lcl ports --env`; `lcl list`.
- Expect: `start -d` returns only when the service is `up` (health passed) and prints the port map. `status` shows
  every service, state, pid, port, uptime; the JSON form has the same fields. `urls` prints the `urls:` entries with
  the assigned ports substituted; `ports --env` prints `LCL_PORT_*` lines usable with `eval`. `lcl list` shows the
  `default` stack of this checkout.

### 02.2 logs, why, restart [not verified]
- Setup: stack from 02.1 running.
- Steps: `lcl logs -n 20`; `lcl logs <service> -f` (Ctrl-C); `lcl logs --errors`; `lcl why <service>`;
  `lcl restart <service>`; `lcl events --since 5m`.
- Expect: logs are the service's stdout/stderr with the service name; `-f` follows; `--errors` filters to error
  lines. `why` prints exit code, health, port owner, the exact command, the resolved environment and last error
  lines. `restart` stops and starts only that service; the pid changes, the port does not. `events` lists start,
  ready, restart as JSONL-backed audit lines in order.

### 02.3 stop and state [not verified]
- Setup: stack from 02.1 running; note the pid from `lcl status`.
- Steps: `lcl stop`; `ps -p <pid>`; `lcl status`; `ls .lcl/default`; `lcl list`.
- Expect: the process group is gone (no orphan child survives), `status` reports the stack stopped, `.lcl/default`
  keeps `state.json`, logs and `events.jsonl` for inspection, and `lcl list` no longer shows it as running.
  Running `lcl stop` again is a no-op with a clear message, not an error.

### 02.4 a dependency failing to become ready is visible [not verified]
- Setup: `examples/long-running-tools` copied; edit one service's `ready-log` regex so it never matches, set its
  health `timeout` to 10.
- Steps: `lcl start -d`; `lcl status`; `lcl why <that service>`.
- Expect: start reports the service as degraded/crashed after the timeout and its dependants do not start; exit
  code is non-zero; `why` names the readiness check that timed out. Nothing is reported as `up` that is not.

## 03 — named stacks and ports

### 03.1 two stacks with a port shift [not verified]
- Setup: `examples/polyglot` (or `examples/minimal`) copied; `ports.step` in `lcl.yml` noted (1000 by default).
- Steps: `lcl start -d`; `lcl ports`; `lcl start -d --stack feature-x`; `lcl ports --stack feature-x`;
  `lcl urls --stack feature-x`; `lcl list`; `lcl status --stack feature-x`.
- Expect: the second stack gets every source port and every selected Compose host port shifted by exactly one
  `ports.step` (same offset for all — relationships between services are preserved). Both stacks run side by side,
  `list` shows both with their offsets, and each `status`/`logs`/`stop` acts only on the `--stack` named. Stop
  `feature-x` first, then `default`; each stop leaves the other untouched.

### 03.2 a foreign listener is reported, never killed [not verified]
- Setup: `examples/minimal` copied; in another terminal occupy the configured port with an unrelated process
  (`python3 -m http.server <port>`).
- Steps: `lcl start -d`; `lcl start -d --ports configured` (after stopping); `lcl doctor`.
- Expect: the default policy shifts the whole stack to the next free sequence and says which port was occupied.
  `--ports configured` refuses to start with an error naming the port and its owner pid. The foreign process is
  still alive afterwards in every case. `doctor` lists the port as taken by a process lcl does not own.

### 03.3 Compose services start, wait for health, stop keeps volumes [not verified]
- Setup: `examples/compose` copied; Docker running.
- Steps: `lcl start -d`; `docker compose ls`; `lcl stop`; `docker volume ls`; `lcl stop --hard`; `docker volume ls`.
- Expect: the Compose project name includes the stack and a checkout hash (`docker compose ls` shows it, and only
  it, created by this run). Containers with a healthcheck are `healthy` before dependants start. `stop` removes
  containers but the project's volumes remain; `stop --hard` removes only that project's volumes.

## 04 — clean safety

### 04.1 clean removes only stopped stacks' state [not verified]
- Setup: two stacks as in 03.1: `default` stopped, `feature-x` running.
- Steps: `lcl clean`; `ls .lcl`; `lcl clean --all`; `ls .lcl`; then `lcl stop --stack feature-x`; `lcl clean --all`.
- Expect: the first `clean` removes `.lcl/default` and nothing else; `feature-x` keeps running and its directory
  stays even under `--all` while its supervisor is alive. After stopping it, `clean --all` removes `.lcl/feature-x`.
  The registry under `LCL_HOME/instances` loses the matching entries only.

### 04.2 clean refuses a directory that is not its own [not verified]
- Setup: no stack running; create `.lcl/impostor/` by hand with a `state.json` that lacks the registry-key
  sentinel (or with a key from another checkout), plus a marker file inside.
- Steps: `lcl clean --all`; `ls .lcl/impostor`.
- Expect: `impostor` is left in place (marker file still there) and the command says why it was skipped; only exact
  `.lcl/<stack>` directories whose `state.json` carries the expected registry key are removed.

## REG — regression watchlist

- `test/lifecycle.test.ts` "version source and package metadata stay aligned": `lcl --version` must equal
  `package.json` `version`. Broken every time only one of `package.json`/`src/version.ts` is bumped.
- `npm pack --dry-run` file list: the standard's `.claude/`, `.agents/`, `.githooks/`, `qa/`, `scripts/` and any
  `.lcl/` state must never appear (the `files` allowlist plus `.npmignore`).

## 99 — known gaps

- Native Windows is not a target; only macOS, Linux and WSL2.
- CI's macOS job runs with `CI_NO_DOCKER=1`, so Compose behaviour is only proven on Ubuntu (and here, 03.3).
- HTTP 401/403 from a health endpoint counts as reachable (secured) health; 5xx fails — by design, documented.
