import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerAvailable } from '../compose.ts';
import { listInstances, pidAlive } from '../instance.ts';
import { conflicts, shiftedPorts } from '../ports.ts';
import { green, red, yellow } from '../ui.ts';
import type { Context } from './common.ts';

export async function doctor(ctx: Context): Promise<void> {
    let problems = 0;
    const ok = (m: string) => console.log(`  ${green('✓')} ${m}`);
    const bad = (m: string) => { problems++; console.log(`  ${red('✗')} ${m}`); };
    const meh = (m: string) => console.log(`  ${yellow('!')} ${m}`);

    if (ctx.catalog.config.compose) { const docker = dockerAvailable(); docker.ok ? ok('docker is running') : bad(docker.reason!); }
    else ok('no compose section — Docker not needed');
    const types = new Set(ctx.catalog.services.map((s) => s.def.type));
    const tools: string[][] = [['lsof', '-v']];
    if (types.has('gradle') || types.has('maven')) tools.push(['java', '-version']);
    if (types.has('npm')) tools.push(['node', '--version'], ['npm', '--version']);
    for (const tool of tools) {
        try { execFileSync(tool[0], [tool[1]], { stdio: 'ignore' }); ok(`${tool[0]} on PATH`); } catch { bad(`${tool[0]} not on PATH`); }
    }
    if (types.has('gradle')) existsSync(join(ctx.root, 'gradlew')) ? ok('gradlew present') : bad('gradlew missing (gradle services need it)');

    // hostnames the project expects to resolve locally (lcl.yml `hosts`)
    const wanted = ctx.catalog.config.hosts;
    if (wanted.length && existsSync('/etc/hosts')) {
        const hosts = readFileSync('/etc/hosts', 'utf8');
        const missing = wanted.filter((h) => !new RegExp(`^\\s*(127\\.0\\.0\\.1|::1)\\s+.*\\b${h.replace(/\./g, '\\.')}\\b`, 'm').test(hosts));
        missing.length === 0 ? ok(`/etc/hosts has all ${wanted.length} hostnames from lcl.yml`) : bad(`/etc/hosts is missing: ${missing.join(', ')}`);
    }

    for (const s of ctx.catalog.services) {
        if (s.def.type !== 'npm') continue;
        const installDir = s.def.install ?? s.def.dir ?? '.';
        existsSync(join(ctx.root, installDir, 'node_modules')) ? ok(`${s.name}: node_modules present`) : meh(`${s.name}: node_modules missing (start runs npm install)`);
    }
    const byType = (t: string) => ctx.catalog.services.filter((s) => s.def.type === t).length;
    ok(`${ctx.configFile}: ${byType('gradle')} gradle, ${byType('maven')} maven, ${byType('npm')} npm, ${byType('exec')} exec service(s); ${Object.keys(ctx.catalog.containers).join(', ') || 'no'} container service(s)${ctx.catalog.config.compose ? `; ${ctx.catalog.infra.length} published ports in ${ctx.catalog.composeServices.length} compose services (${ctx.catalog.config.compose.file})` : ''}`);
    for (const f of ctx.catalog.config.files) existsSync(join(ctx.root, f.template)) ? ok(`template ${f.template}`) : bad(`template missing: ${f.template}`);
    for (const h of ctx.catalog.config.hooks.afterUp) ctx.catalog.services.some((s) => s.name === h.service) ? ok(`hook after-up ${h.service}`) : bad(`hook after-up references unknown service ${h.service}`);
    if (ctx.catalog.config.hooks.beforeStart.length) ok(`${ctx.catalog.config.hooks.beforeStart.length} before-start hook(s)`);
    if (ctx.catalog.config.hooks.afterStop.length) ok(`${ctx.catalog.config.hooks.afterStop.length} after-stop hook(s)`);
    ctx.catalog.unknown.length === 0
        ? ok('every service in lcl.yml is runnable')
        : bad(`lcl.yml services that cannot run: ${ctx.catalog.unknown.join(', ')}`);

    // registry
    const instances = listInstances();
    for (const i of instances) {
        if (i.key === ctx.key) continue;
        i.alive ? ok(`stack ${i.id} running at offset +${i.ports.offset} (${i.root})`) : meh(`stack ${i.id} registered but its supervisor is dead (${i.root}) — \`lcl stop --stack ${i.id}\` cleans up`);
    }
    if (ctx.state?.supervisorPid && !pidAlive(ctx.state.supervisorPid)) meh(`this stack's last supervisor ${ctx.state.supervisorPid} is gone; \`lcl stop\` sweeps leftovers`);

    // ports this stack would use
    const map = ctx.state?.ports ?? shiftedPorts(ctx.catalog, 0);
    const owned = new Set(Object.values(ctx.state?.services ?? {}).map((r) => r.pid).filter(Boolean));
    const found = await conflicts(map, new Set());
    const foreign = found.filter((c) => !c.pids.some((p) => owned.has(p)) && !(ctx.state?.supervisorPid && pidAlive(ctx.state.supervisorPid)));
    if (found.length === 0) ok(`all ${Object.keys(map.services).length + Object.keys(map.infra).length} ports at offset +${map.offset} are free`);
    else if (foreign.length === 0) ok(`ports at offset +${map.offset} are held by this stack`);
    else meh(`ports in use at offset +${map.offset}: ${foreign.map((c) => `${c.what}:${c.port}${c.pids.length ? ` pid ${c.pids.join(',')}` : ''}`).join(', ')} — a start will shift to the next free offset`);

    console.log(problems ? red(`\n${problems} problem(s)`) : green('\nall good'));
    if (problems) process.exit(1);
}
