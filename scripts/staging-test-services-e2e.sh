#!/bin/bash
# The live done-check of test services slice 1 (ROUND-2026-11-03-test-services-hookup.md, "What it proves", items 1-9): ONE staging project, `tx` on, ONE dependency (Postgres 16 from the catalog), tasks run through
# Rovara itself. WRITTEN, NOT RUN against staging. It runs only after the OWNER GO for `tx` on one project (DECISIONS: "Test services: thin slice first"), the catalog steps 1-5, and refuses to start without it
# (STAGING_E2E_OWNER_GO below). It is tested end to end against a fake curl, a fake staging guard and canned CloudWatch lines (tests/contract/staging-test-services-script.test.ts).
#
# NO "EMPTY OR MISSING MEANS PASS". A PASS needs positive evidence: a field that is not there, a report that does not come, a test that is not listed, a timeout, an HTTP error, an unreadable answer is a FAIL (or, where only a
# person can supply the input, an OPERATOR line that also makes the script exit non-zero). The script exits 0 only when every step it ran PASSED and none is left to an operator.
#
# NO SSM, NO ROOT ON THE WORKER. Staging workers are not SSM-managed (their instance profile has no SSM permission, by design). Everything here is one of:
#   - the Rovara API (propose, check, prove, a task on the escape project, the task's view, a cancel), with ONE bearer token read from a file (mode 600; never printed, never in an argument: curl reads the header from a file);
#   - the staging guard (~/.local/share/rovara-tools/staging-aws.sh, account 944937319445, us-west-2) for READ-ONLY AWS calls: sts, ecr describe-images, logs filter-log-events. It creates nothing, deploys nothing, reads no secret;
#   - the WORKER'S OWN SELF-REPORT in CloudWatch Logs (log group /agentx/<env>/worker): after every test-services run and at every worker start the worker logs ONE `test-services.report` line with fixed fields (leftover
#     labelled containers and networks, run directory empty and tmpfs, working sandbox paused or not) and, at start, the facts root wrote at boot (metadata block, run-network walls, IPv6 drops, pre-pull, registry
#     logout). See packages/worker/src/test-services-report.ts. No name, path or secret is in them. A run's outcome is completed | checks_failed | failed | cancelled.
#   - the ESCAPE PROJECT (tests/fixtures/test-services-escape-project): a project whose tests try to get out of a sealed round and pass only if each attempt fails. It is five CHECKS, one per test file (see its README), and the
#     script ties its verdict to them BY NAME. To give the tests something to prove, the script's task prompt makes the WORKING phase plant state and leave a listening heartbeat behind (see "THE ESCAPE TASK").
#
# THE STEPS (the numbers are the done-definition's)
#   P0     the API URL is the staging API: its host must match ROVARA_STAGING_HOST_REGEX (the host of the staging stack's API output; mandatory).
#   P1-P3  preconditions (read-only AWS): the staging account; the catalog repository holds postgres by digest; the committed catalog pin is one of them.
#   P4     the latest worker_start report in the last --worker-window-hours (default 72), NOT only since the script started: boot facts all true, pre-pull ok and logged out, nothing left over, the run directory
#          empty and a tmpfs. (This replaces the read-only host checks of scripts/linux-check-test-services.sh L1/L5/L6 that needed a shell.)
#   1      dependencies listed: POST propose answers a TestEnvironmentState; proposal.environment.dependencies lists a local Postgres with its source line (found); proposal.digest is taken from it.
#   2      Prove passes: POST check for that digest, then POST prove until proposal.proveSteps holds "dependencies" and "dependency_usage" both passed (a failed check, a timeout, or a missing step is a FAIL).
#   3      a task passes a check round: the script starts ONE task on the escape project (--escape-project) through the API (or take --task <id> of one you started in the app), polls it to an END status
#          (SUCCEEDED, FAILED, CANCELLED, INTERRUPTED, CLOSED) and requires SUCCEEDED. A timeout, an HTTP error, or no end status is a FAIL.
#   4      the escape project's five tests, each by name (internet, ipv6, neighbours, planted-state, relay), have a check entry with after=passed in the task view or the --evidence file; the worker's run_end for the run
#          is outcome completed (not checks_failed) and clean. A test with no entry is a FAIL; no entries at all is an OPERATOR line (pass --evidence).
#   5      the PR line: `Integration tests ran against: Postgres (real).` in the task view or the --evidence file.
#   6      unknown calls fail loudly: `Blocked by environment: N call(s)` names registrable domains and counts (example.com and example.net from the escape project's lookups) and no full name.
#   L3     the relay test (detached process left in the working sandbox is frozen in the sealed round) has a passed check entry. It cannot skip: a missing or dead heartbeat FAILS it.
#   7      teardown is clean: the run_end reports since the run (outcome by outcome: pass --expect-outcome completed|checks_failed|failed|cancelled) show nothing left, the run directory empty and a tmpfs, the working sandbox
#          not paused. At least one report must exist.
#   7c     --cancel-test (needs --escape-project): starts a task whose working phase sleeps, cancels it through POST /v1/dev/tasks/<id>/cancel once it runs, requires CANCELLED, then requires a run_end report with outcome
#          cancelled and nothing left. This automates the cancel half of done item 7.
#   7k     --expect-swept: after YOU killed a worker's container/instance and it restarted, the worker_start report shows what the sweep removed and nothing left. (Killing a worker is an operator step.)
#   8      switch off = today: the operator turns tx off for the project, starts the same task and compares with a task from before the release (a person's step).
#   9      any other backing is refused with "not available yet" (the broker's unit tests cover the words; propose a draft with an S3 candidate in the app to see them).
#
# THE ESCAPE TASK: the prompt (ESCAPE_PROMPT) tells the agent to run `npm run plant` (creates planted_escape and escape_planted.planted_escape_other, and a server setting, in the WORKING-phase Postgres, reads them back and
# leaves a receipt) and `npm run setup` (a detached heartbeat that LISTENS on the working sandbox's address and ticks every 200 ms), then to add one README line. The sealed round's tests then assert the plant is absent from the
# round's brand-new Postgres, the heartbeat was alive and is frozen, and the working sandbox cannot be reached. Only an IMPLEMENT task has a working-phase Postgres, so the plant needs a task, not a CHECKS-only run.
#
# SLICE 2 (--aws): the same script, with Rovara local AWS (S3, SQS and DynamoDB) on top of Postgres. WRITTEN, NOT RUN. It needs the slice-2 steps first (the emulator image built on GitHub, `catalog-build --entries local-aws@r1`
# on staging with the owner's OK, the pin committed, a worker image rebuild and upgrade: .superpowers/sdd/s2-integration/report.md). The project is the escape project with its `aws/` overlay copied over it (see the fixture's README).
#   PA     the catalog repository rovara-catalog/<env>/svc/local-aws holds the committed pin of local-aws@r1.
#   1      (changed) the proposal also lists S3, SQS and DynamoDB as `emulated` on local-aws@r1, each with its source line and the template as its resource pointer.
#   4      (changed) the five escape tests AND aws-positive (the declared bucket, queue and table exist: the worker seeded the project's template) have a passed check entry.
#   5      (changed) the PR line reads `Integration tests ran against: Postgres (real), <S3, SQS and DynamoDB> (Rovara local AWS).` (the order follows the proposal's), with all three names.
#   A2     the IAM line: `AWS permissions (IAM) were not checked: Rovara local AWS does not enforce IAM`.
#   A3     aws-control: the emulator's /_rovara/* control paths, tried from the sealed round with no token and a made-up one, were refused (403 or 401): a passed check entry.
#   A4     --aws-flag-project <name> (or --aws-flag-task <id>): a task whose code calls SNS at the emulator: the emulator refused (the aws-out-of-plan check passed) AND the evidence flags
#          `The code called AWS services that are not in the plan` naming sns; the worker's run_end for that task is clean. Without either, an OPERATOR line.
#   P4     (changed) the worker's pre-pull count is at least 2 (Postgres and local-aws).
# Everything else (2, 3, 6, L3, 7, 7c, 7k) is the slice-1 check, on the same project.
#
# USAGE  (from anywhere; the repository's catalog.json is read relative to this script)
#   STAGING_E2E_OWNER_GO=yes ROVARA_STAGING_URL=https://<staging api> ROVARA_STAGING_HOST_REGEX='^api\.staging\.example\.com$' ROVARA_STAGING_TOKEN_FILE=$HOME/.rovara-staging-token ROVARA_STAGING_PROJECT=<project with the dependency> \
#     scripts/staging-test-services-e2e.sh [--aws [--aws-flag-project <name>] [--aws-flag-task <id>]] [--escape-project <name>] [--task <id>] [--evidence <file>] [--expect-outcome <o>] [--cancel-test] [--expect-swept] [--env <name>] [--since <epoch ms>] [--worker-window-hours <n>] [--only <id>[,<id>...]]
#   --since is where the run_end window starts (default: when the script started; with --task and no --since, a minute before the task was created). Re-run with --task / --evidence / --expect-outcome after the steps a person does.
#   Environment for tests and slow days: TSE_POLL_SLEEP (10 s), TSE_POLL_PROVE (60), TSE_POLL_TASK (180), TSE_POLL_REPORTS (18), TSE_POLL_RUNNING (12), TSE_CATALOG_FILE (the committed catalog.json).
set -u
export LC_ALL=C

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGING="${STAGING_AWS:-$HOME/.local/share/rovara-tools/staging-aws.sh}"
EXPECTED_ACCOUNT=944937319445
CATALOG_REPOSITORY_SUFFIX="svc/postgres"
STEP_IDS="P0 P1 P2 P3 PA P4 1 2 3 4 5 6 L3 A2 A3 A4 7 7c 7k 8 9"
TASK_ID=""
EVIDENCE_FILE=""
ESCAPE_PROJECT=""
EXPECT_OUTCOME=""
EXPECT_SWEPT=""
CANCEL_TEST=""
AWS_MODE=""
AWS_FLAG_PROJECT=""
AWS_FLAG_TASK=""
ENV_NAME="staging"
NOW_MS=$(( $(date +%s) * 1000 ))
SINCE_MS="$NOW_MS"
SINCE_GIVEN=""
WORKER_WINDOW_HOURS=72
ONLY=""
POLL_SLEEP="${TSE_POLL_SLEEP:-10}"; POLL_PROVE="${TSE_POLL_PROVE:-60}"; POLL_TASK="${TSE_POLL_TASK:-180}"; POLL_REPORTS="${TSE_POLL_REPORTS:-18}"; POLL_RUNNING="${TSE_POLL_RUNNING:-12}"
ESCAPE_PROMPT='Run `npm run plant` and then `npm run setup` in the terminal; both must print a line starting with OK. Then add one line to README.md that says the escape project ran. Change nothing else.'
CANCEL_PROMPT='Run `npm run plant` and then `npm run setup` in the terminal. Then run `sleep 600` in the terminal and wait for it. Do not change any file.'
while [[ $# -gt 0 ]]; do
  case "$1" in
    --task) TASK_ID="${2:-}"; shift 2 ;;
    --evidence) EVIDENCE_FILE="${2:-}"; shift 2 ;;
    --escape-project) ESCAPE_PROJECT="${2:-}"; shift 2 ;;
    --expect-outcome) EXPECT_OUTCOME="${2:-}"; shift 2 ;;
    --expect-swept) EXPECT_SWEPT=1; shift ;;
    --cancel-test) CANCEL_TEST=1; shift ;;
    --aws) AWS_MODE=1; shift ;;
    --aws-flag-project) AWS_FLAG_PROJECT="${2:-}"; shift 2 ;;
    --aws-flag-task) AWS_FLAG_TASK="${2:-}"; shift 2 ;;
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --since) SINCE_MS="${2:-}"; SINCE_GIVEN=1; shift 2 ;;
    --worker-window-hours) WORKER_WINDOW_HOURS="${2:-}"; shift 2 ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$ENV_NAME" =~ ^[a-z][a-z0-9-]{0,19}$ ]] || { echo "REFUSED: not an environment name." >&2; exit 3; }
