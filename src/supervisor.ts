// The supervisor: one long-lived process per stack that owns the compose containers and every service process,
// watches their logs and health, records state and events, and answers CLI commands over the control socket.
// Everything project-specific (what to run, how, env, health, hooks) comes from lcl.yml via the catalog.

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import type { Catalog, Service } from './catalog.ts';
import { Compose } from './compose.ts';
import { evaluateWhen, interpolate, renderTemplate, type Vars } from './config.ts';
import { progress, serve, type Request } from './control.ts';
import { EventLog } from './events.ts';
import { httpAlive, httpProbe, tcpOpen } from './health.ts';
import { pidAlive, registerInstance, saveState, unregisterInstance, type Paths, type ServiceRecord, type State, type StartOptions } from './instance.ts';
import { LogWatcher } from './logs.ts';
import { freePort, killTree, onSignals, spawnLogged, type Spawned } from './proc.ts';
import { envName, renderComposeEnv, renderComposeOverride, renderFiles, serviceList, urlsFor, variables, writeFile } from './render.ts';
import { dim, fmtDuration, green, red, say, sleep, warn, yellow } from './ui.ts';

type Runtime = {
    service: Service;
    record: ServiceRecord;
    proc?: Spawned;
    watcher: LogWatcher;
    readyLog?: RegExp;
    restarts: number;
    stopping: boolean;
    lastProbe: number;
};

const DEFAULT_START_TIMEOUT = 300;
const HEALTH_INTERVAL = 5_000;

export class Supervisor {
    readonly catalog: Catalog;
    readonly paths: Paths;
    readonly state: State;
    readonly events: EventLog;
    readonly compose: Compose;
    private readonly runtimes = new Map<string, Runtime>();
    private phase: 'starting' | 'running' | 'stopping' = 'starting';
    private shuttingDown: Promise<void> | null = null;
    private ownsInfra = false;

    constructor(catalog: Catalog, paths: Paths, state: State) {
        this.catalog = catalog;
        this.paths = paths;
        this.state = state;
        this.events = new EventLog(paths.events, (e) => {
            if (e.event.startsWith('service.') || e.event.startsWith('instance.') || e.event.startsWith('infra.') || e.event.startsWith('hook.')) {
                const colour = /crash|fail|degraded/.test(e.event) ? red : /up$|ready|start$/.test(e.event) ? green : dim;
                console.log(`    ${colour(e.event.padEnd(18))} ${(e.service ?? '').padEnd(18)} ${e.message ?? ''}`);
            }
        });
        this.compose = new Compose(catalog.root, state.project, paths.composeEnv, paths.composeOverride, join(paths.logs, 'compose.log'), catalog.config.compose.file);
    }

    get options(): StartOptions { return this.state.options; }
    private vars(service?: string): Vars { return variables(this.catalog, this.state, this.paths, service); }

    // ---- lifecycle ----------------------------------------------------------------------------------------------

    async run(): Promise<never> {
        mkdirSync(this.paths.logs, { recursive: true });
        this.state.supervisorPid = process.pid;
        this.state.startedAt = new Date().toISOString();
        this.persist();
        registerInstance(this.state);
        this.events.emit('instance.start', { detail: { offset: this.state.ports.offset, options: this.options as unknown as Record<string, unknown> } });

        serve(this.paths.socket, (req, sock) => this.handle(req, sock));
        onSignals((signal) => { this.events.emit('instance.signal', { message: signal }); void this.shutdown({ volumes: false, exitCode: 130 }); });
        process.on('uncaughtException', (e) => { this.events.emit('instance.error', { message: String(e?.stack ?? e) }); void this.shutdown({ volumes: false, exitCode: 1 }); });

        try {
            await this.bringUp();
        } catch (e) {
            this.events.emit('instance.failed', { message: (e as Error).message });
            warn(`start failed: ${(e as Error).message}`);
            await this.shutdown({ volumes: false, exitCode: 1 });
        }
        this.phase = 'running';
        this.persist();
        this.printBanner();
        void this.monitor();
        return new Promise<never>(() => { /* stays alive until shutdown() exits the process */ });
    }

    private render(): void {
        const vars = this.vars();
        renderFiles(this.catalog, vars, this.state.ports);
        writeFile(this.paths.composeEnv, renderComposeEnv(this.catalog, this.state.ports, vars));
        writeFile(this.paths.composeOverride, renderComposeOverride(this.catalog, this.state.ports));
    }

