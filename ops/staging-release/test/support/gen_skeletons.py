#!/usr/bin/env python3
"""Regenerates fixtures/skeletons/<service>.<operation>.json: the OUTPUT SHAPE of every AWS call the pack makes, expanded from the botocore models that ship with the local AWS CLI v2.
(`aws <svc> <op> --generate-cli-skeleton output` is not usable: this CLI validates required input first. The model is the same source the CLI uses. Offline: no AWS call, no credentials.)
The fake CLI (fake-aws.py) refuses to answer with a field a skeleton lacks, so a script that reads a field the real API does not return fails its test (the lastUpdatedBy / updatedBy class of bug).
Map shapes appear as {"KeyName": <value>}; lists as one-element lists; scalars as "string" / 0 / true.
Run: python3 -I test/support/gen_skeletons.py   (then commit the changed files). The CLI version is recorded in skeletons/_cli-version.txt.
"""
import json
import os
import subprocess
import sys

CALLS = """sts:get-caller-identity cloudformation:describe-stacks cloudformation:list-stack-resources cloudformation:get-template cloudformation:describe-stack-events
cloudformation:describe-change-set cloudformation:list-change-sets cloudformation:create-change-set cloudformation:execute-change-set cloudformation:delete-change-set
s3api:head-object s3api:put-object s3api:list-objects-v2 ssm:get-parameter ssm:get-parameters-by-path ssm:put-parameter ecr:describe-images lambda:get-function-configuration
cloudwatch:get-metric-statistics ecs:describe-services ecs:describe-task-definition codepipeline:get-pipeline-execution codepipeline:list-action-executions
iam:get-role iam:simulate-principal-policy route53resolver:get-firewall-rule-group-association route53resolver:get-firewall-domain-list route53resolver:list-firewall-domains
secretsmanager:describe-secret""".split()
# the CLI's own service directory names where they differ from the command name
DIR = {"s3api": "s3"}


def data_dir():
    if os.environ.get("BOTOCORE_DATA"):
        return os.environ["BOTOCORE_DATA"]
    real = os.path.realpath(subprocess.run(["sh", "-c", "command -v aws"], capture_output=True, text=True).stdout.strip())
    root = os.path.dirname(os.path.dirname(real))
    for dp, dn, _ in os.walk(root):
        if dp.endswith("awscli/botocore/data"):
            return dp
        if dp.count(os.sep) - root.count(os.sep) > 6:
            dn[:] = []
    sys.exit("cannot find the botocore data directory; set BOTOCORE_DATA")


def snake_to_pascal(op):
    return "".join(p.capitalize() for p in op.split("-"))


def expand(shapes, name, seen):
    shape = shapes[name]
    t = shape["type"]
    if t == "structure":
        if name in seen:
            return {}
        return {k: expand(shapes, v["shape"], seen | {name}) for k, v in shape.get("members", {}).items()}
    if t == "list":
        return [expand(shapes, shape["member"]["shape"], seen)]
    if t == "map":
        return {"KeyName": expand(shapes, shape["value"]["shape"], seen)}
    if t in ("integer", "long"):
        return 0
    if t in ("float", "double"):
        return 0.0
    if t == "boolean":
        return True
    return "string"


def main():
    base = data_dir()
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "skeletons")
    os.makedirs(out, exist_ok=True)
    for c in CALLS:
        svc, op = c.split(":")
        d = os.path.join(base, DIR.get(svc, svc))
        ver = sorted(x for x in os.listdir(d) if x[0].isdigit())[-1]
        model = json.load(open(os.path.join(d, ver, "service-2.json")))
        shapes = model["shapes"]
        opdef = model["operations"][snake_to_pascal(op)]
        skeleton = expand(shapes, opdef["output"]["shape"], frozenset()) if "output" in opdef else {}
        with open(os.path.join(out, f"{svc}.{op}.json"), "w") as f:
            json.dump(skeleton, f, indent=1, sort_keys=True)
            f.write("\n")
    with open(os.path.join(out, "_cli-version.txt"), "w") as f:
        f.write(subprocess.run(["aws", "--version"], capture_output=True, text=True).stdout)


if __name__ == "__main__":
    main()