[[ "$SINCE_MS" =~ ^[0-9]{10,16}$ ]] || { echo "REFUSED: --since is epoch milliseconds." >&2; exit 3; }
[[ "$WORKER_WINDOW_HOURS" =~ ^[0-9]{1,4}$ ]] || { echo "REFUSED: --worker-window-hours is a whole number." >&2; exit 3; }
[[ "$EVIDENCE_FILE" == "" || -r "$EVIDENCE_FILE" ]] || { echo "REFUSED: --evidence file is not readable." >&2; exit 3; }
# --only names steps; an unknown name is an error, not an empty run that passes.
if [[ -n "$ONLY" ]]; then
  IFS=',' read -r -a only_ids <<< "$ONLY"
  for id in "${only_ids[@]}"; do [[ " $STEP_IDS " == *" $id "* ]] || { echo "unknown step in --only: '$id' (steps: $STEP_IDS)" >&2; exit 2; }; done
fi
if [[ -n "$CANCEL_TEST" && -z "$ESCAPE_PROJECT" ]]; then echo "--cancel-test needs --escape-project <name>" >&2; exit 2; fi
if [[ -z "$AWS_MODE" && ( -n "$AWS_FLAG_PROJECT" || -n "$AWS_FLAG_TASK" ) ]]; then echo "--aws-flag-project and --aws-flag-task need --aws" >&2; exit 2; fi
[[ "$AWS_FLAG_PROJECT" == "" || "$AWS_FLAG_PROJECT" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]] || { echo "REFUSED: --aws-flag-project is not a project name." >&2; exit 3; }

