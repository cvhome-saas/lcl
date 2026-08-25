// docker compose driver. Every call carries the stack's project name and env file, so stacks never touch each
// other's containers, and `docker compose ls` shows one project per stack.

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';

export class Compose {
    readonly root: string; readonly project: string; readonly envFile: string; readonly overrideFile: string; readonly logFile: string; readonly file: string;
    constructor(root: string, project: string, envFile: string, overrideFile: string, logFile: string, file = 'docker-compose.yml') {
        this.root = root; this.project = project; this.envFile = envFile; this.overrideFile = overrideFile; this.logFile = logFile; this.file = file;
    }

    private base(): string[] {
        const files = ['-f', this.file, ...(existsSync(this.overrideFile) ? ['-f', this.overrideFile] : [])];
        return ['compose', '-p', this.project, '--env-file', this.envFile, ...files];
    }

    run(args: string[], opts: { quiet?: boolean; input?: string } = {}): Promise<{ code: number; out: string }> {
        return new Promise((resolve) => {
            const child = spawn('docker', [...this.base(), ...args], { cwd: this.root, stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
            let out = '';
            const sink = (chunk: Buffer) => {
                out += chunk.toString();
                try { appendFileSync(this.logFile, chunk); } catch { /* log dir may be gone during clean */ }
            };
            child.stdout!.on('data', sink);
            child.stderr!.on('data', sink);
            if (opts.input) { child.stdin!.end(opts.input); }
            child.on('close', (code) => resolve({ code: code ?? 1, out }));
        });
    }

    up(services: string[]) { return this.run(['up', '-d', '--remove-orphans', ...services]); }

    /** service → { state, health } from `compose ps`; health is '' when the image has no HEALTHCHECK. */
    status(): Map<string, { state: string; health: string }> {
        const out = new Map<string, { state: string; health: string }>();
        try {
            const text = execFileSync('docker', [...this.base(), 'ps', '--all', '--format', 'json'], { cwd: this.root, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
            for (const line of text.split('\n').filter(Boolean)) {
                try { const j = JSON.parse(line) as { Service: string; State: string; Health: string }; out.set(j.Service, { state: j.State, health: j.Health ?? '' }); } catch { /* skip */ }
            }
        } catch { /* compose not running */ }
        return out;
    }
    down(volumes: boolean) { return this.run(['down', '--remove-orphans', ...(volumes ? ['-v'] : [])]); }

    /** Running containers of this project → compose service names. */
    running(): string[] {
        try {
            const out = execFileSync('docker', [...this.base(), 'ps', '--services', '--status', 'running'], { cwd: this.root, stdio: ['ignore', 'pipe', 'ignore'] });
            return out.toString().split('\n').map((s) => s.trim()).filter(Boolean);
        } catch { return []; }
    }

}

export function dockerAvailable(): { ok: boolean; reason?: string } {
    try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return { ok: true }; }
    catch { return { ok: false, reason: 'docker is not running (or not on PATH)' }; }
}
