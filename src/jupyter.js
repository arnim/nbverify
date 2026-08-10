import WebSocket from 'ws';
import { NbverifyError } from './errors.js';

/**
 * Client for the standard Jupyter Server REST API (contents + terminals).
 * Works with any backend that yields a server URL and a token.
 */
export class JupyterClient {
  /**
   * @param {string} serverUrl e.g. https://hub.mybinder.org/user/xyz/
   * @param {string} token
   */
  constructor(serverUrl, token) {
    this.serverUrl = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
    this.token = token;
  }

  /** @returns {string} absolute URL under the server base path */
  apiUrl(path) {
    return this.serverUrl + path.replace(/^\//, '');
  }

  async #fetch(path, options = {}) {
    const url = this.apiUrl(path);
    let res;
    try {
      res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `token ${this.token}`,
          ...(options.headers ?? {}),
        },
      });
    } catch (err) {
      throw new NbverifyError('SERVER_UNREACHABLE', `${url}: ${err.message}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new NbverifyError('AUTHENTICATION_FAILED', `${res.status} for ${url}`);
    }
    return res;
  }

  /** Check the server is reachable and the token works. */
  async ping() {
    const res = await this.#fetch('api/');
    if (!res.ok) {
      throw new NbverifyError('SERVER_UNREACHABLE', `GET api/ returned ${res.status}`);
    }
    return res.json();
  }

  // ---- Contents API -------------------------------------------------------

  /** GET api/contents/{path}. Returns the model, or null on 404. */
  async getContents(remotePath, { content = 1, format, type } = {}) {
    const params = new URLSearchParams({ content: String(content) });
    if (format) params.set('format', format);
    if (type) params.set('type', type);
    const res = await this.#fetch(
      `api/contents/${encodeRemotePath(remotePath)}?${params}`
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new NbverifyError(
        'SERVER_UNREACHABLE',
        `GET api/contents/${remotePath} returned ${res.status}`
      );
    }
    return res.json();
  }

  /** Upload a text file (creating parent directories as needed). */
  async putTextFile(remotePath, text) {
    await this.#ensureParentDirs(remotePath);
    const res = await this.#fetch(`api/contents/${encodeRemotePath(remotePath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'file', format: 'text', content: text }),
    });
    if (!res.ok) {
      throw new NbverifyError(
        'SERVER_UNREACHABLE',
        `PUT api/contents/${remotePath} returned ${res.status}: ${await res.text()}`
      );
    }
  }

  async #ensureParentDirs(remotePath) {
    const parts = remotePath.split('/').slice(0, -1);
    let dir = '';
    for (const part of parts) {
      dir = dir ? `${dir}/${part}` : part;
      const existing = await this.getContents(dir, { content: 0 });
      if (existing) continue;
      const res = await this.#fetch(`api/contents/${encodeRemotePath(dir)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'directory' }),
      });
      if (!res.ok && res.status !== 409) {
        throw new NbverifyError(
          'SERVER_UNREACHABLE',
          `PUT api/contents/${dir} (directory) returned ${res.status}: ${await res.text()}`
        );
      }
    }
  }

  /**
   * Pick the remote work directory: `.nbverify` per spec, falling back to
   * `_nbverify` on servers where the Contents API rejects hidden paths
   * (ContentsManager.allow_hidden defaults to false).
   */
  async resolveWorkDir() {
    if (this.workDir) return this.workDir;
    for (const candidate of ['.nbverify', '_nbverify']) {
      if (await this.getContents(candidate, { content: 0 })) {
        this.workDir = candidate;
        return candidate;
      }
      const res = await this.#fetch(`api/contents/${candidate}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'directory' }),
      });
      if (res.ok) {
        this.workDir = candidate;
        return candidate;
      }
    }
    throw new NbverifyError('SERVER_UNREACHABLE', 'cannot create a work directory on the server');
  }

  /**
   * Download a file as a Buffer (uses base64 format so it works for
   * binary and text alike).
   */
  async downloadFile(remotePath) {
    const model = await this.getContents(remotePath, {
      type: 'file',
      format: 'base64',
    });
    if (!model) {
      throw new NbverifyError('DOWNLOAD_FAILED', `not found on server: ${remotePath}`);
    }
    if (model.format === 'base64') {
      return Buffer.from(model.content, 'base64');
    }
    if (model.format === 'text') {
      return Buffer.from(model.content, 'utf8');
    }
    if (model.type === 'notebook') {
      return Buffer.from(JSON.stringify(model.content), 'utf8');
    }
    throw new NbverifyError('DOWNLOAD_FAILED', `unexpected format for ${remotePath}`);
  }

  /** DELETE a file or directory (directories recursively where supported). */
  async delete(remotePath) {
    const res = await this.#fetch(`api/contents/${encodeRemotePath(remotePath)}`, {
      method: 'DELETE',
    });
    return res.ok || res.status === 404;
  }

  /**
   * Recursively list notebook-like files, lexicographically sorted.
   * @returns {Promise<{path: string, kind: 'jupyter'|'quarto'}[]>}
   */
  async listNotebooks() {
    const SKIP_DIRS = new Set(['.git', '.ipynb_checkpoints', '_build', '_site', '.nbverify', '_nbverify']);
    const found = [];
    const walk = async (dir) => {
      const model = await this.getContents(dir);
      if (!model || model.type !== 'directory') return;
      for (const item of model.content ?? []) {
        const name = item.name;
        if (item.type === 'directory') {
          if (!SKIP_DIRS.has(name)) await walk(item.path);
        } else if (name.endsWith('.ipynb')) {
          found.push({ path: item.path, kind: 'jupyter' });
        } else if (name.endsWith('.qmd')) {
          found.push({ path: item.path, kind: 'quarto' });
        }
      }
    };
    await walk('');
    found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return found;
  }

  // ---- Terminals API ------------------------------------------------------

  /** Check that the terminals API is available. */
  async terminalsAvailable() {
    const res = await this.#fetch('api/terminals');
    return res.ok;
  }

  /** Create a terminal, returns its name. */
  async createTerminal() {
    const res = await this.#fetch('api/terminals', { method: 'POST' });
    if (!res.ok) {
      throw new NbverifyError(
        'TOOL_UNAVAILABLE',
        `terminals API unavailable (POST api/terminals returned ${res.status})`
      );
    }
    const model = await res.json();
    return model.name;
  }

  async deleteTerminal(name) {
    await this.#fetch(`api/terminals/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }).catch(() => {});
  }

  /**
   * Open the terminal WebSocket and send a single command line.
   * Output is not parsed; results travel through files (Contents API).
   */
  async sendTerminalCommand(name, command) {
    const wsUrl =
      this.apiUrl(`terminals/websocket/${encodeURIComponent(name)}`).replace(
        /^http/,
        'ws'
      ) + `?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `token ${this.token}` },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new NbverifyError('SERVER_UNREACHABLE', 'terminal websocket timeout')),
        30_000
      );
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(new NbverifyError('SERVER_UNREACHABLE', `terminal websocket: ${err.message}`));
      });
    });
    ws.send(JSON.stringify(['stdin', command + '\n']));
    // Keep the socket open; some servers cull terminals whose socket closes.
    return ws;
  }
}

/** Encode a remote path segment-by-segment, preserving '/' separators. */
function encodeRemotePath(remotePath) {
  return remotePath
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}
