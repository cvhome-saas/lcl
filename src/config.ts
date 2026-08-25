// lcl.yml — the project's stack definition. The tool itself knows nothing about a particular project: every
// service, port, command, environment variable, generated file, hook and URL comes from this file.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseYaml, type YamlValue } from './yaml.ts';
import { die } from './ui.ts';

export const CONFIG_FILE = 'lcl.yml';

export type ServiceType = 'gradle' | 'maven' | 'npm' | 'exec' | 'container';
export const SERVICE_TYPES: ServiceType[] = ['gradle', 'maven', 'npm', 'exec', 'container'];
export type HealthType = 'http' | 'tcp' | 'log' | 'none';

export type Health = {
    type?: HealthType;    // http (path on the port) | tcp (port accepts connections) | log (ready-log seen) | none (process alive)
    path?: string;        // HTTP path probed on the service port (implies type http)
    expect?: string;      // substring the body must contain (e.g. "\"status\":\"UP\"")
    readyLog?: string;    // regex on the log that also counts as "up" (when the HTTP probe is secured/slow)
    timeout?: number;     // seconds to wait for the first healthy probe
};

export type ServiceDef = {
    type: ServiceType;
    port?: number;
    description?: string;
    after?: string[];
    env?: Record<string, string>;
    health?: Health;
    // gradle / maven
    module?: string;
    task?: string;
    args?: string[];
    wrapper?: string;     // ./gradlew | ./mvnw | gradle | mvn
    // any process type
    dir?: string;
    install?: string;     // npm: directory owning node_modules (npm install runs when missing)
    command?: string[];
    prep?: Array<{ dir?: string; command: string[] }>;
    // container
    compose?: string;
    containerPort?: number;
};

export type Hook = { service?: string; when?: string; shell?: string; command?: string[]; dir?: string };

export type Config = {
    file: string;
    root: string;
    name: string;
    ports: { step: number; skipConfigured: boolean };   // skipConfigured: never use the declared ports, start at +step
    build?: string[];          // run by `lcl start --build` before anything starts
    compose?: { file: string; default: string[]; env: Record<string, string> };   // absent: no containers, no Docker needed
    hosts: string[];             // hostnames expected in /etc/hosts (doctor)
    env: Record<string, string>;
    defaults: Partial<Record<ServiceType, Partial<ServiceDef>>>;
    files: Array<{ path: string; template: string }>;
    hooks: { beforeStart: Hook[]; afterUp: Hook[]; afterStop: Hook[] };
    services: Record<string, ServiceDef>;
    urls: Array<{ label: string; url: string }>;
};

export function findConfig(from = process.cwd(), explicit?: string): string {
    if (explicit) {
        const p = resolve(explicit);
        if (!existsSync(p)) die(`config not found: ${p}`);
        return p;
    }
    let dir = resolve(from);
    while (true) {
        const candidate = join(dir, CONFIG_FILE);
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) die(`no ${CONFIG_FILE} found in ${from} or any parent — run lcl inside a project that has one (or pass --config)`);
        dir = parent;
    }
}

