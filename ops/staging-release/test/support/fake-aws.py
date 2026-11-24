#!/usr/bin/env python3
"""A fake `aws` CLI for the gate pack's tests. It never touches the network.

World: the directory in $FAKE_AWS_DIR. A call `aws <svc> <op> [flags]` is answered from the first existing file of
  <svc>.<op>.<stack>.<changeset>.json, <svc>.<op>.<stack>.json, <svc>.<op>.<selector>.json, <svc>.<op>.json
where <stack> is --stack-name, <changeset> is --change-set-name, <selector> is the first of --name, --role-name, --function-name,
--repository-name, --secret-id, --cluster, --pipeline-name, --policy-arn (any "/" in a value becomes "_").
The file holds the JSON to print, or {"__error": "Code", "message": "..."} to fail like the CLI (exit 254, message on stderr).
No matching file: the call fails with NoFakeAnswer, so a script that makes an unexpected call fails loudly.
--query and --output are accepted and ignored (pack scripts never use them: they parse JSON with jq).
Every call is appended to $FAKE_AWS_DIR/calls.log as one line (the arguments, space separated), BEFORE it is answered.
Local state:
  s3 cp / s3 sync / s3api: files under $FAKE_AWS_DIR/s3/<bucket>/<key>  (an upload writes there; `--if-none-match "*"` on an existing key fails like S3)
  sts get-caller-identity: {"Account": "111111111111"} unless a file overrides it
"""
import json
import os
import shutil
import sys

W = os.environ["FAKE_AWS_DIR"]
args = sys.argv[1:]
with open(os.path.join(W, "calls.log"), "a") as f:
    f.write(" ".join(args) + "\n")


def flag(name):
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None


def fail(code, message, rc=254):
    sys.stderr.write(f"An error occurred ({code}) when calling the {args[1] if len(args) > 1 else ''} operation: {message}\n")
    sys.exit(rc)


def safe(v):
    return v.replace("/", "_")


SK = os.environ.get("FAKE_AWS_SKELETONS", "")


def conform(doc, sk, path):
    """Every field of an answer must exist in the AWS output shape (test/fixtures/skeletons, generated from the botocore models). Types are not compared (the CLI shows a JSON template body as an object)."""
    bad = []
    if isinstance(sk, dict) and isinstance(doc, dict):
        if list(sk) == ["KeyName"]:
            for k, v in doc.items():
                bad += conform(v, sk["KeyName"], f"{path}.{k}")
        elif sk:
            for k, v in doc.items():
                if k not in sk:
                    bad.append(f"{path}.{k}")
                else:
                    bad += conform(v, sk[k], f"{path}.{k}")
    elif isinstance(sk, list) and isinstance(doc, list) and sk:
        for i, v in enumerate(doc):
            bad += conform(v, sk[0], f"{path}[{i}]")
    return bad


def emit(doc):
    """Print an answer, after checking it against the operation's skeleton. A missing skeleton is itself an error: add the call to gen_skeletons.py."""
    if not SK:
        fail("NoSkeletons", "FAKE_AWS_SKELETONS is not set", 99)
    f = os.path.join(SK, f"{svc}.{op}.json")
    if not os.path.isfile(f):
        fail("NoSkeleton", f"no skeleton for {svc} {op}: add it to test/support/gen_skeletons.py and regenerate", 99)
    bad = conform(doc, json.load(open(f)), "")
    if bad:
        fail("FAKE-NONCONFORMING", f"{svc} {op}: field(s) not in the AWS output model: {', '.join(bad[:8])}", 99)
    print(json.dumps(doc))


svc, op = (args + ["", ""])[:2]
if svc == "s3":
    sub = args[1]
    rest = [x for x in args[2:] if not x.startswith("--")]
    flags_with_value = {"--region", "--content-type", "--if-none-match", "--cache-control", "--sse"}
    pos = []
    skip = False
    for i, x in enumerate(args[2:]):
        if skip:
            skip = False
            continue
        if x in flags_with_value:
            skip = True
            continue
        if x.startswith("--"):
            continue
        pos.append(x)
    def local_of(u):
        b, _, k = u[len("s3://"):].partition("/")
        return os.path.join(W, "s3", b, k)
    if sub == "cp" and len(pos) == 2:
        src, dst = pos
        recursive = "--recursive" in args
        if src.startswith("s3://") and not dst.startswith("s3://"):
            ls = local_of(src)
            if recursive:
                if not os.path.isdir(ls):
                    fail("NoSuchKey", "empty prefix", 1)
                shutil.copytree(ls, dst, dirs_exist_ok=True)
            else:
                if not os.path.isfile(ls):
                    fail("NoSuchKey", "The specified key does not exist.", 1)
                os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
                shutil.copyfile(ls, dst)
        elif dst.startswith("s3://") and not src.startswith("s3://"):
            ld = local_of(dst)
            if "--if-none-match" in args and os.path.exists(ld):
                fail("PreconditionFailed", "At least one of the pre-conditions you specified did not hold", 1)
            if recursive:
                shutil.copytree(src, ld, dirs_exist_ok=True)
            else:
                os.makedirs(os.path.dirname(ld), exist_ok=True)
                shutil.copyfile(src, ld)
        else:
            fail("Unsupported", "fake s3 cp handles one local side and one s3 side", 1)
        sys.exit(0)
    fail("Unsupported", f"fake s3 {sub}", 1)
