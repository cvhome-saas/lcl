import { rmSync } from 'node:fs';
import { Compose, dockerAvailable } from '../compose.ts';
import { pidAlive, saveState, unregisterInstance } from '../instance.ts';
import { freePort, killTree } from '../proc.ts';
import { die, note, say, sleep, warn } from '../ui.ts';
import { control, liveSupervisor, resolveServices, type Context } from './common.ts';
import { start, type StartFlags } from './start.ts';
import { printStatus } from './status.ts';
import { join } from 'node:path';

export async function stop(ctx: Context, names: string[], flags: { hard: boolean }): Promise<void> {
    const services = resolveServices(ctx, names);
    if (services.length > 0) {
        if (flags.hard) die('--hard cannot be combined with service names');
        await control(ctx, 'stop', { services }, (m) => note(String(m)));
        say(`stopped ${services.join(', ')}`);
        return;
    }

    if (await liveSupervisor(ctx)) {
        const pid = ctx.state!.supervisorPid!;
        say(`stopping stack ${ctx.id} (supervisor ${pid})`);
        await control(ctx, 'shutdown', { volumes: flags.hard });
        const deadline = Date.now() + 120_000;
        while (pidAlive(pid) && Date.now() < deadline) await sleep(500);
        if (pidAlive(pid)) die(`supervisor ${pid} did not stop within 120s`);
        return;
    }
    await stopOrphans(ctx, flags.hard);
}

/** No supervisor answers: kill whatever the last state file recorded, sweep this stack's ports, drop the containers. */
async function stopOrphans(ctx: Context, volumes: boolean): Promise<void> {
    const state = ctx.state;
    if (!state) { warn(`nothing recorded for stack ${ctx.id}`); return; }
    if (state.supervisorPid && pidAlive(state.supervisorPid)) {
        warn(`supervisor ${state.supervisorPid} is alive but unresponsive — killing it`);
        await killTree(state.supervisorPid, 5000);
    }
    let swept = 0;
    for (const [name, rec] of Object.entries(state.services)) {
        if (rec.pid && pidAlive(rec.pid)) { note(`stopping ${name} (pid ${rec.pid})`); await killTree(rec.pid); swept++; }
        const pids = await freePort(rec.port);
        if (pids.length) { note(`killed ${pids.join(',')} still listening on :${rec.port} (${name})`); swept++; }
        rec.state = 'stopped'; rec.pid = undefined;
    }
    if (swept === 0) note('no service processes left from the previous run');
    if ((state.infraUp || volumes) && ctx.catalog.config.compose) {
        if (dockerAvailable().ok) {
            say(volumes ? 'stopping infra containers and deleting volumes' : 'stopping infra containers (volumes kept)');
            const compose = new Compose(ctx.root, state.project, ctx.paths.composeEnv, ctx.paths.composeOverride, join(ctx.paths.logs, 'compose.log'), ctx.catalog.config.compose.file);
            const res = await compose.down(volumes);
            if (res.code !== 0) warn(res.out.trim().split('\n').at(-1) ?? 'docker compose down failed');
        } else warn('docker is not running; containers left as they are');
        state.infraUp = false;
    }
    state.supervisorPid = undefined;
    saveState(ctx.paths, state);
    unregisterInstance(ctx.key);
    rmSync(ctx.paths.socket, { force: true });
    say(`stack ${ctx.id} stopped`);
}

export async function restart(ctx: Context, names: string[], flags: StartFlags & { hard: boolean }): Promise<void> {
    const services = resolveServices(ctx, names);
    if (services.length > 0) {
        if (flags.hard) die('--hard cannot be combined with service names');
        const records = await control(ctx, 'restart', { services }, (m) => note(String(m))) as Array<{ state: string }>;
        await printStatus(ctx);
        if (records.some((r) => r.state !== 'up')) process.exit(1);
        return;
    }
    await stop(ctx, [], { hard: flags.hard });
    const fresh = { ...ctx, state: null };
    await start(fresh, [], flags);
}
