// Terminal output helpers: colours (only on a TTY), the `==>` line style of the old script, and plain tables.

const tty = process.stdout.isTTY === true && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = c('2');
export const red = c('31');
export const green = c('32');
export const yellow = c('33');
export const cyan = c('36');
export const bold = c('1');

export function say(msg: string): void { console.log(`${green('==>')} ${msg}`); }
export function warn(msg: string): void { console.log(`${yellow('==>')} ${msg}`); }
export function fail(msg: string): void { console.error(`${red('==>')} ${msg}`); }
export function note(msg: string): void { console.log(`    ${dim(msg)}`); }

export class CliError extends Error {
    readonly exitCode: number;
    constructor(message: string, exitCode = 1) { super(message); this.exitCode = exitCode; }
}
export function die(msg: string, exitCode = 1): never { throw new CliError(msg, exitCode); }

export function table(rows: string[][], header?: string[]): string {
    const all = header ? [header, ...rows] : rows;
    const widths: number[] = [];
    for (const row of all) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, visible(cell).length); });
    const line = (row: string[]) => row.map((cell, i) => cell + ' '.repeat(widths[i] - visible(cell).length)).join('  ').trimEnd();
    const out = all.map(line);
    if (header) out.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('  '));
    return out.join('\n');
}
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

export function fmtDuration(ms: number): string {
    if (ms < 0) return '-';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h${m % 60}m`;
}

export function parseDuration(text: string): number {
    const m = /^(\d+)(ms|s|m|h|d)?$/.exec(text.trim());
    if (!m) die(`bad duration: ${text} (use e.g. 30s, 10m, 2h)`);
    const n = Number(m[1]);
    return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as Record<string, number>)[m[2] ?? 's'];
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
