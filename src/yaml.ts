// A deliberately small YAML reader: enough for common-config.yml (nested maps, lists of scalars/maps, quoted and
// plain scalars, comments) and nothing more. It exists so the tool has no dependencies and can treat
// common-config.yml as the single source of truth for service names and ports.

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

type Line = { indent: number; text: string };

export function parseYaml(source: string): YamlValue {
    const lines: Line[] = [];
    for (const raw of source.split(/\r?\n/)) {
        const text = stripComment(raw).trimEnd();
        if (text.trim() === '') continue;
        lines.push({ indent: raw.length - raw.trimStart().length, text: text.trim() });
    }
    let pos = 0;
    const parseBlock = (indent: number): YamlValue => {
        if (pos >= lines.length) return null;
        if (lines[pos].text.startsWith('- ') || lines[pos].text === '-') return parseList(indent);
        return parseMap(indent);
    };
    const parseMap = (indent: number): { [key: string]: YamlValue } => {
        const map: { [key: string]: YamlValue } = {};
        while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith('- ')) {
            const { key, rest } = splitKey(lines[pos].text);
            pos++;
            if (/^[|>][+-]?$/.test(rest)) { map[key] = blockScalar(rest, indent); continue; }
            if (rest !== '') { map[key] = scalar(rest); continue; }
            if (pos < lines.length && lines[pos].indent > indent) map[key] = parseBlock(lines[pos].indent);
            else if (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) map[key] = parseList(indent);
            else map[key] = null;
        }
        return map;
    };
    // `|` literal / `>` folded block scalars: every following line indented deeper than the key belongs to it.
    // (Leading indentation inside the block is not preserved — lines were trimmed when read.)
    const blockScalar = (indicator: string, indent: number): string => {
        const parts: string[] = [];
        while (pos < lines.length && lines[pos].indent > indent) parts.push(lines[pos++].text);
        const text = indicator.startsWith('|') ? parts.join('\n') : parts.join(' ');
        return indicator.endsWith('-') ? text : text + '\n';
    };
    const parseList = (indent: number): YamlValue[] => {
        const list: YamlValue[] = [];
        while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith('- ') || lines[pos].text === '-')) {
            const item = lines[pos].text.slice(1).trim();
            if (item === '') { pos++; list.push(pos < lines.length && lines[pos].indent > indent ? parseBlock(lines[pos].indent) : null); continue; }
            if (isKeyValue(item)) {
                // "- key: value" starts an inline map whose remaining keys sit at indent + 2
                const inner = indent + 2;
                lines[pos] = { indent: inner, text: item };
                list.push(parseMap(inner));
            } else {
                pos++;
                list.push(scalar(item));
            }
        }
        return list;
    };
    return parseBlock(lines[0]?.indent ?? 0);
}

function stripComment(line: string): string {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) { if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
}

function isKeyValue(text: string): boolean {
    return /^[^\s'"[{][^:]*:(\s|$)/.test(text) || /^"[^"]*":(\s|$)/.test(text) || /^'[^']*':(\s|$)/.test(text);
}

function splitKey(text: string): { key: string; rest: string } {
    const m = /^("([^"]*)"|'([^']*)'|([^:]+?)):(?:\s+(.*))?$/.exec(text);
    if (!m) throw new Error(`yaml: cannot parse mapping line: ${text}`);
    return { key: m[2] ?? m[3] ?? m[4], rest: (m[5] ?? '').trim() };
}

function scalar(text: string): YamlValue {
    if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
    if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
    if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) return parseFlow(text);
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === 'null' || text === '~') return null;
    if (/^-?\d+$/.test(text)) return Number(text);
    if (/^-?\d+\.\d+$/.test(text)) return Number(text);
    return text;
}

/** Flow collections: `[a, "b", 1]` and `{ key: value, other: [x] }`, nested, with quoted strings. */
function parseFlow(text: string): YamlValue {
    let pos = 0;
    const ws = () => { while (pos < text.length && /\s/.test(text[pos])) pos++; };
    const value = (): YamlValue => {
        ws();
        const ch = text[pos];
        if (ch === '[') {
            pos++;
            const list: YamlValue[] = [];
            ws();
            if (text[pos] === ']') { pos++; return list; }
            while (pos < text.length) {
                list.push(value());
                ws();
                if (text[pos] === ',') { pos++; continue; }
                if (text[pos] === ']') { pos++; return list; }
                throw new Error(`yaml: bad flow sequence: ${text}`);
            }
        }
        if (ch === '{') {
            pos++;
            const map: { [key: string]: YamlValue } = {};
            ws();
            if (text[pos] === '}') { pos++; return map; }
            while (pos < text.length) {
                ws();
                const key = String(bare(':'));
                ws();
                if (text[pos] !== ':') throw new Error(`yaml: bad flow mapping: ${text}`);
                pos++;
                map[key] = value();
                ws();
                if (text[pos] === ',') { pos++; continue; }
                if (text[pos] === '}') { pos++; return map; }
                throw new Error(`yaml: bad flow mapping: ${text}`);
            }
        }
        return bare();
    };
    const bare = (stop = ''): YamlValue => {
        ws();
        const q = text[pos];
        if (q === '"' || q === "'") {
            const end = text.indexOf(q, pos + 1);
            const out = text.slice(pos + 1, end);
            pos = end + 1;
            return out;
        }
        let out = '';
        while (pos < text.length && !',]}'.includes(text[pos]) && !(stop && text[pos] === stop)) out += text[pos++];
        return scalar(out.trim());
    };
    return value();
}

/** Reads a dotted path such as `services.api.port` out of a parsed document. */
export function getPath(doc: YamlValue, path: string): YamlValue {
    let cur: YamlValue = doc;
    for (const part of path.split('.')) {
        if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return null;
        cur = cur[part] ?? null;
    }
    return cur;
}

/** Resolves `${a.b.c}` placeholders against the same document (what Spring does at runtime). */
export function resolvePlaceholders(text: string, doc: YamlValue, depth = 0): string {
    if (depth > 10) return text;
    return text.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (whole, path: string, fallback?: string) => {
        const v = getPath(doc, path);
        if (v === null || typeof v === 'object') return fallback ?? whole;
        return resolvePlaceholders(String(v), doc, depth + 1);
    });
}
