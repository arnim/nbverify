/**
 * The test matrix as data. Each case drives `nbverify test` (black-box,
 * via subprocess) against a real backend and asserts on exit code,
 * run-report.json, and downloaded artifacts — the CLI contract only,
 * nothing about the implementation.
 */

const GH = 'https://github.com/arnim';

// repo2docker-test bundles the python-quarto, r-jupyter, and r-quarto
// flavors in one repository (one image: R runtime + Python requirements +
// Quarto postBuild — repo2docker installs Python and R side by side).
// Each flavor stays a separate matrix case via explicit `paths`; the tiny
// python-jupyter repo is kept separate as the minimal no-R/no-Quarto image
// (and the good-citizen fixture for remote backends).
const MERGED = `${GH}/repo2docker-test`;

export const REPOS = {
  'python-jupyter': {
    url: `${GH}/repo2docker-python-jupyter-test`,
    // no `paths`: runs all discovered notebooks, covering discovery mode
    success: 'success.ipynb',
    failure: 'execution-failure.ipynb',
    // six 15s cells (90s total): each cell fits a 60s budget, the whole
    // notebook does not — only a wall-clock per-notebook timeout catches it
    timeout: 'timeout.ipynb',
    timeoutSeconds: 60,
  },
  'python-quarto': {
    url: MERGED,
    paths: true, // run only this flavor's documents (explicit-paths mode)
    success: 'python-quarto/success.qmd',
    failure: 'python-quarto/execution-failure.qmd',
    // quarto renders are slower (pandoc + kernel startup), so this flavor
    // uses a 120s budget and 6×30s sleeps (180s total)
    timeout: 'python-quarto/timeout.qmd',
    timeoutSeconds: 120,
  },
  'r-jupyter': {
    url: MERGED,
    paths: true,
    success: 'r-jupyter/success.ipynb',
    failure: 'r-jupyter/execution-failure.ipynb',
  },
  'r-quarto': {
    url: MERGED,
    paths: true,
    success: 'r-quarto/success.qmd',
    failure: 'r-quarto/execution-failure.qmd',
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
  // the three merged-repo cases share one image; the first builds it,
  // the Docker layer cache makes the other two cheap
  { backend: 'repo2docker', repo: 'python-quarto', expect: 'mixed', timeoutMin: 90 },
  { backend: 'repo2docker', repo: 'r-jupyter', expect: 'mixed', timeoutMin: 90 },
  { backend: 'repo2docker', repo: 'r-quarto', expect: 'mixed', timeoutMin: 90 },
  { backend: 'repo2docker', repo: 'build-failure', expect: 'provisioning-failure', timeoutMin: 30 },
  { backend: 'binder', repo: 'python-jupyter', expect: 'mixed', timeoutMin: 30 },
  { backend: 'binder', repo: 'build-failure', expect: 'provisioning-failure', timeoutMin: 30 },
  { backend: 'jupyter4nfdi', repo: 'python-jupyter', expect: 'mixed', timeoutMin: 30 },
  { backend: 'jupyter4nfdi', repo: 'build-failure', expect: 'provisioning-failure', timeoutMin: 30 },
];
