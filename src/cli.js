#!/usr/bin/env node
import fs from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import { JupyterClient } from './jupyter.js';
import { runRemote } from './executor.js';
import { writeReport } from './report.js';
import { exitCodeFor, NbverifyError } from './errors.js';
import { getBackend, BACKEND_NAMES } from './backends/index.js';
import { makeSession, writeSession, readSession } from './session.js';

const log = (msg) => process.stderr.write(`nbverify: ${msg}\n`);

const program = new Command();
program
  .name('nbverify')
  .description('Check that a Binder-ready repository’s notebooks actually execute')
  .configureOutput({ writeErr: (s) => process.stderr.write(s) })
  .exitOverride();

// ---- option helpers --------------------------------------------------------

const parseBackend = (v) => {
  if (!BACKEND_NAMES.includes(v)) {
    throw new InvalidArgumentError(`must be one of: ${BACKEND_NAMES.join(', ')}`);
  }
  return v;
};

const parseRenderer = (v) => {
  if (v !== 'quarto' && v !== 'nbconvert') {
    throw new InvalidArgumentError('must be "quarto" or "nbconvert"');
  }
  return v;
};

const parsePositiveNumber = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('must be a positive number');
  return n;
};

function connectionOptions(cmd) {
  return cmd
    .option('--session <file>', 'session file written by `nbverify start`')
    .option('--server-url <url>', 'Jupyter server URL (alternative to --session)')
    .option('--token-env <var>', 'environment variable holding the token', 'JUPYTER_TOKEN');
}

function runOptions(cmd) {
  return cmd
    .option('--ipynb-renderer <renderer>', 'quarto or nbconvert', parseRenderer, 'nbconvert')
    .option('--timeout <seconds>', 'per-notebook timeout', parsePositiveNumber, 600)
    .option('--fail-fast', 'stop after the first failure')
    .option('--output-dir <dir>', 'where to write HTML and the report', 'artifacts')
    .option('--keep-remote-artifacts', 'do not delete the work dir on the server');
}

