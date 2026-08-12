/**
 * The test matrix as data. Each case drives `nbverify test` (black-box,
 * via subprocess) against a real backend and asserts on exit code,
 * run-report.json, and downloaded artifacts — the CLI contract only,
 * nothing about the implementation.
 */

const GH = 'https://github.com/arnim';

export const REPOS = {
  'python-jupyter': {
    url: `${GH}/repo2docker-python-jupyter-test`,
    success: 'success.ipynb',
    failure: 'execution-failure.ipynb',
    // six 15s cells (90s total): each cell fits a 60s budget, the whole
    // notebook does not — only a wall-clock per-notebook timeout catches it
    timeout: 'timeout.ipynb',
    timeoutSeconds: 60,
  },
  'python-quarto': {
    url: `${GH}/repo2docker-python-quarto-test`,
    success: 'success.qmd',
    failure: 'execution-failure.qmd',
    // quarto renders are slower (pandoc + kernel startup), so this repo
    // uses a 120s budget and 6×30s sleeps (180s total)
    timeout: 'timeout.qmd',
    timeoutSeconds: 120,
  },
  'r-jupyter': {
    url: `${GH}/repo2docker-r-jupyter-test`,
    success: 'success.ipynb',
    failure: 'execution-failure.ipynb',
  },
  'r-quarto': {
    url: `${GH}/repo2docker-r-quarto-test`,
    success: 'success.qmd',
    failure: 'execution-failure.qmd',
  },
  'build-failure': {
    url: `${GH}/repo2docker-build-failure-test`,
  },
};

/**
 * expect: 'mixed'  → exit 1; success notebook passes (HTML + sha256),
 *                    failure notebook fails (stderr log); report written.
 *                    Repos with a `timeout` notebook additionally run it with
 *                    `--timeout <timeoutSeconds>` and expect status 'timeout'
 *                    after ~timeoutSeconds wall-clock (not per cell).
 * expect: 'provisioning-failure' → exit 3, PROVISIONING_FAILED, no report.
 *
 * Remote backends only get the small python repo (good-citizen policy);
 * the full renderer matrix runs on local repo2docker.
 */
export const CASES = [
  { backend: 'repo2docker', repo: 'python-jupyter', expect: 'mixed', timeoutMin: 60 },
  { backend: 'repo2docker', repo: 'python-quarto', expect: 'mixed', timeoutMin: 60 },
  { backend: 'repo2docker', repo: 'r-jupyter', expect: 'mixed', timeoutMin: 90 },
  { backend: 'repo2docker', repo: 'r-quarto', expect: 'mixed', timeoutMin: 90 },
  { backend: 'repo2docker', repo: 'build-failure', expect: 'provisioning-failure', timeoutMin: 30 },
  { backend: 'binderbot', repo: 'python-jupyter', expect: 'mixed', timeoutMin: 30 },
  { backend: 'binderbot', repo: 'build-failure', expect: 'provisioning-failure', timeoutMin: 30 },
  { backend: 'jupyter4nfdi', repo: 'python-jupyter', expect: 'mixed', timeoutMin: 30 },
  { backend: 'jupyter4nfdi', repo: 'build-failure', expect: 'provisioning-failure', timeoutMin: 30 },
];
