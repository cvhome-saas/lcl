import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadCatalog } from '../src/catalog.js';
import { shiftedPorts } from '../src/ports.js';

test('shifts every named service port by the same offset', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lcl-ports-'));
    const file = join(directory, 'lcl.yml');
    writeFileSync(file, 'version: 1\nname: ports\nservices:\n  api: { command: [api], ports: { http: 8080, grpc: 9090 } }\n');
    try {
        const ports = shiftedPorts(loadCatalog(file), 1000);
        assert.deepEqual(ports.services, { 'api.http': 9080, 'api.grpc': 10090 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('rejects shifts beyond the TCP port range', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lcl-ports-'));
    const file = join(directory, 'lcl.yml');
    writeFileSync(file, 'version: 1\nname: ports\nservices:\n  api: { command: [api], ports: { http: 65000 } }\n');
    try { assert.throws(() => shiftedPorts(loadCatalog(file), 1000), /exceeds 65535/); }
    finally { rmSync(directory, { recursive: true, force: true }); }
});
