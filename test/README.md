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
  The python-quarto, r-jupyter, and r-quarto flavors live together in
  [arnim/repo2docker-test](https://github.com/arnim/repo2docker-test)
  (repo2docker installs Python and R side by side, so one image serves all
  three); each flavor remains its own case via explicit paths, and the
  shared image is built once per run (Docker layer cache). The minimal
  python-jupyter repo stays separate — it is the only case without
  explicit paths, so it also covers discovery mode, and it keeps a small,
  fast, no-R/no-Quarto image for the remote backends.
  Repos with a `timeout` notebook (`timeout.ipynb` / `timeout.qmd`: several
  sleeps that each fit the budget but together exceed it) also verify that
  `--timeout` is a wall-clock per-notebook limit, not a per-cell one.
- `helpers.js` — subprocess runner, temp dirs, report reader, backend
  availability probes, orphan-container check.
- `cli.test.js` — fast, offline contract tests (`cli/…`, seconds).
- `e2e.test.js` — real provisioning runs (`<backend>/<repo>`, minutes).

## Running

```bash
npm test                                # everything
npm run test:fast                       # offline CLI tests only
npm run test:e2e:repo2docker:smoke      # small local image + build failure
npm run test:e2e:repo2docker            # full local renderer matrix
npm run test:e2e:binderbot              # MyBinder canaries
npm run test:e2e:jupyter4nfdi           # Jupyter4NFDI canaries

# An arbitrary slice (Node options must precede the test file):
node --test --test-concurrency=1 \
  --test-name-pattern="^repo2docker/python-jupyter$" test/e2e.test.js
```

Test names are `<backend>/<repo>` (e2e) and `cli/<case>` (offline), so
`--test-name-pattern` (a regex) selects any slice of the matrix. Invoke Node
directly or use the dedicated scripts above: arguments appended with
`npm test -- ...` come after the test-file glob and are not applied by Node.

## Prerequisites and skipping

Missing prerequisites skip the affected cases with a reason instead of
failing:

- `repo2docker/*` — needs Docker running and `repo2docker` on PATH.
- `jupyter4nfdi/*` — needs `JUPYTER4NFDI_TOKEN` set.
- `binderbot/*` — pure HTTP; only the small python repo is used against
  mybinder.org (good-citizen policy). The full renderer matrix (R, quarto)
  runs on local repo2docker.

Test fixture repositories: [repo2docker-python-jupyter-test](https://github.com/arnim/repo2docker-python-jupyter-test)
(minimal), [repo2docker-test](https://github.com/arnim/repo2docker-test)
(merged Python/R × quarto/nbconvert flavors), and
[repo2docker-build-failure-test](https://github.com/arnim/repo2docker-build-failure-test).

E2E tests run sequentially (`--test-concurrency=1`): one local Docker port
at a time, one MyBinder session at a time.

Full run: the single shared R+Quarto image build dominates; Docker layer
cache makes reruns much faster.
