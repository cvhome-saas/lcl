// The catalog: lcl.yml resolved into launchable services (in dependency order), container-served services, and every
// published port of every compose service (read from the compose file itself).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effective, loadConfig, type Config, type ServiceDef } from './config.ts';
import { getPath, parseYaml, type YamlValue } from './yaml.ts';
import { die } from './ui.ts';

export type Service = { name: string; port?: number; def: ServiceDef };

/** One published port of one compose service. `key` identifies it in PortMap.infra. */
export type Infra = { key: string; compose: string; image: string; containerPort: number; port: number; envVar: string; label: string };

export type Catalog = {
    root: string;
    config: Config;
    services: Service[];                // launchable, in dependency order (`after`), then file order
    levels: string[][];                 // batches that may start concurrently
    containers: Record<string, { compose: string; port: number; containerPort: number }>;
    configuredPorts: Record<string, number>;
    infra: Infra[];
    composeServices: string[];
    unknown: string[];                  // configured but unusable (missing module/command/compose)
};

export function loadCatalog(configFile: string): Catalog {
    const config = loadConfig(configFile);
    const root = config.root;
    const { infra, composeServices } = config.compose ? readCompose(root, config.compose.file) : { infra: [] as Infra[], composeServices: [] as string[] };

    const services: Service[] = [];
    const containers: Catalog['containers'] = {};
    const configuredPorts: Record<string, number> = {};
    const unknown: string[] = [];
    for (const name of Object.keys(config.services)) {
        const def = effective(config, name);
        const port = def.port;
        if (port !== undefined && !Number.isInteger(port)) die(`lcl.yml: services.${name}.port must be a number`);
        if (port !== undefined) configuredPorts[name] = port;
        if (def.type === 'container') {
            const compose = def.compose ?? name;
            if (!config.compose) { unknown.push(`${name} (container service but no compose section)`); continue; }
            if (!composeServices.includes(compose)) { unknown.push(`${name} (compose service ${compose} not in ${config.compose.file})`); continue; }
            if (port === undefined) { unknown.push(`${name} (container service needs the published port)`); continue; }
            containers[name] = { compose, port, containerPort: def.containerPort ?? port };
            continue;
        }
        if ((def.type === 'gradle' || def.type === 'maven') && !def.module) { unknown.push(`${name} (${def.type} without module)`); continue; }
        if ((def.type === 'npm' || def.type === 'exec') && !def.command) { unknown.push(`${name} (${def.type} without command)`); continue; }
        if (port === undefined && (def.health?.type === 'http' || def.health?.type === 'tcp' || def.health?.path)) { unknown.push(`${name} (http/tcp health needs a port)`); continue; }
        services.push({ name, port, def });
    }
    for (const s of services) for (const dep of s.def.after ?? []) {
        if (!services.some((x) => x.name === dep) && !containers[dep]) die(`lcl.yml: services.${s.name}.after references unknown service ${dep}`);
    }
    const levels = topo(services);
    const order = levels.flat();
    services.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

    return { root, config, services, levels, containers, configuredPorts, infra, composeServices, unknown };
}

/** Dependency levels: a service starts after everything in its `after` list is up; ties keep file order. */
function topo(services: Service[]): string[][] {
    const remaining = new Map(services.map((s) => [s.name, new Set((s.def.after ?? []).filter((d) => services.some((x) => x.name === d)))]));
    const levels: string[][] = [];
    while (remaining.size) {
        const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([n]) => n);
        if (ready.length === 0) die(`lcl.yml: circular \`after\` between ${[...remaining.keys()].join(', ')}`);
        levels.push(ready);
        for (const n of ready) remaining.delete(n);
        for (const deps of remaining.values()) for (const n of ready) deps.delete(n);
    }
    return levels;
}

function readCompose(root: string, file: string): { infra: Infra[]; composeServices: string[]; images: Record<string, string> } {
    if (!existsSync(join(root, file))) die(`compose file not found: ${file} (drop the compose section if the project has no containers)`);
    const doc = parseYaml(readFileSync(join(root, file), 'utf8'));
    const services = getPath(doc, 'services');
    if (!services || typeof services !== 'object' || Array.isArray(services)) die(`${file}: no services`);
    const infra: Infra[] = [];
    const images: Record<string, string> = {};
    const composeServices = Object.keys(services);
    for (const [name, svc] of Object.entries(services as Record<string, YamlValue>)) {
        images[name] = String(getPath(svc, 'image') ?? '');
        const ports = getPath(svc, 'ports');
        if (!Array.isArray(ports)) continue;
        for (const entry of ports) {
            const text = typeof entry === 'string' || typeof entry === 'number' ? String(entry) : String(getPath(entry, 'published') ?? '') + ':' + String(getPath(entry, 'target') ?? '');
            // "8080:80", "${SOME_VAR:-80}:80", "127.0.0.1:8080:80", "8080:80/tcp"
            const m = /^(?:[\d.]+:)?(\$\{([A-Z0-9_]+)(?::-(\d+))?\}|(\d+)):(\d+)(?:\/\w+)?$/.exec(text.trim());
            if (!m) continue;
            const containerPort = Number(m[5]);
            const port = Number(m[3] ?? m[4]);
            const envVar = m[2] ?? `LCL_PORT_${name.toUpperCase().replace(/-/g, '_')}_${containerPort}`;
            infra.push({ key: `${name}:${containerPort}`, compose: name, image: images[name], containerPort, port, envVar, label: `${name}:${containerPort}` });
        }
    }
    return { infra, composeServices, images };
}

export function resolveServiceName(catalog: Catalog, name: string): string {
    if (catalog.services.some((s) => s.name === name)) return name;
    die(`unknown service: ${name} (known: ${catalog.services.map((s) => s.name).join(', ')})`);
}
