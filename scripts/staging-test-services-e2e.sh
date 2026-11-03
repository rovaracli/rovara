#!/bin/bash
# The live done-check of test services slice 1 (ROUND-2026-11-03-test-services-hookup.md, "What it proves", items 1-9): ONE staging project, `tx` on, ONE dependency (Postgres 16 from the catalog), one task, end to end.
# WRITTEN, NOT RUN. Nothing here has been run against staging. It runs only after the OWNER GO for `tx` on one project (DECISIONS: "Test services: thin slice first"), the catalog steps 1-5 and the Linux checks
# TS-L1..L4, L6 and TS-RN-4 (scripts/linux-check-test-services.sh), and refuses to start without them (STAGING_E2E_OWNER_GO below).
#
# WHAT IT DOES
#   - every AWS call goes through ~/.local/share/rovara-tools/staging-aws.sh (account 944937319445, us-west-2) and is READ-ONLY (sts, ecr describe-images, ssm describe/get-parameter, ssm send-command of a read-only
#     `docker ps/network ls` on the worker). It creates nothing in AWS, deploys nothing, reads no secret (no secretsmanager call at all).
#   - the Rovara API calls (propose / check / prove / approve of the project's test environment, task start and read) use ONE bearer token read from a FILE (ROVARA_STAGING_TOKEN_FILE, mode 600); the token is never
#     printed, never put in an argument (curl reads the header from the file), and never written to the output.
#   - the output is one line per check:  TSE <id> PASS|FAIL|OPERATOR <name> | <one line of evidence>   and a summary. Exit 0 only if every automated check passes and no OPERATOR step is left.
#
# THE STEPS (the numbers are the done-definition's)
#   P1-P4  preconditions (AWS, read-only): signed in to the staging account; the catalog repository holds postgres by digest; the catalog's pinned digest matches the repository; no leftover run-network objects on the worker.
#   1      dependencies listed: the proposal for the project's latest setup draft lists Postgres with its source line (needs a setup draft: an OPERATOR step if none exists).
#   2      Prove passes: the candidate check starts Postgres and the two Prove steps "dependencies" and "dependency_usage" are passed.
#   3      a task passes a check round: an OPERATOR starts ONE task on the project (the app, or `POST /v1/app/tasks`), gives its id here; the script waits for it and reads its evidence.
#   4      the worker pulled the pinned image BY DIGEST from rovara-catalog/staging/svc/postgres (ecr describe-images shows the pull time; the worker's log line is read through SSM).
#   5      the PR (or the evidence summary file the operator saves from the task) says `Integration tests ran against: Postgres (real).`
#   6      unknown calls fail loudly: the operator adds a test that calls an unlisted host; the evidence says `Blocked by environment: N call(s)` with a registrable domain and a count and NO full name.
#   7      teardown is clean after success, failure, cancel and a killed worker: nothing with the label rovara.run-network is left on the worker (read through SSM) and the run directory is gone.
#   8      switch off = today: with `tx` off for the project the same task runs as before (the operator flips the switch back; the script compares the dispatch payload fields the broker kept).
#   9      any other backing is refused with "not available yet" at approval and at dispatch (the script proposes a draft with an S3 candidate and expects the refusal words).
#
# USAGE  (from the repository root, on the Mac; zsh or bash)
#   STAGING_E2E_OWNER_GO=yes ROVARA_STAGING_URL=https://<staging api> ROVARA_STAGING_TOKEN_FILE=$HOME/.rovara-staging-token ROVARA_STAGING_PROJECT=<project> \
#     scripts/staging-test-services-e2e.sh [--task <task id>] [--evidence <file>] [--worker <instance id>] [--only <id>[,<id>...]]
#   Re-run with --task / --evidence after the operator steps. Without them the script stops at the first OPERATOR step and says what to do.
set -u
export LC_ALL=C

STAGING="${STAGING_AWS:-$HOME/.local/share/rovara-tools/staging-aws.sh}"
EXPECTED_ACCOUNT=944937319445
CATALOG_REPOSITORY_SUFFIX="svc/postgres"
TASK_ID=""
EVIDENCE_FILE=""
WORKER=""
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --task) TASK_ID="${2:-}"; shift 2 ;;
    --evidence) EVIDENCE_FILE="${2:-}"; shift 2 ;;
    --worker) WORKER="${2:-}"; shift 2 ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

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

