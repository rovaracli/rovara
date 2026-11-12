#!/usr/bin/env python3
"""L3 release check for the Team record embedder change (DECISIONS 140). READ-ONLY: it only lists and counts (dynamodb query/scan with a COUNT, s3vectors list calls); it writes, deletes and invokes nothing.

    check_record_release.py --env staging [--aws-cmd "~/.local/share/rovara-tools/staging-aws.sh aws"] [--bucket NAME ...] [--old-spec 0b0a5b868995d4ee]

Run it before the upgrade that brings the bge-small embedder (and again after the first re-embed run). It fails (exit 1) when
  1. a record vector bucket holds an index whose name is not `teamRecordVectorIndexName(workspace, <current spec>)` for a workspace of the Team record's org directory (an old Titan or Qwen3 index, or anything else), or
  2. any table row still says `embeddingSpec` = the old (Qwen3) spec.
Exit 0: both are clean. Exit 2: the check itself could not run (a command failed, an answer could not be read), which is NOT a pass.

The AWS command is `--aws-cmd` (default `staging-aws.sh aws`, which pins staging's account and region); the table is `agentx-<env>-team-record` and the buckets are those named `agentx-<env>-record-vectors*`
(or `--bucket`). The current spec is read from models.lock.json (the record entry), so this file cannot disagree with the image. The index-name hash is the one of packages/cloud-contracts/src/team-record-storage.ts
(`teamRecordVectorIndexName`); tests/unit/embedder/check-record-release.test.ts holds the two equal. The scan counts rows of the whole table (one read per item scanned): fine for a release check, not for a loop.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOCK = HERE.parent / "models.lock.json"
DEFAULT_AWS = str(Path.home() / ".local/share/rovara-tools/staging-aws.sh") + " aws"
ORG_DIRECTORY_PK = "TEAM_RECORD_ORGS"
ORG_ID = re.compile(r"^org_[0-9a-z]{20}$")  # OrgIdSchema; the directory partition also holds REEMBED#, ERASE# and other state items
SAFE_WORKSPACE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


def index_name(workspace_id: str, spec: str) -> str:
    """packages/cloud-contracts/src/team-record-storage.ts `teamRecordVectorIndexName`."""
    if not SAFE_WORKSPACE_ID.match(workspace_id):
        raise ValueError("workspace id is not a safe id")
    if not re.match(r"^[0-9a-f]{16}$", spec):
        raise ValueError("embedding spec is not valid")
    return "ws-" + hashlib.sha256(f"team-record-vectors\u0000{workspace_id}\u0000{spec}".encode()).hexdigest()[:32]


class CheckError(Exception):
    pass


def run_aws(aws: list[str], args: list[str]) -> object:
    try:
        done = subprocess.run([*aws, *args, "--output", "json"], capture_output=True, text=True, timeout=300, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CheckError(f"could not run {' '.join(args[:2])}: {type(error).__name__}") from error
    if done.returncode != 0:
        raise CheckError(f"{' '.join(args[:2])} failed (exit {done.returncode}): {done.stderr.strip()[:300]}")
    try:
        return json.loads(done.stdout) if done.stdout.strip() else {}
    except json.JSONDecodeError as error:
        raise CheckError(f"{' '.join(args[:2])} answered something that is not JSON") from error


def workspaces(aws: list[str], table: str) -> list[str]:
    answer = run_aws(aws, ["dynamodb", "query", "--table-name", table, "--consistent-read", "--key-condition-expression", "pk = :pk",
                           "--expression-attribute-values", json.dumps({":pk": {"S": ORG_DIRECTORY_PK}}), "--projection-expression", "sk"])
    items = answer.get("Items", []) if isinstance(answer, dict) else []
    out = [item["sk"]["S"] for item in items if isinstance(item, dict) and isinstance(item.get("sk"), dict) and isinstance(item["sk"].get("S"), str) and ORG_ID.match(item["sk"]["S"])]
    return sorted(out)


def buckets(aws: list[str], env: str, named: list[str]) -> list[str]:
    if named:
        return named
    prefix = f"agentx-{env}-record-vectors"
    answer = run_aws(aws, ["s3vectors", "list-vector-buckets", "--prefix", prefix])
    found = answer.get("vectorBuckets", []) if isinstance(answer, dict) else []
    return sorted(item["vectorBucketName"] for item in found if isinstance(item, dict) and str(item.get("vectorBucketName", "")).startswith(prefix))


def indexes(aws: list[str], bucket: str) -> list[str]:
    answer = run_aws(aws, ["s3vectors", "list-indexes", "--vector-bucket-name", bucket])
    found = answer.get("indexes", []) if isinstance(answer, dict) else []
    return sorted(item["indexName"] for item in found if isinstance(item, dict) and "indexName" in item)


def old_rows(aws: list[str], table: str, old_spec: str) -> int:
    answer = run_aws(aws, ["dynamodb", "scan", "--table-name", table, "--select", "COUNT", "--filter-expression", "embeddingSpec = :s",
                           "--expression-attribute-values", json.dumps({":s": {"S": old_spec}})])
    count = answer.get("Count") if isinstance(answer, dict) else None
    if not isinstance(count, int):
        raise CheckError("the scan answered no Count")
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only release check of the Team record embedder change (L3).")
    parser.add_argument("--env", required=True, help="the environment name, e.g. staging")
    parser.add_argument("--aws-cmd", default=DEFAULT_AWS, help="the AWS command and its pinned account (default: staging-aws.sh aws)")
    parser.add_argument("--bucket", action="append", default=[], help="a record vector bucket (default: every bucket named agentx-<env>-record-vectors*)")
    parser.add_argument("--old-spec", default="0b0a5b868995d4ee", help="the spec of the model being replaced (Qwen3-Embedding-0.6B)")
    args = parser.parse_args(argv)
    aws = shlex.split(os.path.expanduser(args.aws_cmd))
    table = f"agentx-{args.env}-team-record"
    try:
        current = json.loads(LOCK.read_text(encoding="utf-8"))["models"]["record"]["spec"]
        orgs = workspaces(aws, table)
        expected = {index_name(org, current) for org in orgs}
        names = buckets(aws, args.env, args.bucket)
        if not names:
            print(f"no record vector bucket found for {args.env}", file=sys.stderr)
            return 2
        stray: list[tuple[str, str]] = []
        for bucket in names:
            for name in indexes(aws, bucket):
                if name not in expected:
                    stray.append((bucket, name))
        old = old_rows(aws, table, args.old_spec)
    except (CheckError, ValueError, KeyError, OSError) as error:
        print(f"CHECK COULD NOT RUN: {error}", file=sys.stderr)
        return 2
    print(f"workspaces in the directory: {len(orgs)}; current spec {current}; buckets checked: {', '.join(names)}")
    for bucket, name in stray:
        print(f"FAIL index {name} in {bucket} is not the current index of any workspace (spec {current})")
    if old > 0:
        print(f"FAIL {old} table row(s) still have embeddingSpec = {args.old_spec}")
    if stray or old > 0:
        return 1
    print("PASS: every index is a current index, and no row names the old spec")
    return 0


if __name__ == "__main__":
    sys.exit(main())
