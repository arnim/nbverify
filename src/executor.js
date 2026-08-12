import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NbverifyError } from './errors.js';
import { writeFileAtomic } from './file-utils.js';

const RUNNER_PATH = fileURLToPath(new URL('./runner.py', import.meta.url));

/**
 * Execute documents remotely via the terminal + file protocol described in
 * docs/specification.md and download the resulting HTML.
 *
 * @param {import('./jupyter.js').JupyterClient} client
 * @param {{path: string, renderer: 'quarto'|'nbconvert'}[]} items ordered
 * @param {object} opts
 * @param {number} [opts.timeout] per-notebook seconds (default 600)
 * @param {boolean} [opts.failFast]
 * @param {string} [opts.outputDir] local dir for HTML (default artifacts/)
 * @param {boolean} [opts.keepRemoteArtifacts]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{success: boolean, results: object[]}>}
 */
export async function runRemote(client, items, opts = {}) {
  const {
    timeout = 600,
    failFast = false,
    outputDir = 'artifacts',
    keepRemoteArtifacts = false,
    log = () => {},
  } = opts;

  await preflight(client, items, log);

  const workDir = await client.resolveWorkDir();
  const jobId = crypto.randomBytes(6).toString('hex');
  const jobDir = `${workDir}/job-${jobId}`;
  log(`job ${jobId}: uploading request and runner`);

  const request = {
    fail_fast: failFast,
    items: items.map((it) => ({
      path: it.path,
      renderer: it.renderer,
      timeout,
    })),
  };
  await client.putTextFile(`${jobDir}/request.json`, JSON.stringify(request, null, 2));
  await client.putTextFile(`${jobDir}/runner.py`, await fs.readFile(RUNNER_PATH, 'utf8'));

  const terminal = await client.createTerminal();
  log(`job ${jobId}: started terminal ${terminal}`);
  const ws = await client.sendTerminalCommand(
    terminal,
    `python ${jobDir}/runner.py`
  );

  const results = [];
  try {
    // Poll result files in order; overall deadline scales with the work.
    // The runner enforces `timeout` per notebook as a hard wall-clock limit;
    // the extra 60s here is transport slack (polling interval, Contents API
    // latency) and never extends execution time.
    const overallDeadline = Date.now() + timeout * 1000 * items.length + 60_000;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      log(`running ${item.path} (${item.renderer}) ...`);
      const remote = await pollForResult(client, jobDir, i, overallDeadline);
      if (remote === null) {
        // done.json appeared without this result → fail-fast skipped the rest
        for (let j = i; j < items.length; j++) {
          results.push({ path: items[j].path, renderer: items[j].renderer, status: 'skipped' });
        }
        break;
      }
      const result = await materializeResult(client, jobDir, item, remote, outputDir, log);
      results.push(result);
    }
  } finally {
    try {
      ws.close();
    } catch {}
    await client.deleteTerminal(terminal);
    if (!keepRemoteArtifacts) {
      log(`job ${jobId}: cleaning up remote ${workDir}/`);
      await client.delete(workDir).catch(() => {});
    }
  }

  const success =
    results.length === items.length && results.every((r) => r.status === 'passed');
  return { success, results };
}

