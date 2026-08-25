import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, primaryPort, type Config, type ServiceDef } from './config.js';
import { die } from './ui.js';

export type Service = { name: string; port?: number; ports: Record<string, number>; def: ServiceDef };

export type Infra = {
    key: string;
    compose: string;
    image: string;
    containerPort: number;
    port: number;
    envVar: string;
    label: string;
};

export type Catalog = {
    root: string;
    config: Config;
    services: Service[];
    levels: string[][];
    containers: Record<string, never>;
    configuredPorts: Record<string, number>;
    infra: Infra[];
    composeServices: string[];
    unknown: string[];
};

export function loadCatalog(configFile: string): Catalog {
    const config = loadConfig(configFile);
    const compose = config.compose ? readCompose(config) : { infra: [], composeServices: [] };
    const composeNames = new Set(compose.composeServices);
    const services = Object.entries(config.services).map(([name, def]) => ({ name, def, ports: def.ports, port: primaryPort(def) }));
    const serviceNames = new Set(services.map((service) => service.name));
    for (const name of composeNames) {
        if (serviceNames.has(name)) die(`lcl.yml: ${name} is declared as both a source service and a Compose service`);
    }
    const configuredPorts: Record<string, number> = {};
    for (const service of services) {
        for (const [name, port] of Object.entries(service.ports)) configuredPorts[`${service.name}.${name}`] = port;
        for (const dependency of service.def.dependsOn) {
            if (!serviceNames.has(dependency) && !composeNames.has(dependency)) {
                die(`lcl.yml: services.${service.name}.depends-on references unknown service ${dependency}`);
            }
        }
    }
    for (const name of config.compose?.default ?? []) {
        if (!composeNames.has(name)) die(`lcl.yml: compose.default references unknown compose service ${name}`);
    }
    const usedPorts = new Map<number, string>(Object.entries(configuredPorts).map(([key, port]) => [port, key]));
    for (const item of compose.infra) {
        const previous = usedPorts.get(item.port);
        if (previous) die(`lcl.yml: Compose port ${item.label} duplicates configured host port ${item.port} from ${previous}`);
        usedPorts.set(item.port, item.label);
    }
    const levels = topologicalLevels(services);
    const order = levels.flat();
    services.sort((left, right) => order.indexOf(left.name) - order.indexOf(right.name));
    return {
        root: config.root,
        config,
        services,
        levels,
        containers: {},
        configuredPorts,
        infra: compose.infra,
        composeServices: compose.composeServices,
        unknown: [],
    };
}

export function dependencyClosure(catalog: Catalog, requested: string[]): { source: string[]; compose: string[] } {
    const source = new Set<string>();
    const compose = new Set<string>();
    const byName = new Map(catalog.services.map((service) => [service.name, service]));
    const visit = (name: string): void => {
        if (source.has(name)) return;
        const service = byName.get(name);
        if (!service) {
            if (catalog.composeServices.includes(name)) { compose.add(name); return; }
            die(`unknown service: ${name}`);
        }
        source.add(name);
        for (const dependency of service.def.dependsOn) visit(dependency);
    };
    for (const name of requested.length ? requested : catalog.services.map((service) => service.name)) visit(name);
    return {
        source: catalog.services.filter((service) => source.has(service.name)).map((service) => service.name),
        compose: catalog.composeServices.filter((service) => compose.has(service)),
    };
}

export function resolveServiceName(catalog: Catalog, name: string): string {
    if (catalog.services.some((service) => service.name === name)) return name;
    die(`unknown source service: ${name} (known: ${catalog.services.map((service) => service.name).join(', ')})`);
}

function topologicalLevels(services: Service[]): string[][] {
    const names = new Set(services.map((service) => service.name));
    const remaining = new Map(services.map((service) => [service.name, new Set(service.def.dependsOn.filter((dependency) => names.has(dependency)))]));
    const levels: string[][] = [];
    while (remaining.size) {
        const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0).map(([name]) => name);
        if (ready.length === 0) die(`lcl.yml: circular depends-on relationship between ${[...remaining.keys()].join(', ')}`);
        levels.push(ready);
        for (const name of ready) remaining.delete(name);
        for (const dependencies of remaining.values()) for (const name of ready) dependencies.delete(name);
    }
    return levels;
}

function readCompose(config: Config): { infra: Infra[]; composeServices: string[] } {
    const files = config.compose!.files;
    for (const file of files) if (!existsSync(resolve(config.root, file))) die(`compose file not found: ${file}`);
    let document: { services?: Record<string, { image?: string; ports?: Array<{ target?: number; published?: string | number }> }> };
    try {
        const args = ['compose', ...files.flatMap((file) => ['-f', file]), 'config', '--format', 'json'];
        const discoveryEnvironment = Object.fromEntries(Object.entries(config.compose!.environment).filter(([, value]) => !value.includes('${')));
        document = JSON.parse(execFileSync('docker', args, {
            cwd: config.root,
            env: { ...process.env, ...discoveryEnvironment },
            stdio: ['ignore', 'pipe', 'pipe'],
        }).toString()) as typeof document;
    } catch (error) {
        const detail = (error as { stderr?: Buffer }).stderr?.toString().trim() || (error as Error).message;
        die(`cannot resolve Docker Compose configuration: ${detail}`);
    }
    const services = document.services ?? {};
    const infra: Infra[] = [];
    for (const [name, service] of Object.entries(services)) {
        for (const mapping of service.ports ?? []) {
            const target = Number(mapping.target);
            const published = Number(mapping.published);
            if (!Number.isInteger(target) || !Number.isInteger(published)) continue;
            infra.push({
                key: `${name}.${target}`,
                compose: name,
                image: service.image ?? '',
                containerPort: target,
                port: published,
                envVar: `LCL_PORT_${name.toUpperCase().replace(/-/g, '_')}_${target}`,
                label: `${name}.${target}`,
            });
        }
    }
    return { infra, composeServices: Object.keys(services) };
}
