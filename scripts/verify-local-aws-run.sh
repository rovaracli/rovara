#!/bin/bash
# Slice 2 operator check, scripted so it is not done by eye: is the `image-result` artifact the one the emulator image workflow really built, from the code we expect?
#
#   scripts/verify-local-aws-run.sh <RUN_ID> <EXPECTED_HEAD_SHA> <ARTIFACT_DIR>
#
# It fails (non-zero, one reason on stderr) unless ALL of these hold:
#   1. the run (gh run view, repository PrepLabsAI/rovara-local-aws) is on branch `main` or `rovara/main`, at exactly EXPECTED_HEAD_SHA, of the workflow named `image`, and its conclusion is `success`.
#      The AWS Emulator engine image (catalog revision 4) is built on the fork's branch `rovara/front` until it is merged into rovara/main: with LOCAL_AWS_RUN_BRANCH=rovara/front that ONE extra branch is accepted (an exact name, never a
#      pattern; the full 40-character sha below is the real pin, so a different head of that branch is still refused);
#   2. <ARTIFACT_DIR>/index.digest is one line `sha256:<64 hex>`;
#   3. the run's own log has the line `index digest: <that digest>` (the workflow prints it from the same file it uploads), so the artifact and the run agree.
# Nothing here trusts the artifact for the first check, and a missing field, an empty answer or a failing gh is a failure. `gh` may be replaced with GH=... (tests).
set -u
export LC_ALL=C
RUN_ID="${1:-}"; SHA="${2:-}"; DIR="${3:-}"
REPO="PrepLabsAI/rovara-local-aws"
EXTRA_BRANCH="${LOCAL_AWS_RUN_BRANCH:-}"
[[ -z "$EXTRA_BRANCH" || "$EXTRA_BRANCH" =~ ^rovara/[a-z0-9][a-z0-9._-]{0,60}$ ]] || { echo "REFUSED: LOCAL_AWS_RUN_BRANCH must be one exact branch named rovara/<name>." >&2; exit 1; }
GH="${GH:-gh}"
fail() { echo "REFUSED: $1" >&2; exit 1; }
[[ "$RUN_ID" =~ ^[0-9]{1,20}$ ]] || fail "the first argument is the run id (digits)."
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "the second argument is the expected full 40-character head sha."
[[ -n "$DIR" && -r "$DIR/index.digest" ]] || fail "the third argument is the folder holding index.digest."

meta=$("$GH" run view "$RUN_ID" -R "$REPO" --json headBranch,headSha,workflowName,conclusion 2>/dev/null) || fail "gh could not read run $RUN_ID."
verdict=$(printf '%s' "$meta" | EXPECT_SHA="$SHA" EXTRA_BRANCH="$EXTRA_BRANCH" python3 -I -c '
import json, os, sys
try:
    run = json.load(sys.stdin)
except Exception:
    print("the run answer is not JSON"); sys.exit(1)
bad = []
allowed = ["main", "rovara/main"] + ([os.environ["EXTRA_BRANCH"]] if os.environ.get("EXTRA_BRANCH") else [])
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
echo "OK run $RUN_ID: branch ok, sha $SHA, workflow image, success; the log and index.digest agree on $digest"