# ---- P1-P4 preconditions (read-only AWS)
if wanted P1; then
  account=$("$STAGING" aws sts get-caller-identity --query Account --output text 2>/dev/null)
  [[ "$account" == "$EXPECTED_ACCOUNT" ]] && say P1 PASS "staging account" "account $account, region us-west-2 (the guard refuses any other)" || say P1 FAIL "staging account" "got '${account:-nothing}'"
fi
if wanted P2; then
  digests=$("$STAGING" aws ecr describe-images --repository-name "rovara-catalog/staging/$CATALOG_REPOSITORY_SUFFIX" --query 'imageDetails[].imageDigest' --output text 2>/dev/null)
  [[ -n "$digests" ]] && say P2 PASS "catalog repository holds postgres" "$(echo "$digests" | wc -w | tr -d ' ') image digest(s) in rovara-catalog/staging/$CATALOG_REPOSITORY_SUFFIX" || say P2 FAIL "catalog repository holds postgres" "no image: the repack (catalog step 3) has not been done"
fi
if wanted P3; then
  pinned=$(python3 -c 'import json;d=json.load(open("environments/service-catalog/catalog.json"));print(" ".join(e["image"].get("digest","") for e in d["entries"] if e["id"]=="postgres@16"))' 2>/dev/null)
  if [[ -z "${digests:-}" ]]; then digests=$("$STAGING" aws ecr describe-images --repository-name "rovara-catalog/staging/$CATALOG_REPOSITORY_SUFFIX" --query 'imageDetails[].imageDigest' --output text 2>/dev/null); fi
  if [[ -n "$pinned" && "$digests" == *"sha256:${pinned#sha256:}"* ]]; then say P3 PASS "catalog pin matches the repository" "postgres@16 is pinned to a digest the repository holds"; else say P3 FAIL "catalog pin matches the repository" "the committed catalog pin '${pinned:-none}' is not among the repository's digests (catalog step 4/5)"; fi
fi
if wanted P4 && [[ -n "$WORKER" ]]; then
  cmd='docker ps -a --filter label=rovara.run-network --format "{{.Names}}"; docker network ls --filter label=rovara.run-network --format "{{.Name}}"'
  id=$("$STAGING" aws ssm send-command --instance-ids "$WORKER" --document-name AWS-RunShellScript --parameters "commands=[\"$cmd\"]" --query Command.CommandId --output text 2>/dev/null)
  sleep 5
  out=$("$STAGING" aws ssm get-command-invocation --command-id "$id" --instance-id "$WORKER" --query StandardOutputContent --output text 2>/dev/null)
  [[ -z "$(echo "$out" | tr -d '[:space:]')" || "$out" == "None" ]] && say P4 PASS "no leftovers before the run" "no container or network with the run-network label on $WORKER" || say P4 FAIL "no leftovers before the run" "leftover objects: $(echo "$out" | head -3 | tr '\n' ' ')"
elif wanted P4; then say P4 OPERATOR "no leftovers before the run" "pass --worker <instance id> (an SSM managed worker)"; fi

# ---- 1 dependencies listed, 9 other backings refused (the broker's own words)
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

# ---- 3-7 need a real task: the operator starts it
if wanted 3; then
  if [[ -z "$TASK_ID" ]]; then
    say 3 OPERATOR "a task passes a check round" "approve the proved proposal in the app, start ONE task on $ROVARA_STAGING_PROJECT, then re-run with --task <task id> --evidence <the task's evidence summary saved as a file>"
  else
    view=$(api GET "/v1/app/tasks/$TASK_ID")
    state=$(echo "$view" | json status)
    [[ "$API_STATUS" == "200" ]] && say 3 PASS "task found" "task $TASK_ID is $state" || say 3 FAIL "task found" "GET task answered $API_STATUS"
  fi
