# nbverify — Specification

`nbverify` checks that a Binder-ready GitHub repository not only *builds* but
that its notebooks actually *execute*. It starts a Jupyter server for the
repository, runs selected notebooks remotely, and downloads the rendered HTML
— or reports the errors.

Implementation language: **JavaScript (Node.js ≥ 20)**. Runs on Linux,
macOS, and Windows.

## Design

Three independent layers:

1. **Provisioner** — starts/stops a Jupyter server for the repository:
   `repo2docker`, `binderbot`, or `jupyter4nfdi`.
2. **Server client** — talks to the standard Jupyter Server REST API
   (contents, terminals) given a server URL and token.
3. **Executor** — renders individual documents on the server with
   `quarto` or `nbconvert`, always to HTML.

Layers 2 and 3 are identical for all backends: every backend yields the same
thing — a server URL and an access token.

## CLI

### 1. `nbverify start` — provision a server

```bash
nbverify start REPO_URL --backend repo2docker|binderbot|jupyter4nfdi \
  [--ref REF] [--session session.json]
```

Writes a session file (mode `0600` on POSIX; best-effort on Windows —
since it contains the token) and prints
it to stdout; logs go to stderr:

```json
{
  "backend": "binderbot",
  "repository": "https://github.com/binder-examples/requirements",
  "ref": "main",
  "server_url": "https://hub.mybinder.org/user/.../",
  "token": "<secret>",
  "created_at": "2026-08-10T12:30:00Z",
  "backend_state": {}
}
```

Companion commands:

```bash
nbverify status --session session.json
nbverify stop   --session session.json
```

`list` and `run` (below) accept either `--session session.json` or an
explicit `--server-url URL --token-env VAR` pair.

### 2. `nbverify list` — discover notebooks (optional step)

```bash
nbverify list --session session.json [--json]
```

Recursively walks the Jupyter Contents API
(`GET {server_url}api/contents/{path}` — base path must be preserved) and
prints, lexicographically sorted:

```text
jupyter  notebooks/01-introduction.ipynb
quarto   notebooks/02-analysis.qmd
```

Recognized types: `.ipynb` (jupyter), `.qmd` (quarto).
Skipped: `.git/`, `.ipynb_checkpoints/`, `_build/`, `_site/`, `.nbverify/`,
`_nbverify/`.

### 3. `nbverify run` — execute notebooks

```bash
nbverify run --session session.json \
  [--ipynb-renderer quarto|nbconvert]   # default: nbconvert \
  [--timeout SECONDS]                   # wall-clock per notebook, default: 600 \
  [--fail-fast]                         # default: continue on error \
  [--output-dir DIR]                    # default: artifacts/ \
  PATH [PATH ...]                       # or: --from-file notebooks.txt
```

Rules:

- Notebooks execute **sequentially, in exactly the given order** (filesystem
  side effects carry over; kernel state does not — each notebook gets a
  fresh kernel).
- `.qmd` → always `quarto`; `.ipynb` → `quarto` or `nbconvert`
  (per `--ipynb-renderer`).
- A cell error fails the notebook (no `--allow-errors`); sources are never
  modified; execution is forced (no Quarto freeze/cache).
- Successful HTML is downloaded to `--output-dir`, mirroring the source
  path (`notebooks/02-analysis.ipynb` → `artifacts/notebooks/02-analysis.html`),
  written atomically. HTML from earlier successes is kept even if later
  notebooks fail.
- A machine-readable report is written to `artifacts/run-report.json`.

### 4. `nbverify test` — one-shot (start → run → stop)

```bash
nbverify test REPO_URL --backend binderbot \
  [--ref main] [--ipynb-renderer nbconvert] [--output-dir artifacts/] \
  PATH [PATH ...]     # omit paths to run all discovered notebooks in sorted order
```

Always stops the server in a `finally` block (including on Ctrl-C), unless
`--keep-session` is given.

## Backends

### repo2docker

1. `repo2docker --no-run --image-name nbverify-<id> REPO_URL` to build.
2. Generate a random token; run the image detached:
   `docker run -d -l nbverify=1 -p 127.0.0.1:<port>:8888 <image>
   jupyter server --ip=0.0.0.0 --IdentityProvider.token=<token>`
   (fall back to notebook-server option names for older images).
3. Poll `GET api/` until ready.
4. `backend_state`: container ID, image name, port. `stop` removes the
   container (and image with `--remove-image`).

### binderbot

Launch on a BinderHub (`--binderhub`, default `https://mybinder.org/`) by
driving the build endpoint directly with native `fetch`:
`GET {hub}/build/gh/OWNER/REPO/REF` with `Accept: text/event-stream`
(required — 400 without it), parsing `data:` events until phase `ready`
yields `{url, token}` or phase `failed` aborts with the build log message.
(The `binderbot` npm package (2i2c) wraps this same protocol but is
CLI-only — its client is a bundled, `process.exit`-ing binary — so it is
not usable as a library.) Federation redirects (e.g. to GESIS/2i2c
members) are handled by the hub itself. `stop` calls the server's
`POST api/shutdown`. Public GitHub repositories only (MyBinder constraint).

### jupyter4nfdi

`POST https://hub.nfdi-jupyter.de/hub/api/start` with
`Authorization: token $JUPYTER4NFDI_TOKEN` and body:

```json
{ "option": "repo2docker",
  "repo2docker": { "repotype": "gh", "repourl": "OWNER/REPO", "reporef": "main" } }
```

