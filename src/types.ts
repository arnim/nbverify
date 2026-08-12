/** Shared domain types. */

export type Renderer = 'quarto' | 'nbconvert';
export type BackendName = 'repo2docker' | 'binderbot' | 'jupyter4nfdi';

export interface RunItem {
  path: string;
  renderer: Renderer;
}

export interface NotebookEntry {
  path: string;
  kind: 'jupyter' | 'quarto';
}

/** Session file contents (see SPEC.md). */
export interface Session {
  backend: BackendName;
  repository: string;
  ref: string | null;
  server_url: string;
  token: string;
  created_at: string;
  backend_state: Record<string, unknown>;
}

/** What a backend's start() yields — uniform across all backends. */
export interface StartedServer {
  serverUrl: string;
  token: string;
  backendState: Record<string, unknown>;
}

export interface BackendStatus {
  running: boolean;
  detail: string;
}

export interface StartOptions {
  ref?: string;
  token?: string;
  binderhub?: string;
  launchTimeout?: number;
  log?: (msg: string) => void;
}

export interface StopOptions {
  removeImage?: boolean;
  log?: (msg: string) => void;
}

export interface Backend {
  start(repoUrl: string, opts?: StartOptions): Promise<StartedServer>;
  status(session: Session): Promise<BackendStatus>;
  stop(session: Session, opts?: StopOptions): Promise<void>;
}

/** result-N.json written by runner.py on the server. */
export interface RemoteResult {
  index: number;
  path: string;
  renderer: Renderer;
  command: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  duration_seconds: number;
  html: string | null;
}

export type ResultStatus = 'passed' | 'failed' | 'timeout' | 'skipped';

/** One entry in run-report.json results[]. */
export interface RunResult {
  path: string;
  renderer: Renderer;
  status: ResultStatus;
  exit_code?: number;
  duration_seconds?: number;
  html?: string;
  sha256?: string;
  error?: string;
  stderr_log?: string;
}

export interface RunReport {
  repository: string | null;
  backend: BackendName | null;
  success: boolean;
  started_at: string;
  finished_at: string;
  results: RunResult[];
}
