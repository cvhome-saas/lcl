// Port policy: the configured ports (common-config.yml / compose defaults) are the default. If any of them is taken —
// by another stack, a previous run, or a stray process — the WHOLE stack shifts to the next free sequence,
// offset +1000·k, so a second stack reads as "gateway 9000, catalog 9122, postgres 6432".

import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import type { Catalog } from './catalog.js';
import { listInstances, type PortMap } from './instance.js';
import { die } from './ui.js';

export const DEFAULT_STEP = 1000;
const MAX_OFFSET_STEPS = 50;

/**
 * Bind test on the wildcard address: a JVM listening dual-stack on [::]:8001 does NOT stop a 127.0.0.1:8001 bind on
 * macOS, so testing loopback would call taken ports free. Ports below 1024 cannot be bind-tested without root
 * (EACCES) — there `listening` (from lsof) is the authority, and callers pass it for everything else as a second opinion.
 */
export function portFree(port: number, listening?: Set<number>): Promise<boolean> {
    if (listening?.has(port)) return Promise.resolve(false);
    return new Promise((resolve) => {
        const srv = createServer();
        srv.unref();
        srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EACCES' ? !(listening ?? listeningPorts()).has(port) : false));
        srv.listen({ port, host: '::', exclusive: true }, () => srv.close(() => resolve(true)));
    });
}

/** Every TCP port with a listener on this machine, in one lsof call. */
export function listeningPorts(): Set<number> {
    const set = new Set<number>();
    try {
        const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'n'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        for (const line of out.split('\n')) {
            const m = /^n.*:(\d+)$/.exec(line);
            if (m) set.add(Number(m[1]));
        }
    } catch { /* lsof missing: bind test alone */ }
    return set;
}

export function listenersOnPort(port: number): number[] {
    try {
        const out = execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))];
    } catch { return []; }
}

export function shiftedPorts(catalog: Catalog, offset: number): PortMap {
    const services: Record<string, number> = {};
    for (const service of catalog.services) {
        for (const [name, port] of Object.entries(service.ports)) services[`${service.name}.${name}`] = shifted(port, offset);
    }
    const infra: Record<string, number> = {};
    for (const i of catalog.infra) infra[i.key] = shifted(i.port, offset);
    return { offset, services, infra };
}

function shifted(port: number, offset: number): number {
    const value = port + offset;
    if (value > 65535) die(`port ${port} shifted by ${offset} exceeds 65535; reduce ports.step or choose a smaller offset`);
    return value;
}

/** Ports reserved by other running stacks (alive or not yet listening), so two starts never race for a port. */
function reservedByOthers(selfKey: string): Set<number> {
    const set = new Set<number>();
    for (const inst of listInstances()) {
        if (inst.key === selfKey || !inst.alive) continue;
        for (const p of Object.values(inst.ports.services)) set.add(p);
        for (const p of Object.values(inst.ports.infra)) set.add(p);
    }
    return set;
}

export type Conflict = { what: string; port: number; pids: number[] };

export async function conflicts(map: PortMap, reserved: Set<number>, names?: Set<string>): Promise<Conflict[]> {
    const out: Conflict[] = [];
    const listening = listeningPorts();
    const check = async (what: string, port: number) => {
        if (reserved.has(port)) { out.push({ what, port, pids: [] }); return; }
        if (!(await portFree(port, listening))) out.push({ what, port, pids: listenersOnPort(port) });
    };
    const infraPorts = new Set(Object.values(map.infra));
    for (const [name, port] of Object.entries(map.services)) if ((!names || names.has(name)) && !infraPorts.has(port)) await check(name, port);
    for (const [key, port] of Object.entries(map.infra)) if (!names || names.has(key)) await check(key, port);
    return out;
}

/**
 * Decide the port sequence for a start. `previous` is the offset this stack used last time (kept when still free).
 * `mode`: 'auto' shifts on conflict, 'configured' refuses to shift, 'shift' never uses the configured ports
 * (first free sequence at +step or beyond), a number forces that offset step.
 */
export async function allocatePorts(
    catalog: Catalog, selfKey: string, mode: 'auto' | 'configured' | 'shift' | number, previous: number | undefined, composeServices: string[],
): Promise<{ ports: PortMap; conflicts: Conflict[] }> {
    const reserved = reservedByOthers(selfKey);
    // Every service port counts (any of them may be started later in this stack), but only the infra containers
    // this start brings up — grafana's 3000 must not push a stack that never starts grafana to another offset.
    const relevant = new Set<string>(Object.keys(catalog.configuredPorts));
    for (const i of catalog.infra) if (composeServices.includes(i.compose)) relevant.add(i.key);
    const candidates: number[] = [];
    const OFFSET_STEP = catalog.config.ports.step || DEFAULT_STEP;
    if (typeof mode === 'number') candidates.push(mode * OFFSET_STEP);
    else if (mode === 'configured') candidates.push(0);
    else {
        // configured ports first (unless the stack must stay off them); then the sequence this stack used last
        // time (stable URLs); then walk up
        if (mode === 'auto') candidates.push(0);
        if (previous !== undefined && previous !== 0) candidates.push(previous);
        for (let k = 1; k <= MAX_OFFSET_STEPS; k++) if (k * OFFSET_STEP !== previous) candidates.push(k * OFFSET_STEP);
    }
    let first: Conflict[] | null = null;
    for (const offset of candidates) {
        const map = shiftedPorts(catalog, offset);
        const found = await conflicts(map, reserved, relevant);
        if (found.length === 0) return { ports: map, conflicts: first ?? [] };
        first ??= found;
    }
    const detail = (first ?? []).map((c) => `${c.what}:${c.port}${c.pids.length ? ` (pid ${c.pids.join(',')})` : ' (reserved by another stack)'}`).join(', ');
    if (mode === 'configured') die(`configured ports are in use: ${detail}. Stop the other stack or drop --ports configured.`);
    if (typeof mode === 'number') die(`ports at offset +${mode * (catalog.config.ports.step || DEFAULT_STEP)} are in use: ${detail}`);
    die(`no free port sequence found after ${MAX_OFFSET_STEPS} offsets; first conflict: ${detail}`);
}
