/**
 * End-to-end suite: drives `nbverify test` against real backends.
 *
 * Run everything:            npm test
 * One backend:               npm test -- --test-name-pattern "repo2docker"
 * One case:                  npm test -- --test-name-pattern "repo2docker/python-jupyter"
 *
 * Backends whose prerequisites are missing (Docker, JUPYTER4NFDI_TOKEN)
 * are skipped with a reason, not failed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CASES, REPOS } from './matrix.js';
import { runCli, freshDir, readReport, exists, orphanContainers, skipReason } from './helpers.js';

for (const { backend, repo, expect, timeoutMin } of CASES) {
  const repoDef = REPOS[repo];
  const name = `${backend}/${repo}`;

  test(name, { timeout: timeoutMin * 60_000, concurrency: false }, async (t) => {
    const reason = await skipReason(backend);
    if (reason) return t.skip(reason);

    const outputDir = await freshDir(`${backend}-${repo}`);
    t.after(() => fs.rm(outputDir, { recursive: true, force: true }));

    const args = [
      'test', repoDef.url,
      '--backend', backend,
      '--output-dir', outputDir,
    ];
    if (backend === 'repo2docker') args.push('--remove-image');

    const res = await runCli(args, { timeoutMs: timeoutMin * 60_000 - 10_000 });
    assert.equal(res.timedOut, false, 'CLI must not hang');

    if (expect === 'provisioning-failure') {
      assert.equal(res.code, 3, `exit 3 expected\nstderr:\n${res.stderr.slice(-2000)}`);
      assert.match(res.stderr, /PROVISIONING_FAILED/);
      assert.equal(await exists(path.join(outputDir, 'run-report.json')), false,
        'no report on provisioning failure');
    } else {
      // 'mixed': one passing, one failing notebook → exit 1
      assert.equal(res.code, 1, `exit 1 expected\nstderr:\n${res.stderr.slice(-2000)}`);

      const report = await readReport(outputDir);
      assert.equal(report.repository, repoDef.url);
      assert.equal(report.backend, backend);
      assert.equal(report.success, false);
      assert.equal(report.results.length, 2);

      const passed = report.results.find((r) => r.path === repoDef.success);
      assert.equal(passed.status, 'passed');
      assert.match(passed.sha256, /^[0-9a-f]{64}$/);
      assert.ok(await exists(passed.html), `HTML artifact missing: ${passed.html}`);
      const html = await fs.readFile(passed.html, 'utf8');
      assert.match(html, /<html/i);

      const failed = report.results.find((r) => r.path === repoDef.failure);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.exit_code === 0, false);
      assert.ok(failed.error, 'failed result carries an error summary');
      assert.ok(await exists(failed.stderr_log), `stderr log missing: ${failed.stderr_log}`);
    }

    if (backend === 'repo2docker') {
      assert.deepEqual(await orphanContainers(), [], 'no orphaned nbverify containers');
    }
  });
}
