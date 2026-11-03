#!/bin/bash
# The live done-check of test services slice 1 (ROUND-2026-11-03-test-services-hookup.md, "What it proves", items 1-9): ONE staging project, `tx` on, ONE dependency (Postgres 16 from the catalog), tasks run through
# Rovara itself. WRITTEN, NOT RUN against staging. It runs only after the OWNER GO for `tx` on one project (DECISIONS: "Test services: thin slice first"), the catalog steps 1-5, and refuses to start without it
# (STAGING_E2E_OWNER_GO below).
#
# NO SSM, NO ROOT ON THE WORKER. Staging workers are not SSM-managed (their instance profile has no SSM permission, by design). Everything here is one of:
#   - the Rovara API (propose, check, prove, a task on the escape project, the task's view), with ONE bearer token read from a file (mode 600; never printed, never in an argument: curl reads the header from a file);
#   - the staging guard (~/.local/share/rovara-tools/staging-aws.sh, account 944937319445, us-west-2) for READ-ONLY AWS calls: sts, ecr describe-images, logs filter-log-events. It creates nothing, deploys nothing, reads no secret;
#   - the WORKER'S OWN SELF-REPORT in CloudWatch Logs (log group /agentx/<env>/worker): after every test-services run and at every worker start the worker logs ONE `test-services.report` line with fixed fields (leftover
#     labelled containers and networks, run directory empty and tmpfs, working sandbox paused or not) and, at start, the facts root wrote at boot (metadata block, run-network walls, IPv6 drops, pre-pull, registry
#     logout). See packages/worker/src/test-services-report.ts. No name, path or secret is in them.
#   - the ESCAPE PROJECT (tests/fixtures/test-services-escape-project): a project whose tests try to get out of a sealed round (internet, IPv6, the working sandbox's address, a planted table, a process left running in
#     the working sandbox) and pass only if each attempt fails. Its results come back through the task's normal evidence.
#
# THE STEPS (the numbers are the done-definition's)
#   P1-P3  preconditions (read-only AWS): the staging account; the catalog repository holds postgres by digest; the committed catalog pin is one of them.
#   P4     the worker's start report (CloudWatch): boot facts all true, pre-pull ok and logged out, nothing left over, the run directory empty and a tmpfs. (This replaces the read-only host checks of
#          scripts/linux-check-test-services.sh L1/L5/L6 that needed a shell.)
#   1      dependencies listed: the proposal for the project's latest setup draft lists Postgres with its source line.
#   2      Prove passes: the candidate check starts Postgres; the Prove steps "dependencies" and "dependency_usage" are passed.
#   3      a task passes a check round: the script starts ONE task on the escape project (--escape-project) through the API (or take --task <id> of one you started in the app) and waits for it.
#   4      the escape project's tests all passed in the sealed round (its checks passed in the task's view or the evidence file), and the worker's run_end report is clean.
#   5      the PR line: `Integration tests ran against: Postgres (real).` in the task's view or --evidence <file>.
#   6      unknown calls fail loudly: the escape project's internet test makes name lookups; the evidence says `Blocked by environment: N call(s)` with a registrable domain and a count, no full name.
#   7      teardown is clean after success, failure, cancel and a killed worker: the run_end reports since the script started (outcome by outcome: pass --expect-outcome completed|failed|cancelled) show nothing left, the run
#          directory empty and the working sandbox not paused; after a worker restart the worker_start report shows what the sweep removed and nothing left (--expect-swept).
#   8      switch off = today: the operator turns tx off for the project, starts the same task and compares with a task from before the release (a person's step).
#   9      any other backing is refused with "not available yet" (the broker's unit tests cover the words; propose a draft with an S3 candidate in the app to see them).
#   L3     detached-process relay during a sealed round: the escape project's relay test (it needs the project's setup command, `npm run setup`, to have run in the working sandbox: --require-heartbeat makes a skipped relay test a FAIL).
#
# USAGE  (from the repository root on the Mac)
#   STAGING_E2E_OWNER_GO=yes ROVARA_STAGING_URL=https://<staging api> ROVARA_STAGING_TOKEN_FILE=$HOME/.rovara-staging-token ROVARA_STAGING_PROJECT=<project with the dependency> \
#     scripts/staging-test-services-e2e.sh [--escape-project <name>] [--task <id>] [--evidence <file>] [--expect-outcome <o>] [--expect-swept] [--env <name>] [--since <epoch ms>] [--only <id>[,<id>...]]
#   Re-run with --task / --evidence / --expect-outcome after the steps a person does. Without them it stops at the first step that needs one and says what to do.
set -u
export LC_ALL=C

