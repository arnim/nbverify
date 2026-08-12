import { NbverifyError } from '../errors.js';
import type { BackendStatus, Session, StartedServer, StartOptions, StopOptions } from '../types.js';

/**
 * binderbot backend: launch on a BinderHub (default mybinder.org).
 *
 * Decision (spike 2): the `binderbot` npm package (0.1.4) is CLI-only — its
 * BinderHub client is a devDependency bundled into a `process.exit`-ing
 * binary — so it is not usable as a library. We drive the BinderHub build
 * endpoint directly: `GET {hub}/build/gh/OWNER/REPO/REF` with
 * `Accept: text/event-stream` (required, otherwise 400), parse `data:`
 * events until phase `ready` yields `{url, token}`. This is the same
 * protocol binderbot wraps.
 */

const DEFAULT_HUB = 'https://mybinder.org/';

interface BuildEvent {
  phase?: string;
  message?: string;
  url?: string;
  token?: string;
}

/** Extract OWNER/REPO from a GitHub URL. */
function githubSpec(repoUrl: string): string {
  const m = repoUrl.match(/^(?:https?:\/\/github\.com\/)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) {
    throw new NbverifyError('PROVISIONING_FAILED', `not a GitHub repository URL: ${repoUrl}`);
  }
  return `${m[1]}/${m[2]}`;
}

export async function start(
  repoUrl: string,
  { ref = 'HEAD', binderhub = DEFAULT_HUB, launchTimeout = 1800, log = () => {} }: StartOptions = {}
): Promise<StartedServer> {
  const hub = binderhub.endsWith('/') ? binderhub : binderhub + '/';
  const spec = githubSpec(repoUrl);
  const buildUrl = `${hub}build/gh/${spec}/${encodeURIComponent(ref)}`;
  log(`binderbot: building ${spec}@${ref} on ${hub}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), launchTimeout * 1000);
  let res: Response;
  try {
    res = await fetch(buildUrl, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new NbverifyError('PROVISIONING_FAILED', `cannot reach ${hub}: ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    throw new NbverifyError('PROVISIONING_FAILED', `${buildUrl} returned ${res.status}`);
  }

  try {
    const decoder = new TextDecoder();
    let buf = '';
    let lastMessage = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = event.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let data: BuildEvent;
        try {
          data = JSON.parse(line.slice(5)) as BuildEvent;
        } catch {
          continue;
        }
        if (data.message) {
          lastMessage = data.message.trim();
          log(`binderbot: [${data.phase ?? '?'}] ${lastMessage.split('\n').pop()}`);
        }
        if (data.phase === 'ready' && data.url && data.token) {
          return {
            serverUrl: data.url,
            token: data.token,
            backendState: { binderhub: hub },
          };
        }
        if (data.phase === 'failed') {
          throw new NbverifyError('PROVISIONING_FAILED', lastMessage || 'BinderHub build failed');
        }
      }
    }
    throw new NbverifyError(
      'PROVISIONING_FAILED',
      `BinderHub event stream ended without ready/failed (last: ${lastMessage || 'none'})`
    );
  } catch (err) {
    if ((err as Error).name === 'AbortError' || controller.signal.aborted) {
      throw new NbverifyError('PROVISIONING_FAILED', `launch timed out after ${launchTimeout}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    controller.abort(); // release the stream if we returned early
  }
}

export async function status(session: Session): Promise<BackendStatus> {
  try {
    const res = await fetch(`${session.server_url}api/`, {
      headers: { Authorization: `token ${session.token}` },
    });
    return { running: res.ok, detail: `GET api/ → ${res.status}` };
  } catch (err) {
    return { running: false, detail: (err as Error).message };
  }
}

export async function stop(session: Session, { log = () => {} }: StopOptions = {}): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${session.server_url}api/shutdown`, {
      method: 'POST',
      headers: { Authorization: `token ${session.token}` },
    });
  } catch (err) {
    // Server already gone (culled or shut down) → idempotent success.
    log(`binderbot: server unreachable during stop (${(err as Error).message}); treating as stopped`);
    return;
  }
  if (res.ok || res.status === 404 || res.status === 503) {
    log('binderbot: server shut down');
    return;
  }
  throw new NbverifyError('PROVISIONING_FAILED', `POST api/shutdown returned ${res.status}`);
}
