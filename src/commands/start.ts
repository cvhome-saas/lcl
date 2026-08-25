import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dependencyClosure, type Catalog } from '../catalog.js';
import { request } from '../control.js';
import { composeProjectName, newStateIdentity, pidAlive, type StartOptions, type State } from '../instance.js';
import { allocatePorts, DEFAULT_STEP } from '../ports.js';
import { die, dim, green, note, say, sleep, warn, yellow } from '../ui.js';
import { control, liveSupervisor, resolveServices, type Context } from './common.js';
import { printStatus } from './status.js';

export type StartFlags = {
    detach: boolean; build: boolean; noInfra: boolean; infra?: string; keepInfra: boolean; failFast: boolean;
    restart?: string; parallel: number; ports?: string; noDefaultPorts: boolean;
};

export async function start(ctx: Context, names: string[], flags: StartFlags): Promise<void> {
    const requested = resolveServices(ctx, names);
    const closure = dependencyClosure(ctx.catalog, requested);
    const services = requested.length ? closure.source : [];
    if (await liveSupervisor(ctx)) {
        if (services.length === 0) die(`stack ${ctx.id} is already running (supervisor ${ctx.state!.supervisorPid}). Use \`lcl restart\` or \`lcl stop\` first.`);
        say(`starting ${services.join(', ')} in the running stack ${ctx.id}`);
        const records = await control(ctx, 'start', { services, infra: flags.noInfra ? [] : closure.compose }, (m) => note(String(m))) as Array<{ state: string }>;
        await printStatus(ctx);
        if (records.some((r) => r.state !== 'up')) process.exit(1);
        return;
    }
    if (ctx.state?.supervisorPid && pidAlive(ctx.state.supervisorPid)) die(`supervisor ${ctx.state.supervisorPid} is alive but not answering; run \`lcl stop\` first`);

    const options = buildOptions(ctx.catalog, services, closure.compose, flags);
    const previous = ctx.state?.ports.offset;
    const { ports, conflicts } = await allocatePorts(ctx.catalog, ctx.key, options.portsMode, previous, options.infra);
    if (conflicts.length) {
        warn(`ports in use: ${conflicts.map((c) => `${c.what}:${c.port}${c.pids.length ? ` (pid ${c.pids.join(',')})` : ''}`).join(', ')}`);
        const sample = Object.entries(ports.services).slice(0, 3).map(([n, p]) => `${n} ${p}`).join(', ');
        note(`shifting the whole stack to offset +${ports.offset}: ${sample} …`);
    } else if (options.portsMode === 'auto' && ports.offset !== 0 && ports.offset === previous) {
        note(`reusing offset +${ports.offset} from the previous run of this stack`);
    } else if (typeof options.portsMode === 'number') {
        note(`forced offset +${ports.offset}`);
    } else if (options.portsMode === 'shift') {
        note(`configured ports skipped on request — using offset +${ports.offset}: ${Object.entries(ports.services).slice(0, 3).map(([n, p]) => `${n} ${p}`).join(', ')} …`);
    }

    const state: State = {
        ...newStateIdentity(),
        id: ctx.id, key: ctx.key, root: ctx.root, configFile: ctx.configFile,
        project: composeProjectName(ctx.catalog.config.name, ctx.id, ctx.root), ports, options, services: {}, infraUp: false,
    };
    mkdirSync(ctx.paths.dir, { recursive: true });
    const stateArg = JSON.stringify(state);
    const entry = fileURLToPath(new URL('../main.js', import.meta.url));
    const nodeArgs = [entry, '__supervise', '--state', stateArg];

    if (flags.detach) {
        const fd = openSync(ctx.paths.supervisorLog, 'w');
        const child = spawn(process.execPath, nodeArgs, { cwd: ctx.root, stdio: ['ignore', fd, fd], detached: true });
        closeSync(fd);
        child.unref();
        say(`starting stack ${ctx.id} in the background (supervisor ${child.pid}); log: ${ctx.paths.supervisorLog}`);
        const ok = await waitForReady(ctx, child.pid!);
        await printStatus(ctx);
        if (!ok) process.exit(1);
        return;
    }

    const child = spawn(process.execPath, nodeArgs, { cwd: ctx.root, stdio: 'inherit' });
    // Ctrl-C reaches the supervisor through the shared foreground process group; we just wait for it to finish.
    process.on('SIGINT', () => undefined);
    process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch { /* gone */ } });
    await new Promise<void>((resolve) => child.on('exit', (code) => { process.exitCode = code ?? 1; resolve(); }));
}

