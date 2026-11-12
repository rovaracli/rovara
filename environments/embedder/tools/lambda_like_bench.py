"""Runs INSIDE the embedder container (docker exec), against the Lambda runtime emulator on 127.0.0.1:8080. See lambda_like_bench.sh, which starts the container.
Prints one JSON object: the first invoke (cold: init + request), 100 warm single-query calls, batches of 16 documents of about 300 tokens, a batch of 16 documents of 512 tokens each, a 512-token document, and the memory peak of the container's cgroup.
"""
import json
import statistics
import sys
import time
import urllib.request

URL = "http://127.0.0.1:8080/2015-03-31/functions/function/invocations"
BASE = ("The broker retries the re-embed job when the Lambda embedder times out during a cold start; the pull request changed the SQS visibility timeout "
        "and the reviewer asked for a test on the dead-letter path. ")


def call(model: str, kind: str, texts: list[str]) -> tuple[float, dict]:
    body = json.dumps({"model": model, "kind": kind, "texts": texts}).encode()
    start = time.monotonic()
    with urllib.request.urlopen(urllib.request.Request(URL, data=body, method="POST"), timeout=120) as response:
        answer = json.loads(response.read())
    return (time.monotonic() - start) * 1000, answer


def doc(seed: int, chars: int) -> str:
    text = f"Record {seed}. " + (BASE.replace("re-embed", f"re-embed-{seed}") * 40)
    return text[:chars]


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * (len(ordered) - 1) + 0.5))]


def memory_peak_mb() -> float:
    for path in ("/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"):
        try:
            return int(open(path).read().strip()) / 1e6
        except (FileNotFoundError, ValueError, PermissionError):
            continue
    return float("nan")


out: dict = {}
first_ms, answer = call("record", "query", ["why did the deploy fail last week"])
assert answer.get("ok") is True and answer.get("dimension") == 384, answer
out["first_invoke_ms_cold"] = round(first_ms)
call("record", "query", ["warm the connection"])
queries = [f"why did the re-embed job time out after cold start number {i}" for i in range(100)]
times = [call("record", "query", [q])[0] for q in queries]
out["query_ms"] = {"p50": round(statistics.median(times), 1), "p95": round(percentile(times, 0.95), 1), "max": round(max(times), 1)}
batch_times = []
for trial in range(5):
    texts = [doc(trial * 16 + i, 1400) for i in range(16)]
    ms, answer = call("record", "document", texts)
    assert answer["ok"] and len(answer["vectors"]) == 16
    batch_times.append(ms)
out["batch16_doc300_ms"] = {"p50": round(statistics.median(batch_times)), "max": round(max(batch_times))}
long_times = []
for trial in range(5):
    ms, answer = call("record", "document", [doc(900 + trial, 3200)])
    long_times.append(ms)
# the worst batch the re-embed job can send: 16 documents that all fill the 512-token window (the job caps a call at 8,000 characters, so this is the function's limit, not the job's)
full_times = []
for trial in range(3):
    texts = [doc(2000 + trial * 16 + i, 3200) for i in range(16)]
    ms, full = call("record", "document", texts)
    assert full["ok"] and len(full["vectors"]) == 16 and all(full["truncated"])
    full_times.append(ms)
out["batch16_doc512_ms"] = {"p50": round(statistics.median(full_times)), "max": round(max(full_times))}
# the biggest call the re-embed job sends for full-size texts: its 10,000-character cap lets 4 documents that fill the window go together
job_times = []
for trial in range(5):
    ms, job = call("record", "document", [doc(3000 + trial * 4 + i, 3200) for i in range(4)])
    assert job["ok"] and len(job["vectors"]) == 4
    job_times.append(ms)
out["batch4_doc512_ms"] = {"p50": round(statistics.median(job_times)), "max": round(max(job_times))}
out["doc512_ms"] = {"p50": round(statistics.median(long_times)), "truncated": answer["truncated"]}
lesson_ms, lesson = call("lesson", "document", [doc(5, 1400)])
out["lesson_after_record_ms"] = round(lesson_ms, 1)
out["lesson_same_model"] = lesson["spec"] == answer["spec"]
out["memory_peak_mb"] = round(memory_peak_mb())
json.dump(out, sys.stdout)
