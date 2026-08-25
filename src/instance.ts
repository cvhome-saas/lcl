// Stack identity (`--stack`, default `default`), per-stack paths under .lcl/<stack>/, the state file and the
// global registry of running stacks.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { die } from './ui.js';
import { findConfig } from './config.js';
import { CONTROL_PROTOCOL_VERSION, STATE_VERSION, VERSION } from './version.js';

export function findRoot(from = process.cwd(), explicitConfig?: string): { root: string; configFile: string } {
    const configFile = findConfig(from, explicitConfig);
    return { root: join(configFile, '..'), configFile };
}

export type ServiceState = 'starting' | 'up' | 'degraded' | 'down' | 'crashed' | 'stopped';

export type ServiceRecord = {
    state: ServiceState;
    pid?: number;
    processFingerprint?: string;
    port: number;
    startedAt?: string;
    exitCode?: number | null;
    signal?: string | null;
    health?: string;
    errors: number;
    logFile: string;
    command?: string[];
    cwd?: string;
};

export type PortMap = { offset: number; services: Record<string, number>; infra: Record<string, number> };

export type StartOptions = {
    services: string[];        // requested service names (all when empty)
    infra: string[];           // compose services to bring up ([] with --no-infra)
    keepInfra: boolean;
    build: boolean;
    failFast: boolean;
    restart: number;           // max automatic restarts per service (0 = off)
    parallel: number;
    portsMode: 'auto' | 'configured' | 'shift' | number;   // shift: ignore the configured ports, first free sequence at +step
};

export type State = {
    stateVersion: number;
    protocolVersion: number;
    cliVersion: string;
    id: string;                // stack name
    configFile: string;
    key: string;               // registry key: stack name + checkout, unique across checkouts
    root: string;
    project: string;           // docker compose project name
    supervisorPid?: number;
    supervisorFingerprint?: string;
    startedAt?: string;
    ports: PortMap;
    options: StartOptions;
    services: Record<string, ServiceRecord>;
    infraUp: boolean;
};

export type Paths = {
    root: string; dir: string; logs: string; state: string; events: string; instanceYml: string;
    composeEnv: string; composeOverride: string; socket: string; supervisorLog: string;
};


export const DEFAULT_STACK = 'default';

export function stackName(explicit?: string): string {
    const raw = explicit ?? process.env.LCL_STACK ?? DEFAULT_STACK;
    const id = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) die(`bad stack name: ${raw}`);
    return id;
}

export function registryKey(root: string, stack: string): string {
    return `${stack}@${createHash('sha1').update(root).digest('hex').slice(0, 8)}`;
}

/** A Compose-safe project name that cannot collide with the same stack in another checkout. */
export function composeProjectName(name: string, stack: string, root: string): string {
    const slug = `${name}-${stack}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'stack';
    const checkout = createHash('sha1').update(root).digest('hex').slice(0, 8);
    return `lcl-${slug.slice(0, 48)}-${checkout}`;
}

export function paths(root: string, stack: string): Paths {
    const dir = join(root, '.lcl', stack);
    return {
        root, dir,
        logs: join(dir, 'logs'),
        state: join(dir, 'state.json'),
        events: join(dir, 'events.jsonl'),
        instanceYml: join(dir, 'lcl-instance.yml'),
        composeEnv: join(dir, 'compose.env'),
        composeOverride: join(dir, 'compose.override.yml'),
        // unix socket paths are limited to ~104 bytes on macOS: keep it short and outside the (possibly deep) checkout
        socket: join(tmpdir(), `lcl-${registryKey(root, stack)}.sock`),
        supervisorLog: join(dir, 'supervisor.log'),
    };
}

export function loadState(p: Paths): State | null {
    if (!existsSync(p.state)) return null;
    try {
        const state = JSON.parse(readFileSync(p.state, 'utf8')) as State;
        if (state.stateVersion !== STATE_VERSION) die(`state in ${p.dir} uses unsupported format ${state.stateVersion ?? 'legacy'}; stop the old stack and remove that directory`);
        return state;
    } catch (error) {
        if (error instanceof Error && error.message.includes('unsupported format')) throw error;
        return null;
    }
}

export function saveState(p: Paths, state: State): void {
    mkdirSync(p.dir, { recursive: true });
    const tmp = `${p.state}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, p.state);
}

export function pidAlive(pid?: number): boolean {
    if (!pid || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

// ---- global registry ---------------------------------------------------------------------------------------------

export const REGISTRY_DIR = join(process.env.LCL_HOME ?? join(homedir(), '.lcl'), 'instances');

export type RegistryEntry = {
    id: string; key: string; root: string; project: string; supervisorPid?: number; startedAt?: string; ports: PortMap;
    cliVersion?: string; protocolVersion?: number; updatedAt: string;
};

export function registerInstance(state: State): void {
    mkdirSync(REGISTRY_DIR, { recursive: true });
    const entry: RegistryEntry = {
        id: state.id, key: state.key, root: state.root, project: state.project, supervisorPid: state.supervisorPid,
        startedAt: state.startedAt, ports: state.ports, cliVersion: state.cliVersion, protocolVersion: state.protocolVersion,
        updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(REGISTRY_DIR, `${state.key}.json`), JSON.stringify(entry, null, 2));
}

export function newStateIdentity(): Pick<State, 'stateVersion' | 'protocolVersion' | 'cliVersion'> {
    return { stateVersion: STATE_VERSION, protocolVersion: CONTROL_PROTOCOL_VERSION, cliVersion: VERSION };
}

export function unregisterInstance(key: string): void {
    rmSync(join(REGISTRY_DIR, `${key}.json`), { force: true });
}

/** All registered stacks. Entries whose checkout vanished are dropped; dead supervisors are reported as such. */
export function listInstances(): Array<RegistryEntry & { alive: boolean }> {
    if (!existsSync(REGISTRY_DIR)) return [];
    const out: Array<RegistryEntry & { alive: boolean }> = [];
    for (const file of readdirSync(REGISTRY_DIR)) {
        if (!file.endsWith('.json')) continue;
        try {
            const entry = JSON.parse(readFileSync(join(REGISTRY_DIR, file), 'utf8')) as RegistryEntry;
            if (!existsSync(entry.root)) { rmSync(join(REGISTRY_DIR, file), { force: true }); continue; }
            out.push({ ...entry, alive: pidAlive(entry.supervisorPid) });
        } catch { rmSync(join(REGISTRY_DIR, file), { force: true }); }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id) || a.root.localeCompare(b.root));
}