export function loadConfig(file: string): Config {
    const doc = parseYaml(readFileSync(file, 'utf8'));
    const root = dirname(file);
    const obj = (v: YamlValue, what: string): Record<string, YamlValue> => {
        if (v === null || v === undefined) return {};
        if (typeof v !== 'object' || Array.isArray(v)) die(`${CONFIG_FILE}: ${what} must be a mapping`);
        return v as Record<string, YamlValue>;
    };
    const strList = (v: YamlValue, what: string): string[] => {
        if (v === null || v === undefined) return [];
        if (!Array.isArray(v)) die(`${CONFIG_FILE}: ${what} must be a list`);
        return v.map(String);
    };
    const strMap = (v: YamlValue, what: string): Record<string, string> => Object.fromEntries(Object.entries(obj(v, what)).map(([k, x]) => [k, String(x)]));

    const top = obj(doc, 'document');
    const portsCfg = obj(top.ports, 'ports');
    const composeCfg = top.compose === undefined || top.compose === null ? null : obj(top.compose, 'compose');

    const services: Record<string, ServiceDef> = {};
    for (const [name, raw] of Object.entries(obj(top.services, 'services'))) {
        const s = obj(raw, `services.${name}`);
        const type = String(s.type ?? '') as ServiceType;
        if (!SERVICE_TYPES.includes(type)) die(`${CONFIG_FILE}: services.${name}.type must be ${SERVICE_TYPES.join(' | ')}`);
        const healthRaw = s.health ? obj(s.health, `services.${name}.health`) : undefined;
        services[name] = {
            type,
            port: s.port === undefined || s.port === null ? undefined : Number(s.port),
            description: s.description === undefined ? undefined : String(s.description),
            after: strList(s.after, `services.${name}.after`),
            env: strMap(s.env, `services.${name}.env`),
            health: healthRaw ? {
                type: healthRaw.type === undefined ? undefined : String(healthRaw.type) as HealthType,
                path: healthRaw.path === undefined ? undefined : String(healthRaw.path),
                expect: healthRaw.expect === undefined ? undefined : String(healthRaw.expect),
                readyLog: healthRaw['ready-log'] === undefined ? undefined : String(healthRaw['ready-log']),
                timeout: healthRaw.timeout === undefined ? undefined : Number(healthRaw.timeout),
            } : undefined,
            module: s.module === undefined ? undefined : String(s.module),
            task: s.task === undefined ? undefined : String(s.task),
            wrapper: s.wrapper === undefined ? undefined : String(s.wrapper),
            args: s.args === undefined ? undefined : strList(s.args, `services.${name}.args`),
            dir: s.dir === undefined ? undefined : String(s.dir),
            install: s.install === undefined ? undefined : String(s.install),
            command: s.command === undefined ? undefined : strList(s.command, `services.${name}.command`),
            prep: s.prep === undefined ? undefined : (Array.isArray(s.prep) ? s.prep : []).map((p, i) => {
                const pp = obj(p, `services.${name}.prep[${i}]`);
                return { dir: pp.dir === undefined ? undefined : String(pp.dir), command: strList(pp.command, `services.${name}.prep[${i}].command`) };
            }),
            compose: s.compose === undefined ? undefined : String(s.compose),
            containerPort: s['container-port'] === undefined ? undefined : Number(s['container-port']),
        };
    }

    const defaults: Config['defaults'] = {};
    for (const [type, raw] of Object.entries(obj(top.defaults, 'defaults'))) {
        const d = obj(raw, `defaults.${type}`);
        const h = d.health ? obj(d.health, `defaults.${type}.health`) : undefined;
        defaults[type as ServiceType] = {
            args: d.args === undefined ? undefined : strList(d.args, `defaults.${type}.args`),
            task: d.task === undefined ? undefined : String(d.task),
            wrapper: d.wrapper === undefined ? undefined : String(d.wrapper),
            env: strMap(d.env, `defaults.${type}.env`),
            health: h ? { type: h.type === undefined ? undefined : String(h.type) as HealthType, path: h.path === undefined ? undefined : String(h.path), expect: h.expect === undefined ? undefined : String(h.expect), readyLog: h['ready-log'] === undefined ? undefined : String(h['ready-log']), timeout: h.timeout === undefined ? undefined : Number(h.timeout) } : undefined,
        };
    }

    const hooksCfg = obj(top.hooks, 'hooks');
    const hookList = (key: string, needsService: boolean): Hook[] => (Array.isArray(hooksCfg[key]) ? hooksCfg[key] as YamlValue[] : []).map((h, i) => {
        const hh = obj(h, `hooks.${key}[${i}]`);
        if (needsService && !hh.service) die(`${CONFIG_FILE}: hooks.${key}[${i}].service is required`);
        if (!hh.shell && !hh.command) die(`${CONFIG_FILE}: hooks.${key}[${i}] needs shell or command`);
        return { service: hh.service === undefined ? undefined : String(hh.service), when: hh.when === undefined ? undefined : String(hh.when), shell: hh.shell === undefined ? undefined : String(hh.shell), command: hh.command === undefined ? undefined : strList(hh.command, 'hook command'), dir: hh.dir === undefined ? undefined : String(hh.dir) };
    });

    return {
        file, root,
        name: String(top.name ?? 'stack'),
        ports: { step: Number(portsCfg.step ?? 1000), skipConfigured: portsCfg['skip-configured'] === true },
        build: top.build === undefined ? undefined : strList(top.build, 'build'),
        compose: composeCfg ? {
            file: String(composeCfg.file ?? 'docker-compose.yml'),
            default: strList(composeCfg.default, 'compose.default'),
            env: strMap(composeCfg.env, 'compose.env'),
        } : undefined,
        hosts: strList(top.hosts, 'hosts'),
        env: strMap(top.env, 'env'),
        defaults,
        files: (Array.isArray(top.files) ? top.files : []).map((f, i) => { const ff = obj(f, `files[${i}]`); return { path: String(ff.path), template: String(ff.template) }; }),
        hooks: { beforeStart: hookList('before-start', false), afterUp: hookList('after-up', true), afterStop: hookList('after-stop', false) },
        services,
        urls: (Array.isArray(top.urls) ? top.urls : []).map((u, i) => { const uu = obj(u, `urls[${i}]`); return { label: String(uu.label), url: String(uu.url) }; }),
    };
}

