// Process control. Every child is spawned in its own process group, so a gradle launcher's forked JVM or npm's
// child process cannot outlive a stop: we signal the whole group, then insist with SIGKILL. Orphan cleanup only
// signals a PID whose recorded process identity still matches; a port owner is never treated as proof of ownership.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { pidAlive } from './instance.js';
import { sleep } from './ui.js';

export type Spawned = { child: ChildProcess; pid: number; fingerprint?: string };

export function spawnLogged(command: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; logFile: string; append?: boolean }): Spawned {
    const fd = openSync(opts.logFile, opts.append ? 'a' : 'w');
    const child = spawn(command[0], command.slice(1), {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['ignore', fd, fd],
        detached: true,
    });
    closeSync(fd);
    if (!child.pid) {
        child.once('error', () => undefined);
        throw new Error(`failed to spawn ${command.join(' ')}`);
    }
    return { child, pid: child.pid, fingerprint: processFingerprint(child.pid) };
}

export function processFingerprint(pid: number): string | undefined {
    try {
        return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined;
    } catch { return undefined; }
}

export function ownsRecordedProcess(pid: number, fingerprint?: string): boolean {
    if (!fingerprint || !pidAlive(pid)) return false;
    return processFingerprint(pid) === fingerprint;
}

export function children(pid: number): number[] {
    try {
        return execFileSync('pgrep', ['-P', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\s+/).filter(Boolean).map(Number);
    } catch { return []; }
}

export function descendants(pid: number): number[] {
    const out: number[] = [];
    const walk = (p: number) => { for (const c of children(p)) { out.push(c); walk(c); } };
    walk(pid);
    return out;
}

function signalTree(pid: number, signal: NodeJS.Signals): void {
    const all = [...descendants(pid), pid];
    try { process.kill(-pid, signal); } catch { /* not a group leader or already gone */ }
    for (const p of all) { try { process.kill(p, signal); } catch { /* gone */ } }
}

/** SIGTERM the tree, wait up to `graceMs`, then SIGKILL whatever is left. Resolves when nothing is alive. */
export async function killTree(pid: number, graceMs = 20_000): Promise<void> {
    if (!pidAlive(pid) && descendants(pid).length === 0) return;
    const all = [...descendants(pid), pid];
    signalTree(pid, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
        if (!all.some(pidAlive)) return;
        await sleep(500);
    }
    signalTree(pid, 'SIGKILL');
    await sleep(300);
}

export function onSignals(handler: (signal: NodeJS.Signals) => void): void {
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) process.on(s, () => handler(s));
}
