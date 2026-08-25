import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { dockerAvailable } from '../src/compose.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(repository, 'bin/lcl.js');

test('Compose infrastructure is isolated and becomes healthy', { skip: !dockerAvailable().ok, timeout: 180_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'lcl-compose-'));
    const home = join(root, 'home');
    cpSync(join(repository, 'templates/compose.yml'), join(root, 'lcl.yml'));
    cpSync(join(repository, 'templates/compose.compose.yml'), join(root, 'compose.yml'));
    const env = { ...process.env, LCL_HOME: home, NO_COLOR: '1' };
    try {
        execFileSync(process.execPath, [cli, 'start', '-d', '--root', root], { env, timeout: 150_000 });
        const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--json', '--root', root], { env }).toString()) as { infra: string[] };
        assert.deepEqual(status.infra, ['postgres']);
        execFileSync(process.execPath, [cli, 'stop', '--hard', '--root', root], { env, timeout: 60_000 });
    } finally {
        spawnSync(process.execPath, [cli, 'stop', '--hard', '--root', root], { env, timeout: 30_000 });
        rmSync(root, { recursive: true, force: true });
    }
});
