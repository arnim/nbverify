# nbverify

**Know that notebooks run—not just build.**

`nbverify` provisions a Jupyter environment for a GitHub repository, executes
its Jupyter and Quarto notebooks, and downloads the rendered HTML along with a
machine-readable report.

## Quick start

Requires Node.js 20 or later.

```bash
git clone https://github.com/arnim/nbverify.git
cd nbverify
npm install
npm link
```

Run every discovered notebook through MyBinder:

```bash
nbverify test https://github.com/OWNER/REPOSITORY \
  --backend binderbot
```

Or run selected notebooks in order:

```bash
nbverify test https://github.com/OWNER/REPOSITORY \
  --backend binderbot \
  notebooks/introduction.ipynb analysis/report.qmd
```

Rendered pages and `run-report.json` are written to `artifacts/`.

## Backends

| Backend | Best for | Requirements |
| --- | --- | --- |
| `binderbot` | Public GitHub repositories on MyBinder | None beyond Node.js |
| `repo2docker` | Local, reproducible runs | Docker and repo2docker |
| `jupyter4nfdi` | NFDI Jupyter infrastructure | `JUPYTER4NFDI_TOKEN` |

## Reuse a session

For more control, provision once and run notebooks separately:

```bash
nbverify start https://github.com/OWNER/REPOSITORY --backend binderbot
nbverify list --session session.json
nbverify run --session session.json notebooks/example.ipynb
nbverify stop --session session.json
```

Use `nbverify help` or `nbverify help <command>` for all options.

## Documentation

See the [project specification](docs/specification.md) for the architecture,
CLI behavior, execution protocol, and error model.

## License

[BSD 3-Clause](LICENSE)