/** Verify required tools and the terminals API before doing any work. */
export async function preflight(client, items, log = () => {}) {
  if (!(await client.terminalsAvailable())) {
    throw new NbverifyError('TOOL_UNAVAILABLE', 'server does not expose api/terminals');
  }
  for (const item of items) {
    const model = await client.getContents(item.path, { content: 0 });
    if (!model) {
      throw new NbverifyError('FILE_NOT_FOUND', `not on server: ${item.path}`);
    }
  }
  const needed = new Set(items.map((it) => it.renderer));
  if (needed.size === 0) return;

  // Tool checks also go through the file protocol (no output parsing).
  const workDir = await client.resolveWorkDir();
  const checkId = crypto.randomBytes(6).toString('hex');
  const checkDir = `${workDir}/check-${checkId}`;
  const script = `
import json, os, subprocess
here = os.path.dirname(os.path.abspath(__file__))
out = {}
for tool, cmd in {
    "quarto": ["quarto", "--version"],
    "nbconvert": ["jupyter", "nbconvert", "--version"],
}.items():
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        out[tool] = {"ok": p.returncode == 0, "version": (p.stdout or p.stderr).strip()}
    except Exception as e:
        out[tool] = {"ok": False, "error": str(e)}
tmp = os.path.join(here, "tools.json.tmp")
with open(tmp, "w") as f:
    json.dump(out, f)
os.replace(tmp, os.path.join(here, "tools.json"))
`;
  await client.putTextFile(`${checkDir}/check.py`, script);
  const terminal = await client.createTerminal();
  const ws = await client.sendTerminalCommand(terminal, `python ${checkDir}/check.py`);
  let tools;
  try {
    tools = await pollForJson(client, `${checkDir}/tools.json`, Date.now() + 180_000);
  } finally {
    try {
      ws.close();
    } catch {}
    await client.deleteTerminal(terminal);
    await client.delete(checkDir).catch(() => {});
  }
  for (const renderer of needed) {
    const info = tools[renderer];
    if (!info?.ok) {
      throw new NbverifyError(
        'TOOL_UNAVAILABLE',
        `${renderer} is not available on the server (${info?.error ?? info?.version ?? 'unknown'})`
      );
    }
    log(`preflight: ${renderer} ${info.version.split('\n')[0]}`);
  }
}

async function pollForResult(client, jobDir, index, deadline) {
  const resultPath = `${jobDir}/result-${index}.json`;
  const donePath = `${jobDir}/done.json`;
  for (;;) {
    const model = await client.getContents(resultPath, { type: 'file', format: 'text' });
    if (model) return JSON.parse(model.content);
    const done = await client.getContents(donePath, { content: 0 });
    if (done) {
      // one more check in case result landed between the two requests
      const again = await client.getContents(resultPath, { type: 'file', format: 'text' });
      if (again) return JSON.parse(again.content);
      return null;
    }
    if (Date.now() > deadline) {
      throw new NbverifyError('EXECUTION_TIMEOUT', `timed out waiting for ${resultPath}`);
    }
    await sleep(2000);
  }
}

async function pollForJson(client, remotePath, deadline) {
  for (;;) {
    const model = await client.getContents(remotePath, { type: 'file', format: 'text' });
    if (model) return JSON.parse(model.content);
    if (Date.now() > deadline) {
      throw new NbverifyError('EXECUTION_TIMEOUT', `timed out waiting for ${remotePath}`);
    }
    await sleep(2000);
  }
}

async function materializeResult(client, jobDir, item, remote, outputDir, log) {
  const base = {
    path: item.path,
    renderer: item.renderer,
    exit_code: remote.exit_code,
    duration_seconds: remote.duration_seconds,
  };

  if (remote.exit_code === 0 && remote.html) {
    const htmlLocal = path.join(
      outputDir,
      ...item.path.split('/').slice(0, -1),
      item.path.split('/').pop().replace(/\.(ipynb|qmd)$/, '.html')
    );
    const buf = await client.downloadFile(`${jobDir}/${remote.html}`);
    await writeFileAtomic(htmlLocal, buf);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    log(`passed  ${item.path} → ${htmlLocal} (${remote.duration_seconds}s)`);
    return { ...base, status: 'passed', html: htmlLocal, sha256 };
  }

  const status = remote.timed_out ? 'timeout' : 'failed';
  const stderrLog = path.join(
    outputDir,
    'logs',
    item.path.split('/').pop().replace(/\.(ipynb|qmd)$/, '') + '.stderr.log'
  );
  await writeFileAtomic(stderrLog, Buffer.from(remote.stderr ?? '', 'utf8'));
  log(`${status.toUpperCase()}  ${item.path} (exit ${remote.exit_code}, ${remote.duration_seconds}s) — stderr: ${stderrLog}`);
  return {
    ...base,
    status,
    error: summarizeError(remote),
    stderr_log: stderrLog,
  };
}

function summarizeError(remote) {
  if (remote.timed_out) return 'EXECUTION_TIMEOUT: renderer exceeded timeout';
  const text = `${remote.stderr ?? ''}\n${remote.stdout ?? ''}`;
  const lines = text.split('\n').filter((l) => l.trim());
  const interesting = lines.find(
    (l) => /Error|error|Exception|Traceback|FAILED/.test(l)
  );
  return (interesting ?? lines[lines.length - 1] ?? 'execution failed').trim().slice(0, 500) +
    ' (full stderr in log)';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