    private async bringUp(): Promise<void> {
        this.render();

        if (this.options.build) {
            const build = this.catalog.config.build;
            if (!build?.length) throw new Error('--build: lcl.yml has no `build:` command');
            say(`building: ${build.join(' ')}`);
            const code = await this.runToCompletion(build.map((a) => interpolate(a, this.vars(), 'build')), this.catalog.root, join(this.paths.logs, 'build.log'));
            if (code !== 0) throw new Error(`build failed — see ${join(this.paths.logs, 'build.log')}`);
        }

        if (this.options.infra.length > 0) {
            say(`starting containers: ${this.options.infra.join(', ')} (compose project ${this.state.project})`);
            const res = await this.compose.up(this.options.infra);
            if (res.code !== 0) throw new Error(`docker compose up failed:\n${res.out.trim().split('\n').slice(-10).join('\n')}`);
            this.ownsInfra = true;
            this.state.infraUp = true;
            this.persist();
            this.events.emit('infra.up', { message: this.options.infra.join(' ') });
            // wait until every published port of the started containers answers
            const ports = this.catalog.infra.filter((i) => this.options.infra.includes(i.compose)).map((i) => ({ i, port: this.state.ports.infra[i.key] }));
            for (const { i, port } of ports) {
                const ok = await waitUntil(() => tcpOpen(port), 60_000);
                if (!ok) warn(`${i.label} is not answering on :${port}`);
            }
        }

        const wanted = new Set(this.options.services.length ? this.options.services : this.catalog.services.map((s) => s.name));
        say(`starting services (ports offset +${this.state.ports.offset})`);
        for (const level of this.catalog.levels) {
            const batch = this.catalog.services.filter((s) => level.includes(s.name) && wanted.has(s.name));
            await this.startBatch(batch);
            if (this.phase === 'stopping') return;
        }
    }

    private async startBatch(services: Service[]): Promise<void> {
        const width = Math.max(1, this.options.parallel);
        for (let i = 0; i < services.length; i += width) {
            const slice = services.slice(i, i + width);
            await Promise.all(slice.map((s) => this.startService(s.name).catch((e) => warn(`${s.name}: ${(e as Error).message}`))));
            if (this.phase === 'stopping') return;
        }
    }

    // ---- services -----------------------------------------------------------------------------------------------

    private runtime(name: string): Runtime {
        let rt = this.runtimes.get(name);
        if (!rt) {
            const service = this.catalog.services.find((s) => s.name === name);
            if (!service) throw new Error(`unknown service ${name}`);
            const logFile = join(this.paths.logs, `${name}.log`);
            rt = {
                service,
                record: { state: 'down', port: this.state.ports.services[name], errors: 0, logFile },
                watcher: new LogWatcher(logFile),
                readyLog: service.def.health?.readyLog ? new RegExp(service.def.health.readyLog) : undefined,
                restarts: 0, stopping: false, lastProbe: 0,
            };
            this.runtimes.set(name, rt);
            this.state.services[name] = rt.record;
        }
        return rt;
    }

