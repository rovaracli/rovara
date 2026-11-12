#!/bin/bash
# Slice 2 operator check, scripted so it is not done by eye: is the `image-result` artifact the one the emulator image workflow really built, from the code we expect?
#
#   scripts/verify-local-aws-run.sh <RUN_ID> <EXPECTED_HEAD_SHA> <ARTIFACT_DIR> [<REPOSITORY> [<PRIVATE_SOURCE_SHA>]]
#
# REPOSITORY is one of two literals (anything else is refused): `PrepLabsAI/rovara-local-aws` (the default: the private fork, the old path) or `rovaracli/rovara-local-aws` (the public CI-only copy the AWS Emulator engine image is built in,
# because Actions cannot run on private repositories; owner decision, like decision 33 for Rovara-cloud). Every snapshot there is a parentless commit of the private branch `rovara/front` (src/ and .superpowers/ removed), so it cannot
# fast-forward `main` and is pushed to its own branch `snapshot/<first 12 hex of the private rovara/front sha>`. For that repository PRIVATE_SOURCE_SHA (the full 40-character private commit, the `privateSourceSha` of the sources entry's
# provenance) is REQUIRED and the run's branch must be exactly `snapshot/` plus its first 12 hex characters; EXPECTED_HEAD_SHA is the PUBLIC snapshot sha. Before snapshotting, scripts/verify-local-aws-snapshot.sh proves the snapshot
# is parentless and its tree is the private commit's tree minus those two folders.
#
# It fails (non-zero, one reason on stderr) unless ALL of these hold:
#   1. the run (gh run view, in REPOSITORY) is on an allowed branch of that repository, at exactly EXPECTED_HEAD_SHA, of the workflow named `image`, and its conclusion is `success`. Allowed: `main` or `rovara/main` in
#      PrepLabsAI/rovara-local-aws (and no private sha is given); in rovaracli/rovara-local-aws exactly `snapshot/<first 12 hex of PRIVATE_SOURCE_SHA>` and never `main`. No variable adds a branch, and the full 40-character sha is the real pin;
#   2. <ARTIFACT_DIR>/index.digest is one line `sha256:<64 hex>`;
#   3. the run's own log has the line `index digest: <that digest>` (the workflow prints it from the same file it uploads), so the artifact and the run agree.
# Nothing here trusts the artifact for the first check, and a missing field, an empty answer or a failing gh is a failure. `gh` may be replaced with GH=... (tests).
set -u
export LC_ALL=C
RUN_ID="${1:-}"; SHA="${2:-}"; DIR="${3:-}"
REPO="${4:-PrepLabsAI/rovara-local-aws}"; PRIVATE_SHA="${5:-}"
case "$REPO" in
  PrepLabsAI/rovara-local-aws)
    [[ -z "$PRIVATE_SHA" ]] || { echo "REFUSED: a private source sha is for the public repository only." >&2; exit 1; }
    ALLOWED_BRANCHES="main rovara/main" ;;
  rovaracli/rovara-local-aws)
    [[ "$PRIVATE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "REFUSED: the public repository needs the private rovara/front sha (full 40 characters) as the fifth argument." >&2; exit 1; }
    ALLOWED_BRANCHES="snapshot/${PRIVATE_SHA:0:12}" ;;
  *) echo "REFUSED: the repository is PrepLabsAI/rovara-local-aws or rovaracli/rovara-local-aws." >&2; exit 1 ;;
esac
GH="${GH:-gh}"
fail() { echo "REFUSED: $1" >&2; exit 1; }
[[ "$RUN_ID" =~ ^[0-9]{1,20}$ ]] || fail "the first argument is the run id (digits)."
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "the second argument is the expected full 40-character head sha."
[[ -n "$DIR" && -r "$DIR/index.digest" ]] || fail "the third argument is the folder holding index.digest."

meta=$("$GH" run view "$RUN_ID" -R "$REPO" --json headBranch,headSha,workflowName,conclusion 2>/dev/null) || fail "gh could not read run $RUN_ID."
verdict=$(printf '%s' "$meta" | EXPECT_SHA="$SHA" ALLOWED_BRANCHES="$ALLOWED_BRANCHES" python3 -I -c '
import json, os, sys
try:
    run = json.load(sys.stdin)
except Exception:
    print("the run answer is not JSON"); sys.exit(1)
bad = []
allowed = os.environ["ALLOWED_BRANCHES"].split()
if run.get("headBranch") not in allowed: bad.append("branch is %r (needs %s)" % (run.get("headBranch"), " or ".join(allowed)))
if run.get("headSha") != os.environ["EXPECT_SHA"]: bad.append("head sha is %r (expected %s)" % (run.get("headSha"), os.environ["EXPECT_SHA"]))
if run.get("workflowName") != "image": bad.append("workflow is %r (needs image)" % run.get("workflowName"))
if run.get("conclusion") != "success": bad.append("conclusion is %r (needs success)" % run.get("conclusion"))
if bad:
    print("; ".join(bad)); sys.exit(1)
print("ok")
') || fail "run $RUN_ID: $verdict"

digest=$(tr -d '[:space:]' < "$DIR/index.digest")
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "index.digest is not one sha256 digest."
log=$("$GH" run view "$RUN_ID" -R "$REPO" --log 2>/dev/null) || fail "gh could not read the log of run $RUN_ID."
printf '%s\n' "$log" | grep -F -q -- "index digest: $digest" || fail "the run's log has no line 'index digest: $digest': the artifact is not this run's."
# A different digest in the same log is also a refusal: the log must name exactly one index digest.
others=$(printf '%s\n' "$log" | grep -o 'index digest: sha256:[0-9a-f]\{64\}' | sort -u | wc -l | tr -d ' ')
[[ "$others" == "1" ]] || fail "the run's log names $others different index digests."
echo "OK run $RUN_ID in $REPO: branch ok, sha $SHA, workflow image, success; the log and index.digest agree on $digest"
