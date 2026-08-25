import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(repository, 'bin/lcl.js');
const fixtureService = join(repository, 'test/fixtures/http-service.mjs');

function run(root: string, home: string, args: string[], environment: NodeJS.ProcessEnv = {}): string {
    return execFileSync(process.execPath, [cli, ...args, '--root', root], {
        env: { ...process.env, ...environment, LCL_HOME: home, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
    }).toString();
}

test('packaged CLI starts dependency closure, reports state, and stops cleanly', { timeout: 60_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'lcl-life-'));
    const home = join(root, 'home');
    writeFileSync(join(root, 'lcl.yml'), `
version: 1
name: lifecycle
ports: { step: 1000, skip-configured: true }
services:
  dependency:
    command: ["${process.execPath}", "${fixtureService}", dependency, "\${port.dependency.http}"]
    ports: { http: 45101 }
    health: { type: http, port: http, path: /health, expect: UP, timeout: 15 }
  api:
    command: ["${process.execPath}", "${fixtureService}", api, "\${port.api.http}"]
    depends-on: [dependency]
    ports: { http: 45102 }
    health: { type: http, port: http, path: /health, expect: UP, timeout: 15 }
urls:
  - { label: api, url: "http://localhost:\${port.api.http}" }
`);
    try {
        run(root, home, ['start', 'api', '-d']);
        const status = JSON.parse(run(root, home, ['status', '--json'])) as { live: boolean; state: { services: Record<string, { state: string }> } };
        assert.equal(status.live, true);
        assert.equal(status.state.services.dependency.state, 'up');
        assert.equal(status.state.services.api.state, 'up');
        const state = JSON.parse(readFileSync(join(root, '.lcl/default/state.json'), 'utf8')) as { ports: { offset: number } };
        assert.equal(state.ports.offset, 1000);
        run(root, home, ['stop']);
        const stopped = JSON.parse(run(root, home, ['status', '--json'])) as { live: boolean };
        assert.equal(stopped.live, false);
    } finally {
        spawnSync(process.execPath, [cli, 'stop', '--root', root], { env: { ...process.env, LCL_HOME: home }, timeout: 10_000 });
        rmSync(root, { recursive: true, force: true });
    }
});

test('injects project .env defaults with host and lcl.yml precedence', { timeout: 60_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'lcl-dotenv-'));
    const home = join(root, 'home');
    writeFileSync(join(root, '.env'), `
LCL_TEST_DOTENV_ONLY="from file"
LCL_TEST_HOST_WINS=from-file
LCL_TEST_GLOBAL_WINS=from-file
LCL_TEST_SERVICE_WINS=from-file
LCL_STACK=from-file
`);
    writeFileSync(join(root, 'lcl.yml'), `
version: 1
name: dotenv
ports: { step: 1000, skip-configured: true }
environment:
  LCL_TEST_GLOBAL_WINS: from-global
  LCL_TEST_SERVICE_WINS: from-global
services:
  api:
    command: ["${process.execPath}", "${fixtureService}", api, "\${port.api.http}", LCL_TEST_DOTENV_ONLY, LCL_TEST_HOST_WINS, LCL_TEST_GLOBAL_WINS, LCL_TEST_SERVICE_WINS, LCL_STACK]
    ports: { http: 45201 }
    environment:
      LCL_TEST_SERVICE_WINS: from-service
    health: { type: http, port: http, path: /health, expect: UP, timeout: 15 }
`);
    try {
        run(root, home, ['start', 'api', '-d'], { LCL_TEST_HOST_WINS: 'from-host' });
        const log = readFileSync(join(root, '.lcl/default/logs/api.log'), 'utf8');
        assert.match(log, /^LCL_TEST_DOTENV_ONLY=from file$/m);
        assert.match(log, /^LCL_TEST_HOST_WINS=from-host$/m);
        assert.match(log, /^LCL_TEST_GLOBAL_WINS=from-global$/m);
        assert.match(log, /^LCL_TEST_SERVICE_WINS=from-service$/m);
        assert.match(log, /^LCL_STACK=default$/m);
        run(root, home, ['stop']);
    } finally {
        spawnSync(process.execPath, [cli, 'stop', '--root', root], { env: { ...process.env, LCL_HOME: home }, timeout: 10_000 });
        rmSync(root, { recursive: true, force: true });
    }
});

test('version source and package metadata stay aligned', () => {
    const packageJson = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { version: string };
    assert.equal(run(repository, join(tmpdir(), 'lcl-version-home'), ['--version']).trim(), packageJson.version);
});