pass=0; fail=0; operator=0
say() { printf 'TSE %s %s %s | %s\n' "$1" "$2" "$3" "$4"; case "$2" in PASS) pass=$((pass+1));; FAIL) fail=$((fail+1));; OPERATOR) operator=$((operator+1));; esac; }
wanted() { [[ -z "$ONLY" ]] || [[ ",$ONLY," == *",$1,"* ]]; }

[[ "${STAGING_E2E_OWNER_GO:-}" == "yes" ]] || { echo "REFUSED: this is the slice-1 staging proof; it runs only after the owner's go for tx on one project (set STAGING_E2E_OWNER_GO=yes)." >&2; exit 3; }
[[ -x "$STAGING" ]] || { echo "REFUSED: $STAGING (the staging guard) is not there." >&2; exit 3; }
for needed in ROVARA_STAGING_URL ROVARA_STAGING_PROJECT ROVARA_STAGING_TOKEN_FILE ROVARA_STAGING_HOST_REGEX; do [[ -n "${!needed:-}" ]] || { echo "REFUSED: set $needed." >&2; exit 3; }; done
[[ "$ROVARA_STAGING_URL" =~ ^https://([A-Za-z0-9.-]+)(:[0-9]+)?(/.*)?$ ]] || { echo "REFUSED: the staging URL must be https://<host>." >&2; exit 3; }
API_HOST="${BASH_REMATCH[1]}"
[[ "$API_HOST" =~ ^[0-9.]+$ || "$API_HOST" == localhost* ]] && { echo "REFUSED: the staging URL must name the staging API by its domain." >&2; exit 3; }
[[ "$API_HOST" =~ $ROVARA_STAGING_HOST_REGEX ]] || { echo "REFUSED: the API host '$API_HOST' does not match ROVARA_STAGING_HOST_REGEX (the staging API's host): this script must not drive another environment." >&2; exit 3; }
[[ -r "$ROVARA_STAGING_TOKEN_FILE" ]] || { echo "REFUSED: the token file is not readable." >&2; exit 3; }
mode=$(stat -f '%Lp' "$ROVARA_STAGING_TOKEN_FILE" 2>/dev/null || stat -c '%a' "$ROVARA_STAGING_TOKEN_FILE" 2>/dev/null)
[[ "$mode" == "600" || "$mode" == "400" ]] || { echo "REFUSED: the token file must be mode 600." >&2; exit 3; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tse.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
# The header goes to curl from a file, so the token is in no argument and no output.
printf 'Authorization: Bearer %s\n' "$(tr -d '\n' < "$ROVARA_STAGING_TOKEN_FILE")" > "$WORK/header"; chmod 600 "$WORK/header"
say P0 PASS "API URL is the staging API" "host $API_HOST matches ROVARA_STAGING_HOST_REGEX"

# ---- the verdict helper (python, written once). Every subcommand fails (non-zero, a reason on stderr) when what it needs is missing: nothing here defaults to "ok".
cat > "$WORK/tse.py" <<'PY'
import json, os, sys
from datetime import datetime

def load():
    try:
        return json.load(sys.stdin)
    except Exception as error:
        sys.stderr.write("the answer is not JSON (%s)\n" % type(error).__name__); sys.exit(1)

def dig(data, path):
    for key in path.split("."):
        if isinstance(data, list):
            data = data[int(key)]
        else:
            data = data[key]
    return data

def walk(node):
    yield node
    if isinstance(node, dict):
        for value in node.values():
            yield from walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk(value)

cmd = sys.argv[1]
if cmd == "get":
    try:
        value = dig(load(), sys.argv[2])
    except Exception:
        sys.stderr.write("no %s in the answer\n" % sys.argv[2]); sys.exit(1)
    if value is None or value == "":
        sys.stderr.write("%s is empty\n" % sys.argv[2]); sys.exit(1)
    print(json.dumps(value) if isinstance(value, (dict, list)) else str(value).lower() if isinstance(value, bool) else value)
elif cmd == "deps":
    state = load()
    try:
        deps = state["proposal"]["environment"]["dependencies"]
    except Exception:
        sys.stderr.write("the answer has no proposal.environment.dependencies"); sys.exit(1)
    if not isinstance(deps, list):
        sys.stderr.write("proposal.environment.dependencies is not a list"); sys.exit(1)
    good = [d for d in deps if isinstance(d, dict) and d.get("family") == "postgres" and (d.get("backing") or {}).get("kind") == "local" and d.get("found")]
    if not good:
        sys.stderr.write("no local Postgres with a source line among %s" % ",".join(str(d.get("id")) for d in deps if isinstance(d, dict)) or "no dependencies"); sys.exit(1)
    if os.environ.get("AWS_MODE"):
        # Slice 2: S3, SQS and DynamoDB must be there as emulated on local-aws@r1, each with its source line and the infrastructure file as its resource pointer. A missing one is a FAIL, not a smaller list.
        for service in ("s3", "sqs", "dynamodb"):
            found = [d for d in deps if isinstance(d, dict) and d.get("family") == "aws:" + service and (d.get("backing") or {}).get("kind") == "emulated" and (d.get("backing") or {}).get("catalogId") == "local-aws@r1" and d.get("found") and ((d.get("backing") or {}).get("resources") or {}).get("path")]
            if not found:
                sys.stderr.write("no emulated %s on local-aws@r1 with a source line and a resource pointer among %s" % (service, ",".join(str(d.get("id")) for d in deps if isinstance(d, dict)))); sys.exit(1)
            good.append(found[0])
    print(",".join(str(d["id"]) for d in good))
elif cmd == "prove":
    state = load()
    proposal = state.get("proposal") if isinstance(state, dict) else None
    if not isinstance(proposal, dict):
        sys.stderr.write("the answer has no proposal"); sys.exit(1)
    check = (proposal.get("check") or {}).get("status")
    steps = proposal.get("proveSteps")
    if check == "failed":
        sys.stderr.write("the candidate check failed: %s" % (proposal.get("check") or {}).get("failedStep", "no step named")); sys.exit(1)
    if not isinstance(steps, list) or not steps:
        if check in ("checking", "unchecked", "outdated", None):
            print("pending: check is %s, no Prove steps yet" % check); sys.exit(4)
        sys.stderr.write("the check is %s but the answer has no proveSteps" % check); sys.exit(1)
    got = {s.get("step"): s.get("status") for s in steps if isinstance(s, dict)}
    missing = [n for n in ("dependencies", "dependency_usage") if n not in got]
    if missing:
        if check in ("checking", "unchecked"):
            print("pending: check is %s, Prove steps %s not there yet" % (check, ",".join(missing))); sys.exit(4)
        sys.stderr.write("Prove has no step %s (steps: %s)" % (",".join(missing), ",".join(sorted(map(str, got))))); sys.exit(1)
    bad = [n + "=" + str(got[n]) for n in ("dependencies", "dependency_usage") if got[n] != "passed"]
    if bad:
        sys.stderr.write("Prove steps not passed: " + ", ".join(bad)); sys.exit(1)
    print("dependencies=passed dependency_usage=passed check=%s" % check)
elif cmd == "status":
    try:
        value = dig(load(), "task.status")
    except Exception:
        sys.stderr.write("no task.status in the answer"); sys.exit(1)
    if value not in ("STARTING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "CLOSED"):
        sys.stderr.write("task.status '%s' is not a known status" % value); sys.exit(1)
    print(value)
elif cmd == "created":
    try:
        stamp = dig(load(), "task.createdAt")
        print(int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000))
    except Exception:
        sys.stderr.write("no readable task.createdAt"); sys.exit(1)
elif cmd == "reports":
    phase = sys.argv[2]
    try:
        messages = json.load(sys.stdin)
    except Exception:
        sys.stderr.write("the log answer is not JSON"); sys.exit(1)
    if messages is None:
        messages = []
    if not isinstance(messages, list):
        sys.stderr.write("the log answer is not a list"); sys.exit(1)
    for message in messages:
        try:
            line = json.loads(message)
        except Exception:
            continue
        if isinstance(line, dict) and line.get("event") == "test-services.report" and line.get("phase") == phase:
            print(json.dumps(line, sort_keys=True))
elif cmd == "start":
    lines = [json.loads(l) for l in sys.stdin if l.strip()]
    if not lines:
        sys.stderr.write("no report"); sys.exit(1)
    r = lines[-1]; f = r.get("bootFacts"); bad = []
    if not isinstance(f, dict):
        bad.append("boot facts " + str(f))
    else:
        for k in ("metadataBlocked", "runWalls", "ipv6Drops", "loggedOut"):
            if f.get(k) is not True: bad.append(k)
        if f.get("prepull") != "ok": bad.append("prepull " + str(f.get("prepull")))
        minimum = 2 if os.environ.get("AWS_MODE") else 1
        if not isinstance(f.get("prepulled"), int) or isinstance(f.get("prepulled"), bool) or f["prepulled"] < minimum: bad.append("nothing pre-pulled" if minimum == 1 else "fewer than %d images pre-pulled" % minimum)
    if r.get("leftoverContainers") != 0 or r.get("leftoverNetworks") != 0: bad.append("leftover objects (or Docker could not be asked)")
    if r.get("runDirEmpty") is not True: bad.append("run directory not empty")
    if r.get("runDirTmpfs") is not True: bad.append("run directory not a tmpfs")
    if bad:
        sys.stderr.write(", ".join(bad)); sys.exit(1)
    print("ok")
elif cmd == "runs":
    expect = os.environ.get("EXPECT", "")
    lines = [json.loads(l) for l in sys.stdin if l.strip()]
    if not lines:
        sys.stderr.write("no run_end report"); sys.exit(1)
    bad, seen = [], []
    for r in lines:
        o = r.get("outcome"); seen.append(str(o))
        if o not in ("completed", "checks_failed", "failed", "cancelled"): bad.append("unknown outcome " + str(o))
        if r.get("leftoverContainers") != 0 or r.get("leftoverNetworks") != 0: bad.append("leftover objects after a %s run (or Docker could not be asked)" % o)
        if r.get("runDirEmpty") is not True: bad.append("run directory not empty after a %s run" % o)
        if r.get("runDirTmpfs") is not True: bad.append("run directory not a tmpfs after a %s run" % o)
        if r.get("workingSandboxPaused") is not False: bad.append("working sandbox left paused or unknown after a %s run" % o)
    if expect and expect not in seen: bad.append("no %s run reported" % expect)
    if bad:
        sys.stderr.write(", ".join(sorted(set(bad)))); sys.exit(1)
    print(",".join(seen))
elif cmd == "last-outcome":
    lines = [json.loads(l) for l in sys.stdin if l.strip()]
    if not lines:
        sys.stderr.write("no run_end report"); sys.exit(1)
    print(lines[-1].get("outcome"))
elif cmd == "swept":
    lines = [json.loads(l) for l in sys.stdin if l.strip()]
    if not lines:
        sys.stderr.write("no worker_start report"); sys.exit(1)
    r = lines[-1]
    total = (r.get("sweptContainers") or 0) + (r.get("sweptNetworks") or 0)
    if not total > 0 or r.get("leftoverContainers") != 0 or r.get("leftoverNetworks") != 0:
        sys.stderr.write("swept %s, left %s containers and %s networks" % (total, r.get("leftoverContainers"), r.get("leftoverNetworks"))); sys.exit(1)
    print(total)
elif cmd == "entries":
    required = os.environ["REQUIRED"].split(",")
    entries = []
    for path in sys.argv[2:]:
        try:
            data = json.load(open(path))
        except Exception:
            continue
        for node in walk(data):
            if isinstance(node, dict) and isinstance(node.get("label"), str) and "after" in node:
                entries.append((node["label"], node["after"]))
    if not entries:
        sys.stderr.write("no check entries (label and after) in the task view or the evidence file"); sys.exit(4)
    bad = []
    for name in required:
        mine = [after for label, after in entries if name in label]
        if not mine: bad.append("no check entry for " + name)
        elif any(a != "passed" for a in mine): bad.append("%s: %s" % (name, ",".join(sorted(set(map(str, mine))))))
    if bad:
        sys.stderr.write("; ".join(bad)); sys.exit(1)
    print("all %d passed" % len(required))
else:
    sys.stderr.write("unknown helper command"); sys.exit(2)
PY
py() { AWS_MODE="$AWS_MODE" python3 -I "$WORK/tse.py" "$@"; }

# api METHOD PATH [JSON-BODY]: runs in THIS shell (never inside $(...)), so API_STATUS and API_BODY are real. A curl failure or an unreadable answer is status 000 and an empty body, which no step treats as success.
api() {
  local method="$1" path="$2" body="${3:-}" status
  local args=(-sS --max-time 60 -o "$WORK/api.out" -w '%{http_code}' -X "$method" -H "@$WORK/header" -H 'Content-Type: application/json')
  [[ -n "$body" ]] && args+=(--data "$body")
  : > "$WORK/api.out"
  if status=$(curl "${args[@]}" "$ROVARA_STAGING_URL$path" 2>"$WORK/api.err"); then API_STATUS="$status"; else API_STATUS=000; fi
  [[ "$API_STATUS" =~ ^[0-9]{3}$ ]] || API_STATUS=000
  API_BODY=$(cat "$WORK/api.out" 2>/dev/null)
}
ok2xx() { [[ "$API_STATUS" == 2* ]]; }
errline() { head -c 200 "$1" 2>/dev/null | tr '\n' ' '; }
newid() { uuidgen | tr 'A-Z' 'a-z'; }
ENV_PATH="/v1/app/projects/$ROVARA_STAGING_PROJECT/test-environment"

# ---- the worker's self-report, read from CloudWatch Logs through the staging guard (read-only)
LOG_GROUP="/agentx/$ENV_NAME/worker"
# reports PHASE FROM_MS -> prints each `test-services.report` line of that phase since FROM_MS as one compact JSON object per line (oldest first) into $WORK/reports. Returns 1 (reason in $WORK/reports.err) when the read
# failed or the answer was not JSON; returns 0 with an EMPTY file when the log simply has none (callers decide: no report is never a pass).
reports() {
  local phase="$1" from="$2" out
  : > "$WORK/reports"; : > "$WORK/reports.err"
  if ! out=$("$STAGING" aws logs filter-log-events --log-group-name "$LOG_GROUP" --start-time "$from" --filter-pattern '"test-services.report"' --query 'events[].message' --output json 2>"$WORK/reports.err"); then
    out="the log read failed: $(errline "$WORK/reports.err")"; echo "$out" > "$WORK/reports.err"; return 1
  fi
  printf '%s' "$out" | py reports "$phase" > "$WORK/reports" 2>"$WORK/reports.err"
}
# wait_reports PHASE FROM_MS: polls (CloudWatch lags) until at least one report exists. 0: there are some in $WORK/reports. 1: the read failed. 2: none after the polls.
wait_reports() {
  local n
  for ((n = 0; n < POLL_REPORTS; n++)); do
    reports "$1" "$2" || return 1
    [[ -s "$WORK/reports" ]] && return 0
    sleep "$POLL_SLEEP"
  done
  return 2
}
why() { # why STATUS-OF-wait_reports PHASE
  case "$1" in 1) cat "$WORK/reports.err" ;; *) echo "no $2 report in $LOG_GROUP since $3 after polling" ;; esac
}

# ---- P1-P3 preconditions (read-only AWS)
if wanted P1; then
  if account=$("$STAGING" aws sts get-caller-identity --query Account --output text 2>"$WORK/cli.err") && [[ "$account" == "$EXPECTED_ACCOUNT" ]]; then
    say P1 PASS "staging account" "account $account, region us-west-2 (the guard refuses any other)"
  else say P1 FAIL "staging account" "got '${account:-nothing}' $(errline "$WORK/cli.err")"; fi
fi
digests=""; digests_ok=""
if wanted P2 || wanted P3; then
  if digests=$("$STAGING" aws ecr describe-images --repository-name "rovara-catalog/$ENV_NAME/$CATALOG_REPOSITORY_SUFFIX" --query 'imageDetails[].imageDigest' --output text 2>"$WORK/cli.err"); then digests_ok=1; else digests_ok=""; digests_err="$(errline "$WORK/cli.err")"; fi
fi
if wanted P2; then
  if [[ -n "$digests_ok" && -n "$digests" ]]; then say P2 PASS "catalog repository holds postgres" "$(echo "$digests" | wc -w | tr -d ' ') image digest(s) in rovara-catalog/$ENV_NAME/$CATALOG_REPOSITORY_SUFFIX"
  else say P2 FAIL "catalog repository holds postgres" "${digests_err:-no image: the repack (catalog step 3) has not been done}"; fi
fi
if wanted P3; then
  pinned=$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(" ".join(e["image"]["digest"] for e in d["entries"] if e["id"]=="postgres@16" and e["image"].get("digest")))' "${TSE_CATALOG_FILE:-$ROOT/environments/service-catalog/catalog.json}" 2>/dev/null)
  if [[ -n "$pinned" && -n "$digests_ok" && "$digests" == *"sha256:${pinned#sha256:}"* ]]; then say P3 PASS "catalog pin matches the repository" "postgres@16 is pinned to a digest the repository holds"
  else say P3 FAIL "catalog pin matches the repository" "the committed catalog pin '${pinned:-none}' is not among the repository's digests (catalog step 4/5)"; fi
fi

# ---- PA (slice 2): the local-aws image is in the catalog repository by the committed pin
if wanted PA && [[ -n "$AWS_MODE" ]]; then
  if aws_digests=$("$STAGING" aws ecr describe-images --repository-name "rovara-catalog/$ENV_NAME/svc/local-aws" --query 'imageDetails[].imageDigest' --output text 2>"$WORK/cli.err") && [[ -n "$aws_digests" ]]; then
    aws_pin=$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(" ".join(e["image"]["digest"] for e in d["entries"] if e["id"]=="local-aws@r1" and e["image"].get("digest")))' "${TSE_CATALOG_FILE:-$ROOT/environments/service-catalog/catalog.json}" 2>/dev/null)
    if [[ -n "$aws_pin" && "$aws_digests" == *"sha256:${aws_pin#sha256:}"* ]]; then say PA PASS "local-aws is pinned and in the repository" "local-aws@r1 is pinned to a digest rovara-catalog/$ENV_NAME/svc/local-aws holds"
    else say PA FAIL "local-aws is pinned and in the repository" "the committed pin '${aws_pin:-none}' is not among the repository's digests (the slice-2 catalog step, then commit the pin)"; fi
  else say PA FAIL "local-aws is pinned and in the repository" "no image in rovara-catalog/$ENV_NAME/svc/local-aws: $(errline "$WORK/cli.err")"; fi
elif wanted PA; then :; fi

# ---- P4 the worker's start report: root's facts and nothing left over. A window that reaches back (a worker may have started days ago), not only since this script began.
if wanted P4; then
  p4_from=$(( NOW_MS - WORKER_WINDOW_HOURS * 3600 * 1000 ))
  if reports worker_start "$p4_from"; then
    if [[ -s "$WORK/reports" ]]; then
      if bad=$(py start < "$WORK/reports" 2>&1); then say P4 PASS "worker start report" "the latest worker_start in the last ${WORKER_WINDOW_HOURS}h: boot facts all true, pre-pull ok and logged out, nothing left over, run directory empty and a tmpfs"
      else say P4 FAIL "worker start report" "$bad"; fi
    else say P4 FAIL "worker start report" "no worker_start report in $LOG_GROUP in the last ${WORKER_WINDOW_HOURS}h (restart a worker, or widen --worker-window-hours)"; fi
  else say P4 FAIL "worker start report" "$(cat "$WORK/reports.err")"; fi
fi

# ---- 1 dependencies listed
digest=""
if wanted 1; then
  api POST "$ENV_PATH/propose" '{}'
  if ok2xx; then
    if digest=$(printf '%s' "$API_BODY" | py get proposal.digest 2>"$WORK/py.err") && deps=$(printf '%s' "$API_BODY" | py deps 2>"$WORK/py.err"); then
      say 1 PASS "dependencies listed" "the proposal lists a local Postgres with its source line: $deps (digest ${digest:0:12})"
    else digest=""; say 1 FAIL "dependencies listed" "$(errline "$WORK/py.err") (propose answered $API_STATUS; needs a setup draft that detected Postgres)"; fi
  elif [[ "$API_STATUS" == 4* && "$API_STATUS" != 401 && "$API_STATUS" != 403 ]]; then
    say 1 OPERATOR "dependencies listed" "propose answered $API_STATUS: run the project's setup draft in the app first, then re-run"
  else say 1 FAIL "dependencies listed" "propose answered $API_STATUS $(errline "$WORK/api.err")"; fi
fi

# ---- 2 Prove passes
if wanted 2; then
  if [[ -z "$digest" ]]; then say 2 FAIL "Prove passes" "no proposal digest: step 1 must pass in this run first"
  else
    api POST "$ENV_PATH/check" "{\"digest\":\"$digest\",\"requestId\":\"$(newid)\"}"
    if ! ok2xx; then say 2 FAIL "Prove passes" "the candidate check was not started: check answered $API_STATUS"
    else
      verdict=""; code=4
      for ((n = 0; n < POLL_PROVE; n++)); do
        sleep "$POLL_SLEEP"
        api POST "$ENV_PATH/prove" "{\"digest\":\"$digest\"}"
        if ! ok2xx; then verdict="prove answered $API_STATUS"; continue; fi
        verdict=$(printf '%s' "$API_BODY" | py prove 2>&1); code=$?
        [[ "$code" -ne 4 ]] && break
      done
      if [[ "$code" -eq 0 ]]; then say 2 PASS "Prove passes" "$verdict"
      elif [[ "$code" -eq 4 ]]; then say 2 FAIL "Prove passes" "timed out after $POLL_PROVE polls: ${verdict:-no answer}"
      else say 2 FAIL "Prove passes" "$verdict"; fi
    fi
  fi
fi

# start_task PROMPT -> sets TASK_ID or returns 1 (reason in $WORK/py.err)
start_task() {
  local prompt="$1" body
  body=$(python3 -I -c 'import json,sys;print(json.dumps({"requestId":sys.argv[1],"project":sys.argv[2],"instructions":sys.argv[3],"client":"staging-test-services-e2e"}))' "$(newid)" "$ESCAPE_PROJECT" "$prompt")
  api POST "/v1/dev/tasks" "$body"
  ok2xx || { echo "the start answered $API_STATUS $(errline "$WORK/api.err")" > "$WORK/py.err"; return 1; }
  TASK_ID=$(printf '%s' "$API_BODY" | py get task.taskId 2>"$WORK/py.err") || return 1
}
# wait_task_end POLLS -> polls the task; sets TASK_STATE and keeps the last good view in $WORK/view.json. Returns 0 at an END status, 1 on a timeout or when every poll failed.
wait_task_end() {
  local polls="$1" n state good=""
  TASK_STATE=""
  for ((n = 0; n < polls; n++)); do
    sleep "$POLL_SLEEP"
    api GET "/v1/dev/tasks/$TASK_ID"
    ok2xx || { TASK_ERR="the view answered $API_STATUS"; continue; }
    state=$(printf '%s' "$API_BODY" | py status 2>"$WORK/py.err") || { TASK_ERR="$(errline "$WORK/py.err")"; continue; }
    printf '%s' "$API_BODY" > "$WORK/view.json"; good=1; TASK_STATE="$state"
    case "$state" in SUCCEEDED|FAILED|CANCELLED|INTERRUPTED|CLOSED) return 0 ;; esac
  done
  [[ -n "$good" ]] || TASK_STATE=""
  return 1
}
TASK_ERR=""; : > "$WORK/view.json"