On `202`, poll the returned `status_url` until running or failed.
`backend_state` keeps `status_url` and `delete_url`; `stop` is
`DELETE delete_url` (404 = already stopped). The first status poll may
transiently report `stopped` before the hub registers the spawn, so
`stopped` only counts as terminal after a pending state was seen (or a
short grace period). Build failures surface in the status payload's
`logs`, which are included in the `PROVISIONING_FAILED` message.

**Note:** the Hub API token itself is reused as the Jupyter server token —
it is a long-lived credential, so it is never printed or logged and should be
supplied via `--token-env` (default `JUPYTER4NFDI_TOKEN`).

## Remote execution

Jupyter Server cannot run shell commands via REST, so `nbverify` uses its
terminal API with a file-based protocol (no terminal output parsing, no shell
interpolation of user paths):

1. Upload `<workdir>/job-<id>/request.json` (ordered notebook list, renderers,
   timeouts) and `<workdir>/job-<id>/runner.py` (stdlib-only Python — Python
   is guaranteed in every repo2docker image) via the Contents API.
   `<workdir>` is `.nbverify`, falling back to `_nbverify` where the
   Contents API rejects hidden paths (`ContentsManager.allow_hidden` is
   `False` by default → HTTP 400).
2. `POST api/terminals`, connect to its WebSocket, send one fixed command:
   `python <workdir>/job-<id>/runner.py`. The WebSocket stays open for the
   duration of the job so idle-culling doesn't kill the terminal; results
   still flow only through files.
3. The runner executes each item via `subprocess`:
   - `quarto render PATH --to html --execute --no-cache --output N.html`
     (`--output` must be a bare filename and Quarto writes it next to the
     input — `--output-dir` may not point outside the project — so the
     runner moves the file into the job dir afterwards; the render runs
     from the document's own directory because Quarto's embed-resources
     post-processing resolves the `<name>_files/` support dir against the
     CWD, which breaks for subdirectory documents otherwise)
   - `jupyter nbconvert --to html --execute PATH --output N
     --output-dir <job-dir> --ExecutePreprocessor.timeout=-1`

   `--timeout` is a wall-clock limit for the entire notebook, enforced
   uniformly for both renderers via the runner's `subprocess` timeout (the
   renderer's process group is killed on expiry); nbconvert's per-cell
   timeout is disabled so only the process-level deadline is authoritative.
   The executor's polling grace is transport slack only and never extends
   execution time.

   and writes `<job-dir>/result-N.json` (exit code, duration, stdout/stderr)
   after each item, plus `done.json` at the end.
4. The CLI polls the result files via the Contents API, downloads each HTML
   on success, then deletes `<workdir>/` (unless `--keep-remote-artifacts`).

**Preflight** (before running): check `quarto --version` and/or
`jupyter nbconvert --version` for the renderers actually needed, and that
`api/terminals` is available. Tool checks reuse the same terminal +
file protocol (`<workdir>/check-<id>/check.py` → `tools.json`), so terminal
output is never parsed anywhere. Missing tools are a clear, immediate error
(`TOOL_UNAVAILABLE`) — nbverify never installs tools into the environment
under test.

## Report and errors

`run-report.json`:

```json
{
  "repository": "https://github.com/...",
  "backend": "binderbot",
  "success": false,
  "started_at": "...", "finished_at": "...",
  "results": [
    { "path": "notebooks/01-introduction.qmd", "renderer": "quarto",
      "status": "passed", "exit_code": 0, "duration_seconds": 32.8,
      "html": "artifacts/notebooks/01-introduction.html", "sha256": "..." },
    { "path": "notebooks/02-analysis.ipynb", "renderer": "nbconvert",
      "status": "failed", "exit_code": 1, "duration_seconds": 4.2,
      "error": "CellExecutionError: ... (full stderr in log)",
      "stderr_log": "artifacts/logs/02-analysis.stderr.log" }
  ]
}
```

Error codes: `PROVISIONING_FAILED`, `SERVER_UNREACHABLE`,
`AUTHENTICATION_FAILED`, `FILE_NOT_FOUND`, `TOOL_UNAVAILABLE`,
`EXECUTION_FAILED`, `EXECUTION_TIMEOUT`, `DOWNLOAD_FAILED`.

Exit codes:

| Code | Meaning |
|---:|---|
| 0 | all notebooks passed |
| 1 | one or more notebooks failed |
| 2 | invalid arguments |
| 3 | provisioning failed |
| 4 | server communication failed |
| 5 | required tool/capability missing |
| 130 | interrupted |

## Implementation

Dependencies: `commander` (CLI), `ws` (terminal WebSocket), native `fetch`
(REST); everything else stdlib.

```text
nbverify/
├── package.json       # "bin": {"nbverify": "src/cli.js"} → npm install -g / npx
├── src/
│   ├── cli.js
│   ├── backends/      # repo2docker.js, binderbot.js, jupyter4nfdi.js
│   ├── jupyter.js     # Contents + terminals client
│   ├── executor.js    # job orchestration, polling, download
│   ├── runner.py      # uploaded to the server, stdlib-only
│   └── report.js
└── skill/             # later: Agent Skill (agentskills.io)
    └── SKILL.md       # tells an agent when and how to invoke the nbverify CLI
```

The Agent Skill is a thin wrapper around the CLI: `SKILL.md` describes the
commands (`nbverify test ...` etc.) and how to read `run-report.json`. The
CLI never depends on `skill/`, so standalone use is unaffected.

### Cross-platform notes

- No shell-specific code: spawn processes without a shell; build local paths
  with Node's `path`; remote (Jupyter API) paths always use `/`.
- `binderbot` and `jupyter4nfdi` backends are pure HTTP and work everywhere.
  The `repo2docker` backend requires Docker and, on Windows, WSL (where
  repo2docker is supported).
