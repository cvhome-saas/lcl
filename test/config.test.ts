import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dependencyClosure, loadCatalog } from '../src/catalog.js';
import { interpolate, loadConfig } from '../src/config.js';
import { CliError } from '../src/ui.js';

function fixture(yaml: string): { directory: string; file: string } {
    const directory = mkdtempSync(join(tmpdir(), 'lcl-config-'));
    const file = join(directory, 'lcl.yml');
    writeFileSync(file, yaml);
    return { directory, file };
}

test('loads generic command services, named ports, and defaults', () => {
    const item = fixture(`
version: 1
name: demo
defaults:
  environment: { LOG_LEVEL: info }
services:
  db:
    command: [node, db.js]
    ports: { tcp: 5432 }
  api:
    command: [node, api.js, "\${port.api.http}"]
    depends-on: [db]
    ports: { http: 8080, grpc: 9090 }
    health: { type: http, port: http, path: /health }
`);
    try {
        const config = loadConfig(item.file);
        assert.deepEqual(config.services.api.dependsOn, ['db']);
        assert.deepEqual(config.services.api.ports, { http: 8080, grpc: 9090 });
        assert.equal(config.services.api.environment.LOG_LEVEL, 'info');
        const catalog = loadCatalog(item.file);
        assert.deepEqual(catalog.levels, [['db'], ['api']]);
        assert.deepEqual(dependencyClosure(catalog, ['api']).source, ['db', 'api']);
    } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('rejects legacy configuration before runtime', () => {
    const item = fixture('name: old\nservices:\n  api: { type: exec, command: [node, app.js] }\n');
    try {
        assert.throws(() => loadConfig(item.file), (error: unknown) => error instanceof CliError && /legacy configuration/.test(error.message));
    } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('rejects duplicate ports and dependency cycles', () => {
    const duplicate = fixture('version: 1\nname: x\nservices:\n  a: { command: [a], ports: { http: 8000 } }\n  b: { command: [b], ports: { http: 8000 } }\n');
    const cycle = fixture('version: 1\nname: x\nservices:\n  a: { command: [a], depends-on: [b] }\n  b: { command: [b], depends-on: [a] }\n');
    try {
        assert.throws(() => loadConfig(duplicate.file), /duplicates configured port/);
        assert.throws(() => loadCatalog(cycle.file), /circular depends-on/);
    } finally {
        rmSync(duplicate.directory, { recursive: true, force: true });
        rmSync(cycle.directory, { recursive: true, force: true });
    }
});

test('rejects ambiguous source and Compose services and host-port collisions', () => {
    const sameName = fixture('version: 1\nname: x\ncompose: { files: [compose.yml] }\nservices:\n  db: { command: [db] }\n');
    const samePort = fixture('version: 1\nname: x\ncompose: { files: [compose.yml] }\nservices:\n  api: { command: [api], ports: { http: 5432 } }\n');
    writeFileSync(join(sameName.directory, 'compose.yml'), 'services:\n  db:\n    image: postgres:17-alpine\n');
    writeFileSync(join(samePort.directory, 'compose.yml'), 'services:\n  db:\n    image: postgres:17-alpine\n    ports: ["5432:5432"]\n');
    try {
        assert.throws(() => loadCatalog(sameName.file), /both a source service and a Compose service/);
        assert.throws(() => loadCatalog(samePort.file), /duplicates configured host port/);
    } finally {
        rmSync(sameName.directory, { recursive: true, force: true });
        rmSync(samePort.directory, { recursive: true, force: true });
    }
});

test('interpolation is strict while environment lookup is explicit', () => {
    assert.equal(interpolate('http://localhost:${port.api.http}', { 'port.api.http': '8181' }), 'http://localhost:8181');
    assert.throws(() => interpolate('${missing}', {}), /unknown variable/);
});
