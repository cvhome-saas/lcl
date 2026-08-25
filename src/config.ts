import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { die } from './ui.js';

export const CONFIG_FILE = 'lcl.yml';
export const CONFIG_VERSION = 1;

export type HealthType = 'http' | 'tcp' | 'log' | 'process';

export type Health = {
    type?: HealthType;
    port?: string;
    path?: string;
    expect?: string;
    readyLog?: string;
    timeout?: number;
};

export type CommandDef = {
    command?: string[];
    shell?: string;
    cwd?: string;
};

export type ServiceDef = {
    description?: string;
    cwd?: string;
    command?: string[];
    shell?: string;
    prepare: CommandDef[];
    dependsOn: string[];
    ports: Record<string, number>;
    environment: Record<string, string>;
    health?: Health;
};

export type Hook = CommandDef & { service?: string; when?: string };

export type Config = {
    version: 1;
    file: string;
    root: string;
    name: string;
    ports: { step: number; skipConfigured: boolean };
    build?: string[];
    compose?: { files: string[]; default: string[]; environment: Record<string, string> };
    hosts: string[];
    environment: Record<string, string>;
    defaults: { environment: Record<string, string>; prepare: CommandDef[]; health?: Health };
    files: Array<{ path: string; template: string }>;
    hooks: { beforeStart: Hook[]; afterUp: Hook[]; afterStop: Hook[] };
    services: Record<string, ServiceDef>;
    urls: Array<{ label: string; url: string }>;
};

type Raw = Record<string, unknown>;

const sourceSchema = new URL('../schema/lcl.schema.json', import.meta.url);
const packageSchema = new URL('../../schema/lcl.schema.json', import.meta.url);
const schema = JSON.parse(readFileSync(existsSync(sourceSchema) ? sourceSchema : packageSchema, 'utf8')) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
const validateSchema = ajv.compile(schema);

export function findConfig(from = process.cwd(), explicit?: string): string {
    if (explicit) {
        const path = resolve(explicit);
        if (!existsSync(path)) die(`config not found: ${path}`);
        return path;
    }
    let directory = resolve(from);
    while (true) {
        const candidate = resolve(directory, CONFIG_FILE);
        if (existsSync(candidate)) return candidate;
        const parent = dirname(directory);
        if (parent === directory) die(`no ${CONFIG_FILE} found in ${from} or any parent — run lcl inside a configured project or pass --config`);
        directory = parent;
    }
}

export function loadConfig(file: string): Config {
    let raw: unknown;
    try {
        raw = parse(readFileSync(file, 'utf8'), { merge: true, uniqueKeys: true });
    } catch (error) {
        die(`${file}: invalid YAML: ${(error as Error).message}`);
    }
    if (!validateSchema(raw)) die(formatValidationErrors(file, validateSchema.errors ?? []));

    const top = raw as Raw;
    const defaultsRaw = asObject(top.defaults);
    const defaults = {
        environment: stringMap(defaultsRaw.environment),
        prepare: commandList(defaultsRaw.prepare),
        health: health(defaultsRaw.health),
    };
    const services: Record<string, ServiceDef> = {};
    for (const [name, value] of Object.entries(asObject(top.services))) {
        const service = asObject(value);
        const serviceHealth = health(service.health);
        services[name] = {
            description: optionalString(service.description),
            cwd: optionalString(service.cwd),
            command: stringList(service.command),
            shell: optionalString(service.shell),
            prepare: service.prepare === undefined ? defaults.prepare : commandList(service.prepare),
            dependsOn: stringList(service['depends-on']) ?? [],
            ports: numberMap(service.ports),
            environment: { ...defaults.environment, ...stringMap(service.environment) },
            health: serviceHealth || defaults.health ? { ...(defaults.health ?? {}), ...(serviceHealth ?? {}) } : undefined,
        };
    }

    const composeRaw = top.compose === undefined ? undefined : asObject(top.compose);
    const hooksRaw = asObject(top.hooks);
    const config: Config = {
        version: CONFIG_VERSION,
        file: resolve(file),
        root: dirname(resolve(file)),
        name: String(top.name),
        ports: {
            step: Number(asObject(top.ports).step ?? 1000),
            skipConfigured: asObject(top.ports)['skip-configured'] === true,
        },
        build: stringList(top.build),
        compose: composeRaw ? {
            files: stringList(composeRaw.files) ?? [],
            default: stringList(composeRaw.default) ?? [],
            environment: stringMap(composeRaw.environment),
        } : undefined,
        hosts: stringList(top.hosts) ?? [],
        environment: stringMap(top.environment),
        defaults,
        files: array(top.files).map((value) => {
            const entry = asObject(value);
            return { path: String(entry.path), template: String(entry.template) };
        }),
        hooks: {
            beforeStart: hookList(hooksRaw['before-start']),
            afterUp: hookList(hooksRaw['after-up']),
            afterStop: hookList(hooksRaw['after-stop']),
        },
        services,
        urls: array(top.urls).map((value) => {
            const entry = asObject(value);
            return { label: String(entry.label), url: String(entry.url) };
        }),
    };
    validateSemantics(config);
    return config;
}

