#!/usr/bin/env node

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
    console.error(`lcl needs Node.js 22 or newer (found ${process.versions.node})`);
    process.exit(1);
}

await import('../dist/src/main.js');
