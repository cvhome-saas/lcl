// Control channel between CLI commands and a running supervisor: a unix socket speaking JSON lines.

import { createServer, connect, type Server, type Socket } from 'node:net';
import { existsSync, rmSync } from 'node:fs';

export type Request = { cmd: string; args?: Record<string, unknown> };
export type Response = { ok: true; data: unknown } | { ok: false; error: string };
export type Handler = (req: Request, sock: Socket) => Promise<unknown>;

export function serve(socketPath: string, handler: Handler): Server {
    if (existsSync(socketPath)) rmSync(socketPath, { force: true });
    const server = createServer((sock) => {
        let buf = '';
        sock.on('data', (chunk) => {
            buf += chunk.toString();
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line.trim()) continue;
                let req: Request;
                try { req = JSON.parse(line); } catch { sock.write(JSON.stringify({ ok: false, error: 'bad request' }) + '\n'); continue; }
                handler(req, sock)
                    .then((data) => sock.write(JSON.stringify({ ok: true, data } satisfies Response) + '\n'))
                    .catch((e) => sock.write(JSON.stringify({ ok: false, error: (e as Error).message } satisfies Response) + '\n'));
            }
        });
        sock.on('error', () => { /* client went away */ });
    });
    server.listen(socketPath);
    return server;
}

/** Sends one request and resolves with its response. `onProgress` receives `{progress: …}` frames sent before the reply. */
export function request(socketPath: string, req: Request, onProgress?: (line: unknown) => void, timeoutMs = 600_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
        if (!existsSync(socketPath)) return reject(new Error('no supervisor socket'));
        const sock = connect(socketPath);
        let buf = '';
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('supervisor did not answer in time')); }, timeoutMs);
        sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
        sock.on('data', (chunk) => {
            buf += chunk.toString();
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line.trim()) continue;
                const msg = JSON.parse(line);
                if ('progress' in msg) { onProgress?.(msg.progress); continue; }
                clearTimeout(timer);
                sock.end();
                if (msg.ok) resolve(msg.data); else reject(new Error(msg.error));
            }
        });
        sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

export function supervisorReachable(socketPath: string): Promise<boolean> {
    return request(socketPath, { cmd: 'ping' }, undefined, 3000).then(() => true, () => false);
}

export const progress = (sock: Socket, message: string) => { try { sock.write(JSON.stringify({ progress: message }) + '\n'); } catch { /* closed */ } };
