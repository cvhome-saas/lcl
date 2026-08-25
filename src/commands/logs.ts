import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { followEvents, formatEvent, readEvents } from '../events.ts';
import { listInstances, pidAlive, type ServiceRecord } from '../instance.ts';
import { ERROR_RE, followFiles, tailFile } from '../logs.ts';
import { listenersOnPort } from '../ports.ts';
import { descendants } from '../proc.ts';
import { bold, die, dim, parseDuration, red, yellow } from '../ui.ts';
import { control, liveSupervisor, resolveServices, type Context } from './common.ts';

export async function logs(ctx: Context, names: string[], flags: { follow: boolean; since?: string; grep?: string; errors: boolean; lines: number }): Promise<void> {
    const services = resolveServices(ctx, names);
    const files = services.length
        ? services.map((s) => join(ctx.paths.logs, `${s}.log`))
        : existsSync(ctx.paths.logs) ? readdirSync(ctx.paths.logs).filter((f) => f.endsWith('.log')).map((f) => join(ctx.paths.logs, f)) : [];
    const existing = files.filter((f) => existsSync(f));
    if (existing.length === 0) die(`no logs in ${ctx.paths.logs}`);

    const pattern = flags.grep ? new RegExp(flags.grep) : flags.errors ? ERROR_RE : null;
    if (!flags.follow || pattern || flags.since) {
        const since = flags.since ? Date.now() - parseDuration(flags.since) : null;
        for (const file of existing) {
            const lines = flags.since ? readFileSync(file, 'utf8').split('\n') : tailFile(file, flags.lines);
            const name = file.split('/').pop()!.replace(/\.log$/, '');
            for (const line of lines) {
                if (pattern && !pattern.test(line)) continue;
                if (since && !lineAfter(line, since)) continue;
                console.log(existing.length > 1 ? `${dim(name.padEnd(18))} ${line}` : line);
            }
        }
        if (!flags.follow) return;
    }
    const child = followFiles(existing);
    await new Promise<void>((resolve) => { child.on('exit', () => resolve()); process.on('SIGINT', () => { child.kill(); resolve(); }); });
}

/** Log lines start with an ISO-ish timestamp for Java (`2026-08-25T10:00:00.000+03:00`) — used for --since. */
function lineAfter(line: string, since: number): boolean {
    const m = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*(?:Z|[+-]\d{2}:?\d{2})?)/.exec(line);
    if (!m) return true;
    const t = Date.parse(m[1].replace(' ', 'T'));
    return Number.isNaN(t) || t >= since;
}

export async function events(ctx: Context, flags: { follow: boolean; since?: string; service?: string; json: boolean }): Promise<void> {
    const since = flags.since ? Date.now() - parseDuration(flags.since) : null;
    const show = (e: ReturnType<typeof readEvents>[number]) => {
        if (flags.service && e.service !== flags.service) return;
        if (since && Date.parse(e.ts) < since) return;
        console.log(flags.json ? JSON.stringify(e) : formatEvent(e));
    };
    readEvents(ctx.paths.events).forEach(show);
    if (!flags.follow) return;
    const stop = followEvents(ctx.paths.events, show);
    await new Promise<void>((resolve) => process.on('SIGINT', () => { stop(); resolve(); }));
}

export async function why(ctx: Context, name: string): Promise<void> {
    const [service] = resolveServices(ctx, [name]);
    let record: ServiceRecord | undefined;
    let lastErrors: string[] = [];
    let lastLines: string[] = [];
    let restarts = 0;
    let env: Record<string, string | undefined> = {};
    if (await liveSupervisor(ctx)) {
        const data = await control(ctx, 'why', { service }) as { record: ServiceRecord; restarts: number; lastErrors: string[]; lastLines: string[]; env: Record<string, string> };
        ({ record, lastErrors, lastLines, restarts, env } = data);
    } else {
        record = ctx.state?.services[service];
        const file = join(ctx.paths.logs, `${service}.log`);
        lastLines = tailFile(file, 30);
        lastErrors = tailFile(file, 2000).filter((l) => ERROR_RE.test(l)).slice(-30);
    }
    if (!record) die(`${service} has not been started in stack ${ctx.id}`);

    const port = record.port;
    console.log(`${bold(service)}  state=${record.state}  port=${port}  pid=${record.pid ?? '-'}${record.pid && !pidAlive(record.pid) ? red(' (dead)') : ''}  restarts=${restarts}`);
    if (record.exitCode !== undefined && record.exitCode !== null) console.log(`exit code ${record.exitCode}${record.signal ? ` signal ${record.signal}` : ''}`);
    else if (record.signal) console.log(`killed by ${record.signal}`);
    if (record.health) console.log(`health: ${record.health}`);
    const listeners = listenersOnPort(port);
    const own = record.pid ? new Set([record.pid, ...descendants(record.pid)]) : new Set<number>();
    const foreign = listeners.filter((p) => !own.has(p));
    if (listeners.length) console.log(`port :${port} held by pid ${listeners.join(',')}${foreign.length && record.pid ? yellow(' (not this service!)') : own.size ? dim(' (child of the launcher)') : ''}`);
    else console.log(`port :${port} is free`);
    console.log(`log:  ${record.logFile}`);
    if (record.command) console.log(`cmd:  ${dim(`(cd ${record.cwd}) `)}${record.command.join(' ')}`);
    const interesting = Object.entries(env).filter(([k]) => !(k in process.env) || k.startsWith('LCL_') || k === 'PORT');
    if (interesting.length) console.log(`env:  ${dim(interesting.map(([k, v]) => `${k}=${v}`).join(' '))}`);

    const eventsFor = readEvents(ctx.paths.events).filter((e) => e.service === service).slice(-8);
    if (eventsFor.length) { console.log(`\n${bold('recent events')}`); eventsFor.forEach((e) => console.log('  ' + formatEvent(e))); }
    if (lastErrors.length) { console.log(`\n${bold('last errors')} (${lastErrors.length})`); lastErrors.slice(-15).forEach((l) => console.log('  ' + red(l.slice(0, 220)))); }
    if (lastLines.length) { console.log(`\n${bold('last log lines')}`); lastLines.slice(-15).forEach((l) => console.log('  ' + l.slice(0, 220))); }
}

export function clean(ctx: Context, all: boolean): void {
    if (ctx.state?.supervisorPid && pidAlive(ctx.state.supervisorPid)) die(`stack ${ctx.id} is running — stop it first`);
    rmSync(ctx.paths.dir, { recursive: true, force: true });
    console.log(`removed ${ctx.paths.dir}`);
    if (all) {
        for (const inst of listInstances()) if (!inst.alive && inst.key !== ctx.key) { rmSync(join(inst.root, 'build', 'lcl', inst.id), { recursive: true, force: true }); console.log(`removed ${join(inst.root, 'build', 'lcl', inst.id)}`); }
    }
}
