import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadCatalog } from '../src/catalog.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

for (const name of readdirSync(join(repository, 'examples'))) {
    test(`example ${name} has a valid catalog`, { skip: name === 'compose' && process.env.CI_NO_DOCKER === '1' }, () => {
        const catalog = loadCatalog(join(repository, 'examples', name, 'lcl.yml'));
        assert.equal(catalog.config.version, 1);
    });
}
