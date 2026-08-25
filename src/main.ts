// lcl — run one or several independent local stacks side by side (`--stack <name>`, default `default`).

import { parseArgs } from 'node:util';
import { loadCatalog } from './catalog.ts';
import { paths, type State } from './instance.ts';
import { Supervisor } from './supervisor.ts';
import { CliError, fail } from './ui.ts';
import { context } from './commands/common.ts';
import { start } from './commands/start.ts';
import { restart, stop } from './commands/stop.ts';
import { printList, printPorts, printStatus, printUrls } from './commands/status.ts';
import { clean, events, logs, why } from './commands/logs.ts';
import { doctor } from './commands/doctor.ts';

const HELP = `lcl — local stack runner. Several stacks can run at once: --stack <name> (default: default)

  lcl start [svc…] [-d] [--build] [--no-infra | --infra core|all|a,b,c] [--keep-infra]
            [--ports auto|configured|shift|offset=k | --no-default-ports] [--parallel N] [--fail-fast] [--restart on-failure[:N]]
  lcl stop [svc…] [--hard]          stop the stack (or only those services); --hard also deletes compose volumes
  lcl restart [svc…] [start flags]  stop + start (whole stack, or only those services)
  lcl status [--json]               services, state, ports, pids, uptime, error counts, health
  lcl urls | lcl ports [--json|--env]
  lcl logs [svc…] [-f] [-n N] [--since 10m] [--grep RE] [--errors]
  lcl events [-f] [--since 1h] [--service svc] [--json]   audit trail (build/lcl/events.jsonl)
  lcl why <svc>                     exit code, health, port owner, command, env, last errors
  lcl doctor                        docker, PATH tools, /etc/hosts, node_modules, ports, registry
  lcl list                          every running stack
  lcl clean [--all]                 remove build/lcl/<stack> of a stopped stack

The project is described by lcl.yml (found upwards from the cwd, or --config <file>): services, runner type, ports,
env, generated files, hooks, urls. If any configured port is taken, the whole stack shifts to the next free +step sequence;
--ports shift / --no-default-ports never uses the configured ports (lcl.yml ports.skip-configured: true makes that the default).
Every command acts on one stack: --stack xxx (or LCL_STACK=xxx) selects it, 'default' is used otherwise. Each stack
has its own supervisor, services, compose project (lcl-<stack>), ports, logs and audit trail (build/lcl/<stack>/).

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
        },
    });
    const [command = 'start', ...rest] = positionals;
    if (values.help) { console.log(HELP); return; }

    if (command === '__supervise') {
        const state = JSON.parse(values.state ?? '') as State;
        const supervisor = new Supervisor(loadCatalog(state.configFile), paths(state.root, state.id), state);
        await supervisor.run();
        return;
    }

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
