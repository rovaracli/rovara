#!/usr/bin/env python3
"""The client half of the runner client's live test (slice 4, lane W3): boto3 against the Rovara front, with a numpy function behind the worker's runner client.
usage: drive.py <front endpoint> <control token> <zip file>     (prints PASS/FAIL/INFO lines; exit 1 on a failure)"""
import json, statistics, sys, time, urllib.request
import boto3
from botocore.config import Config

endpoint, token, zip_path = sys.argv[1:4]
X86_PATH = sys.argv[4] if len(sys.argv) > 4 else None
ZIP = open(zip_path, "rb").read()
kw = dict(endpoint_url=endpoint, region_name="us-east-1", aws_access_key_id="ROVARATESTKEY", aws_secret_access_key="rovaratestsecret", config=Config(retries={"max_attempts": 1}, read_timeout=120))
lam, iam, sqs = (boto3.client(n, **kw) for n in ("lambda", "iam", "sqs"))
fails = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + ((" :: " + str(detail)[:400]) if (detail and not ok) else ""), flush=True)
    if not ok:
        fails.append(name)


def info(name, value):
    print("INFO  " + name + "  " + (value if isinstance(value, str) else json.dumps(value)), flush=True)


def ctl(method, path):
    req = urllib.request.Request(endpoint + path, method=method, data=b"" if method == "POST" else None, headers={"x-rovara-control-token": token})
    return json.loads(urllib.request.urlopen(req, timeout=60).read() or b"{}")


def stats(name):
    return {r["name"]: r for r in ctl("GET", "/_rovara/lambda/heavy").get("runnerFunctions", [])}.get(name, {})


def call(name, event, **kwargs):
    t = time.time()
    r = lam.invoke(FunctionName=name, Payload=json.dumps(event).encode(), **kwargs)
    return r, (time.time() - t) * 1000, r["Payload"].read()


