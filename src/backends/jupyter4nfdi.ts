import { NbverifyError } from '../errors.js';
import type { BackendStatus, Session, StartedServer, StartOptions, StopOptions } from '../types.js';

/**
 * jupyter4nfdi backend: start a repo2docker-built server on
 * https://hub.nfdi-jupyter.de via its Hub API.
 *
 * The Hub API token doubles as the Jupyter server token (long-lived
 * credential — never printed or logged; supplied via --token-env,
 * default JUPYTER4NFDI_TOKEN).
 */

const HUB = 'https://hub.nfdi-jupyter.de';

interface HubStartResponse {
  status_url: string;
  delete_url: string;
}

interface HubStatusResponse {
  status: string;
  next_url?: string;
  message?: string;
  detail?: string;
  logs?: string[];
}

interface NfdiState {
  status_url?: string;
  delete_url?: string;
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
  { ref = 'main', token, launchTimeout = 1800, log = () => {} }: StartOptions = {}
): Promise<StartedServer> {
  if (!token) {
    throw new NbverifyError('AUTHENTICATION_FAILED', 'no Jupyter4NFDI token (set JUPYTER4NFDI_TOKEN or --token-env)');
  }
  const spec = githubSpec(repoUrl);
  log(`jupyter4nfdi: requesting server for ${spec}@${ref}`);

  let res: Response;
  try {
    res = await fetch(`${HUB}/hub/api/start`, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        option: 'repo2docker',
        repo2docker: { repotype: 'gh', repourl: spec, reporef: ref },
      }),
    });
  } catch (err) {
    throw new NbverifyError('PROVISIONING_FAILED', `cannot reach ${HUB}: ${(err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new NbverifyError('AUTHENTICATION_FAILED', `hub API returned ${res.status}`);
  }
  if (res.status !== 202) {
    throw new NbverifyError(
      'PROVISIONING_FAILED',
      `POST hub/api/start returned ${res.status}: ${(await res.text()).slice(0, 500)}`
    );
  }
  const { status_url: statusUrl, delete_url: deleteUrl } = (await res.json()) as HubStartResponse;

  const deadline = Date.now() + launchTimeout * 1000;
  // The first poll may transiently report "stopped" before the hub
  // registers the spawn; only treat stopped/failed as terminal after a
  // short grace period or once we've seen the spawn pending.
  const graceUntil = Date.now() + 30_000;
  let seenPending = false;
  for (;;) {
    const poll = await fetch(statusUrl, { headers: { Authorization: `token ${token}` } });
    if (!poll.ok) {
      throw new NbverifyError('PROVISIONING_FAILED', `GET status_url returned ${poll.status}`);
    }
    const state = (await poll.json()) as HubStatusResponse;
    log(`jupyter4nfdi: ${state.status}`);
    if (state.status === 'running' && state.next_url) {
      return {
        serverUrl: state.next_url,
        token,
        backendState: { status_url: statusUrl, delete_url: deleteUrl },
      };
    }
    if (state.status === 'pending') seenPending = true;
    const terminal =
      state.status === 'failed' ||
      (state.status === 'stopped' && (seenPending || Date.now() > graceUntil));
    if (terminal) {
      // Best effort: clean up the failed server record.
      await fetch(deleteUrl, {
        method: 'DELETE',
        headers: { Authorization: `token ${token}` },
      }).catch(() => {});
      const logs = Array.isArray(state.logs) ? state.logs.slice(-5).join('\n') : '';
      throw new NbverifyError(
        'PROVISIONING_FAILED',
        `server ${state.status}: ${state.message ?? state.detail ?? (logs || 'no detail from hub')}`
      );
    }
    if (Date.now() > deadline) {
      await deleteServer(deleteUrl, token).catch(() => {});
      throw new NbverifyError('PROVISIONING_FAILED', `launch timed out after ${launchTimeout}s`);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

export async function status(session: Session): Promise<BackendStatus> {
  const { status_url: statusUrl } = (session.backend_state ?? {}) as NfdiState;
  if (!statusUrl) return { running: false, detail: 'no status_url in session' };
  try {
    const res = await fetch(statusUrl, {
      headers: { Authorization: `token ${session.token}` },
    });
    if (!res.ok) return { running: false, detail: `GET status_url → ${res.status}` };
    const state = (await res.json()) as HubStatusResponse;
    return { running: state.status === 'running', detail: state.status };
  } catch (err) {
    return { running: false, detail: (err as Error).message };
  }
}

export async function stop(session: Session, { log = () => {} }: StopOptions = {}): Promise<void> {
  const { delete_url: deleteUrl } = (session.backend_state ?? {}) as NfdiState;
  if (!deleteUrl) {
    throw new NbverifyError('PROVISIONING_FAILED', 'no delete_url in session');
  }
  await deleteServer(deleteUrl, session.token);
  log('jupyter4nfdi: server deleted');
}

async function deleteServer(deleteUrl: string, token: string): Promise<void> {
  const res = await fetch(deleteUrl, {
    method: 'DELETE',
    headers: { Authorization: `token ${token}` },
  });
  if (!(res.ok || res.status === 404)) {
    throw new NbverifyError('PROVISIONING_FAILED', `DELETE delete_url returned ${res.status}`);
  }
}
