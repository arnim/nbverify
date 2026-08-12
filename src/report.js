import path from 'node:path';
import { writeFileAtomic } from './file-utils.js';

/**
 * Write artifacts/run-report.json (atomically).
 * @param {string} outputDir
 * @param {object} report
 * @returns {Promise<string>} path of the written report
 */
export async function writeReport(outputDir, report) {
  const file = path.join(outputDir, 'run-report.json');
  await writeFileAtomic(file, JSON.stringify(report, null, 2) + '\n');
  return file;
}
