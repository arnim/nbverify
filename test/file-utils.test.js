import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../src/file-utils.js';

test('writeFileAtomic creates parent directories and replaces the destination', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nbverify-file-utils-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'nested', 'result.txt');

  await writeFileAtomic(file, 'first');
  await writeFileAtomic(file, Buffer.from('second'));

  assert.equal(await fs.readFile(file, 'utf8'), 'second');
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['result.txt']);
});
