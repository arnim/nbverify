#!/usr/bin/env node
import fs from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import { JupyterClient } from './jupyter.js';
import { runRemote } from './executor.js';
import { writeReport } from './report.js';
import { exitCodeFor } from './errors.js';

const log = (msg) => process.stderr.write(`nbverify: ${msg}\n`);

const program = new Command();
program
  .name('nbverify')
  .description('Check that a Binder-ready repository’s notebooks actually execute')
  .configureOutput({ writeErr: (s) => process.stderr.write(s) });

function connectionOptions(cmd) {
  return cmd
    .option('--session <file>', 'session file written by `nbverify start`')
    .option('--server-url <url>', 'Jupyter server URL (alternative to --session)')
    .option('--token-env <var>', 'environment variable holding the token', 'JUPYTER_TOKEN');
}

async function clientFromOptions(opts) {
  let serverUrl;
  let token;
  let session = null;
  if (opts.session) {
    session = JSON.parse(await fs.readFile(opts.session, 'utf8'));
    serverUrl = session.server_url;
    token = session.token;
  }
  if (opts.serverUrl) {
    serverUrl = opts.serverUrl;
    token = process.env[opts.tokenEnv];
    if (!token) {
      throw new InvalidArgumentError(`environment variable ${opts.tokenEnv} is not set`);
    }
  }
  if (!serverUrl || !token) {
    throw new InvalidArgumentError('provide --session FILE or --server-url URL with --token-env VAR');
  }
  return { client: new JupyterClient(serverUrl, token), session };
}

connectionOptions(
  program
    .command('list')
    .description('discover notebooks on the server (Contents API)')
)
  .option('--json', 'print JSON instead of text')
  .action(async (opts) => {
    const { client } = await clientFromOptions(opts);
    await client.ping();
    const notebooks = await client.listNotebooks();
    if (opts.json) {
      process.stdout.write(JSON.stringify(notebooks, null, 2) + '\n');
    } else {
      for (const nb of notebooks) {
        process.stdout.write(`${nb.kind.padEnd(8)} ${nb.path}\n`);
      }
    }
  });

connectionOptions(
  program
    .command('run')
    .description('execute notebooks on the server and download HTML')
    .argument('[paths...]', 'notebook paths, executed in the given order')
)
  .option('--from-file <file>', 'read notebook paths from a file (one per line)')
  .option('--ipynb-renderer <renderer>', 'quarto or nbconvert', (v) => {
    if (v !== 'quarto' && v !== 'nbconvert') {
      throw new InvalidArgumentError('must be "quarto" or "nbconvert"');
    }
    return v;
  }, 'nbconvert')
  .option('--timeout <seconds>', 'per-notebook timeout', (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('must be a positive number');
    return n;
  }, 600)
  .option('--fail-fast', 'stop after the first failure')
  .option('--output-dir <dir>', 'where to write HTML and the report', 'artifacts')
  .option('--keep-remote-artifacts', 'do not delete .nbverify/ on the server')
  .action(async (paths, opts) => {
    const { client, session } = await clientFromOptions(opts);
    await client.ping();

    if (opts.fromFile) {
      const text = await fs.readFile(opts.fromFile, 'utf8');
      paths = paths.concat(text.split('\n').map((l) => l.trim()).filter(Boolean));
    }
    if (paths.length === 0) {
      log('no paths given, running all discovered notebooks in sorted order');
      paths = (await client.listNotebooks()).map((nb) => nb.path);
    }
    if (paths.length === 0) {
      log('nothing to run');
      process.exit(0);
    }

    const items = paths.map((p) => {
      const remote = p.replace(/\\/g, '/').replace(/^\.\//, '');
      if (remote.endsWith('.qmd')) return { path: remote, renderer: 'quarto' };
      if (remote.endsWith('.ipynb')) return { path: remote, renderer: opts.ipynbRenderer };
      throw new InvalidArgumentError(`unsupported file type: ${p}`);
    });

    const startedAt = new Date().toISOString();
    const { success, results } = await runRemote(client, items, {
      timeout: opts.timeout,
      failFast: Boolean(opts.failFast),
      outputDir: opts.outputDir,
      keepRemoteArtifacts: Boolean(opts.keepRemoteArtifacts),
      log,
    });

    const report = {
      repository: session?.repository ?? null,
      backend: session?.backend ?? null,
      success,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      results,
    };
    const reportPath = await writeReport(opts.outputDir, report);
    log(`report: ${reportPath}`);

    const passed = results.filter((r) => r.status === 'passed').length;
    log(`${passed}/${items.length} passed`);
    process.exit(success ? 0 : 1);
  });

program.parseAsync().catch((err) => {
  if (err instanceof InvalidArgumentError || err.code === 'commander.invalidArgument') {
    log(err.message);
    process.exit(2);
  }
  log(err.message);
  process.exit(exitCodeFor(err));
});
