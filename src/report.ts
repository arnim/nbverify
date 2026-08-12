import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunReport } from './types.js';

/**
 * Write artifacts/run-report.json (atomically).
 * @returns path of the written report
 */
export async function writeReport(outputDir: string, report: RunReport): Promise<string> {
  const file = path.join(outputDir, 'run-report.json');
  await fs.mkdir(outputDir, { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(report, null, 2) + '\n');
  await fs.rename(tmp, file);
  return file;
}