async function clientFromOptions(opts) {
  let serverUrl;
  let token;
  let session = null;
  if (opts.session) {
    session = await readSession(opts.session);
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

// ---- shared run logic ------------------------------------------------------

async function executeRun(client, session, paths, opts) {
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
    return true;
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
  log(`${results.filter((r) => r.status === 'passed').length}/${items.length} passed`);
  return success;
}

// ---- provisioning helpers --------------------------------------------------

async function startBackend(repoUrl, opts) {
  const backend = getBackend(opts.backend);
  const token =
    opts.backend === 'jupyter4nfdi'
      ? process.env[opts.tokenEnv ?? 'JUPYTER4NFDI_TOKEN']
      : undefined;
  const started = await backend.start(repoUrl, {
    ref: opts.ref,
    token,
    binderhub: opts.binderhub,
    launchTimeout: opts.launchTimeout,
    log,
  });
  return makeSession({
    backend: opts.backend,
    repository: repoUrl,
    ref: opts.ref ?? null,
    serverUrl: started.serverUrl,
    token: started.token,
    backendState: started.backendState,
  });
}

async function stopBackend(session, opts = {}) {
  const backend = getBackend(session.backend);
  await backend.stop(session, { removeImage: Boolean(opts.removeImage), log });
}

// ---- commands ---------------------------------------------------------------

program
  .command('start')
  .description('provision a Jupyter server for a repository')
  .argument('<repo-url>', 'GitHub repository URL')
  .requiredOption('--backend <name>', BACKEND_NAMES.join('|'), parseBackend)
  .option('--ref <ref>', 'git ref (branch, tag, commit)')
  .option('--session <file>', 'session file to write', 'session.json')
  .option('--binderhub <url>', 'BinderHub URL (binderbot backend)', 'https://mybinder.org/')
  .option('--token-env <var>', 'env var with the hub token (jupyter4nfdi backend)', 'JUPYTER4NFDI_TOKEN')
  .option('--launch-timeout <seconds>', 'max seconds to wait for the server', parsePositiveNumber, 1800)
  .action(async (repoUrl, opts) => {
    const session = await startBackend(repoUrl, opts);
    const json = await writeSession(opts.session, session);
    log(`session written to ${opts.session}`);
    process.stdout.write(json);
  });

program
  .command('status')
  .description('check whether the provisioned server is running')
  .requiredOption('--session <file>', 'session file')
  .action(async (opts) => {
    const session = await readSession(opts.session);
    const backend = getBackend(session.backend);
    const { running, detail } = await backend.status(session);
    process.stdout.write(
      JSON.stringify(
        { backend: session.backend, repository: session.repository, running, detail },
        null,
        2
      ) + '\n'
    );
    process.exit(running ? 0 : 1);
  });

program
  .command('stop')
  .description('stop the provisioned server (idempotent)')
  .requiredOption('--session <file>', 'session file')
  .option('--remove-image', 'also remove the built image (repo2docker backend)')
  .action(async (opts) => {
    const session = await readSession(opts.session);
    await stopBackend(session, opts);
    log('stopped');
  });

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

runOptions(
  connectionOptions(
    program
      .command('run')
      .description('execute notebooks on the server and download HTML')
      .argument('[paths...]', 'notebook paths, executed in the given order')
  ).option('--from-file <file>', 'read notebook paths from a file (one per line)')
).action(async (paths, opts) => {
  const { client, session } = await clientFromOptions(opts);
  await client.ping();
  const success = await executeRun(client, session, paths, opts);
  process.exit(success ? 0 : 1);
});

runOptions(
  program
    .command('test')
    .description('one-shot: start → run → stop')
    .argument('<repo-url>', 'GitHub repository URL')
    .argument('[paths...]', 'notebook paths (omit to run all discovered)')
    .requiredOption('--backend <name>', BACKEND_NAMES.join('|'), parseBackend)
    .option('--ref <ref>', 'git ref (branch, tag, commit)')
    .option('--binderhub <url>', 'BinderHub URL (binderbot backend)', 'https://mybinder.org/')
    .option('--token-env <var>', 'env var with the hub token (jupyter4nfdi backend)', 'JUPYTER4NFDI_TOKEN')
    .option('--launch-timeout <seconds>', 'max seconds to wait for the server', parsePositiveNumber, 1800)
    .option('--keep-session <file>', 'keep the server running and write the session here')
    .option('--remove-image', 'remove the built image after the run (repo2docker backend)')
).action(async (repoUrl, paths, opts) => {
  let session = null;
  let interrupted = false;

  const cleanup = async () => {
    if (!session || opts.keepSession) return;
    const s = session;
    session = null; // never stop twice
    try {
      log('stopping server');
      await stopBackend(s, opts);
    } catch (err) {
      log(`warning: failed to stop server: ${err.message}`);
    }
  };

  const onSignal = () => {
    interrupted = true;
    log('interrupted, stopping server');
    cleanup().finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    session = await startBackend(repoUrl, opts);
    if (opts.keepSession) {
      await writeSession(opts.keepSession, session);
      log(`session written to ${opts.keepSession}`);
    }
    const client = new JupyterClient(session.server_url, session.token);
    await client.ping();
    const success = await executeRun(client, session, paths, opts);
    await cleanup();
    process.exit(interrupted ? 130 : success ? 0 : 1);
  } finally {
    await cleanup();
  }
});

program.parseAsync().catch((err) => {
  if (typeof err.code === 'string' && err.code.startsWith('commander.')) {
    // help/version display exits 0; every argument error exits 2
    process.exit(err.code === 'commander.helpDisplayed' || err.code === 'commander.version' ? 0 : 2);
  }
  if (err instanceof InvalidArgumentError) {
    log(err.message);
    process.exit(2);
  }
  log(err.message);
  process.exit(err instanceof NbverifyError ? exitCodeFor(err) : 1);
});
