import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { NbverifyError } from '../errors.js';

/**
 * repo2docker backend: build the image locally, run it detached with a
 * random token, poll until the Jupyter server answers.
 *
 * Requires repo2docker and Docker (on Windows: WSL).
 */

/** Spawn without a shell, stream stderr/stdout to log, resolve exit code. */
function run(cmd, args, { log = () => {}, echo = false } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(new NbverifyError('PROVISIONING_FAILED', `cannot spawn ${cmd}: ${err.message}`));
    }
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d;
      if (echo) process.stderr.write(d);
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
      if (echo) process.stderr.write(d);
    });
    proc.on('error', (err) => {
      reject(
        new NbverifyError(
          'PROVISIONING_FAILED',
          err.code === 'ENOENT' ? `${cmd} not found on PATH` : `${cmd}: ${err.message}`
        )
      );
    });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function pingServer(port, token) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/`, {
      headers: { Authorization: `token ${token}` },
      redirect: 'follow',
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function containerRunning(containerId) {
  const { code, stdout } = await run('docker', ['inspect', '-f', '{{.State.Running}}', containerId]);
  return code === 0 && stdout.trim() === 'true';
}

export async function start(repoUrl, { ref, launchTimeout = 3600, log = () => {} } = {}) {
  // Docker availability first: clearest possible error.
  const dockerCheck = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (dockerCheck.code !== 0) {
    throw new NbverifyError('PROVISIONING_FAILED', 'Docker daemon not available (is Docker running?)');
  }

  const id = crypto.randomBytes(4).toString('hex');
  const image = `nbverify-${id}`;

  // 1. Build.
  const buildArgs = ['--no-run', '--image-name', image];
  if (ref) buildArgs.push('--ref', ref);
  buildArgs.push(repoUrl);
  log(`repo2docker: building ${image} from ${repoUrl}${ref ? `@${ref}` : ''} (output follows)`);
  const build = await run('repo2docker', buildArgs, { echo: true });
  if (build.code !== 0) {
    throw new NbverifyError('PROVISIONING_FAILED', `repo2docker build failed (exit ${build.code})`);
  }

  // 2. Run detached with a random token.
  const token = crypto.randomBytes(24).toString('hex');
  const port = await freePort();
  const commands = [
    ['jupyter', 'server', '--ip=0.0.0.0', `--IdentityProvider.token=${token}`],
    // Fallback for older images without jupyter-server.
    ['jupyter', 'notebook', '--ip=0.0.0.0', `--NotebookApp.token=${token}`],
  ];

  let containerId = null;
  try {
    for (const command of commands) {
      log(`repo2docker: starting container (${command.slice(0, 2).join(' ')}) on 127.0.0.1:${port}`);
      const runRes = await run('docker', [
        'run', '-d',
        '-l', 'nbverify=1',
        '-p', `127.0.0.1:${port}:8888`,
        image,
        ...command,
      ]);
      if (runRes.code !== 0) {
        throw new NbverifyError('PROVISIONING_FAILED', `docker run failed: ${runRes.stderr.trim().slice(0, 500)}`);
      }
      containerId = runRes.stdout.trim();

      // 3. Poll until ready (or the container dies → try the fallback).
      const deadline = Date.now() + launchTimeout * 1000;
      let died = false;
      while (Date.now() < deadline) {
        if (await pingServer(port, token)) {
          log(`repo2docker: server ready at http://127.0.0.1:${port}/`);
          return {
            serverUrl: `http://127.0.0.1:${port}/`,
            token,
            backendState: { container_id: containerId, image, port },
          };
        }
        if (!(await containerRunning(containerId))) {
          died = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      const { stdout: logs } = await run('docker', ['logs', '--tail', '15', containerId]);
      await run('docker', ['rm', '-f', containerId]);
      containerId = null;
      if (died && command !== commands[commands.length - 1]) {
        log('repo2docker: container exited immediately; trying notebook-server fallback');
        continue;
      }
      throw new NbverifyError(
        'PROVISIONING_FAILED',
        died
          ? `container exited before the server came up: ${logs.trim().slice(-500)}`
          : `server not ready after ${launchTimeout}s`
      );
    }
    throw new NbverifyError('PROVISIONING_FAILED', 'no server command succeeded');
  } catch (err) {
    if (containerId) await run('docker', ['rm', '-f', containerId]).catch(() => {});
    throw err;
  }
}

export async function status(session) {
  const { container_id: cid, port } = session.backend_state ?? {};
  if (!cid) return { running: false, detail: 'no container_id in session' };
  if (!(await containerRunning(cid))) return { running: false, detail: 'container not running' };
  const ready = await pingServer(port, session.token);
  return { running: ready, detail: ready ? 'server responding' : 'container up, server not responding' };
}

export async function stop(session, { removeImage = false, log = () => {} } = {}) {
  const { container_id: cid, image } = session.backend_state ?? {};
  if (cid) {
    const res = await run('docker', ['rm', '-f', cid]);
    log(
      res.code === 0
        ? `repo2docker: removed container ${cid.slice(0, 12)}`
        : `repo2docker: container already gone (${res.stderr.trim().slice(0, 120)})`
    );
  }
  if (removeImage && image) {
    const res = await run('docker', ['rmi', image]);
    log(res.code === 0 ? `repo2docker: removed image ${image}` : `repo2docker: image not removed (${res.stderr.trim().slice(0, 120)})`);
  }
}
