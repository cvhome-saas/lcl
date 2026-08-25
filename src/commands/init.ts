import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { die, say } from '../ui.js';

export const INIT_TEMPLATES = ['empty', 'node', 'python', 'java', 'compose'] as const;
export type InitTemplate = typeof INIT_TEMPLATES[number];

export function init(root: string, templateName: string, force: boolean): void {
    if (!INIT_TEMPLATES.includes(templateName as InitTemplate)) die(`--template must be one of: ${INIT_TEMPLATES.join(', ')}`);
    const target = resolve(root, 'lcl.yml');
    if (existsSync(target) && !force) die(`${target} already exists; pass --force to replace it`);
    const template = templateFile(`${templateName}.yml`);
    const project = basename(resolve(root)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'local-stack';
    writeFileSync(target, readFileSync(template, 'utf8').replaceAll('__PROJECT__', project));
    if (templateName === 'compose') {
        const composeTarget = resolve(root, 'compose.yml');
        if (!existsSync(composeTarget) || force) writeFileSync(composeTarget, readFileSync(templateFile('compose.compose.yml'), 'utf8'));
    }
    ensureIgnored(root);
    say(`created ${target} from the ${templateName} template`);
    if (templateName !== 'empty') console.log('validate it with `lcl validate`, then start it with `lcl start`');
}

function templateFile(name: string): string {
    const sourcePath = fileURLToPath(new URL(`../../templates/${name}`, import.meta.url));
    if (existsSync(sourcePath)) return sourcePath;
    return fileURLToPath(new URL(`../../../templates/${name}`, import.meta.url));
}

function ensureIgnored(root: string): void {
    const path = join(root, '.gitignore');
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (existing.split(/\r?\n/).includes('.lcl/')) return;
    writeFileSync(path, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}.lcl/\n`);
}