# ---- 3 a task on the escape project, through the API
RUN_FROM="$SINCE_MS"
if wanted 3; then
  started=""
  if [[ -z "$TASK_ID" && -n "$ESCAPE_PROJECT" ]]; then
    if start_task "$ESCAPE_PROMPT"; then started=1; else say 3 FAIL "task started" "$(cat "$WORK/py.err")"; fi
  elif [[ -z "$TASK_ID" ]]; then
    say 3 OPERATOR "a task passes a check round" "pass --escape-project <name> (the project whose checks are tests/fixtures/test-services-escape-project) to start one, or --task <id> of one you started"
  fi
  if [[ -n "$TASK_ID" ]]; then
    if wait_task_end "$POLL_TASK"; then
      [[ "$TASK_STATE" == "SUCCEEDED" ]] && say 3 PASS "task passed a check round" "task $TASK_ID ended SUCCEEDED" || say 3 FAIL "task passed a check round" "task $TASK_ID ended $TASK_STATE"
    else
      say 3 FAIL "task reached an end status" "task $TASK_ID did not end within $POLL_TASK polls (last status '${TASK_STATE:-none}', ${TASK_ERR:-no error})"
    fi
  fi
fi
# A task named by --task but not waited for here (for instance --only 4,5,6): read its view once, so its createdAt and its check entries are available.
if [[ -n "$TASK_ID" && ! -s "$WORK/view.json" ]]; then
  api GET "/v1/dev/tasks/$TASK_ID"
  if ok2xx && printf '%s' "$API_BODY" | py status >/dev/null 2>&1; then printf '%s' "$API_BODY" > "$WORK/view.json"; fi