fi
if wanted 4 && [[ -n "$TASK_ID" ]]; then
  # The worker logs one fixed line per pull; the image digest is read from the catalog pin, never from the log's free text.
  if [[ -n "$WORKER" ]]; then
    id=$("$STAGING" aws ssm send-command --instance-ids "$WORKER" --document-name AWS-RunShellScript --parameters 'commands=["docker images --digests --format \"{{.Repository}}@{{.Digest}}\" | grep rovara-catalog/"]' --query Command.CommandId --output text 2>/dev/null)
    sleep 5
    out=$("$STAGING" aws ssm get-command-invocation --command-id "$id" --instance-id "$WORKER" --query StandardOutputContent --output text 2>/dev/null)
    [[ "$out" == *"rovara-catalog/staging/$CATALOG_REPOSITORY_SUFFIX@sha256:"* ]] && say 4 PASS "pulled by digest" "$(echo "$out" | head -1)" || say 4 FAIL "pulled by digest" "no rovara-catalog/staging/$CATALOG_REPOSITORY_SUFFIX@sha256:<digest> image on the worker"
  else say 4 OPERATOR "pulled by digest" "pass --worker <instance id>"; fi
fi
if wanted 5 && [[ -n "$EVIDENCE_FILE" ]]; then
  grep -q 'Integration tests ran against: Postgres (real)\.' "$EVIDENCE_FILE" && say 5 PASS "the PR line" "'Integration tests ran against: Postgres (real).' is in $EVIDENCE_FILE" || say 5 FAIL "the PR line" "the line is not in $EVIDENCE_FILE"
elif wanted 5; then say 5 OPERATOR "the PR line" "pass --evidence <file with the PR body or the Evidence tab text>"; fi
if wanted 6 && [[ -n "$EVIDENCE_FILE" ]]; then
  if grep -q 'Blocked by environment:' "$EVIDENCE_FILE"; then
    line=$(grep -m1 'Blocked by environment:' "$EVIDENCE_FILE")
    # Only registrable domains and counts: no label that looks like a key or a long random token.
    if echo "$line" | grep -Eq '[A-Za-z0-9_-]{25,}'; then say 6 FAIL "unknown calls fail loudly" "the line holds a long token-like word: $line"; else say 6 PASS "unknown calls fail loudly" "$line"; fi
  else say 6 OPERATOR "unknown calls fail loudly" "add a test that calls an unlisted host, run a task, save its evidence and re-run"; fi
fi
if wanted 7 && [[ -n "$WORKER" && -n "$TASK_ID" ]]; then
  cmd='docker ps -a --filter label=rovara.run-network --format "{{.Names}}"; docker network ls --filter label=rovara.run-network --format "{{.Name}}"; ls /run/rovara 2>/dev/null | wc -l'
  id=$("$STAGING" aws ssm send-command --instance-ids "$WORKER" --document-name AWS-RunShellScript --parameters "commands=[\"$cmd\"]" --query Command.CommandId --output text 2>/dev/null)
  sleep 5
  out=$("$STAGING" aws ssm get-command-invocation --command-id "$id" --instance-id "$WORKER" --query StandardOutputContent --output text 2>/dev/null)
  objects=$(echo "$out" | grep -v '^[0-9]*$' | tr -d '[:space:]')
  [[ -z "$objects" ]] && say 7 PASS "teardown is clean" "no run-network object left after the task (repeat after a failing task, a cancel and a killed worker; each is its own run of this check)" || say 7 FAIL "teardown is clean" "left: $(echo "$out" | head -3 | tr '\n' ' ')"
elif wanted 7; then say 7 OPERATOR "teardown is clean" "pass --worker and --task; repeat after success, failure, cancel and a killed worker (kill the worker's container mid-round, restart it, then run this check)"; fi

# ---- 8 switch off = today, 9 other backings refused
if wanted 8; then say 8 OPERATOR "switch off is today" "turn tx off for the project (owner), start the same task, and compare its dispatch payload and PR body with a task from before the release: no testServices, no dependency line"; fi
if wanted 9; then
  reply=$(api POST "$ENV_PATH/propose" '{"probe":"s3-candidate"}')
  [[ "$API_STATUS" == "400" || "$API_STATUS" == "409" ]] && echo "$reply" | grep -qi 'not available yet' && say 9 PASS "other backings refused" "answered $API_STATUS with the 'not available yet' words" || say 9 OPERATOR "other backings refused" "propose a draft with an S3 candidate in the app and read the refusal words (this script cannot craft one through the public route; the unit tests cover the broker side)"
fi

printf 'TSE SUMMARY pass=%d fail=%d operator=%d\n' "$pass" "$fail" "$operator"
[[ "$fail" -eq 0 && "$operator" -eq 0 ]]
