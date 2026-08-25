// lcl — run one or several independent local stacks side by side (`--stack <name>`, default `default`).

import { parseArgs } from 'node:util';
import { loadCatalog } from './catalog.js';
import { paths, type State } from './instance.js';
import { Supervisor } from './supervisor.js';
import { CliError, fail } from './ui.js';
import { context } from './commands/common.js';
import { start } from './commands/start.js';
import { restart, stop } from './commands/stop.js';
import { printList, printPorts, printStatus, printUrls } from './commands/status.js';
import { clean, events, logs, why } from './commands/logs.js';
import { doctor } from './commands/doctor.js';
import { init } from './commands/init.js';
import { VERSION } from './version.js';

const HELP = `lcl — local stack runner. Several stacks can run at once: --stack <name> (default: default)

  lcl start [svc…] [-d] [--build] [--no-infra | --infra core|all|a,b,c] [--keep-infra]
            [--ports auto|configured|shift|offset=k | --no-default-ports] [--parallel N] [--fail-fast] [--restart on-failure[:N]]
  lcl stop [svc…] [--hard]          stop the stack (or only those services); --hard also deletes compose volumes
  lcl restart [svc…] [start flags]  stop + start (whole stack, or only those services)
  lcl status [--json]               services, state, ports, pids, uptime, error counts, health
  lcl urls | lcl ports [--json|--env]
  lcl logs [svc…] [-f] [-n N] [--since 10m] [--grep RE] [--errors]
  lcl events [-f] [--since 1h] [--service svc] [--json]   audit trail (.lcl/<stack>/events.jsonl)
  lcl why <svc>                     exit code, health, port owner, command, env, last errors
  lcl doctor                        Docker, PATH tools, /etc/hosts, working directories, ports, registry
  lcl list                          every running stack
  lcl clean [--all]                 remove .lcl/<stack> state for stopped stacks
  lcl validate [--json]             validate lcl.yml and print the resolved catalog
  lcl init [--template empty|node|python|java|compose] [--force]
  lcl --version

The project is described by lcl.yml (found upwards from the cwd, or --config <file>): services, commands, ports,
env, generated files, hooks, urls. If any configured port is taken, the whole stack shifts to the next free +step sequence;
--ports shift / --no-default-ports never uses the configured ports (lcl.yml ports.skip-configured: true makes that the default).
Every command acts on one stack: --stack xxx (or LCL_STACK=xxx) selects it, 'default' is used otherwise. Each stack
has its own supervisor, services, checkout-scoped Compose project, ports, logs and audit trail (.lcl/<stack>/).

  lcl start -d                      the default stack
  lcl start -d --stack xxx          a second stack next to it (ports shift to the next free +1000 sequence)
  lcl status --stack xxx · lcl logs catalog -f --stack xxx · lcl stop --stack xxx`;

async function main(argv: string[]): Promise<void> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean', short: 'v' },
            stack: { type: 'string', short: 's' },
            instance: { type: 'string' },   // old spelling of --stack
            root: { type: 'string' },
            config: { type: 'string', short: 'c' },
            detach: { type: 'boolean', short: 'd' },
            build: { type: 'boolean' },
            'no-infra': { type: 'boolean' },
            infra: { type: 'string' },
            'keep-infra': { type: 'boolean' },
            ports: { type: 'string' },
            'no-default-ports': { type: 'boolean' },
            parallel: { type: 'string' },
            'fail-fast': { type: 'boolean' },
            restart: { type: 'string' },
            hard: { type: 'boolean' },
            volumes: { type: 'boolean' },
            json: { type: 'boolean' },
            env: { type: 'boolean' },
            follow: { type: 'boolean', short: 'f' },
            lines: { type: 'string', short: 'n' },
            since: { type: 'string' },
            grep: { type: 'string' },
            errors: { type: 'boolean' },
            service: { type: 'string' },
            all: { type: 'boolean' },
            state: { type: 'string' },
            list: { type: 'boolean' },
            template: { type: 'string' },
            force: { type: 'boolean' },
        },
    });
    const [command = 'start', ...rest] = positionals;
    if (values.help) { console.log(HELP); return; }
    if (values.version) { console.log(VERSION); return; }

    if (command === '__supervise') {
        const state = JSON.parse(values.state ?? '') as State;
        const supervisor = new Supervisor(loadCatalog(state.configFile), paths(state.root, state.id), state);
        await supervisor.run();
        return;
    }

    if (command === 'init') { init(values.root ?? process.cwd(), values.template ?? 'empty', Boolean(values.force)); return; }

    const ctx = context({ stack: values.stack ?? values.instance, root: values.root, config: values.config });
    const startFlags = {
        detach: Boolean(values.detach), build: Boolean(values.build), noInfra: Boolean(values['no-infra']), infra: values.infra,
        keepInfra: Boolean(values['keep-infra']), failFast: Boolean(values['fail-fast']), restart: values.restart,
        parallel: Number(values.parallel ?? 1), ports: values.ports, noDefaultPorts: Boolean(values['no-default-ports']),
    };
    const hard = Boolean(values.hard || values.volumes);
    switch (command) {
        case 'start':
            if (values.list) { printPorts(ctx, 'table'); return; }
            return start(ctx, rest, startFlags);
        case 'stop': return stop(ctx, rest, { hard });
        case 'restart': return restart(ctx, rest, { ...startFlags, hard });
        case 'status': case 'ps': return printStatus(ctx, Boolean(values.json));
        case 'pid': return printStatus(ctx, false);
        case 'urls': return printUrls(ctx);
        case 'ports': return printPorts(ctx, values.json ? 'json' : values.env ? 'env' : 'table');
        case 'logs': return logs(ctx, rest, { follow: Boolean(values.follow), since: values.since, grep: values.grep, errors: Boolean(values.errors), lines: Number(values.lines ?? 50) });
        case 'events': return events(ctx, { follow: Boolean(values.follow), since: values.since, service: values.service, json: Boolean(values.json) });
        case 'why': if (!rest[0]) throw new CliError('usage: lcl why <service>', 2); return why(ctx, rest[0]);
        case 'doctor': return doctor(ctx);
        case 'validate':
            if (values.json) console.log(JSON.stringify({ version: ctx.catalog.config.version, services: ctx.catalog.services.map((service) => service.name), compose: ctx.catalog.composeServices }, null, 2));
            else console.log(`valid schema v${ctx.catalog.config.version}: ${ctx.catalog.services.length} source service(s), ${ctx.catalog.composeServices.length} Compose service(s)`);
            return;
        case 'list': printList(); return;
        case 'clean': clean(ctx, Boolean(values.all)); return;
        case 'help': console.log(HELP); return;
        default: throw new CliError(`unknown command: ${command}\n\n${HELP}`, 2);
    }
}

main(process.argv.slice(2)).catch((e: unknown) => {
    if (e instanceof CliError) { fail(e.message); process.exit(e.exitCode); }
    fail((e as Error)?.stack ?? String(e));
    process.exit(1);
});