STAGING="${STAGING_AWS:-$HOME/.local/share/rovara-tools/staging-aws.sh}"
EXPECTED_ACCOUNT=944937319445
CATALOG_REPOSITORY_SUFFIX="svc/postgres"
TASK_ID=""
EVIDENCE_FILE=""
ESCAPE_PROJECT=""
EXPECT_OUTCOME=""
EXPECT_SWEPT=""
REQUIRE_HEARTBEAT=""
ENV_NAME="staging"
SINCE_MS=$(( $(date +%s) * 1000 ))
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --task) TASK_ID="${2:-}"; shift 2 ;;
    --evidence) EVIDENCE_FILE="${2:-}"; shift 2 ;;
    --escape-project) ESCAPE_PROJECT="${2:-}"; shift 2 ;;
    --expect-outcome) EXPECT_OUTCOME="${2:-}"; shift 2 ;;
    --expect-swept) EXPECT_SWEPT=1; shift ;;
    --require-heartbeat) REQUIRE_HEARTBEAT=1; shift ;;
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --since) SINCE_MS="${2:-}"; shift 2 ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$ENV_NAME" =~ ^[a-z][a-z0-9-]{0,19}$ ]] || { echo "REFUSED: not an environment name." >&2; exit 3; }
[[ "$SINCE_MS" =~ ^[0-9]{10,16}$ ]] || { echo "REFUSED: --since is epoch milliseconds." >&2; exit 3; }

pass=0; fail=0; operator=0
say() { printf 'TSE %s %s %s | %s\n' "$1" "$2" "$3" "$4"; case "$2" in PASS) pass=$((pass+1));; FAIL) fail=$((fail+1));; OPERATOR) operator=$((operator+1));; esac; }
wanted() { [[ -z "$ONLY" ]] || [[ ",$ONLY," == *",$1,"* ]]; }

