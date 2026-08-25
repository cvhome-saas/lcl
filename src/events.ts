// Audit trail: one JSON line per lifecycle event, per stack. Read by `lcl events` and `lcl why`.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { dirname } from 'node:path';

export type Event = {
    ts: string;
    event: string;
    service?: string;
    pid?: number;
    detail?: Record<string, unknown>;
    message?: string;
};

export class EventLog {
    private readonly file: string;
    private readonly onWrite?: (e: Event) => void;
    constructor(file: string, onWrite?: (e: Event) => void) { this.file = file; this.onWrite = onWrite; }

    emit(event: string, extra: Omit<Event, 'ts' | 'event'> = {}): Event {
        const e: Event = { ts: new Date().toISOString(), event, pid: process.pid, ...extra };
        mkdirSync(dirname(this.file), { recursive: true });
        appendFileSync(this.file, JSON.stringify(e) + '\n');
        this.onWrite?.(e);
        return e;
    }
}

export function readEvents(file: string): Event[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as Event]; } catch { return []; }
    });
}

export function formatEvent(e: Event): string {
    const parts = [e.ts.replace('T', ' ').replace(/\.\d+Z$/, ''), e.event.padEnd(20), (e.service ?? '').padEnd(18)];
    if (e.message) parts.push(e.message);
    else if (e.detail) parts.push(Object.entries(e.detail).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' '));
    return parts.join(' ').trimEnd();
}

/** Follows the events file, invoking `cb` for every new line. Returns a stop function. */
export function followEvents(file: string, cb: (e: Event) => void): () => void {
    let offset = existsSync(file) ? statSync(file).size : 0;
    const poll = () => {
        if (!existsSync(file)) return;
        const size = statSync(file).size;
        if (size < offset) offset = 0;
        if (size === offset) return;
        const chunk = readFileSync(file, 'utf8').slice(offset);
        offset = size;
        for (const line of chunk.split('\n').filter(Boolean)) { try { cb(JSON.parse(line)); } catch { /* partial line */ } }
    };
    watchFile(file, { interval: 500 }, poll);
    return () => unwatchFile(file, poll);
}
