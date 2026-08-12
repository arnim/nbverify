/**
 * Fast, offline CLI-contract tests (argument validation, exit code 2).
 * These need no backend and run in a couple of seconds:
 *   npm test -- --test-name-pattern "cli"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from './helpers.js';

test('cli/unknown-command exits 2', async () => {
  const res = await runCli(['frobnicate']);
  assert.equal(res.code, 2);
});

test('cli/invalid-backend exits 2', async () => {
  const res = await runCli(['test', 'https://github.com/x/y', '--backend', 'nope']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /repo2docker, binderbot, jupyter4nfdi/);
});

test('cli/run-without-connection exits 2', async () => {
  const res = await runCli(['run', 'a.ipynb']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /--session|--server-url/);
});

test('cli/run-unsupported-file-type exits 2', async () => {
  const res = await runCli([
    'run', '--server-url', 'http://127.0.0.1:1/', '--token-env', 'PATH', 'notes.txt',
  ]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unsupported file type/);
});

test('cli/negative-timeout exits 2', async () => {
  const res = await runCli([
    'run', '--server-url', 'http://127.0.0.1:1/', '--token-env', 'PATH',
    '--timeout', '-5', 'a.ipynb',
  ]);
  assert.equal(res.code, 2);
});

test('cli/help exits 0', async () => {
  const res = await runCli(['--help']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /start|test/);
});

test('cli/unreachable-server exits 4', async () => {
  const res = await runCli(
    ['list', '--server-url', 'http://127.0.0.1:9/', '--token-env', 'PATH'],
    { timeoutMs: 30_000 }
  );
  assert.equal(res.code, 4);
  assert.match(res.stderr, /SERVER_UNREACHABLE/);
});
