import * as repo2docker from './repo2docker.js';
import * as binder from './binder.js';
import * as jupyter4nfdi from './jupyter4nfdi.js';

/**
 * Uniform backend interface:
 *   start(repoUrl, opts) → { serverUrl, token, backendState }
 *   status(session)      → { running, detail }
 *   stop(session, opts)  → void (idempotent)
 */
const backends = { repo2docker, binder, jupyter4nfdi };

export function getBackend(name) {
  const backend = backends[name];
  if (!backend) {
    throw new Error(`unknown backend: ${name} (expected ${Object.keys(backends).join('|')})`);
  }
  return backend;
}

export const BACKEND_NAMES = Object.keys(backends);
