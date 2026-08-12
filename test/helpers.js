import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

/** Run the nbverify CLI as a subprocess (black box). */
export function runCli(args, { timeoutMs = 60 * 60_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Fresh output directory under the OS temp dir. */
export async function freshDir(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `nbverify-test-${label}-`));
}

export async function readReport(outputDir) {
  return JSON.parse(await fs.readFile(path.join(outputDir, 'run-report.json'), 'utf8'));
}

export async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.on('error', () => resolve({ code: -1, stdout: '' }));
    proc.on('close', (code) => resolve({ code, stdout }));
  });
}

/** Container IDs left behind by nbverify (label nbverify=1). */
export async function orphanContainers() {
  const { code, stdout } = await runCmd('docker', ['ps', '-aq', '--filter', 'label=nbverify=1']);
  if (code !== 0) return [];
  return stdout.trim().split('\n').filter(Boolean);
}

// ---- backend availability (memoized skip reasons) ---------------------------

let dockerReason;
export async function skipReason(backend) {
  if (backend === 'jupyter4nfdi') {
    return process.env.JUPYTER4NFDI_TOKEN ? null : 'JUPYTER4NFDI_TOKEN not set';
  }
  if (backend === 'repo2docker') {
    if (dockerReason === undefined) {
      const docker = await runCmd('docker', ['info', '--format', '{{.ServerVersion}}']);
      if (docker.code !== 0) dockerReason = 'Docker daemon not available';
      else {
        const r2d = await runCmd('repo2docker', ['--version']);
        dockerReason = r2d.code === 0 ? null : 'repo2docker not on PATH';
      }
    }
    return dockerReason;
  }
  return null; // binderbot: pure HTTP
}
