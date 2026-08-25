import { request } from '../control.ts';
import { listInstances, loadState, pidAlive, type ServiceRecord, type State } from '../instance.ts';
import { shiftedPorts } from '../ports.ts';
import { envName, urlsFor, variables } from '../render.ts';
import { tcpOpen } from '../health.ts';
import { bold, cyan, dim, fmtDuration, green, red, table, yellow } from '../ui.ts';
import { liveSupervisor, type Context } from './common.ts';
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';

const colour = (s: string) => ({ up: green, degraded: yellow, starting: cyan, crashed: red, down: dim, stopped: dim } as Record<string, (t: string) => string>)[s]?.(s) ?? s;

export async function printStatus(ctx: Context, json = false): Promise<void> {
    ctx.state = loadState(ctx.paths);
    const live = await liveSupervisor(ctx);
    let state = ctx.state;
    let phase = 'stopped';
    let infra: string[] = [];
    if (live) {
        const snap = await request(ctx.paths.socket, { cmd: 'status' }) as { phase: string; state: State; infra: string[] };
        state = snap.state; phase = snap.phase; infra = snap.infra;
    }
    if (json) { console.log(JSON.stringify({ stack: ctx.id, phase, live, infra, state }, null, 2)); return; }

    console.log(`${bold('stack')}      ${ctx.id}  ${dim(ctx.root)}`);
    console.log(`${bold('supervisor')} ${live ? green(`running ${state!.supervisorPid} (${phase})`) : state?.supervisorPid && pidAlive(state.supervisorPid) ? yellow(`pid ${state.supervisorPid} not answering`) : dim('stopped')}`);
    if (!state) { console.log(dim('never started here — `lcl start`')); return; }
    console.log(`${bold('ports')}      offset +${state.ports.offset}  compose project ${state.project}${infra.length ? `  containers: ${infra.join(' ')}` : ''}`);
    console.log('');
    const rows: string[][] = [];
    for (const s of ctx.catalog.services) {
        const rec: ServiceRecord | undefined = state.services[s.name];
        const port = state.ports.services[s.name];
        if (!rec) {
            const busy = port ? await tcpOpen(port) : false;
            rows.push([s.name, busy ? yellow('port-used') : dim('not started'), port ? String(port) : '-', '', '', '', '']);
            continue;
        }
        const alive = live ? rec.state : rec.pid && pidAlive(rec.pid) ? rec.state : port && (await tcpOpen(port)) ? 'port-used' : 'stopped';
        rows.push([
            s.name, colour(alive), port ? String(port) : '-', rec.pid ? String(rec.pid) : '-',
            rec.startedAt && (alive === 'up' || alive === 'degraded' || alive === 'starting') ? fmtDuration(Date.now() - Date.parse(rec.startedAt)) : '-',
            rec.errors ? (rec.errors > 0 ? yellow(String(rec.errors)) : '0') : '0',
            (rec.health ?? '').slice(0, 60),
        ]);
    }
    console.log(table(rows, ['service', 'state', 'port', 'pid', 'uptime', 'errors', 'health']));
    console.log('');
    console.log(dim(`logs: ${relative(process.cwd(), ctx.paths.logs) || '.'}   ·   lcl why <service> for details`));
}

export function printUrls(ctx: Context): void {
    const ports = ctx.state?.ports ?? shiftedPorts(ctx.catalog, 0);
    const vars = variables(ctx.catalog, { id: ctx.id, project: ctx.state?.project ?? `lcl-${ctx.catalog.config.name}-${ctx.id}`, ports }, ctx.paths);
    const rows = urlsFor(ctx.catalog, vars).map(([k, v]) => [k, v]);
    if (!ctx.state) console.log(dim('(not started — showing the configured ports)'));
    console.log(table(rows));
}

export function printPorts(ctx: Context, mode: 'table' | 'json' | 'env'): void {
    const ports = ctx.state?.ports ?? shiftedPorts(ctx.catalog, 0);
    if (mode === 'json') { console.log(JSON.stringify(ports, null, 2)); return; }
    if (mode === 'env') {
        for (const [name, port] of Object.entries(ports.services)) console.log(`export ${envName(name)}=${port}`);
        for (const i of ctx.catalog.infra) console.log(`export ${i.envVar}=${ports.infra[i.key]}`);
        const vars = variables(ctx.catalog, { id: ctx.id, project: ctx.state?.project ?? '', ports }, ctx.paths);
        for (const [label, url] of urlsFor(ctx.catalog, vars)) console.log(`export ${label.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_URL=${url}`);
        return;
    }
    if (!ctx.state) console.log(dim('(not started — configured ports; a start shifts them if any is taken)'));
    else console.log(`offset +${ports.offset}`);
    const rows: string[][] = [];
    for (const s of ctx.catalog.services) rows.push([s.name, s.port === undefined ? '-' : String(ports.services[s.name]), s.port === undefined ? '-' : String(s.port), s.def.type === 'gradle' ? `gradle ${s.def.module}` : `${s.def.type} ${s.def.dir ?? ''} ${(s.def.command ?? []).join(' ')}`.trim()]);
    for (const [name, c] of Object.entries(ctx.catalog.containers)) rows.push([name, String(ports.services[name]), String(c.port), `container (compose ${c.compose})`]);
    for (const i of ctx.catalog.infra) rows.push([i.label, String(ports.infra[i.key]), String(i.port), `container ${i.image}`]);
    console.log(table(rows, ['service', 'port', 'configured', 'runner']));
}

export function printList(): void {
    const instances = listInstances();
    if (instances.length === 0) { console.log(dim('no running stacks')); return; }
    const rows = instances.map((i) => {
        let branch = '';
        try { branch = execFileSync('git', ['-C', i.root, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not git */ }
        const first = Object.entries(i.ports.services)[0];
        return [i.id, i.alive ? green(`running ${i.supervisorPid}`) : red('dead'), `+${i.ports.offset}`, first ? `${first[0]} ${first[1]}` : '', branch, i.root];
    });
    console.log(table(rows, ['stack', 'supervisor', 'offset', 'first service', 'branch', 'checkout']));
}
