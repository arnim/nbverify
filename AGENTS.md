# Development Rules

## Validation before committing

Run the fast offline suite before every commit:

```bash
npm run test:fast
```

For changes to provisioning, Docker lifecycle/cleanup, server readiness, the
remote runner, timeout handling, or end-to-end test infrastructure, also run:

```bash
npm run test:e2e:repo2docker:smoke
```

Do not routinely run the full local or remote matrix before committing. It is
slow and runs automatically every night. Run an affected backend slice when a
change specifically requires it:

```bash
npm run test:e2e:repo2docker
npm run test:e2e:binderbot
npm run test:e2e:jupyter4nfdi
```

Use the dedicated scripts above. For an arbitrary slice, invoke Node directly
with `--test-name-pattern` before the test file; do not append it to
`npm test`, because appended arguments come after the test-file glob:

```bash
node --test --test-concurrency=1 \
  --test-name-pattern='^repo2docker/python-jupyter$' test/e2e.test.js
```
