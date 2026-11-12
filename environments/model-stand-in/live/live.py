#!/usr/bin/env python3
"""Live proof of the model stand-in (lane SM3): boto3 InvokeEndpoint through the Rovara front (helper mode) to the real stand-in binary.

    live.py --stand-in-bin <model-stand-in> --front-bin <rovara-aws-front> [--engine-bin /usr/bin/aws-emulator]

Run it in the Linux VM with a Python that has boto3 (the spike's venv): `colima ssh -p aws-emu-spike -- bash <this folder>/run-live.sh`. It builds nothing, starts its own
stand-in (config written here, four listeners on free ports at the host's own non-loopback address, because the front refuses a stand-in at a loopback address), its own front
(planned mode, the engine as its child) and stops only those processes. No AWS account, no network beyond the host's own address, no docker.

What it proves, each through boto3 (the SDK's parser reads every answer):
  contract      GET /ping is 200; POST /invocations answers; an unknown path is 404
  shapes        a schema-generated reply (typed, same shape every call), a JSON vector and label reply per instance, a CSV in and out, a JSON echo with fields
  routing       one address per endpoint (the front's ROVARA_AWS_SAGEMAKER_HELPER list) and a multi-model endpoint by TargetModel (the front forwards the header)
  behaviour     latency, fail_first (a retry test), error statuses as ModelError with OriginalStatusCode, an unknown target model, a content type the model refuses
  streaming     InvokeEndpointWithResponseStream over the stand-in's chunked reply
  safety        a body over 6 MiB is refused; the stand-in's log holds no request value; the front's evidence counts the stand-in's calls
Exit code 0 when every check passes.
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

FAILED = []
MARKER = "PII-4111-1111-1111-1111-jane.doe@example.com"


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ((" :: " + str(detail)[:400]) if (detail and not ok) else ""))
    if not ok:
        FAILED.append(name)


def free_port():
    s = socket.socket()
    s.bind(("0.0.0.0", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def own_address():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))
        return s.getsockname()[0]
    finally:
        s.close()


def http(method, url, token=None, body=None, headers=None):
    req = urllib.request.Request(url, data=(json.dumps(body).encode() if isinstance(body, (dict, list)) else body), method=method)
    if token:
        req.add_header("X-Rovara-Control-Token", token)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except urllib.error.URLError:
        return 0, b""


def config(ports):
    p0, p1, p2, p3 = ports
    return {
        "version": 1, "listen": ":%d" % p0, "seed": "sm3-live", "default_endpoint": "fraud-scorer",
        "endpoints": {
            # the default endpoint (primary listener): a typed reply from a schema, a little latency, json only
            "fraud-scorer": {"model": {"kind": "schema", "accepts": ["application/json"], "latency_ms": 40, "custom_attributes": "model=fraud-v3", "schema": {
                "type": "object", "properties": {
                    "transaction_id": {"type": "string", "format": "uuid"}, "score": {"type": "number", "minimum": 0, "maximum": 1},
                    "decision": {"enum": ["approve", "review", "decline"]}, "reasons": {"type": "array", "items": {"type": "string", "maxLength": 12}, "minItems": 1, "maxItems": 3},
                    "scored_at": {"type": "string", "format": "date-time"}}}}},
            # vector reply per instance, retry test: the first two calls fail with 503
            "embedder": {"port": p1, "model": {"kind": "vector", "size": 4, "normalize": True, "key": "predictions", "fail_first": 2, "error_status": 503, "error_message": "model is warming up"}},
            # a multi-model endpoint (one container, several models, chosen by TargetModel), one of them streams
            "tenant-models": {"port": p2, "models": {
                "tenant-a.tar.gz": {"kind": "label", "labels": ["churn", "stay"], "with_probabilities": True},
                "tenant-b.tar.gz": {"kind": "fixed", "body": "token-0 token-1 token-2", "content_type": "text/event-stream"}}},
            # csv in, csv out; the reply is chunked (InvokeEndpointWithResponseStream has no TargetModel, so the streaming model is a single-model endpoint)
            "batch-scorer": {"port": p3, "model": {"kind": "csv", "columns": 2, "skip_header": True, "header": ["score", "confidence"], "decimals": 3, "stream": {"chunks": 5, "delay_ms": 20}}},
        }}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stand-in-bin", required=True)
    ap.add_argument("--front-bin", required=True)
    ap.add_argument("--engine-bin", default="/usr/bin/aws-emulator")
    args = ap.parse_args()
    work = tempfile.mkdtemp(prefix="sm3-live-")
    addr = own_address()
    ports = [free_port() for _ in range(4)]
    fport = free_port()
    cfg_path = os.path.join(work, "model-stand-in.json")
    with open(cfg_path, "w") as f:
        json.dump(config(ports), f)
    procs = []
    try:
        v = subprocess.run([args.stand_in_bin, "--config", cfg_path, "--validate"], capture_output=True, timeout=20)
        check("--validate accepts the config", v.returncode == 0, v)
        bad = os.path.join(work, "bad.json")
        open(bad, "w").write('{"version":1,"endpoints":{"x":{"model":{"kind":"fixed","body":"a","lateny_ms":1}}}}')
        v = subprocess.run([args.stand_in_bin, "--config", bad, "--validate"], capture_output=True, timeout=20)
        check("--validate refuses a misspelt option", v.returncode == 1 and b"lateny_ms" in v.stderr, v)

        log_path = os.path.join(work, "stand-in.log")
        logf = open(log_path, "wb")
        stand = subprocess.Popen([args.stand_in_bin, "--config", cfg_path], stdout=logf, stderr=logf, env={"PATH": "/usr/bin:/bin"})
        procs.append(stand)
        direct = "http://%s:%d" % (addr, ports[0])
        for _ in range(100):
            if http("GET", direct + "/ping")[0:1] == (200,):
                break
            time.sleep(0.1)
        st, body = http("GET", direct + "/ping")
        check("contract: GET /ping is 200 with no body", st == 200 and body == b"", (st, body))
        check("contract: an unknown path is 404", http("GET", direct + "/nothing")[0] == 404)
        check("contract: GET /invocations is 405", http("GET", direct + "/invocations")[0] == 405)

        token = "tok" + "x" * 20
        helpers = ",".join("http://%s:%d" % (addr, p) for p in ports)
        env = {"HOME": work, "PATH": "/usr/bin:/bin", "QUARKUS_HTTP_HOST": "127.0.0.1", "QUARKUS_HTTP_PORT": str(fport),
               "ROVARA_AWS_BASE_URL": "http://127.0.0.1:%d" % fport, "ROVARA_AWS_AUTH_PRESIGN_SECRET": "presign" + "p" * 20,
               "ROVARA_AWS_SERVICES_SQS_RECEIPT_HANDLE_SECRET": "receipt" + "r" * 20, "ROVARA_AWS_CONTROL_TOKEN": token,
               "ROVARA_AWS_ENGINE_BIN": args.engine_bin, "ROVARA_AWS_FRONT_WORKDIR": work,
               "ROVARA_AWS_PLANNED_SERVICES": "sagemaker,sagemaker-runtime,s3,iam,sts",
               "ROVARA_AWS_SAGEMAKER_HELPER": helpers}
        front = subprocess.Popen([args.front_bin], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        procs.append(front)
        base = "http://127.0.0.1:%d" % fport
        for _ in range(200):
            try:
                if urllib.request.urlopen(base + "/_rovara/health", timeout=2).status == 200:
                    break
            except Exception:
                time.sleep(0.1)
        else:
            sys.exit("the front did not become healthy")
        urls = ["http://%s:%d" % (addr, p) for p in ports]
        run(base, token, urls, direct)
        memory(stand.pid, urls)
        logf.flush()
        log = open(log_path, "r", errors="replace").read()
        check("safety: the stand-in's log holds no request value (body, header or target model of the caller)",
              "4111" not in log and "jane.doe" not in log and "PII-" not in log and "Bearer" not in log, log[-600:])
        check("safety: the stand-in logged one line per call, with sizes and a hash", log.count("msg=invocation") >= 15 and "body_sha8=" in log and "in_bytes=" in log, log[-300:])
    finally:
        for p in reversed(procs):  # only the processes this script started
            p.terminate()
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()
        shutil.rmtree(work, ignore_errors=True)
    print("\n%d check(s) failed: %s" % (len(FAILED), ", ".join(FAILED)) if FAILED else "\nall checks passed")
    sys.exit(1 if FAILED else 0)


def memory(pid, urls):
    """Worst-case bodies straight at the stand-in (6 MiB of tiny array elements and CSV rows, three at a time), then its peak resident memory against the catalog's 128 MiB."""
    import concurrent.futures
    tiny = b'{"instances":[' + b"1," * 3_000_000 + b"1]}"
    rows = b"a\n" * 3_000_000
    jobs = [(urls[1], "application/json", tiny), (urls[3], "text/csv", rows), (urls[1], "application/json", tiny), (urls[3], "text/csv", rows), (urls[0], "application/json", tiny)]
    with concurrent.futures.ThreadPoolExecutor(3) as pool:
        codes = list(pool.map(lambda j: http("POST", j[0] + "/invocations", None, j[2], {"Content-Type": j[1]})[0], jobs))
    check("memory: worst-case bodies are answered or refused, never a crash", all(c in (0, 200, 400, 500, 503) for c in codes), codes)  # 0: refused under the sender (the body budget answers 503 and closes)
    check("memory: the stand-in is still up after them", http("GET", urls[0] + "/ping")[0] == 200)
    hwm = 0
    for line in open("/proc/%d/status" % pid):
        if line.startswith("VmHWM:"):
            hwm = int(line.split()[1]) // 1024
    print("     peak resident memory: %d MiB" % hwm)
    check("memory: peak resident memory stays under the catalog's 128 MiB", 0 < hwm < 128, hwm)