if svc == "s3api":
    bucket, key = flag("--bucket"), flag("--key")
    if op == "put-object":
        p = os.path.join(W, "s3", bucket or "", key or "")
        if flag("--if-none-match") == "*" and os.path.exists(p):
            fail("PreconditionFailed", "At least one of the pre-conditions you specified did not hold", 254)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        shutil.copyfile(flag("--body"), p)
        emit({"ETag": "\"fake\""})
        sys.exit(0)
    if op == "head-object":
        p = os.path.join(W, "s3", bucket or "", key or "")
        if not os.path.isfile(p):
            fail("404", "Not Found")
        emit({"ContentLength": os.path.getsize(p)})
        sys.exit(0)
    if op == "list-objects-v2":
        prefix = flag("--prefix") or ""
        base = os.path.join(W, "s3", bucket or "")
        keys = []
        for root, _, files in os.walk(base):
            for n in files:
                k = os.path.relpath(os.path.join(root, n), base)
                if k.startswith(prefix):
                    keys.append({"Key": k, "Size": os.path.getsize(os.path.join(root, n))})
        emit({"Contents": sorted(keys, key=lambda x: x["Key"])})
        sys.exit(0)

# iam simulate-principal-policy (additive, gate 15): with no iam.simulate-principal-policy.json, every --action-names value is answered "allowed", except the
# actions listed in $FAKE_AWS_DIR/sim-decisions.json ({"<action>": "implicitDeny" | "explicitDeny" | ..., "*": "<decision for every action>"}), and except actions
# listed in sim-omit.json (a list: those actions get no result at all).
if (svc, op) == ("iam", "simulate-principal-policy") and not os.path.isfile(os.path.join(W, "iam.simulate-principal-policy.json")):
    names = []
    if "--action-names" in args:
        for x in args[args.index("--action-names") + 1:]:
            if x.startswith("--"):
                break
            names.append(x)
    def _load(n, d):
        p = os.path.join(W, n)
        return json.load(open(p)) if os.path.isfile(p) else d
    dec, omit = _load("sim-decisions.json", {}), _load("sim-omit.json", [])
    emit({"EvaluationResults": [
        {"EvalActionName": a, "EvalDecision": dec.get(a, dec.get("*", "allowed")), "PermissionsBoundaryDecisionDetail": {"AllowedByPermissionsBoundary": True}}
        for a in names if a not in omit]})
    sys.exit(0)

stack = flag("--stack-name")
cs = flag("--change-set-name")
sel = None
for n in ["--name", "--role-name", "--function-name", "--repository-name", "--secret-id", "--cluster", "--pipeline-name", "--policy-arn", "--path", "--firewall-rule-group-association-id", "--firewall-domain-list-id"]:
    if flag(n):
        sel = flag(n)
        break
cands = []
if stack and cs:
    cands.append(f"{svc}.{op}.{safe(stack)}.{safe(cs)}.json")
if stack:
    cands.append(f"{svc}.{op}.{safe(stack)}.json")
if sel:
    cands.append(f"{svc}.{op}.{safe(sel)}.json")
cands.append(f"{svc}.{op}.json")
for c in cands:
    p = os.path.join(W, c)
    if os.path.isfile(p):
        # the Nth call of the same answer can differ: <name>.<N>.json (N from 1) wins over <name>.json when it exists (a change set replaced between two reads)
        os.makedirs(os.path.join(W, ".count"), exist_ok=True)
        cf = os.path.join(W, ".count", c)
        n = (int(open(cf).read()) if os.path.isfile(cf) else 0) + 1
        open(cf, "w").write(str(n))
        nth = os.path.join(W, c[: -len(".json")] + f".{n}.json")
        if os.path.isfile(nth):
            p = nth
        with open(p) as fh:
            doc = fh.read()
        try:
            d = json.loads(doc)
        except ValueError:
            print(doc)
            sys.exit(0)
        if isinstance(d, dict) and "__error" in d:
            fail(d["__error"], d.get("message", ""))
        emit(d)
        sys.exit(0)
if (svc, op) == ("sts", "get-caller-identity"):
    emit({"Account": "111111111111", "Arn": "arn:aws:sts::111111111111:assumed-role/fake/fake", "UserId": "X"})
    sys.exit(0)
if svc == "cloudformation" and op == "wait":
    sys.exit(0)
if (svc, op) == ("cloudformation", "execute-change-set"):
    res = os.path.join(W, "exec-result." + safe(stack or ""))
    if os.path.isfile(res):
        status = open(res).read().strip()
        dp = os.path.join(W, f"cloudformation.describe-stacks.{safe(stack)}.json")
        if os.path.isfile(dp):
            doc = json.load(open(dp))
            doc["Stacks"][0]["StackStatus"] = status
            json.dump(doc, open(dp, "w"))
if (svc, op) == ("ssm", "put-parameter"):
    # keep what was written, so a test can read the exact value: <world>/ssm-put.<name>.json
    open(os.path.join(W, "ssm-put." + safe(flag("--name") or "") + ".json"), "w").write(flag("--value") or "")
if op in ("put-parameter", "delete-change-set", "execute-change-set") and not any(os.path.isfile(os.path.join(W, c)) for c in cands):
    emit({})
    sys.exit(0)
if (svc, op) == ("ssm", "get-parameter"):
    fail("ParameterNotFound", "Parameter not found.")
if (svc, op) == ("cloudformation", "create-change-set"):
    emit({"Id": f"arn:aws:cloudformation:us-west-2:111111111111:changeSet/{cs or flag('--change-set-name')}/00000000-0000-4000-8000-000000000000", "StackId": f"arn:aws:cloudformation:us-west-2:111111111111:stack/{stack}/11111111-1111-4111-8111-111111111111"})
    sys.exit(0)
fail("NoFakeAnswer", "no fake file for " + " | ".join(cands))