    async startService(name: string, sock?: Socket): Promise<ServiceRecord> {
        const rt = this.runtime(name);
        if (rt.proc && pidAlive(rt.proc.pid)) { progress(sock!, `${name} already running`); return rt.record; }
        const { service, record } = rt;
        const def = service.def;
        const port = record.port;

        if (await tcpOpen(port)) {
            record.state = 'down';
            record.health = `:${port} already in use by another process`;
            this.events.emit('service.skipped', { service: name, message: record.health });
            this.persist();
            return record;
        }

        this.render();
        rt.stopping = false;
        rt.watcher.reset();
        record.state = 'starting';
        record.startedAt = new Date().toISOString();
        record.exitCode = undefined; record.signal = undefined; record.health = undefined; record.errors = 0;
        this.events.emit('service.starting', { service: name, message: `:${port}` });
        this.persist();

        const vars = this.vars(name);
        const env = this.serviceEnv(name);
        const t = (s: string) => interpolate(s, vars, `services.${name}`);
        let command: string[];
        let cwd = join(this.catalog.root, def.dir ?? '.');
        if (def.type === 'gradle') {
            command = ['./gradlew', `${def.module}:${def.task ?? 'bootRun'}`, ...(def.args ?? []).map(t)];
            cwd = this.catalog.root;
        } else {
            if (def.type === 'npm') {
                const installDir = join(this.catalog.root, def.install ?? def.dir ?? '.');
                if (!existsSync(join(installDir, 'node_modules'))) {
                    this.events.emit('service.install', { service: name, message: `npm install in ${def.install ?? def.dir ?? '.'}` });
                    const code = await this.runToCompletion(['npm', 'install'], installDir, join(this.paths.logs, `${name}-install.log`));
                    if (code !== 0) return this.failed(rt, `npm install failed — see ${join(this.paths.logs, `${name}-install.log`)}`);
                }
            }
            for (const [i, prep] of (def.prep ?? []).entries()) {
                const prepLog = join(this.paths.logs, `${name}-prep.log`);
                if (i === 0) rmSync(prepLog, { force: true });
                const cmd = prep.command.map(t);
                progress(sock!, `${name}: ${cmd.join(' ')}`);
                const code = await this.runToCompletion(cmd, join(this.catalog.root, prep.dir ?? def.dir ?? '.'), prepLog, true, env);
                if (code !== 0) return this.failed(rt, `${cmd.join(' ')} failed — see ${prepLog}`);
            }
            command = (def.command ?? []).map(t);
            env.PORT = String(port);
        }
        record.command = command;
        record.cwd = cwd;

        const spawned = spawnLogged(command, { cwd, env, logFile: record.logFile });
        rt.proc = spawned;
        record.pid = spawned.pid;
        this.persist();
        spawned.child.on('exit', (code, signal) => this.onExit(rt, spawned, code, signal));

        const timeout = (def.health?.timeout ?? DEFAULT_START_TIMEOUT) * 1000;
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            rt.watcher.poll();
            // onExit may have flipped the state while we slept (read rt.record, not the narrowed local)
            if (rt.proc !== spawned || rt.record.state === 'crashed' || rt.record.state === 'stopped') return record;
            if (await tcpOpen(port)) {
                const probe = await this.probe(rt);
                const readyByLog = rt.readyLog ? rt.watcher.lastLines.some((l) => rt.readyLog!.test(l)) || rt.watcher.started : false;
                if (probe.ok || readyByLog) {
                    record.state = 'up';
                    record.health = probe.ok ? probe.reason : `ready (log) — probe: ${probe.reason}`;
                    record.errors = rt.watcher.errors;
                    rt.lastProbe = Date.now();
                    this.events.emit('service.up', { service: name, message: `:${port} ${record.health} after ${fmtDuration(Date.now() - Date.parse(record.startedAt!))}` });
                    this.persist();
                    await this.runHooks(name);
                    return record;
                }
            }
            await sleep(2000);
        }
        record.state = 'degraded';
        record.health = `did not become healthy within ${fmtDuration(timeout)}`;
        this.events.emit('service.degraded', { service: name, message: record.health });
        this.persist();
        return record;
    }

    private probe(rt: Runtime) {
        const h = rt.service.def.health;
        return h?.path ? httpProbe(rt.record.port, h.path, h.expect) : httpAlive(rt.record.port);
    }

    private failed(rt: Runtime, message: string): ServiceRecord {
        rt.record.state = 'crashed';
        rt.record.health = message;
        this.events.emit('service.failed', { service: rt.service.name, message });
        this.persist();
        return rt.record;
    }

    /** Global env + the service's env from lcl.yml (templated) + LCL_PORT_* for every service and container port. */
    private serviceEnv(name?: string): NodeJS.ProcessEnv {
        const vars = this.vars(name);
        const env: NodeJS.ProcessEnv = { LCL_STACK: this.state.id, LCL_STACK_DIR: this.paths.dir };
        for (const [n, port] of Object.entries(this.state.ports.services)) env[envName(n)] = String(port);
        for (const i of this.catalog.infra) env[i.envVar] = String(this.state.ports.infra[i.key]);
        const list = serviceList(this.catalog, this.state.ports);
        for (const [k, v] of Object.entries(this.catalog.config.env)) env[k] = renderTemplate(v, vars, list, `env.${k}`);
        if (name) {
            const def = this.catalog.services.find((s) => s.name === name)?.def;
            for (const [k, v] of Object.entries(def?.env ?? {})) env[k] = renderTemplate(v, vars, list, `services.${name}.env.${k}`);
        }
        return env;
    }

    private async runHooks(name: string): Promise<void> {
        const vars = this.vars(name);
        for (const hook of this.catalog.config.hooks.afterUp) {
            if (hook.service !== name) continue;
            if (!evaluateWhen(hook.when, vars)) { this.events.emit('hook.skipped', { service: name, message: hook.when }); continue; }
            const cmd = hook.shell ? ['sh', '-c', interpolate(hook.shell, vars, `hooks.after-up.${name}`)] : (hook.command ?? []).map((c) => interpolate(c, vars, `hooks.after-up.${name}`));
            const log = join(this.paths.logs, `${name}-hook.log`);
            const code = await this.runToCompletion(cmd, join(this.catalog.root, hook.dir ?? '.'), log, true, this.serviceEnv(name));
            const shown = (hook.shell ? cmd[2] : cmd.join(' ')).replace(/\s+/g, ' ').slice(0, 100);
            this.events.emit(code === 0 ? 'hook.done' : 'hook.failed', { service: name, message: `${shown}${code === 0 ? '' : ` → exit ${code}, see ${log}`}` });
        }
    }

    private onExit(rt: Runtime, spawned: Spawned, code: number | null, signal: NodeJS.Signals | null): void {
        if (rt.proc !== spawned) return; // a newer process replaced it
        rt.watcher.poll();
        rt.record.exitCode = code;
        rt.record.signal = signal;
        rt.record.pid = undefined;
        rt.record.errors = rt.watcher.errors;
        rt.proc = undefined;
        if (rt.stopping || this.phase === 'stopping') {
            rt.record.state = 'stopped';
            this.events.emit('service.stopped', { service: rt.service.name, message: `exit ${code ?? signal}` });
            this.persist();
            return;
        }
        rt.record.state = 'crashed';
        const lastError = rt.watcher.lastErrors.at(-1);
        rt.record.health = `exited with ${code ?? signal}${lastError ? `: ${lastError.slice(0, 160)}` : ''}`;
        this.events.emit('service.crashed', { service: rt.service.name, message: rt.record.health, detail: { code, signal, errors: rt.watcher.errors } });
        this.persist();
        if (this.options.failFast) {
            warn(`${rt.service.name} exited — bringing the rest down (--fail-fast)`);
            void this.shutdown({ volumes: false, exitCode: 1 });
            return;
        }
        if (this.options.restart > 0 && rt.restarts < this.options.restart) {
            rt.restarts++;
            const delay = Math.min(30_000, 2_000 * 2 ** (rt.restarts - 1));
            this.events.emit('service.restart-scheduled', { service: rt.service.name, message: `attempt ${rt.restarts}/${this.options.restart} in ${fmtDuration(delay)}` });
            setTimeout(() => { if (!rt.stopping && this.phase !== 'stopping') void this.startService(rt.service.name); }, delay);
        }
    }

    async stopService(name: string, sock?: Socket): Promise<ServiceRecord> {
        const rt = this.runtime(name);
        rt.stopping = true;
        if (rt.proc && pidAlive(rt.proc.pid)) {
            progress(sock!, `stopping ${name} (pid ${rt.proc.pid})`);
            this.events.emit('service.stopping', { service: name, message: `pid ${rt.proc.pid}` });
            await killTree(rt.proc.pid);
        }
        const swept = await freePort(rt.record.port);
        if (swept.length) this.events.emit('service.swept', { service: name, message: `killed listeners ${swept.join(',')} on :${rt.record.port}` });
        rt.proc = undefined;
        rt.record.pid = undefined;
        rt.record.state = 'stopped';
        this.persist();
        return rt.record;
    }

    async restartService(name: string, sock?: Socket): Promise<ServiceRecord> {
        await this.stopService(name, sock);
        const rt = this.runtime(name);
        rt.restarts = 0;
        this.events.emit('service.restarted', { service: name });
        return this.startService(name, sock);
    }

    // ---- monitoring ---------------------------------------------------------------------------------------------

    private async monitor(): Promise<void> {
        while (this.phase !== 'stopping') {
            let changed = false;
            for (const rt of this.runtimes.values()) {
                rt.watcher.poll();
                if (rt.record.errors !== rt.watcher.errors) { rt.record.errors = rt.watcher.errors; changed = true; }
                if (!rt.proc || (rt.record.state !== 'up' && rt.record.state !== 'degraded')) continue;
                if (Date.now() - rt.lastProbe < HEALTH_INTERVAL) continue;
                rt.lastProbe = Date.now();
                const probe = await this.probe(rt);
                const next = probe.ok ? 'up' : 'degraded';
                if (next !== rt.record.state) {
                    rt.record.state = next;
                    this.events.emit(`service.${next}`, { service: rt.service.name, message: probe.reason });
                    changed = true;
                }
                if (rt.record.health !== probe.reason) { rt.record.health = probe.reason; changed = true; }
            }
            if (changed) this.persist();
            await sleep(1000);
        }
    }

    // ---- shutdown -----------------------------------------------------------------------------------------------

    shutdown(opts: { volumes: boolean; exitCode: number }): Promise<void> {
        if (this.shuttingDown) return this.shuttingDown;
        this.phase = 'stopping';
        this.shuttingDown = (async () => {
            this.events.emit('instance.stopping', { detail: { volumes: opts.volumes } });
            say('shutting down');
            const names = [...this.runtimes.keys()].reverse();
            await Promise.all(names.map((n) => this.stopService(n).catch(() => undefined)));
            if (this.ownsInfra && !this.options.keepInfra) {
                say(opts.volumes ? 'stopping containers and deleting volumes' : 'stopping containers (volumes kept)');
                const res = await this.compose.down(opts.volumes);
                this.events.emit(res.code === 0 ? 'infra.down' : 'infra.down-failed', { message: res.code === 0 ? undefined : res.out.trim().split('\n').at(-1) });
                this.state.infraUp = false;
            }
            this.state.supervisorPid = undefined;
            this.persist();
            unregisterInstance(this.state.key);
            this.events.emit('instance.stopped');
            rmSync(this.paths.socket, { force: true });
            say(`all stopped. logs kept in ${this.paths.logs}`);
            process.exit(opts.exitCode);
        })();
        return this.shuttingDown;
    }

    // ---- control ------------------------------------------------------------------------------------------------

    private async handle(req: Request, sock: Socket): Promise<unknown> {
        const names = ((req.args?.services as string[] | undefined) ?? []);
        switch (req.cmd) {
            case 'ping': return 'pong';
            case 'status': return this.snapshot();
            case 'start': { const out: ServiceRecord[] = []; for (const n of names) out.push(await this.startService(n, sock)); this.events.emit('command.start', { message: names.join(' ') }); return out; }
            case 'stop': { const out: ServiceRecord[] = []; for (const n of names) out.push(await this.stopService(n, sock)); this.events.emit('command.stop', { message: names.join(' ') }); return out; }
            case 'restart': { const out: ServiceRecord[] = []; for (const n of names) out.push(await this.restartService(n, sock)); this.events.emit('command.restart', { message: names.join(' ') }); return out; }
            case 'why': return this.why(String(req.args?.service));
            case 'shutdown': { const volumes = Boolean(req.args?.volumes); setTimeout(() => void this.shutdown({ volumes, exitCode: 0 }), 50); return 'stopping'; }
            default: throw new Error(`unknown command ${req.cmd}`);
        }
    }

    snapshot() {
        return { phase: this.phase, state: this.state, infra: this.compose.running() };
    }

    why(name: string) {
        const rt = this.runtimes.get(name);
        if (!rt) throw new Error(`${name} was never started in this stack`);
        rt.watcher.poll();
        return { record: rt.record, restarts: rt.restarts, lastErrors: rt.watcher.lastErrors.slice(-30), lastLines: rt.watcher.lastLines, env: this.serviceEnv(name) };
    }

    private persist(): void {
        saveState(this.paths, this.state);
        if (this.phase !== 'stopping') registerInstance(this.state);
    }

    private runToCompletion(command: string[], cwd: string, logFile: string, append = false, env?: NodeJS.ProcessEnv): Promise<number> {
        return new Promise((resolve) => {
            const { child } = spawnLogged(command, { cwd, env: env ?? this.serviceEnv(), logFile, append });
            child.on('exit', (code) => resolve(code ?? 1));
        });
    }

    private printBanner(): void {
        const up = Object.values(this.state.services).filter((r) => r.state === 'up').length;
        const total = Object.keys(this.state.services).length;
        console.log('');
        say(`${up}/${total} service(s) up — stack ${this.state.id}, ports offset +${this.state.ports.offset}`);
        for (const [label, url] of urlsFor(this.catalog, this.vars())) console.log(`    ${label.padEnd(16)} ${url}`);
        console.log(`    ${'logs'.padEnd(16)} ${this.paths.logs}`);
        const flag = this.state.id === 'default' ? '' : ` --stack ${this.state.id}`;
        console.log(`    ${dim(`lcl status${flag} · lcl logs -f${flag} · lcl why <service>${flag} · lcl stop${flag}`)}`);
        console.log('');
        if (up < total) console.log(yellow('    some services are not up — run `lcl status` and `lcl why <service>`'));
    }
}

async function waitUntil(fn: () => Promise<boolean>, timeoutMs: number, everyMs = 1000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await fn()) return true; await sleep(everyMs); }
    return fn();
}
