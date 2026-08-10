import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Write artifacts/run-report.json (atomically).
 * @param {string} outputDir
 * @param {object} report
 * @returns {Promise<string>} path of the written report
 */
export async function writeReport(outputDir, report) {
  const file = path.join(outputDir, 'run-report.json');
  await fs.mkdir(outputDir, { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(report, null, 2) + '\n');
  await fs.rename(tmp, file);
  return file;
}
