"""Controller-owned HTTP adapter for ProductAdKit retry proofs.

The candidate source remains the behavior under test. This adapter only gives
the fixed HTTP replay DSL a small JSON surface over jobs.submit() and exposes
bounded counters that stand in for generation and billing side effects.
"""
from __future__ import annotations

import inspect
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


SOURCE_ROOT = Path.cwd().resolve()
sys.path.insert(0, str(SOURCE_ROOT))

import jobs  # noqa: E402

try:
    from quality_store import QualityStore  # noqa: E402
except ImportError:
    QualityStore = None


_LOCK = threading.RLock()
_GENERATION_CALLS = 0
_SUBMITTED_JOB_IDS: list[str] = []
_STATE_DB = Path(tempfile.gettempdir()) / f"mergeproof-retry-{os.getpid()}.sqlite3"


def _remove_state_db() -> None:
    for suffix in ("", "-shm", "-wal"):
        try:
            Path(f"{_STATE_DB}{suffix}").unlink()
        except FileNotFoundError:
            pass


def _reset_fixture() -> None:
    global _GENERATION_CALLS
    with _LOCK:
        _GENERATION_CALLS = 0
        _SUBMITTED_JOB_IDS.clear()
        if hasattr(jobs, "_runner"):
            jobs._runner = None
        if hasattr(jobs, "_jobs"):
            jobs._jobs.clear()
        if hasattr(jobs, "configure_store"):
            jobs.configure_store(None)
        _remove_state_db()
        if hasattr(jobs, "configure_store") and QualityStore is not None:
            jobs.configure_store(QualityStore(_STATE_DB))


def _generate(_kind, _image, _params):
    global _GENERATION_CALLS
    with _LOCK:
        _GENERATION_CALLS += 1
    return {"ok": True}


def _wait_for_terminal(job_id: str) -> None:
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        record = jobs.get(job_id)
        if record and record.get("status") in {"done", "error"}:
            return
        time.sleep(0.005)
    raise RuntimeError("job did not settle inside the trusted replay deadline")


def _submit(idempotency_key: str | None) -> str:
    parameters = inspect.signature(jobs.submit).parameters
    if "idempotency_key" in parameters:
        job_id = jobs.submit(
            _generate,
            "posters",
            b"fixture-image",
            {"n": 1},
            idempotency_key=idempotency_key,
        )
    else:
        # The base revision has no idempotency boundary, so an identical retry
        # is necessarily a second independent generation job.
        job_id = jobs.submit(_generate, "posters", b"fixture-image", {"n": 1})
    _wait_for_terminal(job_id)
    with _LOCK:
        _SUBMITTED_JOB_IDS.append(job_id)
    return job_id


def _state() -> dict[str, object]:
    with _LOCK:
        job_ids = list(_SUBMITTED_JOB_IDS)
        return {
            "submissions": len(job_ids),
            "unique_job_ids": len(set(job_ids)),
            "generation_calls": _GENERATION_CALLS,
            "job_ids": job_ids,
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "MergeProofRetryAdapter/1"

    def _json_body(self) -> dict[str, object]:
        raw_length = self.headers.get("content-length", "0")
        if not raw_length.isdigit() or int(raw_length) > 65_536:
            raise ValueError("invalid request size")
        body = self.rfile.read(int(raw_length))
        if not body:
            return {}
        value = json.loads(body)
        if not isinstance(value, dict):
            raise ValueError("request body must be an object")
        return value

    def _respond(self, status: int, value: dict[str, object] | None = None) -> None:
        payload = b"" if value is None else json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/healthz":
            self._respond(200, {"status": "ok"})
            return
        if path == "/__mergeproof/fixtures/retry-job/state":
            self._respond(200, _state())
            return
        self._respond(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            body = self._json_body()
            if path == "/__mergeproof/fixtures/retry-job/setup":
                _reset_fixture()
                self._respond(204)
                return
            if path == "/jobs":
                raw_key = body.get("idempotency_key")
                if raw_key is not None and not isinstance(raw_key, str):
                    raise ValueError("idempotency_key must be a string")
                key = str(raw_key).strip()[:160] or None if raw_key is not None else None
                self._respond(202, {"job_id": _submit(key), "status": "done"})
                return
            self._respond(404, {"error": "not_found"})
        except (ValueError, json.JSONDecodeError):
            self._respond(422, {"error": "invalid_request"})
        except Exception:
            self._respond(500, {"error": "adapter_failure"})

    def log_message(self, _format: str, *_args: object) -> None:
        return


def main() -> None:
    _reset_fixture()
    port = int(os.environ["PORT"])
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