def client(name, base):
    return boto3.client(name, endpoint_url=base, region_name="us-east-1", aws_access_key_id="AKIAEXAMPLE", aws_secret_access_key="secret", config=Config(retries={"max_attempts": 1}))


def run(base, token, helper_urls, direct):
    sm, rt = client("sagemaker", base), client("sagemaker-runtime", base)
    names = ["fraud-scorer", "embedder", "tenant-models", "batch-scorer"]
    for name in names:
        sm.create_model(ModelName=name, ExecutionRoleArn="arn:aws:iam::000000000000:role/r", PrimaryContainer={"Image": "000000000000.dkr.ecr.us-east-1.amazonaws.com/img:1"})
        sm.create_endpoint_config(EndpointConfigName=name + "-cfg", ProductionVariants=[{"VariantName": "AllTraffic", "ModelName": name, "InitialInstanceCount": 1, "InstanceType": "ml.m5.large", "InitialVariantWeight": 1.0}])
        sm.create_endpoint(EndpointName=name, EndpointConfigName=name + "-cfg")
    time.sleep(1.5)
    # the first helper is the default backing; the others are chosen by address
    for name, url in zip(names[1:], helper_urls[1:]):
        st, body = http("PUT", "%s/_rovara/sagemaker/endpoints/%s" % (base, name), token, {"mode": "helper", "helper": url})
        check("backing for %s is its own stand-in address" % name, st == 200, (st, body))

    # ---- schema reply
    r = rt.invoke_endpoint(EndpointName="fraud-scorer", ContentType="application/json", Body=json.dumps({"amount": 12.5, "card": MARKER}).encode(), CustomAttributes="trace=" + MARKER)
    doc = json.loads(r["Body"].read())
    ok = (len(doc["transaction_id"]) == 36 and 0 <= doc["score"] <= 1 and doc["decision"] in ("approve", "review", "decline") and 1 <= len(doc["reasons"]) <= 3
          and all(len(x) <= 12 for x in doc["reasons"]) and doc["scored_at"].endswith("Z"))
    check("shapes: a schema-generated reply has the declared types", ok, doc)
    check("shapes: the model's custom attributes come back through the front", r["CustomAttributes"] == "model=fraud-v3", r["CustomAttributes"])
    again = json.loads(rt.invoke_endpoint(EndpointName="fraud-scorer", ContentType="application/json", Body=json.dumps({"amount": 12.5, "card": MARKER}).encode())["Body"].read())
    other = json.loads(rt.invoke_endpoint(EndpointName="fraud-scorer", ContentType="application/json", Body=b'{"amount": 99}')["Body"].read())
    check("shapes: the same request gets the same reply, another request another", again == doc and other != doc and set(other) == set(doc), (again, other))
    t0 = time.time()
    rt.invoke_endpoint(EndpointName="fraud-scorer", ContentType="application/json", Body=b"{}")
    check("behaviour: configured latency (40 ms) is waited", time.time() - t0 >= 0.035, time.time() - t0)
    try:
        rt.invoke_endpoint(EndpointName="fraud-scorer", ContentType="image/png", Body=b"\x89PNG")
        check("behaviour: a content type the model refuses", False)
    except ClientError as e:
        er = e.response
        check("behaviour: a content type the model refuses is a ModelError with OriginalStatusCode 415", er["Error"]["Code"] == "ModelError" and er["OriginalStatusCode"] == 415, er)

    # ---- fail_first, then a vector per instance
    for i in range(2):
        try:
            rt.invoke_endpoint(EndpointName="embedder", ContentType="application/json", Body=b'{"instances":[[1,2],[3,4]]}')
            check("behaviour: call %d fails (fail_first)" % (i + 1), False)
        except ClientError as e:
            er = e.response
            check("behaviour: call %d fails with ModelError 503 and the configured sentence" % (i + 1), er["Error"]["Code"] == "ModelError" and er["OriginalStatusCode"] == 503
                  and er["OriginalMessage"] == '{"error":"model is warming up"}', er)
    r = rt.invoke_endpoint(EndpointName="embedder", ContentType="application/json", Body=b'{"instances":[[1,2],[3,4],[5,6]]}')
    preds = json.loads(r["Body"].read())["predictions"]
    check("shapes: a vector per instance, each normalised", len(preds) == 3 and all(len(p) == 4 and abs(sum(p) - 1) < 0.001 for p in preds), preds)

    # ---- multi-model by TargetModel
    r = rt.invoke_endpoint(EndpointName="tenant-models", ContentType="application/json", TargetModel="tenant-a.tar.gz", Body=b'{"customer": 1}')
    doc = json.loads(r["Body"].read())
    check("routing: TargetModel selects the tenant-a model", doc["label"] in ("churn", "stay") and set(doc["probabilities"]) == {"churn", "stay"}, doc)
    r = rt.invoke_endpoint(EndpointName="tenant-models", ContentType="text/plain", TargetModel="tenant-b.tar.gz", Body=b"x")
    check("routing: TargetModel selects the tenant-b model", r["Body"].read() == b"token-0 token-1 token-2" and r["ContentType"] == "text/event-stream", r)
    try:
        rt.invoke_endpoint(EndpointName="tenant-models", ContentType="application/json", TargetModel="tenant-" + MARKER + ".tar.gz", Body=b"{}")
        check("routing: an unknown target model", False)
    except ClientError as e:
        er = e.response
        check("routing: an unknown target model is a ModelError 404 that does not repeat the name", er["Error"]["Code"] == "ModelError" and er["OriginalStatusCode"] == 404 and "PII-" not in json.dumps(er), er)
    try:
        rt.invoke_endpoint(EndpointName="tenant-models", ContentType="application/json", Body=b"{}")
        check("routing: no target model on a multi-model endpoint", False)
    except ClientError as e:
        check("routing: no TargetModel on a multi-model endpoint is a ModelError 400", e.response["Error"]["Code"] == "ModelError" and e.response["OriginalStatusCode"] == 400, e.response)

    # ---- csv in, csv out
    r = rt.invoke_endpoint(EndpointName="batch-scorer", ContentType="text/csv", Accept="text/csv", Body=b"id,amount\n1,10.5\n2,7\n3,99\n")
    lines = r["Body"].read().decode().strip().split("\n")
    check("shapes: CSV in, CSV out (header, then one row per input row)", lines[0] == "score,confidence" and len(lines) == 4 and all(len(l.split(",")) == 2 for l in lines)
          and r["ContentType"] == "text/csv", lines)

    # ---- streaming over the stand-in's chunked reply (the same CSV model, asked as a stream)
    body = b"id,amount\n1,10.5\n2,7\n3,99\n"
    whole = rt.invoke_endpoint(EndpointName="batch-scorer", ContentType="text/csv", Body=body)["Body"].read()
    r = rt.invoke_endpoint_with_response_stream(EndpointName="batch-scorer", ContentType="text/csv", Body=body)
    parts = [ev["PayloadPart"]["Bytes"] for ev in r["Body"] if "PayloadPart" in ev]
    check("streaming: the chunked reply arrives as several PayloadPart events that join to the model's reply", len(parts) >= 3 and b"".join(parts) == whole, parts)

    # ---- limits
    try:
        rt.invoke_endpoint(EndpointName="batch-scorer", ContentType="text/csv", Body=b"a" * (6 * 1024 * 1024 + 1))
        check("safety: a body over 6 MiB", False)
    except ClientError as e:
        check("safety: a body over 6 MiB is refused (by the front, before the stand-in)", e.response["Error"]["Code"] == "ValidationError", e.response)
    st, _ = http("POST", helper_urls[3] + "/invocations", None, b"a" * (6 * 1024 * 1024 + 1), {"Content-Type": "text/csv"})
    # Go answers 413 without reading the rest and closes; a client that is still sending may see the reset instead of the status (both mean refused, nothing was answered 200)
    check("safety: the stand-in itself refuses a body over 6 MiB (413, or the connection closed under the sender)", st in (413, 0), st)
    st, _ = http("POST", helper_urls[3] + "/invocations", None, b"a" * (6 * 1024 * 1024), {"Content-Type": "text/csv"})
    check("safety: and takes exactly 6 MiB", st == 200, st)

    # ---- evidence: the front counted the stand-in's calls
    st, body = http("GET", "%s/_rovara/sagemaker/endpoints" % base, token)
    table = {e["name"]: e for e in json.loads(body)["endpoints"]}
    check("evidence: the front counts calls via the stand-in, per endpoint", all(table[n]["viaHelper"] >= 1 for n in names) and table["embedder"]["errors"] == 2, {n: (table[n]["viaHelper"], table[n]["errors"]) for n in names})
    check("evidence: each endpoint is labelled a model stand-in (hand-written fake)", all("stand-in" in table[n]["backing"]["label"] for n in names), [table[n]["backing"]["label"] for n in names])


if __name__ == "__main__":
    main()