fi
if [[ -n "$TASK_ID" && -z "$SINCE_GIVEN" ]] && created=$(py created < "$WORK/view.json" 2>/dev/null); then RUN_FROM=$(( created - 60000 )); fi

# the sources the verdicts of 4-6 and L3 read: the task's view and the evidence file the person saved
SOURCES=(); [[ -s "$WORK/view.json" ]] && SOURCES+=("$WORK/view.json"); [[ -n "$EVIDENCE_FILE" ]] && SOURCES+=("$EVIDENCE_FILE")
TEXT="$WORK/text"; : > "$TEXT"; for source in ${SOURCES[@]+"${SOURCES[@]}"}; do cat "$source" >> "$TEXT"; done
ESCAPE_TESTS="tests/internet.test.js,tests/ipv6.test.js,tests/neighbours.test.js,tests/planted-state.test.js,tests/relay.test.js"
[[ -n "$AWS_MODE" ]] && ESCAPE_TESTS="$ESCAPE_TESTS,tests/aws-positive.test.js"
if wanted 4; then
  if [[ ${#SOURCES[@]} -eq 0 ]]; then say 4 OPERATOR "the escape project's tests passed" "pass --task and/or --evidence <file>"
  else
    verdict=$(REQUIRED="$ESCAPE_TESTS" py entries "${SOURCES[@]}" 2>&1); code=$?
    if [[ "$code" -eq 0 ]]; then
      if wait_reports run_end "$RUN_FROM"; then
        outcome=$(py last-outcome < "$WORK/reports" 2>&1)
        if [[ "$outcome" == "completed" ]]; then say 4 PASS "the escape project's tests passed" "$verdict by name (internet, ipv6, neighbours, planted-state, relay${AWS_MODE:+, aws-positive}); the worker's last run_end is completed"
        else say 4 FAIL "the escape project's tests passed" "check entries passed but the worker's last run_end outcome is '$outcome'"; fi
      else say 4 FAIL "the escape project's tests passed" "check entries passed but there is no worker run_end report: $(why $? run_end "$RUN_FROM")"; fi
    elif [[ "$code" -eq 4 ]]; then say 4 OPERATOR "the escape project's tests passed" "$verdict: pass --evidence <file> saved from the task's Evidence tab"
    else say 4 FAIL "the escape project's tests passed" "$verdict"; fi
  fi
fi
if wanted 5; then
  if [[ ! -s "$TEXT" ]]; then say 5 OPERATOR "the PR line" "pass --task and/or --evidence <file>"
  elif [[ -n "$AWS_MODE" ]]; then
    if line=$(grep -m1 -o 'Integration tests ran against: Postgres (real), [^"\\]*(Rovara local AWS)\.' "$TEXT") && [[ "$line" == *S3* && "$line" == *SQS* && "$line" == *DynamoDB* ]]; then say 5 PASS "the PR line" "$line"
    else say 5 FAIL "the PR line" "no line 'Integration tests ran against: Postgres (real), <S3, SQS and DynamoDB> (Rovara local AWS).' in the task's view or the evidence file"; fi
  elif grep -q 'Integration tests ran against: Postgres (real)\.' "$TEXT"; then say 5 PASS "the PR line" "'Integration tests ran against: Postgres (real).' is there"
  else say 5 FAIL "the PR line" "the line is not in the task's view or the evidence file"; fi
fi
if wanted 6; then
  if [[ ! -s "$TEXT" ]]; then say 6 OPERATOR "unknown calls fail loudly" "pass --task and/or --evidence <file>"
  elif line=$(grep -m1 -o 'Blocked by environment:[^"\\]*' "$TEXT"); then
    if echo "$line" | grep -Eq '[A-Za-z0-9_-]{25,}'; then say 6 FAIL "unknown calls fail loudly" "the line holds a long token-like word: $line"
    elif echo "$line" | grep -Eq 'unknown-[a-z0-9]{4,}'; then say 6 FAIL "unknown calls fail loudly" "the line names a full lookup name, not its registrable domain: $line"
    elif ! echo "$line" | grep -Eq '[0-9]+ call' || ! echo "$line" | grep -Eq 'example\.com' || ! echo "$line" | grep -Eq 'example\.net'; then say 6 FAIL "unknown calls fail loudly" "the line lacks a count or the escape project's lookups (example.com, example.net): $line"
    else say 6 PASS "unknown calls fail loudly" "$line"; fi
  else say 6 FAIL "unknown calls fail loudly" "no 'Blocked by environment' line: the escape project's internet test makes name lookups that must be counted"; fi
fi
if wanted L3; then
  if [[ ${#SOURCES[@]} -eq 0 ]]; then say L3 OPERATOR "relay test ran" "pass --task and/or --evidence <file>"
  else
    verdict=$(REQUIRED="tests/relay.test.js" py entries "${SOURCES[@]}" 2>&1); code=$?
    if [[ "$code" -eq 0 ]]; then say L3 PASS "relay test ran" "the relay check passed (it cannot skip: a missing or dead heartbeat fails it)"
    elif [[ "$code" -eq 4 ]]; then say L3 OPERATOR "relay test ran" "$verdict: pass --evidence <file>"
    else say L3 FAIL "relay test ran" "$verdict"; fi
  fi
fi

# ---- slice 2: the IAM line, the control paths, the out-of-plan call
if [[ -n "$AWS_MODE" ]]; then
  if wanted A2; then
    if [[ ! -s "$TEXT" ]]; then say A2 OPERATOR "the IAM line" "pass --task and/or --evidence <file>"
    elif grep -q 'AWS permissions (IAM) were not checked: Rovara local AWS does not enforce IAM' "$TEXT"; then say A2 PASS "the IAM line" "'AWS permissions (IAM) were not checked: Rovara local AWS does not enforce IAM' is there"
    else say A2 FAIL "the IAM line" "the line is not in the task's view or the evidence file"; fi
  fi
  if wanted A3; then
    if [[ ${#SOURCES[@]} -eq 0 ]]; then say A3 OPERATOR "control paths refused from the sealed round" "pass --task and/or --evidence <file>"
    else
      verdict=$(REQUIRED="tests/aws-control.test.js" py entries "${SOURCES[@]}" 2>&1); code=$?
      if [[ "$code" -eq 0 ]]; then say A3 PASS "control paths refused from the sealed round" "the emulator's /_rovara/* paths answered 403 or 401 with no token and a made-up one (health answered first)"
      elif [[ "$code" -eq 4 ]]; then say A3 OPERATOR "control paths refused from the sealed round" "$verdict: pass --evidence <file>"
      else say A3 FAIL "control paths refused from the sealed round" "$verdict"; fi
    fi
  fi
  if wanted A4; then
    flag_task="$AWS_FLAG_TASK"; saved_task="$TASK_ID"; saved_project="$ESCAPE_PROJECT"
    if [[ -z "$flag_task" && -n "$AWS_FLAG_PROJECT" ]]; then
      ESCAPE_PROJECT="$AWS_FLAG_PROJECT"; TASK_ID=""
      if start_task "$ESCAPE_PROMPT"; then flag_task="$TASK_ID"; else say A4 FAIL "out-of-plan call is flagged" "the flag task was not started: $(cat "$WORK/py.err")"; flag_task="-"; fi
      ESCAPE_PROJECT="$saved_project"
    fi
    if [[ -z "$flag_task" ]]; then say A4 OPERATOR "out-of-plan call is flagged" "pass --aws-flag-project <name> (the project with the out-of-plan variant, see the fixture's README) or --aws-flag-task <id>"
    elif [[ "$flag_task" != "-" ]]; then
      TASK_ID="$flag_task"; cp "$WORK/view.json" "$WORK/view.main.json" 2>/dev/null; : > "$WORK/view.json"
      if wait_task_end "$POLL_TASK" || [[ -s "$WORK/view.json" ]]; then
        flag_from=$(py created < "$WORK/view.json" 2>/dev/null); flag_from=$(( ${flag_from:-$NOW_MS} - 60000 ))
        verdict=$(REQUIRED="tests/aws-out-of-plan.test.js" py entries "$WORK/view.json" 2>&1); code=$?
        if [[ "$code" -ne 0 ]]; then say A4 FAIL "out-of-plan call is flagged" "the emulator was not shown to refuse the SNS call: $verdict (task $flag_task, status ${TASK_STATE:-unknown})"
        elif ! grep -q 'The code called AWS services that are not in the plan' "$WORK/view.json" || ! grep -Eq 'not in the plan[^"]*sns' "$WORK/view.json"; then say A4 FAIL "out-of-plan call is flagged" "the SNS call was refused but the task's evidence does not say 'The code called AWS services that are not in the plan: sns' (is a refused call of a disabled service in the ledger?)"
        elif wait_reports run_end "$flag_from" && cleanruns=$(py runs < "$WORK/reports" 2>&1); then say A4 PASS "out-of-plan call is flagged" "task $flag_task: the emulator refused SNS and the evidence flags it; worker run_end reports clean ($cleanruns)"
        else say A4 FAIL "out-of-plan call is flagged" "flagged, but the worker's run_end is not clean: ${cleanruns:-$(why $? run_end "$flag_from")}"; fi
      else say A4 FAIL "out-of-plan call is flagged" "task $flag_task did not end within $POLL_TASK polls (last status '${TASK_STATE:-none}', ${TASK_ERR:-no error})"; fi
      cp "$WORK/view.main.json" "$WORK/view.json" 2>/dev/null
      TASK_ID="$saved_task"
    fi
    ESCAPE_PROJECT="$saved_project"
  fi
fi

# ---- 7 teardown, from the worker's run_end reports for the run
if wanted 7; then
  if wait_reports run_end "$RUN_FROM"; then
    if verdict=$(EXPECT="$EXPECT_OUTCOME" py runs < "$WORK/reports" 2>&1); then say 7 PASS "teardown is clean" "run_end reports since the run: $verdict; nothing left, run directory empty and a tmpfs, working sandbox not paused"
    else say 7 FAIL "teardown is clean" "$verdict"; fi
  else
    status=$?
    if [[ "$status" -eq 2 && -z "$TASK_ID" && -z "$SINCE_GIVEN" ]]; then say 7 OPERATOR "teardown is clean" "no run_end report since this script started (run a task, then re-run with --task <id> or --since; repeat with --expect-outcome failed, then cancelled)"
    else say 7 FAIL "teardown is clean" "$(why "$status" run_end "$RUN_FROM")"; fi
  fi
fi

# ---- 7c cancel: start a task, cancel it while it runs, and check the worker's report
if wanted 7c && [[ -n "$CANCEL_TEST" ]]; then
  cancel_from=$(( $(date +%s) * 1000 - 60000 ))
  saved_task="$TASK_ID"; TASK_ID=""
  if ! start_task "$CANCEL_PROMPT"; then say 7c FAIL "cancel starts a task" "$(cat "$WORK/py.err")"
  else
    cancel_id="$TASK_ID"; running=""
    for ((n = 0; n < POLL_RUNNING; n++)); do
      sleep "$POLL_SLEEP"
      api GET "/v1/dev/tasks/$cancel_id"
      if ok2xx && [[ "$(printf '%s' "$API_BODY" | py status 2>/dev/null)" == "RUNNING" ]]; then running=1; break; fi
    done
    if [[ -z "$running" ]]; then say 7c FAIL "cancel a running task" "task $cancel_id never reached RUNNING in $POLL_RUNNING polls"
    else
      sleep "$POLL_SLEEP"
      api POST "/v1/dev/tasks/$cancel_id/cancel" "{\"requestId\":\"$(newid)\"}"
      if ! ok2xx; then say 7c FAIL "cancel a running task" "cancel answered $API_STATUS"
      else
        TASK_ID="$cancel_id"
        if wait_task_end "$POLL_TASK" && [[ "$TASK_STATE" == "CANCELLED" ]]; then
          if wait_reports run_end "$cancel_from"; then
            if verdict=$(EXPECT="cancelled" py runs < "$WORK/reports" 2>&1); then say 7c PASS "cancel leaves nothing" "task $cancel_id CANCELLED; the worker reported a cancelled run with nothing left, run directory empty, working sandbox not paused"
            else say 7c FAIL "cancel leaves nothing" "$verdict"; fi
          else say 7c FAIL "cancel leaves nothing" "$(why $? run_end "$cancel_from")"; fi
        else say 7c FAIL "cancel a running task" "task $cancel_id ended '${TASK_STATE:-no end status}' (needs CANCELLED) ${TASK_ERR}"; fi
      fi
    fi
  fi
  TASK_ID="$saved_task"
elif wanted 7c; then
  say 7c OPERATOR "cancel leaves nothing" "pass --cancel-test with --escape-project <name>"
fi

# ---- 7k killed worker: the sweep at the restarted worker's start (the kill itself is a person's step)
if wanted 7k && [[ -n "$EXPECT_SWEPT" ]]; then
  if wait_reports worker_start "$SINCE_MS"; then
    if swept=$(py swept < "$WORK/reports" 2>&1); then say 7k PASS "killed worker is swept" "the restarted worker removed $swept leftover object(s) and nothing is left"
    else say 7k FAIL "killed worker is swept" "$swept"; fi
  else say 7k FAIL "killed worker is swept" "$(why $? worker_start "$SINCE_MS")"; fi
fi

# ---- 8, 9 (a person's steps)
if wanted 8; then say 8 OPERATOR "switch off is today" "turn tx off for the project (owner), start the same task and compare its dispatch payload and PR body with a task from before the release: no testServices, no dependency line"; fi
if wanted 9; then say 9 OPERATOR "other backings refused" "propose a draft with an S3 candidate in the app and read the 'not available yet' words (the broker's unit tests cover the words)"; fi
if wanted 7k && [[ -z "$EXPECT_SWEPT" ]]; then say 7k OPERATOR "killed worker is swept" "kill a worker mid-run, let it restart, then re-run with --expect-swept"; fi

printf 'TSE SUMMARY pass=%d fail=%d operator=%d\n' "$pass" "$fail" "$operator"
[[ "$fail" -eq 0 && "$operator" -eq 0 ]]
