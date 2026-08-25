// What every command needs: the checkout root, the catalog, the stack's paths and its recorded state.

import { loadCatalog, resolveServiceName, type Catalog } from '../catalog.js';
import { request, supervisorReachable } from '../control.js';
import { findRoot, loadState, paths, pidAlive, registryKey, stackName, type Paths, type State } from '../instance.js';
import { die } from '../ui.js';

export type Context = { root: string; configFile: string; id: string; key: string; catalog: Catalog; paths: Paths; state: State | null };

export function context(opts: { stack?: string; root?: string; config?: string }): Context {
    const { root, configFile } = findRoot(opts.root ?? process.cwd(), opts.config);
    const id = stackName(opts.stack);
    const p = paths(root, id);
    return { root, configFile, id, key: registryKey(root, id), catalog: loadCatalog(configFile), paths: p, state: loadState(p) };
}

export async function liveSupervisor(ctx: Context): Promise<boolean> {
    if (!ctx.state?.supervisorPid || !pidAlive(ctx.state.supervisorPid)) return false;
    return supervisorReachable(ctx.paths.socket);
}

export function resolveServices(ctx: Context, names: string[]): string[] {
    return [...new Set(names.map((n) => resolveServiceName(ctx.catalog, n)))];
}

export async function control(ctx: Context, cmd: string, args?: Record<string, unknown>, onProgress?: (m: unknown) => void): Promise<unknown> {
    if (!(await liveSupervisor(ctx))) die(`stack ${ctx.id} is not running — start it with \`lcl start${ctx.id === 'default' ? '' : ` --stack ${ctx.id}`}\``);
    return request(ctx.paths.socket, { cmd, args }, onProgress);
}