TRUST = json.dumps({"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]})
ROLE = iam.create_role(RoleName="live-role", AssumeRolePolicyDocument=TRUST)["Role"]["Arn"]


def mk(name, timeout=20, mem=512):
    t = time.time()
    r = lam.create_function(FunctionName=name, Runtime="python3.12", Role=ROLE, Handler="app.handler", Timeout=timeout, MemorySize=mem, Code={"ZipFile": ZIP})
    return r, (time.time() - t) * 1000


# ---- create: the package goes to the worker, which judges and unpacks it
r, ms = mk("np-direct")
info("CreateFunction with the numpy package (zip bytes, ms)", [len(ZIP), round(ms)])
check("CreateFunction answers with the real configuration, not the stub's", r["MemorySize"] == 512 and r["Handler"] == "app.handler" and r["Runtime"] == "python3.12" and r["CodeSize"] == len(ZIP), r)

# ---- the direct fast path
r, cold_ms, body = call("np-direct", {"hello": 1})
out = json.loads(body) if r["StatusCode"] == 200 and "FunctionError" not in r else {}
check("direct Invoke runs numpy in the sandbox and answers", out.get("sum") == 45.0 and out.get("dot") == float(sum(i * i for i in range(1000))) and out.get("arch") == "aarch64" and out.get("fn") == "np-direct" and out.get("echo") == {"hello": 1}, [r.get("FunctionError"), body[:300]])
info("direct cold Invoke ms (first call: sandbox start, python and numpy import, matmul)", round(cold_ms))
info("numpy version in the function", out.get("numpy", "?"))
warm = []
for i in range(15):
    r, ms, body = call("np-direct", {"i": i})
    warm.append(ms)
    if "FunctionError" in r or json.loads(body).get("echo") != {"i": i}:
        check("warm Invoke " + str(i), False, body[:200])
info("direct warm Invoke ms (median, max of 15)", [round(statistics.median(warm), 1), round(max(warm), 1)])
s = stats("np-direct")
check("the front counted the direct calls and one cold start", s.get("direct", 0) >= 16 and s.get("ok", 0) >= 16 and s.get("cold", 0) == 1, s)
check("one warm sandbox served all of them (no throttling, no errors)", s.get("functionErrors", 0) == 0 and s.get("unavailable", 0) == 0, s)

# ---- errors and the log tail
r, ms, body = call("np-direct", {"op": "raise"}, LogType="Tail")
check("a raised exception is a function error with its errorType", r.get("FunctionError") == "Unhandled" and json.loads(body).get("errorType") == "ValueError", [r.get("FunctionError"), body[:200]])
import base64
check("LogType=Tail carries the runtime's log (START and REPORT lines)", "START RequestId" in base64.b64decode(r.get("LogResult", "")).decode(errors="replace") and "REPORT RequestId" in base64.b64decode(r.get("LogResult", "")).decode(errors="replace"), base64.b64decode(r.get("LogResult", "")).decode(errors="replace")[:300])

# ---- a timeout, exact, with no 30 s ceiling to hide behind (the function's own Timeout is 2 s)
mk("np-slow", timeout=2)
t = time.time()
r, ms, body = call("np-slow", {"op": "sleep", "s": 5})
check("a function past its Timeout fails with the Lambda timeout message", r.get("FunctionError") == "Unhandled" and "Task timed out after 2.00 seconds" in body.decode(), [r.get("FunctionError"), body[:200]])
info("timeout call took ms", round(ms))
r, ms, body = call("np-slow", {"hello": 2})
check("after a timeout the next call starts a fresh sandbox and answers", "FunctionError" not in r and json.loads(body).get("sum") == 45.0, body[:200])

# ---- the engine's SQS trigger: the stub posts on the hidden queue, the front hands it to the worker, the answer goes back through the engine
mk("np-sqs", timeout=20)
q = sqs.create_queue(QueueName="live-q", Attributes={"VisibilityTimeout": "30"})["QueueUrl"]
qarn = sqs.get_queue_attributes(QueueUrl=q, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
lam.create_event_source_mapping(EventSourceArn=qarn, FunctionName="np-sqs", BatchSize=1)
t0 = time.time()
sqs.send_message(QueueUrl=q, MessageBody=json.dumps({"order": 1}))
deadline = time.time() + 45
while time.time() < deadline and stats("np-sqs").get("ok", 0) < 1:
    time.sleep(0.25)
sqs_ms = (time.time() - t0) * 1000
s = stats("np-sqs")
check("an SQS message invoked the function through the stub and the worker answered ok", s.get("viaStub", 0) >= 1 and s.get("ok", 0) >= 1 and s.get("functionErrors", 0) == 0, s)
info("SQS send to function answered ms (includes the mapping's polling and a cold start)", round(sqs_ms))
time.sleep(2)
a = sqs.get_queue_attributes(QueueUrl=q, AttributeNames=["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"])["Attributes"]
check("the engine deleted the message after the function succeeded", a["ApproximateNumberOfMessages"] == "0" and a["ApproximateNumberOfMessagesNotVisible"] == "0", a)
t0 = time.time()
sqs.send_message(QueueUrl=q, MessageBody=json.dumps({"order": 2}))
while time.time() - t0 < 30 and stats("np-sqs").get("ok", 0) < 2:
    time.sleep(0.1)
info("second (warm) SQS message answered ms", round((time.time() - t0) * 1000))
check("both SQS messages were run by the worker", stats("np-sqs").get("viaStub", 0) >= 2, stats("np-sqs"))

# ---- the reset barrier, then the same function created again
ctl("POST", "/_rovara/reset")
check("reset empties the registry", ctl("GET", "/_rovara/lambda/heavy").get("runnerFunctions") == [])
try:
    ROLE = iam.create_role(RoleName="live-role", AssumeRolePolicyDocument=TRUST)["Role"]["Arn"]
except Exception:
    ROLE = iam.get_role(RoleName="live-role")["Role"]["Arn"]
r, create_ms = mk("np-again")
r, ms, body = call("np-again", {"after": "reset"})
check("after a reset a new function registers again and runs", "FunctionError" not in r and json.loads(body).get("echo") == {"after": "reset"}, body[:200])
info("function created and called after the reset (create ms, cold call ms)", [round(create_ms), round(ms)])
# ---- an x86_64 numpy package. TODAY the front itself refuses x86-64 native code (runner_registry.go, reason x86-native) and never forwards it to the worker, so the worker's arm64 wheel swap is proved in run-runner-live.mjs's
# worker-side section instead; this prints what the front answers so the gap is visible.
if X86_PATH:
    ZIP = open(X86_PATH, "rb").read()
    r, ms = mk("np-x86")
    r, ms, body = call("np-x86", {"x": 86})
    info("an x86_64 numpy package through the front (it answers by itself; the worker never sees it)", [r.get("FunctionError"), body.decode()[:160]])
print("DONE", len(fails), "failures", flush=True)
sys.exit(1 if fails else 0)
