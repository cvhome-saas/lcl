// Health probes. Java services expose /actuator/health (show-details: always); node dev servers just answer HTTP.

import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';

export type Probe = { ok: boolean; reason: string };

export function tcpOpen(port: number, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = connect({ port, host: '127.0.0.1' });
        const done = (v: boolean) => { sock.destroy(); resolve(v); };
        sock.setTimeout(timeoutMs, () => done(false));
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
    });
}

type Reply = { status: number; body: string };

function get(port: number, path: string, timeoutMs: number): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `localhost:${port}`, accept: '*/*' }, timeout: timeoutMs }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { if (body.length < 65536) body += c; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('timeout', () => { req.destroy(new Error(`no answer within ${timeoutMs / 1000}s`)); });
        req.on('error', reject);
        req.end();
    });
}

/** GET `path`; ok when the status is < 500 and, if given, the body contains `expect`. Secured (401/403) counts as ok. */
export async function httpProbe(port: number, path: string, expect?: string, timeoutMs = 5000): Promise<Probe> {
    try {
        const res = await get(port, path, timeoutMs);
        if (res.status === 401 || res.status === 403) return { ok: true, reason: `${path} ${res.status} (secured)` };
        if (res.status >= 500) return { ok: false, reason: `${path} http ${res.status}` };
        if (expect && !res.body.includes(expect)) {
            let status = res.body.slice(0, 80);
            try { const b = JSON.parse(res.body) as { status?: string; components?: Record<string, { status?: string }> }; status = String(b.status ?? status); const failing = Object.entries(b.components ?? {}).filter(([, c]) => c.status && c.status !== 'UP').map(([k, c]) => `${k}=${c.status}`); if (failing.length) status += `: ${failing.join(', ')}`; } catch { /* not json */ }
            return { ok: false, reason: status };
        }
        return { ok: true, reason: expect ? 'UP' : `${path} http ${res.status}` };
    } catch (e) {
        return { ok: false, reason: `unreachable: ${(e as Error).message}` };
    }
}

export async function httpAlive(port: number, timeoutMs = 30_000): Promise<Probe> {
    try {
        const res = await get(port, '/', timeoutMs);
        return res.status < 500 ? { ok: true, reason: `http ${res.status}` } : { ok: false, reason: `http ${res.status}` };
    } catch (e) {
        return { ok: false, reason: `unreachable: ${(e as Error).message}` };
    }
}
