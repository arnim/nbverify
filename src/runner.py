"""nbverify remote runner (stdlib only).

Uploaded to .nbverify/job-<id>/runner.py together with request.json.
Executes each requested document with quarto or nbconvert, writing
result-N.json after every item and done.json at the end. All communication
with the nbverify CLI happens through these files (Contents API polling);
terminal output is never parsed.
"""

import json
import os
import signal
import subprocess
import sys
import time

JOB_DIR = os.path.dirname(os.path.abspath(__file__))
# runner.py lives at <root>/.nbverify/job-<id>/runner.py; document paths in
# request.json are relative to <root> (the Jupyter Contents API root).
ROOT_DIR = os.path.dirname(os.path.dirname(JOB_DIR))


def write_json(name, obj):
    tmp = os.path.join(JOB_DIR, name + ".tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, os.path.join(JOB_DIR, name))


def run_renderer(cmd, timeout):
    """Run cmd with a wall-clock deadline, killing its process group on expiry.

    Renderers spawn children (kernels); a plain subprocess timeout would only
    kill the direct child and leave a hung kernel behind.
    """
    proc = subprocess.Popen(
        cmd,
        cwd=ROOT_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
        return proc.returncode, stdout, stderr, False
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            proc.kill()
        stdout, stderr = proc.communicate()
        return -1, stdout or "", stderr or "", True


def run_item(index, item):
    path = item["path"]
    renderer = item["renderer"]
    timeout = item.get("timeout", 600)
    out_name = "%d.html" % index
    out_path = os.path.join(JOB_DIR, out_name)

    if renderer == "quarto":
        # --output must be a bare filename; quarto writes it next to the
        # input, so we move it into the job dir afterwards.
        cmd = [
            "quarto", "render", path,
            "--to", "html",
            "--execute",
            "--no-cache",
            "--output", out_name,
        ]
    else:  # nbconvert
        cmd = [
            "jupyter", "nbconvert",
            "--to", "html",
            "--execute", path,
            "--output", str(index),
            "--output-dir", JOB_DIR,
            # Per-cell timeout disabled: --timeout is a wall-clock limit for
            # the whole notebook, enforced uniformly by run_renderer below.
            "--ExecutePreprocessor.timeout=-1",
        ]

    started = time.time()
    result = {
        "index": index,
        "path": path,
        "renderer": renderer,
        "command": cmd,
    }
    try:
        exit_code, stdout, stderr, timed_out = run_renderer(cmd, timeout)
        result["exit_code"] = exit_code
        result["stdout"] = stdout[-100000:]
        result["stderr"] = stderr[-100000:]
        result["timed_out"] = timed_out
    except FileNotFoundError as exc:
        result["exit_code"] = 127
        result["stdout"] = ""
        result["stderr"] = "tool not found: %s" % exc
        result["timed_out"] = False
    result["duration_seconds"] = round(time.time() - started, 3)
    if renderer == "quarto" and result["exit_code"] == 0:
        produced = os.path.join(ROOT_DIR, os.path.dirname(path), out_name)
        if os.path.exists(produced):
            os.replace(produced, out_path)
    result["html"] = out_name if (
        result["exit_code"] == 0 and os.path.exists(out_path)
    ) else None
    if result["exit_code"] == 0 and result["html"] is None:
        result["exit_code"] = 1
        result["stderr"] += "\nnbverify: renderer exited 0 but produced no HTML"
    write_json("result-%d.json" % index, result)
    return result


def main():
    with open(os.path.join(JOB_DIR, "request.json")) as f:
        request = json.load(f)

    fail_fast = request.get("fail_fast", False)
    statuses = []
    for index, item in enumerate(request["items"]):
        result = run_item(index, item)
        ok = result["exit_code"] == 0
        statuses.append(ok)
        if fail_fast and not ok:
            break

    write_json("done.json", {
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "completed": len(statuses),
        "requested": len(request["items"]),
        "success": all(statuses) and len(statuses) == len(request["items"]),
    })


if __name__ == "__main__":
    sys.exit(main())
