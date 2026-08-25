import assert from 'node:assert/strict';
import test from 'node:test';
import { composeProjectName } from '../src/instance.js';
import { ownsRecordedProcess, processFingerprint } from '../src/proc.js';

test('Compose project identity is checkout-scoped and Docker-safe', () => {
    const first = composeProjectName('My.Project', 'Feature/A', '/tmp/checkout-a');
    const second = composeProjectName('My.Project', 'Feature/A', '/tmp/checkout-b');
    assert.match(first, /^[a-z0-9][a-z0-9_-]*$/);
    assert.notEqual(first, second);
});

test('recorded process ownership rejects a stale fingerprint', () => {
    const fingerprint = processFingerprint(process.pid);
    assert.ok(fingerprint);
    assert.equal(ownsRecordedProcess(process.pid, fingerprint), true);
    assert.equal(ownsRecordedProcess(process.pid, `${fingerprint}-stale`), false);
    assert.equal(ownsRecordedProcess(process.pid), false);
});
