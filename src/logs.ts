// Log files and log awareness: the supervisor follows every service log, counts errors and keeps the last error
// lines so `status` and `why` can explain a failure without anyone opening the file.

import { closeSync, existsSync, openSync, readSync, statSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

export const ERROR_RE = /\bERROR\b|Exception\b|Caused by:|\bFATAL\b|✖|Error:/;
export const STARTED_RE = /Started \S+ in [\d.]+ seconds|✓ Ready in|Local:\s+http|Application bundle generation complete/;
const RING = 100;

export class LogWatcher {
    private offset = 0;
    private partial = '';
    errors = 0;
    started = false;
    readonly lastErrors: string[] = [];
    readonly lastLines: string[] = [];

    readonly file: string;
    constructor(file: string) { this.file = file; }

    /** Reads newly appended bytes. Cheap enough to call every second per service. */
    poll(): void {
        if (!existsSync(this.file)) return;
        const size = statSync(this.file).size;
        if (size < this.offset) { this.offset = 0; this.partial = ''; }
        if (size === this.offset) return;
        const fd = openSync(this.file, 'r');
        try {
            const buf = Buffer.alloc(size - this.offset);
            readSync(fd, buf, 0, buf.length, this.offset);
            this.offset = size;
            const text = this.partial + buf.toString('utf8');
            const lines = text.split('\n');
            this.partial = lines.pop() ?? '';
            for (const line of lines) this.consume(line);
        } finally { closeSync(fd); }
    }

    private consume(line: string): void {
        push(this.lastLines, line, 30);
        if (ERROR_RE.test(line)) { this.errors++; push(this.lastErrors, line, RING); }
        if (!this.started && STARTED_RE.test(line)) this.started = true;
    }

    reset(): void {
        this.offset = 0; this.partial = ''; this.errors = 0; this.started = false;
        this.lastErrors.length = 0; this.lastLines.length = 0;
    }
}

function push(arr: string[], line: string, max: number): void {
    arr.push(line);
    if (arr.length > max) arr.splice(0, arr.length - max);
}

export function tailFile(file: string, lines: number): string[] {
    if (!existsSync(file)) return [];
    const all = readFileSync(file, 'utf8').split('\n');
    if (all.at(-1) === '') all.pop();
    return all.slice(-lines);
}

/** `tail -F` on the given files; returns the child so callers can stop it. */
export function followFiles(files: string[]) {
    return spawn('tail', ['-n', '0', '-F', ...files], { stdio: 'inherit' });
}
