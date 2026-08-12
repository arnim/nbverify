# nbverify test suite

Black-box tests that drive the `nbverify` CLI as a subprocess and assert
only on its public contract: arguments, exit codes, `run-report.json`,
downloaded artifacts, and cleanup. Nothing here touches `src/` internals,
so the suite is unchanged by refactors (e.g. a TypeScript conversion) —
if it stays green, the tool still works.

Built on Node's `node:test` runner — no test dependencies.

## Layout

- `matrix.js` — the backend × repository matrix as data (one e2e test is
  generated per case). Add a repo or a case here, nothing else.
  Repos with a `timeout` notebook (`timeout.ipynb` / `timeout.qmd`: several
  sleeps that each fit the budget but together exceed it) also verify that
  `--timeout` is a wall-clock per-notebook limit, not a per-cell one.
- `helpers.js` — subprocess runner, temp dirs, report reader, backend
  availability probes, orphan-container check.
- `cli.test.js` — fast, offline contract tests (`cli/…`, seconds).
- `e2e.test.js` — real provisioning runs (`<backend>/<repo>`, minutes).

## Running

```bash
npm test                                                  # everything
npm run test:fast                                         # offline CLI tests only
npm test -- --test-name-pattern "repo2docker"             # one backend
npm test -- --test-name-pattern "repo2docker/python-jupyter"  # one case
npm test -- --test-name-pattern "build-failure"           # one repo, all backends
```

Test names are `<backend>/<repo>` (e2e) and `cli/<case>` (offline), so
`--test-name-pattern` (a regex) selects any slice of the matrix.

## Prerequisites and skipping

Missing prerequisites skip the affected cases with a reason instead of
failing:

- `repo2docker/*` — needs Docker running and `repo2docker` on PATH.
- `jupyter4nfdi/*` — needs `JUPYTER4NFDI_TOKEN` set.
- `binderbot/*` — pure HTTP; only the small python repo is used against
  mybinder.org (good-citizen policy). The full renderer matrix (R, quarto)
  runs on local repo2docker.

E2E tests run sequentially (`--test-concurrency=1`): one local Docker port
at a time, one MyBinder session at a time.

Full run: ~9 min with everything available (R image builds dominate;
Docker layer cache makes reruns much faster).