/** Effective definition: type defaults overlaid by the service's own fields. */
export function effective(config: Config, name: string): ServiceDef {
    const def = config.services[name];
    const d = config.defaults[def.type] ?? {};
    return {
        ...d, ...def,
        env: { ...(d.env ?? {}), ...(def.env ?? {}) },
        health: def.health || d.health ? { ...(d.health ?? {}), ...(def.health ?? {}) } : undefined,
        args: def.args ?? d.args,
        task: def.task ?? d.task,
        wrapper: def.wrapper ?? d.wrapper,
    };
}

// ---- templating -----------------------------------------------------------------------------------------------------
//   ${stack} ${stack.dir} ${root} ${project} ${offset} ${service} ${port} ${port.<service>} ${port.<compose>:<containerPort>}
//   ${env.NAME}   and, in template files, {{#each services}} … {{name}} {{port}} … {{/each}}

export type Vars = Record<string, string>;

export function interpolate(text: string, vars: Vars, where = 'template'): string {
    return text.replace(/\$\{([^}]+)\}/g, (whole, key: string) => {
        if (key in vars) return vars[key];
        if (key.startsWith('env.')) return process.env[key.slice(4)] ?? '';
        die(`${where}: unknown variable ${whole} (known: ${Object.keys(vars).filter((k) => !k.startsWith('port.')).join(', ')}, port.<service>, port.<compose>:<port>)`);
    });
}

export function renderTemplate(text: string, vars: Vars, services: Array<{ name: string; port: number }>, where: string): string {
    const expanded = text.replace(/\{\{#each services\}\}([\s\S]*?)\{\{\/each\}\}/g, (_, body: string) =>
        services.map((s, i) => body.replace(/\{\{(name|port|index|last)\}\}/g, (__, k: string) => k === 'name' ? s.name : k === 'port' ? String(s.port) : k === 'index' ? String(i) : String(i === services.length - 1))
            .replace(/\{\{#unless last\}\}([\s\S]*?)\{\{\/unless\}\}/g, (___, inner: string) => (i === services.length - 1 ? '' : inner))).join(''));
    return interpolate(expanded, vars, where);
}

/** `when:` expressions: two interpolated operands compared with == or != (e.g. "${offset} != 0"). Empty = true. */
export function evaluateWhen(expr: string | undefined, vars: Vars): boolean {
    if (!expr) return true;
    const text = interpolate(expr, vars, 'when');
    const m = /^\s*(.*?)\s*(==|!=)\s*(.*?)\s*$/.exec(text);
    if (!m) die(`when: cannot evaluate "${expr}" (use <a> == <b> or <a> != <b>)`);
    const eq = m[1] === m[3];
    return m[2] === '==' ? eq : !eq;
}