[[ "${STAGING_E2E_OWNER_GO:-}" == "yes" ]] || { echo "REFUSED: this is the slice-1 staging proof; it runs only after the owner's go for tx on one project (set STAGING_E2E_OWNER_GO=yes)." >&2; exit 3; }
[[ -x "$STAGING" ]] || { echo "REFUSED: $STAGING (the staging guard) is not there." >&2; exit 3; }
: "${ROVARA_STAGING_URL:?set ROVARA_STAGING_URL}" "${ROVARA_STAGING_PROJECT:?set ROVARA_STAGING_PROJECT}" "${ROVARA_STAGING_TOKEN_FILE:?set ROVARA_STAGING_TOKEN_FILE}"
[[ "$ROVARA_STAGING_URL" == https://* ]] || { echo "REFUSED: the staging URL must be https." >&2; exit 3; }
[[ -r "$ROVARA_STAGING_TOKEN_FILE" ]] || { echo "REFUSED: the token file is not readable." >&2; exit 3; }
mode=$(stat -f '%Lp' "$ROVARA_STAGING_TOKEN_FILE" 2>/dev/null || stat -c '%a' "$ROVARA_STAGING_TOKEN_FILE" 2>/dev/null)
[[ "$mode" == "600" || "$mode" == "400" ]] || { echo "REFUSED: the token file must be mode 600." >&2; exit 3; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tse.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
# The header goes to curl from a file, so the token is in no argument and no output.
printf 'Authorization: Bearer %s\n' "$(tr -d '\n' < "$ROVARA_STAGING_TOKEN_FILE")" > "$WORK/header"; chmod 600 "$WORK/header"
api() { # api METHOD PATH [JSON-BODY]  -> prints the body, sets API_STATUS
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -o "$WORK/api.out" -w '%{http_code}' -X "$method" -H "@$WORK/header" -H 'Content-Type: application/json' "$ROVARA_STAGING_URL$path")
  [[ -n "$body" ]] && args+=(--data "$body")
  API_STATUS=$(curl "${args[@]}" 2>"$WORK/api.err") || API_STATUS=000
  cat "$WORK/api.out"
}
ENV_PATH="/v1/app/projects/$ROVARA_STAGING_PROJECT/test-environment"
json() { python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    for k in sys.argv[1].split("."):
        d=d[int(k)] if isinstance(d,list) else d[k]
    print(d if not isinstance(d,(dict,list)) else json.dumps(d))
except Exception:
    print("")' "$1"; }

# ---- the worker's self-report, read from CloudWatch Logs through the staging guard (read-only)
LOG_GROUP="/agentx/$ENV_NAME/worker"
# reports PHASE -> prints each `test-services.report` line of that phase since $SINCE_MS as one compact JSON object per line (oldest first). A failed read prints nothing and returns 1.
reports() {
  local phase="$1" out
  out=$("$STAGING" aws logs filter-log-events --log-group-name "$LOG_GROUP" --start-time "$SINCE_MS" --filter-pattern '"test-services.report"' --query 'events[].message' --output json 2>/dev/null) || return 1
  printf '%s' "$out" | PHASE="$phase" python3 -c 'import json,os,sys
phase=os.environ["PHASE"]
try:
    messages=json.load(sys.stdin)
except Exception:
    sys.exit(1)
for message in messages or []:
    try:
        line=json.loads(message)
    except Exception:
        continue
    if line.get("event")=="test-services.report" and line.get("phase")==phase:
        print(json.dumps(line,sort_keys=True))'
}
# field LINE NAME -> the field's value
field() { printf '%s' "$1" | json "$2"; }

# ---- P1-P3 preconditions (read-only AWS)
if wanted P1; then
  account=$("$STAGING" aws sts get-caller-identity --query Account --output text 2>/dev/null)
  [[ "$account" == "$EXPECTED_ACCOUNT" ]] && say P1 PASS "staging account" "account $account, region us-west-2 (the guard refuses any other)" || say P1 FAIL "staging account" "got '${account:-nothing}'"
fi
digests=""
if wanted P2 || wanted P3; then digests=$("$STAGING" aws ecr describe-images --repository-name "rovara-catalog/$ENV_NAME/$CATALOG_REPOSITORY_SUFFIX" --query 'imageDetails[].imageDigest' --output text 2>/dev/null); fi
if wanted P2; then
  [[ -n "$digests" ]] && say P2 PASS "catalog repository holds postgres" "$(echo "$digests" | wc -w | tr -d ' ') image digest(s) in rovara-catalog/$ENV_NAME/$CATALOG_REPOSITORY_SUFFIX" || say P2 FAIL "catalog repository holds postgres" "no image: the repack (catalog step 3) has not been done"
fi
if wanted P3; then
  pinned=$(python3 -c 'import json;d=json.load(open("environments/service-catalog/catalog.json"));print(" ".join(e["image"].get("digest","") for e in d["entries"] if e["id"]=="postgres@16"))' 2>/dev/null)
  if [[ -n "$pinned" && "$digests" == *"sha256:${pinned#sha256:}"* ]]; then say P3 PASS "catalog pin matches the repository" "postgres@16 is pinned to a digest the repository holds"; else say P3 FAIL "catalog pin matches the repository" "the committed catalog pin '${pinned:-none}' is not among the repository's digests (catalog step 4/5)"; fi
fi

# ---- P4 the worker's start report: root's facts and nothing left over
if wanted P4; then
  if lines=$(reports worker_start) && [[ -n "$lines" ]]; then
    last=$(printf '%s\n' "$lines" | tail -n1)
    bad=$(printf '%s' "$last" | python3 -c 'import json,sys
r=json.load(sys.stdin); f=r.get("bootFacts"); bad=[]
if not isinstance(f,dict): bad.append("boot facts "+str(f))
else:
    for k in ("metadataBlocked","runWalls","ipv6Drops","loggedOut"):
        if f.get(k) is not True: bad.append(k)
    if f.get("prepull")!="ok": bad.append("prepull "+str(f.get("prepull")))
    if not isinstance(f.get("prepulled"),int) or f["prepulled"]<1: bad.append("nothing pre-pulled")
if r.get("leftoverContainers")!=0 or r.get("leftoverNetworks")!=0: bad.append("leftover objects")
if r.get("runDirEmpty") is not True: bad.append("run directory not empty")
if r.get("runDirTmpfs") is not True: bad.append("run directory not a tmpfs")
print(", ".join(bad))' 2>/dev/null)
    [[ -z "$bad" ]] && say P4 PASS "worker start report" "boot facts all true, pre-pull ok and logged out, nothing left over, run directory empty and a tmpfs" || say P4 FAIL "worker start report" "${bad:-unreadable report}"
  else
    say P4 FAIL "worker start report" "no worker_start report in $LOG_GROUP since $SINCE_MS (restart a worker, or pass an earlier --since), or the log read failed"
  fi
fi

# ---- 1 dependencies listed
if wanted 1; then
  reply=$(api POST "$ENV_PATH/propose" '{}')
  if [[ "$API_STATUS" == "200" || "$API_STATUS" == "201" ]]; then
    digest=$(echo "$reply" | json digest)
    deps=$(echo "$reply" | python3 -c 'import json,sys
d=json.load(sys.stdin); b=d.get("body") or d.get("environment") or d
print(",".join(x.get("id","") for x in (b.get("dependencies") or [])))' 2>/dev/null)
    [[ "$deps" == *postgres* ]] && say 1 PASS "dependencies listed" "the proposal lists: $deps (digest ${digest:0:12})" || say 1 FAIL "dependencies listed" "the proposal lists '${deps:-nothing}' (needs a setup draft that detected Postgres)"
  else
    say 1 OPERATOR "dependencies listed" "propose answered $API_STATUS: run the project's setup draft in the app first, then re-run"
  fi
fi

# ---- 2 Prove passes
if wanted 2 && [[ -n "${digest:-}" ]]; then
  api POST "$ENV_PATH/check" "{\"digest\":\"$digest\",\"requestId\":\"$(uuidgen | tr 'A-Z' 'a-z')\"}" > /dev/null
  [[ "$API_STATUS" == "202" ]] || say 2 FAIL "candidate check started" "check answered $API_STATUS"
  proved=""
  for _ in $(seq 1 60); do
    sleep 10
    proved=$(api POST "$ENV_PATH/prove" "{\"digest\":\"$digest\"}")
    [[ "$API_STATUS" == "200" ]] && break
  done
  steps=$(echo "$proved" | python3 -c 'import json,sys
d=json.load(sys.stdin); r=d.get("report") or d
print(" ".join(s["step"]+"="+s["status"] for s in r.get("steps",[]) if s["step"] in ("dependencies","dependency_usage")))' 2>/dev/null)
  [[ "$steps" == *dependencies=passed* && "$steps" == *dependency_usage=passed* ]] && say 2 PASS "Prove passes" "$steps" || say 2 FAIL "Prove passes" "${steps:-no Prove report} (status $API_STATUS)"
fi

# ---- 3 a task on the escape project, through the API
if wanted 3; then
  if [[ -z "$TASK_ID" && -n "$ESCAPE_PROJECT" ]]; then
    reply=$(api POST "/v1/dev/tasks" "{\"requestId\":\"$(uuidgen | tr 'A-Z' 'a-z')\",\"project\":\"$ESCAPE_PROJECT\",\"instructions\":\"Add one line to README.md that says the escape project ran. Change nothing else.\",\"client\":\"staging-test-services-e2e\"}")
    TASK_ID=$(echo "$reply" | json task.taskId)
    [[ -n "$TASK_ID" ]] && say 3 PASS "task started" "task $TASK_ID on $ESCAPE_PROJECT (the API answered $API_STATUS)" || say 3 OPERATOR "task started" "the API answered $API_STATUS and gave no task id: start ONE task on $ESCAPE_PROJECT in the app, then re-run with --task <id>"
  elif [[ -z "$TASK_ID" ]]; then
    say 3 OPERATOR "a task passes a check round" "pass --escape-project <name> (the project whose tests are tests/fixtures/test-services-escape-project) to start one, or --task <id> of one you started"
  fi
  if [[ -n "$TASK_ID" ]]; then
    : > "$WORK/view.json"
    for _ in $(seq 1 180); do
      sleep 10
      view=$(api GET "/v1/dev/tasks/$TASK_ID"); printf '%s' "$view" > "$WORK/view.json"
      [[ "$API_STATUS" == "200" ]] || continue
      state=$(echo "$view" | python3 -c 'import json,sys
d=json.load(sys.stdin); t=d.get("task") or d
print(t.get("status") or t.get("state") or (t.get("workflow") or {}).get("state") or "")' 2>/dev/null)
      case "$state" in SUCCEEDED|FAILED|CANCELLED|COMPLETED|MERGED|READY_FOR_REVIEW|BLOCKED) break ;; esac
    done
    [[ -s "$WORK/view.json" ]] && say 3 PASS "task reached an end state" "task $TASK_ID is ${state:-unknown}" || say 3 FAIL "task reached an end state" "no view of task $TASK_ID"
  fi
fi

# the text the verdicts of 4-6 read: the task's view and the evidence file the person saved
TEXT="$WORK/text"; : > "$TEXT"; [[ -s "$WORK/view.json" ]] && cat "$WORK/view.json" >> "$TEXT"; [[ -n "$EVIDENCE_FILE" && -r "$EVIDENCE_FILE" ]] && cat "$EVIDENCE_FILE" >> "$TEXT"
if wanted 4; then
  if [[ ! -s "$TEXT" ]]; then say 4 OPERATOR "the escape project's tests passed" "pass --task and/or --evidence <file>"
  elif grep -Eq '"after": ?"(failed|timed_out)"' "$TEXT"; then say 4 FAIL "the escape project's tests passed" "a check failed in the sealed round: an escape attempt SUCCEEDED, or the run is broken (read the evidence)"
  elif grep -Eq '"after": ?"passed"|checks? passed' "$TEXT"; then say 4 PASS "the escape project's tests passed" "no check failed; every attempt to get out failed"
  else say 4 OPERATOR "the escape project's tests passed" "no check result in the text I have; pass --evidence <file>"; fi
fi
if wanted 5; then
  if grep -q 'Integration tests ran against: Postgres (real)\.' "$TEXT"; then say 5 PASS "the PR line" "'Integration tests ran against: Postgres (real).' is there"
  elif [[ -s "$TEXT" ]]; then say 5 FAIL "the PR line" "the line is not in the task's view or the evidence file"
  else say 5 OPERATOR "the PR line" "pass --task and/or --evidence <file>"; fi
fi
if wanted 6; then
  if grep -q 'Blocked by environment:' "$TEXT"; then
    line=$(grep -m1 -o 'Blocked by environment:[^"]*' "$TEXT")
    # Only registrable domains and counts: no long token-like word.
    if echo "$line" | grep -Eq '[A-Za-z0-9_-]{25,}'; then say 6 FAIL "unknown calls fail loudly" "the line holds a long token-like word: $line"; else say 6 PASS "unknown calls fail loudly" "$line"; fi
  elif [[ -s "$TEXT" ]]; then say 6 FAIL "unknown calls fail loudly" "no 'Blocked by environment' line: the escape project's internet test makes name lookups that must be counted"
  else say 6 OPERATOR "unknown calls fail loudly" "pass --task and/or --evidence <file>"; fi
fi

# ---- 7 teardown, from the worker's run_end reports since the script started
if wanted 7; then
  if lines=$(reports run_end) && [[ -n "$lines" ]]; then
    verdict=$(printf '%s\n' "$lines" | EXPECT="$EXPECT_OUTCOME" python3 -c 'import json,os,sys
expect=os.environ.get("EXPECT",""); bad=[]; seen=[]
for raw in sys.stdin:
    r=json.loads(raw); seen.append(r.get("outcome"))
    if r.get("leftoverContainers")!=0 or r.get("leftoverNetworks")!=0: bad.append("leftover objects after a "+str(r.get("outcome"))+" run")
    if r.get("runDirEmpty") is not True: bad.append("run directory not empty after a "+str(r.get("outcome"))+" run")
    if r.get("workingSandboxPaused") is True: bad.append("working sandbox left paused after a "+str(r.get("outcome"))+" run")
if expect and expect not in seen: bad.append("no "+expect+" run reported")
print("|".join([", ".join(sorted(set(bad))), ",".join(seen)]))' 2>/dev/null)
    problems="${verdict%%|*}"; seen="${verdict#*|}"
    [[ -z "$problems" ]] && say 7 PASS "teardown is clean" "run_end reports since the start: ${seen:-none}; nothing left, run directory empty, working sandbox not paused" || say 7 FAIL "teardown is clean" "$problems"
  else say 7 OPERATOR "teardown is clean" "no run_end report in $LOG_GROUP since $SINCE_MS yet (run a task, then re-run; repeat with --expect-outcome failed, then cancelled)"; fi
  if [[ -n "$EXPECT_SWEPT" ]]; then
    if lines=$(reports worker_start) && [[ -n "$lines" ]]; then
      swept=$(printf '%s\n' "$lines" | tail -n1 | python3 -c 'import json,sys
r=json.load(sys.stdin); print((r.get("sweptContainers") or 0)+(r.get("sweptNetworks") or 0), r.get("leftoverContainers"), r.get("leftoverNetworks"))' 2>/dev/null)
      set -- $swept
      [[ "${1:-0}" -gt 0 && "${2:-1}" == 0 && "${3:-1}" == 0 ]] && say 7 PASS "killed worker is swept" "the restarted worker removed $1 leftover object(s) and nothing is left" || say 7 FAIL "killed worker is swept" "swept ${1:-?}, left ${2:-?} containers and ${3:-?} networks"
    else say 7 FAIL "killed worker is swept" "no worker_start report since $SINCE_MS"; fi
  fi
fi

# ---- 8, 9 and the relay (a person's steps)
if wanted 8; then say 8 OPERATOR "switch off is today" "turn tx off for the project (owner), start the same task and compare its dispatch payload and PR body with a task from before the release: no testServices, no dependency line"; fi
if wanted 9; then say 9 OPERATOR "other backings refused" "propose a draft with an S3 candidate in the app and read the 'not available yet' words (the broker's unit tests cover the words)"; fi
if wanted L3 && [[ -n "$REQUIRE_HEARTBEAT" ]]; then
  if [[ ! -s "$TEXT" ]]; then say L3 OPERATOR "relay test ran" "pass --task and/or --evidence <file>"
  elif grep -qi 'skipped' "$TEXT" && grep -qi 'relay' "$TEXT"; then say L3 FAIL "relay test ran" "the relay test was skipped: the project's setup command (npm run setup) did not start the heartbeat in the working sandbox"
  else say L3 PASS "relay test ran" "the relay test is not reported as skipped"; fi
fi

printf 'TSE SUMMARY pass=%d fail=%d operator=%d\n' "$pass" "$fail" "$operator"
[[ "$fail" -eq 0 && "$operator" -eq 0 ]]