function validateSemantics(config: Config): void {
    const serviceNames = new Set(Object.keys(config.services));
    const usedPorts = new Map<number, string>();
    for (const [name, service] of Object.entries(config.services)) {
        for (const [portName, port] of Object.entries(service.ports)) {
            const previous = usedPorts.get(port);
            if (previous) die(`${CONFIG_FILE}: services.${name}.ports.${portName} duplicates configured port ${port} from ${previous}`);
            usedPorts.set(port, `${name}.${portName}`);
        }
        if (service.health?.type === 'http' || service.health?.type === 'tcp') {
            const portName = service.health.port ?? primaryPortName(service);
            if (!portName) die(`${CONFIG_FILE}: services.${name}.health needs a named port`);
            if (!(portName in service.ports)) die(`${CONFIG_FILE}: services.${name}.health.port references unknown port ${portName}`);
            service.health.port = portName;
        }
        if (service.health?.type === 'log' && !service.health.readyLog) die(`${CONFIG_FILE}: services.${name}.health type log needs ready-log`);
        if (service.health?.readyLog) {
            try { new RegExp(service.health.readyLog); } catch (error) { die(`${CONFIG_FILE}: services.${name}.health.ready-log is invalid: ${(error as Error).message}`); }
        }
        for (const dependency of service.dependsOn) {
            if (serviceNames.has(dependency)) continue;
            if (config.compose) continue;
            die(`${CONFIG_FILE}: services.${name}.depends-on references unknown service ${dependency}`);
        }
    }
    for (const hook of config.hooks.afterUp) {
        if (!hook.service || !serviceNames.has(hook.service)) die(`${CONFIG_FILE}: hooks.after-up service must name a source service`);
    }
}

export function primaryPortName(service: ServiceDef): string | undefined {
    if ('http' in service.ports) return 'http';
    return Object.keys(service.ports)[0];
}

export function primaryPort(service: ServiceDef): number | undefined {
    const name = primaryPortName(service);
    return name ? service.ports[name] : undefined;
}

export type Vars = Record<string, string>;

export function interpolate(text: string, vars: Vars, where = 'value'): string {
    return text.replace(/\$\{([^}]+)\}/g, (whole, key: string) => {
        if (key in vars) return vars[key];
        if (key.startsWith('env.')) return process.env[key.slice(4)] ?? '';
        die(`${where}: unknown variable ${whole}`);
    });
}

export function renderTemplate(text: string, vars: Vars, services: Array<{ name: string; port: number }>, where: string): string {
    const expanded = text.replace(/\{\{#each services\}\}([\s\S]*?)\{\{\/each\}\}/g, (_, body: string) =>
        services.map((service, index) => body
            .replace(/\{\{(name|port|index|last)\}\}/g, (__, key: string) => key === 'name' ? service.name : key === 'port' ? String(service.port) : key === 'index' ? String(index) : String(index === services.length - 1))
            .replace(/\{\{#unless last\}\}([\s\S]*?)\{\{\/unless\}\}/g, (__, inner: string) => index === services.length - 1 ? '' : inner)).join(''));
    return interpolate(expanded, vars, where);
}

export function evaluateWhen(expression: string | undefined, vars: Vars): boolean {
    if (!expression) return true;
    const text = interpolate(expression, vars, 'when');
    const match = /^\s*(.*?)\s*(==|!=)\s*(.*?)\s*$/.exec(text);
    if (!match) die(`when: cannot evaluate "${expression}"; use <a> == <b> or <a> != <b>`);
    const equal = match[1] === match[3];
    return match[2] === '==' ? equal : !equal;
}

function formatValidationErrors(file: string, errors: ErrorObject[]): string {
    if (errors.some((error) => error.instancePath === '/version' || error.params.missingProperty === 'version')) {
        return `${file}: unsupported legacy configuration; schema v1 requires \`version: 1\` and generic command services`;
    }
    const details = errors.slice(0, 12).map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('\n  - ');
    return `${file}: configuration does not match schema v1:\n  - ${details}`;
}

function asObject(value: unknown): Raw {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {};
}

function array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function optionalString(value: unknown): string | undefined {
    return value === undefined ? undefined : String(value);
}

function stringList(value: unknown): string[] | undefined {
    return value === undefined ? undefined : array(value).map(String);
}

function stringMap(value: unknown): Record<string, string> {
    return Object.fromEntries(Object.entries(asObject(value)).map(([key, entry]) => [key, String(entry)]));
}

function numberMap(value: unknown): Record<string, number> {
    return Object.fromEntries(Object.entries(asObject(value)).map(([key, entry]) => [key, Number(entry)]));
}

function command(value: unknown): CommandDef {
    if (Array.isArray(value)) return { command: value.map(String) };
    const raw = asObject(value);
    return { command: stringList(raw.command), shell: optionalString(raw.shell), cwd: optionalString(raw.cwd) };
}

function commandList(value: unknown): CommandDef[] {
    return array(value).map(command);
}

function health(value: unknown): Health | undefined {
    if (value === undefined) return undefined;
    const raw = asObject(value);
    return {
        type: optionalString(raw.type) as HealthType | undefined,
        port: optionalString(raw.port),
        path: optionalString(raw.path),
        expect: optionalString(raw.expect),
        readyLog: optionalString(raw['ready-log']),
        timeout: raw.timeout === undefined ? undefined : Number(raw.timeout),
    };
}

function hookList(value: unknown): Hook[] {
    return array(value).map((entry) => {
        const raw = asObject(entry);
        return { ...command(raw), service: optionalString(raw.service), when: optionalString(raw.when) };
    });
}
