"""Run a sealed subset of Product AdKit baseline tests without pytest.

The trusted probe copies the frozen tests into the extracted candidate's tests
directory first.  This runner loads only those explicit files and then adds the
candidate source directory to sys.path so assertions exercise the PR revision,
not a mounted duplicate of the application code.
"""
from __future__ import annotations

import argparse
import importlib.util
import inspect
import resource
import sys
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--tests-dir", required=True)
    parser.add_argument("--metric", choices=("latency-ms", "peak-memory-mb"))
    parser.add_argument("--test", action="append", required=True)
    return parser.parse_args()


def load_test_module(path: Path, index: int):
    module_name = f"mergeproof_frozen_{path.stem}_{index}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load frozen test module: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_test_module(path: Path, index: int) -> None:
    module = load_test_module(path, index)
    test_functions = [
        value
        for name, value in sorted(vars(module).items())
        if name.startswith("test_") and callable(value)
    ]
    if not test_functions:
        raise RuntimeError(f"Frozen test module has no test functions: {path.name}")
    for test_function in test_functions:
        if inspect.signature(test_function).parameters:
            raise RuntimeError(
                f"Frozen test function must not require a pytest fixture: {test_function.__name__}"
            )
        test_function()


def peak_memory_megabytes() -> float:
    # Linux reports ru_maxrss in KiB; macOS reports bytes. E2B runs Linux, but
    # keeping the conversion explicit makes the trusted asset reproducible.
    maximum = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return maximum / (1_000_000 if sys.platform == "darwin" else 1024)


def main() -> None:
    args = parse_args()
    source_dir = Path(args.source_dir).resolve()
    tests_dir = Path(args.tests_dir).resolve()
    if not source_dir.is_dir() or not tests_dir.is_dir():
        raise RuntimeError("Trusted suite requires source and tests directories.")
    sys.path.insert(0, str(source_dir))

    started = time.perf_counter()
    for index, name in enumerate(args.test):
        if Path(name).name != name or not name.startswith("test_") or not name.endswith(".py"):
            raise RuntimeError(f"Unsafe frozen test name: {name}")
        path = tests_dir / name
        if not path.is_file():
            raise RuntimeError(f"Frozen test file is missing: {name}")
        run_test_module(path, index)

    if args.metric == "latency-ms":
        print(f"{(time.perf_counter() - started) * 1000:.3f}")
    elif args.metric == "peak-memory-mb":
        print(f"{peak_memory_megabytes():.3f}")


if __name__ == "__main__":
    main()
