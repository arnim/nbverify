import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Write data to a file atomically, creating its parent directory if needed. */
export async function writeFileAtomic(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, filePath);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
