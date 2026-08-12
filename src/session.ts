import fs from 'node:fs/promises';
import type { BackendName, Session } from './types.js';

/**
 * Session file handling. The file contains the server token, so it is
 * written with mode 0600 on POSIX (best-effort on Windows, where chmod is
 * a no-op for the group/other bits).
 */

export function makeSession(args: {
  backend: BackendName;
  repository: string;
  ref: string | null;
  serverUrl: string;
  token: string;
  backendState?: Record<string, unknown>;
}): Session {
  return {
    backend: args.backend,
    repository: args.repository,
    ref: args.ref,
    server_url: args.serverUrl,
    token: args.token,
    created_at: new Date().toISOString(),
    backend_state: args.backendState ?? {},
  };
}

export async function writeSession(file: string, session: Session): Promise<string> {
  const json = JSON.stringify(session, null, 2) + '\n';
  await fs.writeFile(file, json, { mode: 0o600 });
  // writeFile's mode only applies on creation; enforce on overwrite too.
  await fs.chmod(file, 0o600).catch(() => {});
  return json;
}

export async function readSession(file: string): Promise<Session> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Session;
}