function buildOptions(catalog: Catalog, services: string[], dependencyInfra: string[], flags: StartFlags): StartOptions {
    let infra: string[];
    if (flags.noInfra || !catalog.config.compose) infra = [];
    else if (!flags.infra || flags.infra === 'default') infra = catalog.config.compose.default.length ? catalog.config.compose.default : catalog.composeServices;
    else if (flags.infra === 'all') infra = catalog.composeServices;
    else {
        infra = flags.infra.split(',').map((s) => s.trim()).filter(Boolean);
        for (const s of infra) if (!catalog.composeServices.includes(s)) die(`--infra: ${s} is not a configured Compose service (${catalog.composeServices.join(', ')})`);
    }
    if (!flags.noInfra) infra = [...new Set([...infra, ...dependencyInfra])];

    let restart = 0;
    if (flags.restart) {
        const m = /^(on-failure|always)(?::(\d+))?$/.exec(flags.restart);
        if (!m) die(`--restart expects on-failure[:N] (got ${flags.restart})`);
        restart = m[2] ? Number(m[2]) : 3;
    }
    let portsMode: StartOptions['portsMode'] = catalog.config.ports.skipConfigured ? 'shift' : 'auto';
    if (flags.noDefaultPorts) portsMode = 'shift';
    if (flags.ports) {
        if (flags.ports === 'auto') portsMode = 'auto';
        else if (flags.ports === 'configured') portsMode = 'configured';
        else if (flags.ports === 'shift') portsMode = 'shift';
        else if (/^offset=\d+$/.test(flags.ports)) portsMode = Number(flags.ports.slice(7));
        else die(`--ports expects auto | configured | shift | offset=<k> (k × ${catalog.config.ports.step || DEFAULT_STEP})`);
    }
    return { services, infra, keepInfra: flags.keepInfra, build: flags.build, failFast: flags.failFast, restart, parallel: Math.max(1, flags.parallel), portsMode };
}

async function waitForReady(ctx: Context, supervisorPid: number, timeoutMs = 1_200_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const seen = new Set<string>();
    while (Date.now() < deadline) {
        try {
            const snap = await request(ctx.paths.socket, { cmd: 'status' }, undefined, 5000) as { phase: string; state: State };
            for (const [name, r] of Object.entries(snap.state.services)) {
                const key = `${name}:${r.state}`;
                if (seen.has(key)) continue;
                seen.add(key);
                if (r.state === 'up') console.log(`    ${green(name.padEnd(20))} up${r.port ? ` on :${r.port}` : ''}`);
                else if (r.state === 'crashed' || r.state === 'degraded') console.log(`    ${yellow(name.padEnd(20))} ${r.state}: ${r.health ?? ''}`);
                else if (r.state === 'starting') console.log(`    ${dim(name.padEnd(20))} starting${r.port ? ` on :${r.port}` : ''}`);
            }
            if (snap.phase === 'running') {
                const wanted = snap.state.options.services.length ? snap.state.options.services : Object.keys(snap.state.services);
                return wanted.every((n) => snap.state.services[n]?.state === 'up');
            }
        } catch { /* socket not up yet */ }
        if (!pidAlive(supervisorPid)) {
            warn(`supervisor exited before the stack was ready — see ${ctx.paths.supervisorLog}`);
            return false;
        }
        await sleep(2000);
    }
    warn('timed out waiting for the stack');
    return false;
}
