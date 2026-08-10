import fs from 'node:fs/promises';

/**
 * Session file handling. The file contains the server token, so it is
 * written with mode 0600 on POSIX (best-effort on Windows, where chmod is
 * a no-op for the group/other bits).
 */

/** @returns {object} the session as written */
export function makeSession({ backend, repository, ref, serverUrl, token, backendState = {} }) {
  return {
    backend,
    repository,
    ref,
    server_url: serverUrl,
    token,
    created_at: new Date().toISOString(),
    backend_state: backendState,
  };
}

export async function writeSession(file, session) {
  const json = JSON.stringify(session, null, 2) + '\n';
  await fs.writeFile(file, json, { mode: 0o600 });
  // writeFile's mode only applies on creation; enforce on overwrite too.
  await fs.chmod(file, 0o600).catch(() => {});
  return json;
}

export async function readSession(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
