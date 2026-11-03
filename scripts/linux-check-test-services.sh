#!/bin/bash
# TS-L1 to TS-L8: the Linux checks for test services (switch `tx`; design test-services.md section 12/13; task TS37). Deferred checks: they must pass on linux-runtime or a staging worker before `tx` is turned on.
# NOTHING HERE HAS BEEN RUN against a real worker yet. It does the READ-ONLY part of each check (the host's firewall rules, Docker's inventory, address-range use, leftovers) in every run. The LIVE part of L1, L2, L3, L4 (Postgres
# only, plus the template_db reset, TS-RUN-3) and L6 needs throwaway run networks and containers: it is done by scripts/linux-check-test-services-live.ts (the worker's real run-layer modules, run inside a container of the worker's
# own image), and only when the operator delivers that driver (TSL_DIR is set: see "LIVE PARTS" below). Without it those items print PENDING; L5, L7 and L8 stay PENDING in slice 1. A PENDING line is never a pass: `tx` stays off until
# every line is PASS.
#
# NO SSM ON STAGING WORKERS (read this first). Staging EC2 workers are NOT SSM-managed: their instance profile has no SSM permission, by design, and none may be added. The "THROUGH SSM" recipes below are therefore for a host
# you really have a shell on (the linux-runtime CI job, a developer's Linux machine, a worker launched for the purpose), NEVER for a staging worker. What each check needs, and where a staging worker gets it instead:
#   id (design 12/13)                                  needs a root shell?   on a staging worker, it is proven by
#   L1 walls, isolation, Docker version                 no (boot facts)       the worker_start report's bootFacts: metadataBlocked, runWalls, ipv6Drops, dockerVersion (TS-RN-4 is metadataBlocked)
#   L1 iptables backend, address range, Docker pools    yes                   linux-runtime CI only (tests/linux); the run networks' allocation is exercised by every task
#   L2 dual-homed working sandbox                       no                    the escape project's neighbours test (the working sandbox's address and the gateway do not answer; the run's own Postgres does)
#   L3 sealed sandbox: internet, IPv6, other run, relay no                    the escape project: internet.test.js, ipv6.test.js, neighbours.test.js, planted-state.test.js, relay.test.js
#   L3 embedded resolver, multicast, run files          yes                   linux-runtime CI only; spoofed source addresses (TS-SEAL-4) need CAP_NET_RAW: linux-runtime CI only
#   L4 Postgres hardening, template_db reset            partly                the helper's run arguments are unit-tested; the reset is exercised by every round; the flags themselves: linux-runtime CI
#   L5 test-account proxy                                -                     not in slice 1 (gates `ta`)
#   L6 killed-worker sweep, no leftovers                no (self-report)      the run_end reports (nothing left, run directory empty, working sandbox not paused) and, after a restart, the worker_start report's swept counts
#   L7, L8                                               -                     later slices
# The staging done-check (scripts/staging-test-services-e2e.sh) reads the self-reports from CloudWatch Logs through the staging guard and runs the escape project as a task.
#
# WHAT IT DOES. READ-ONLY: it reads iptables, interfaces, routes, /etc/docker/daemon.json, Docker's inventory (ps, network ls, network inspect, inspect, version) and /proc/meminfo, and changes none of them. It starts no container, makes no network,
# writes no file, uses no AWS access and reads no secret. It never prints an environment variable. (The live parts, when delivered, start containers and networks of their own and use the worker role's registry login: see LIVE PARTS.)
#
# OUTPUT. One line per check part, then a summary:
#   TSL <id> PASS|FAIL|PENDING <check_name> | <one line of evidence>
#   TSL SUMMARY pass=<p> fail=<f> pending=<n>
# Exit status 0 only when every line is PASS; 1 when any line is FAIL; 3 when none failed but some are PENDING (always, until L5, L7 and L8 have live parts).
#
# LIVE PARTS (needs the owner's OK to run, on an IDLE staging worker; the catalog must pin postgres@16 first). The shell script then, as root on the worker: logs in to the worker's own registry with the instance role (aws ecr get-login-password,
# the way the boot does), pulls the pinned Postgres image BY DIGEST (the worker role's catalog grant, TS-IMG-1), starts the driver in a throwaway container of the worker image (no network, no capability, read-only, the Docker socket and one
# work directory), prints the driver's lines in place of the PENDING ones, and removes everything the checks made (containers and networks carrying the throwaway workspace label, the work directory). One plain environment variable may be
# set: TSL_ENV (default staging). The driver makes no AWS call (this script fetches the registry's manifest of each pinned digest with the worker role) and reads no secret; its only credential is a random Postgres password that never leaves the helper's 0600 env file. Deliver it with the driver's own command:
#   npx tsx scripts/linux-check-test-services-live.ts --ssm-params > "$TMPDIR/tsl-params.json"
#   $STAGING aws ssm send-command --instance-ids <instance-id> --document-name AWS-RunShellScript --comment ts-linux-checks-live --timeout-seconds 3000 --parameters file://"$TMPDIR/tsl-params.json" --query Command.CommandId --output text
# (the same get-command-invocation as step 3 below reads the answer; SSM returns at most 24,000 characters, and the whole output is about 5,000.)
#
# HOW AN OPERATOR RUNS THE READ-ONLY PART ON A STAGING WORKER THROUGH SSM, like scripts/staging-checks/setup-agent-su1.sh. Every AWS command goes through the staging guard (account 944937319445, us-west-2) and nothing else; run from
# the repository root on the Mac, on an idle worker:
#   STAGING=$HOME/.local/share/rovara-tools/staging-aws.sh
#   1. find a worker that is an SSM managed node (as in setup-agent-su1.sh step 1);
#   2. send the script as one base64 piece through AWS-RunShellScript (it runs as root), piped into bash so no file is written on the worker:
#        B64=$(base64 < scripts/linux-check-test-services.sh | tr -d '\n')
#        $STAGING aws ssm send-command --instance-ids <instance-id> --document-name AWS-RunShellScript --comment ts-linux-checks --timeout-seconds 300 \
#          --parameters "commands=[\"echo $B64 | base64 -d | bash\"]" --query Command.CommandId --output text
#   3. read the answer:
#        $STAGING aws ssm get-command-invocation --command-id <command-id> --instance-id <instance-id> --query '[Status,StandardOutputContent]' --output text
set -u
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

if [[ $# -gt 0 ]]; then printf 'TSL ERROR this script takes no arguments\n'; exit 2; fi
TSL_DIR=${TSL_DIR:-}
TSL_ENV=${TSL_ENV:-staging}
[[ "$TSL_ENV" =~ ^[a-z][a-z0-9-]{0,19}$ ]] || { printf 'TSL ERROR TSL_ENV is not an environment name\n'; exit 2; }
[[ -z "$TSL_DIR" || "$TSL_DIR" =~ ^/var/tmp/tsl\.[A-Za-z0-9]{6}$ ]] || { printf 'TSL ERROR TSL_DIR is not a directory this script is delivered into\n'; exit 2; }

PASS=0; FAIL=0; PENDING=0
emit() { # emit <id> <PASS|FAIL|PENDING> <name> <detail>
  local detail
  detail=$(printf '%s' "$4" | tr '\r\n\t' '   ' | cut -c1-400)
  printf 'TSL %s %s %s | %s\n' "$1" "$2" "$3" "$detail"
  case "$2" in PASS) PASS=$((PASS + 1)) ;; FAIL) FAIL=$((FAIL + 1)) ;; *) PENDING=$((PENDING + 1)) ;; esac
}
verdict() { # verdict <id> <name> <failures-string> <pass-detail>
  if [[ -z "$3" ]]; then emit "$1" PASS "$2" "$4"; else emit "$1" FAIL "$2" "$3"; fi
}
pending() { emit "$1" PENDING "$2" "$3"; } # pending <id> <name> <what the live part will do>
# The live driver's lines (scripts/linux-check-test-services-live.ts), by id. LIVE_RAN=1 once the driver was started: an item it gave no line for is then a FAIL, not a PENDING.
LIVE_OUT=""
LIVE_RAN=0
LIVE_BLOCKED=""
live_line() { # live_line <id> <name> <what the live part will do> [a failure found by a host check made here]
  local row status name detail
  row=$(printf '%s\n' "$LIVE_OUT" | grep -m1 -F -- "TSL $1 ")
  if [[ -n "$row" ]]; then
    status=$(printf '%s' "$row" | awk '{print $3}'); name=$(printf '%s' "$row" | awk '{print $4}'); detail=${row#* | }
    case "$status" in PASS|FAIL|PENDING) ;; *) status=FAIL; detail="the driver gave an unreadable status" ;; esac
    if [[ -n "${4:-}" ]]; then status=FAIL; detail="$4; driver: $detail"; fi
    emit "$1" "$status" "$name" "$detail"
  elif [[ -n "${4:-}" ]]; then emit "$1" FAIL "$2" "$4"
  elif [[ -n "$LIVE_BLOCKED" ]]; then emit "$1" FAIL "$2" "$LIVE_BLOCKED"
  elif (( LIVE_RAN == 1 )); then emit "$1" FAIL "$2" "the live driver gave no result for this item"
  else pending "$1" "$2" "$3"; fi
}

DOCKER=$(cat /etc/agentx/docker-path 2>/dev/null || true)
[[ "$DOCKER" == /* && -x "$DOCKER" ]] || DOCKER=$(command -v docker || true)
have_docker() { [[ -n "$DOCKER" && -x "$DOCKER" ]]; }
dk() { "$DOCKER" "$@"; }

# The run network's labels and ranges (packages/worker/src/run-network.ts). Keep in step with it.
FAMILY_LABEL=rovara.run-network
RANGE_PREFIX=172.30.

# BEGIN LIVE: the only code in this file that starts, pulls, removes or writes anything. It runs only when the operator delivers the driver (TSL_DIR); tests/contract/linux-check-test-services.test.ts holds the rest read-only.
# The throwaway workspace key of the live driver (TSL_WORKSPACE in scripts/linux-check-test-services-live.ts): every object it makes carries it, and this script removes whatever carries it when it ends.
TSL_WORKSPACE_KEY=7e57c4ec7e57c4ec
TSL_WORK=""
TSL_DOCKER_CONFIG=""
tsl_cleanup() {
  [[ -n "$DOCKER" && -x "$DOCKER" ]] || return 0
  local ids
  ids=$("$DOCKER" ps -a -q --filter "label=$FAMILY_LABEL.workspace=$TSL_WORKSPACE_KEY" 2>/dev/null) || ids=""
  [[ -z "$ids" ]] || "$DOCKER" rm -f -v $ids >/dev/null 2>&1
  ids=$("$DOCKER" network ls -q --filter "label=$FAMILY_LABEL.workspace=$TSL_WORKSPACE_KEY" 2>/dev/null) || ids=""
  [[ -z "$ids" ]] || "$DOCKER" network rm $ids >/dev/null 2>&1
  [[ -z "$TSL_WORK" ]] || rm -rf "$TSL_WORK"
  [[ -z "$TSL_DOCKER_CONFIG" ]] || rm -rf "$TSL_DOCKER_CONFIG"
  return 0
}
# run_live_driver: pull the pinned images, start the driver in a throwaway container of the worker image, keep its lines in LIVE_OUT. Never reads or prints a credential. The registry login goes to a Docker config directory of its own
# (DOCKER_CONFIG), so the worker's own login on this host is never touched, and the directory is removed with the rest.
run_live_driver() {
  LIVE_RAN=1
  local image reg region gid ref refs out token doc account digest manifest
  [[ -s "$TSL_DIR/live.mjs" && -s "$TSL_DIR/catalog.json" ]] || { LIVE_OUT="TSL ERROR the driver or the catalog was not delivered"; return 1; }
  have_docker || { LIVE_OUT="TSL ERROR no docker"; return 1; }
  image=$(cat /etc/agentx/worker-image 2>/dev/null || true)
  [[ "$image" =~ ^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]] || { LIVE_OUT="TSL ERROR the worker image identity is invalid"; return 1; }
  reg=${image%%/*}
  region=$(sed -n 's/^AWS_REGION=//p' /etc/agentx/worker.env 2>/dev/null | head -1)
  [[ "$reg" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$ && "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || { LIVE_OUT="TSL ERROR the worker's registry or region is not an ECR one"; return 1; }
  gid=$(stat -c %g /var/run/docker.sock 2>/dev/null || true)
  [[ "$gid" =~ ^[0-9]+$ ]] || { LIVE_OUT="TSL ERROR the Docker socket is not readable"; return 1; }
  TSL_WORK=$(mktemp -d /var/tmp/tsl-work.XXXXXX) || { LIVE_OUT="TSL ERROR no work directory"; return 1; }
  chmod 0755 "$TSL_WORK"
  mkdir "$TSL_WORK/manifests" && chmod 0755 "$TSL_WORK/manifests"
  TSL_DOCKER_CONFIG=$(mktemp -d /var/tmp/tsl-docker.XXXXXX) || { LIVE_OUT="TSL ERROR no Docker config directory"; return 1; }
  # The account this host runs in, from its own instance identity document (IMDSv2), never from a setting; unknown when the lookup fails, and the driver then does not trust the staging-only key.
  account=""
  token=$(curl -fsS --max-time 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token 2>/dev/null || true)
  if [[ -n "$token" ]]; then
    doc=$(curl -fsS --max-time 3 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/dynamic/instance-identity/document 2>/dev/null || true)
    account=$(printf '%s' "$doc" | sed -n 's/.*"accountId" *: *"\([0-9]\{12\}\)".*/\1/p' | head -1)
  fi
  local sig_mount=()
  [[ -s "$TSL_DIR/catalog.sig.json" ]] && sig_mount=(-v "$TSL_DIR/catalog.sig.json:/opt/agentx/tsl-catalog.sig.json:ro")
  local base=(--rm --network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,size=64m -v "$TSL_DIR/live.mjs:/opt/agentx/tsl-live.mjs:ro" -v "$TSL_DIR/catalog.json:/opt/agentx/tsl-catalog.json:ro" ${sig_mount[@]+"${sig_mount[@]}"}
    -v "$TSL_WORK/manifests:/opt/agentx/tsl-manifests:ro" -e "TSL_REGISTRY=$reg" -e "TSL_ENV=$TSL_ENV" -e TSL_CATALOG=/opt/agentx/tsl-catalog.json -e TSL_MANIFESTS=/opt/agentx/tsl-manifests
    -e "TSL_WORKER_IMAGE=$image" -e "TSL_WORK=$TSL_WORK" -e "TSL_ACCOUNT_ID=$account")
  # The driver checks the signature first: with no trusted catalog key it says BLOCKED here and nothing is pulled.
  refs=$(DOCKER_CONFIG="$TSL_DOCKER_CONFIG" "$DOCKER" run "${base[@]}" --user 1000:1000 --entrypoint /usr/local/bin/node "$image" /opt/agentx/tsl-live.mjs pull-list 2>&1) || {
    case "$refs" in "BLOCKED:"*) LIVE_OUT=""; LIVE_BLOCKED=$(printf '%s' "$refs" | head -1 | cut -c1-120) ;; *) LIVE_OUT="TSL ERROR pull-list: $(printf '%s' "$refs" | tr '\r\n\t' '   ' | cut -c1-200)" ;; esac
    return 1
  }
  # The worker's own registry login, with the instance role, as the boot does it, into the check's own Docker config; the pulls are by digest and bounded.
  { timeout --foreground --kill-after=10s 120s aws ecr get-login-password --region "$region" | DOCKER_CONFIG="$TSL_DOCKER_CONFIG" timeout --foreground --kill-after=10s 60s "$DOCKER" login --username AWS --password-stdin "$reg" >/dev/null 2>&1; } || { LIVE_OUT="TSL ERROR the registry login failed"; return 1; }
  for ref in $refs; do
    [[ "$ref" =~ ^$reg/rovara-catalog/$TSL_ENV/svc/([a-z0-9._-]+)@sha256:([a-f0-9]{64})$ ]] || { LIVE_OUT="TSL ERROR the driver named an image outside the environment's catalog"; return 1; }
    digest=${BASH_REMATCH[2]}
    # The manifest the registry serves for the digest, byte for byte (the driver hashes it), with the worker role's catalog grant.
    manifest=$(timeout --foreground --kill-after=10s 60s aws ecr batch-get-image --region "$region" --repository-name "rovara-catalog/$TSL_ENV/svc/${BASH_REMATCH[1]}" --image-ids "imageDigest=sha256:$digest" --query 'images[0].imageManifest' --output text 2>/dev/null) || { LIVE_OUT="TSL ERROR the manifest of $ref could not be read"; return 1; }
    printf '%s' "$manifest" > "$TSL_WORK/manifests/$digest"
    DOCKER_CONFIG="$TSL_DOCKER_CONFIG" timeout --foreground --kill-after=10s 600s "$DOCKER" pull --quiet "$ref" >/dev/null 2>&1 || { LIVE_OUT="TSL ERROR the pull of $ref failed"; return 1; }
  done
  out=$(DOCKER_CONFIG="$TSL_DOCKER_CONFIG" timeout --foreground --kill-after=30s 2400s "$DOCKER" run "${base[@]}" --user 0:0 --group-add "$gid" -v /var/run/docker.sock:/var/run/docker.sock -v "$TSL_WORK:$TSL_WORK" --entrypoint /usr/local/bin/node "$image" /opt/agentx/tsl-live.mjs run 2>&1) || true
  LIVE_OUT=$out
  return 0
}
# END LIVE

# the line number of the first rule of chain $1 in rules text $2 that holds every |-separated token of $3 (iptables writes the options of a rule in its own order)
rule_at() { printf '%s\n' "$2" | awk -v chain="$1" -v toks="$3" 'BEGIN{n=split(toks,t,"|")} index($0,"-A " chain " ")==1{ok=1; for(i=1;i<=n;i++) if(index($0,t[i])==0){ok=0;break} if(ok){print NR; exit}}'; }
# the line numbers of rules of chain $1 in $2, before line $3, that accept or return traffic from an rvi bridge: such a rule above the DROP would hide it
rvi_opened_before() { printf '%s\n' "$2" | awk -v chain="$1" -v upto="$3" 'index($0,"-A " chain " ")==1 && NR<upto && index($0,"-i rvi")!=0 && $0 ~ /-j (ACCEPT|RETURN)( |$)/{printf "%s ", NR}'; }

DOCKER_USER=$(iptables -S DOCKER-USER 2>/dev/null || true)
INPUT_RULES=$(iptables -S INPUT 2>/dev/null || true)
ALL_RULES=$(iptables -S 2>/dev/null || true)
DAEMON_JSON=/etc/docker/daemon.json

# bash CIDR helpers: cidr_overlaps A B is true when the two ranges share an address
to_int() { local IFS=.; set -- $1; echo $(( ($1 << 24) + ($2 << 16) + ($3 << 8) + $4 )); }
cidr_overlaps() { local ai ap bi bp p mask; ai=$(to_int "${1%/*}"); ap=${1#*/}; bi=$(to_int "${2%/*}"); bp=${2#*/}; p=$(( ap < bp ? ap : bp )); mask=$(( (0xffffffff << (32 - p)) & 0xffffffff )); [[ $(( ai & mask )) -eq $(( bi & mask )) ]]; }
# version_at_least A B: dotted version A >= B (numeric parts only)
version_at_least() { local IFS=.; local -a a=($1) b=($2); local i; for i in 0 1 2; do local x=${a[i]:-0} y=${b[i]:-0}; x=${x//[!0-9]/}; y=${y//[!0-9]/}; if (( ${x:-0} > ${y:-0} )); then return 0; fi; if (( ${x:-0} < ${y:-0} )); then return 1; fi; done; return 0; }

# BEGIN LIVE CALL
# ---- the live driver, when the operator delivered it: it runs first (it makes and removes its own run networks), so the read-only parts below see the host as it is when it is done.
if [[ -n "$TSL_DIR" ]]; then
  trap tsl_cleanup EXIT
  trap 'tsl_cleanup; exit 130' INT TERM HUP
  run_live_driver || true
  tsl_cleanup
  case "$LIVE_OUT" in "TSL ERROR"*) printf '%s\n' "$LIVE_OUT" | head -3 ;; esac
  [[ -z "$LIVE_BLOCKED" ]] || printf 'TSL BLOCKED %s\n' "$LIVE_BLOCKED"
fi
# END LIVE CALL

# ---- TS-L1: sandbox-to-helper traffic on an rvi* internal network passes, and helper-to-internet fails.
# Read-only part: the boot firewall walls every rvi* bridge (and no rule opens one), which is the whole reason the run network needs no rule of its own.
fails=""
at_forward=$(rule_at DOCKER-USER "$DOCKER_USER" "-i rvi+|! -o rvi+|-j DROP")
at_input=$(rule_at INPUT "$INPUT_RULES" "-i rvi+|-j DROP")
[[ -n "$at_forward" ]] || fails="$fails no-DOCKER-USER-rvi-drop"
[[ -n "$at_input" ]] || fails="$fails no-INPUT-rvi-drop"
if [[ -n "$at_forward" ]]; then opened=$(rvi_opened_before DOCKER-USER "$DOCKER_USER" "$at_forward"); [[ -z "$opened" ]] || fails="$fails rvi-opened-above-the-drop(lines:${opened% })"; fi
if [[ -n "$at_input" ]]; then opened=$(rvi_opened_before INPUT "$INPUT_RULES" "$at_input"); [[ -z "$opened" ]] || fails="$fails rvi-opened-above-the-input-drop(lines:${opened% })"; fi
verdict L1.walls rvi-walls-present-and-not-opened "${fails# }" "DOCKER-USER drop at line ${at_forward:-?}, INPUT drop at line ${at_input:-?}"

# ---- TS-L1 (two rvi bridges never talk): the boot firewall also drops routed (not bridged) traffic between two different rvi bridges, so one run's helpers cannot reach another run's or an end-to-end network's.
fails=""
at_isolation=$(rule_at DOCKER-USER "$DOCKER_USER" "-i rvi+|-o rvi+|-m physdev|! --physdev-is-bridged|-j DROP")
if [[ -z "$at_isolation" ]]; then fails="no-rvi-to-rvi-isolation-drop"
else opened=$(rvi_opened_before DOCKER-USER "$DOCKER_USER" "$at_isolation"); [[ -z "$opened" ]] || fails="rvi-opened-above-the-isolation-drop(lines:${opened% })"; fi
verdict L1.isolation rvi-to-rvi-isolation-drop-present "$fails" "DOCKER-USER drops -i rvi+ -o rvi+ that is not bridged, at line ${at_isolation:-?}"

# ---- TS-L1 (Docker is new enough): CVE-2024-29018, an internal network's containers could have DNS queries forwarded out by the daemon; fixed in Moby 26.0.0, 25.0.4 and 23.0.11 (reported by the NVD mirrors and distro trackers; the upstream advisory itself was not reachable when this was written, so confirm it). 24.x has no fix.
fails=""
version=""
if have_docker; then version=$(dk version --format '{{.Server.Version}}' 2>/dev/null || true); fi
if [[ -z "$version" ]]; then fails="docker-version-unreadable"
else
  major=${version%%.*}
  if [[ "$major" == 24 ]]; then fails="docker-$version-has-no-fix-for-CVE-2024-29018"
  elif ! { version_at_least "$version" 26.0.0 || { [[ "$major" == 25 ]] && version_at_least "$version" 25.0.4; } || { [[ "$major" == 23 ]] && version_at_least "$version" 23.0.11; }; }; then fails="docker-$version-older-than-the-CVE-2024-29018-fix"; fi
fi
verdict L1.docker-version docker-has-the-CVE-2024-29018-fix "$fails" "Docker Engine ${version:-?}"

# ---- TS-L1 (one firewall, Docker's and ours): our rules are only effective if Docker puts its chains into the SAME iptables the boot firewall writes to. On Amazon Linux 2023 that is the iptables-nft front end (iptables v1.8.x (nf_tables)), which Docker also uses and which
# supports the physdev match, so the backend's name is no requirement; what matters is that this iptables lists Docker's chains and the FORWARD jump into DOCKER-USER (if Docker used the other backend they would not be listed here).
fails=""
backend=$(iptables --version 2>/dev/null || true)
[[ -n "$backend" ]] || fails="$fails no-iptables"
printf '%s\n' "$ALL_RULES" | grep -qx -e '-N DOCKER-USER' || fails="$fails no-DOCKER-USER-chain-in-this-iptables"
printf '%s\n' "$ALL_RULES" | grep -qx -e '-A FORWARD -j DOCKER-USER' || fails="$fails FORWARD-does-not-jump-to-DOCKER-USER"
printf '%s\n' "$ALL_RULES" | grep -qx -e '-N DOCKER' -e '-N DOCKER-ISOLATION-STAGE-1' -e '-N DOCKER-FORWARD' || fails="$fails no-docker-chain-in-this-iptables"
verdict L1.iptables-backend docker-and-boot-firewall-share-one-iptables "${fails# }" "${backend:-no iptables}: Docker's chains and the FORWARD jump to DOCKER-USER are listed by this iptables"

# ---- TS-L1 (Docker's own drops for an internal network): for a run network that exists now, Docker's isolation chains hold DROP rules that name its bridge. Needs a live run network, so an idle worker reports PENDING.
fails=""
checked=0
if have_docker; then
  for id in $(dk network ls -q --filter "label=$FAMILY_LABEL" 2>/dev/null); do
    bridge=$(dk network inspect --format '{{index .Options "com.docker.network.bridge.name"}}' "$id" 2>/dev/null || true)
    [[ "$bridge" =~ ^rvi[0-9a-f]{8}$ ]] || { fails="$fails network-$id-has-no-rvi-bridge"; continue; }
    checked=$((checked + 1))
    drops=$(printf '%s\n' "$ALL_RULES" | grep -v -e '^-A DOCKER-USER ' -e '^-A INPUT ' | grep -c -e "-[io] $bridge .*-j DROP" -e "-j DROP.*-[io] $bridge" || true)
    (( drops >= 1 )) || fails="$fails no-docker-internal-drop-for-$bridge"
  done
else fails="no-docker"; fi
if [[ -n "$fails" ]]; then emit L1.internal-drops FAIL docker-internal-network-drops-present "${fails# }"
elif (( checked == 0 )); then pending L1.internal-drops docker-internal-network-drops-present "no run network exists now; start one and check that Docker's isolation chains drop traffic into and out of its bridge"
else emit L1.internal-drops PASS docker-internal-network-drops-present "$checked run network(s) with Docker drop rules naming their bridge"; fi
live_line L1.live helper-reachable-internet-not "start two throwaway run networks with a helper and a sandbox each: the sandbox reaches the helper on its port; neither reaches a public address, a private range, the metadata address or the gateway"
live_line L1.live-other-run another-runs-helper-unreachable "a sandbox on the first run network cannot reach the second one's helper or sandbox, in either direction, while it still reaches its own helper"

# ---- TS-L1/L2 precondition: the run network's range (172.30.0.0/16) is free on this host, apart from rvi* run networks themselves.
fails=""
routes=$(ip -4 route show 2>/dev/null || true)
while read -r line; do
  [[ -n "$line" ]] || continue
  case "$line" in "${RANGE_PREFIX}"*) case "$line" in *" dev rvi"*) ;; *) fails="$fails route(${line%% *})" ;; esac ;; esac
done <<< "$routes"
if have_docker; then
  family=" $(dk network ls -q --filter "label=$FAMILY_LABEL" 2>/dev/null | tr '\n' ' ')"
  for id in $(dk network ls -q 2>/dev/null); do
    subnets=$(dk network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$id" 2>/dev/null || true)
    case " $subnets" in *" ${RANGE_PREFIX}"*) case "$family" in *" $id "*) ;; *) fails="$fails docker-network($id)" ;; esac ;; esac
  done
else fails="$fails no-docker"; fi
verdict L1.range range-172.30-free "${fails# }" "no route and no Docker network outside the run family uses ${RANGE_PREFIX}0.0/16"

# ---- TS-L1 (Docker cannot take the reserved ranges itself): daemon.json sets default-address-pools, and none of them overlaps 172.29/16 (setup runs), 172.30/16 (run networks), 172.17/16 (docker0) or the VPC's 10.42/16.
fails=""
daemon=$(tr -d ' \n\t' < "$DAEMON_JSON" 2>/dev/null || true)
case "$daemon" in
  *'"default-address-pools":['*)
    count=0
    for base in $(printf '%s' "$daemon" | grep -o '"base":"[0-9./]*"' | sed 's/"base":"\(.*\)"/\1/'); do
      count=$((count + 1))
      [[ "$base" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] || { fails="$fails bad-pool($base)"; continue; }
      for reserved in 172.29.0.0/16 172.30.0.0/16 172.17.0.0/16 10.42.0.0/16; do cidr_overlaps "$base" "$reserved" && fails="$fails pool($base)-overlaps-$reserved"; done
    done
    (( count > 0 )) || fails="$fails no-pool-bases" ;;
  *) fails="no-default-address-pools-in-$DAEMON_JSON" ;;
esac
verdict L1.pools docker-address-pools-leave-reserved-ranges-alone "${fails# }" "default-address-pools in $DAEMON_JSON overlap none of 172.29/16, 172.30/16, 172.17/16, 10.42/16"

# ---- TS-L2: the dual-homed working sandbox resolves run aliases and allowed public names; the helpers cannot use the sandbox as a route.
fails=""
if have_docker; then
  internal=$(dk network inspect --format '{{.Internal}}' agentx-task 2>/dev/null || true)
  [[ "$internal" == false ]] || fails="$fails agentx-task-internal=${internal:-missing}"
else fails="no-docker"; fi
verdict L2.egress-network working-egress-network-has-a-way-out "${fails# }" "agentx-task is not an internal network (the working sandbox's second leg)"
live_line L2.live dual-homed-sandbox "a sandbox on agentx-task and the services network resolves run aliases and an allowed public name; a helper cannot send traffic through the sandbox or reach the working network"

# ---- TS-L3: the sealed check sandbox with a run-owned resolv.conf reaches only the DNS helper, the run's names and the proxy.
live_line L3.live sealed-sandbox-reaches-only-the-run "a sealed sandbox on the services network alone with the run-owned resolv.conf: a run name resolves, an unknown name goes to the sinkhole, an IP literal on the internet fails"
# The reviewer's TS-L3 list (TS16 review, 2026-11-03; also in the header of packages/worker/src/check-sandbox.ts). Each is a live probe from inside the sealed check sandbox (.4) of a throwaway run network, after
# detachWorkingSandbox() has taken the working sandbox (.3) off it.
fails=""
nat_rules=$(iptables -t nat -S 2>/dev/null || true)
printf '%s\n' "$nat_rules" | grep -q -e '-[io] rvi' -e '172\.30\.' && fails="host-nat-table-names-an-rvi-bridge-or-172.30"
live_line L3.embedded-resolver docker-embedded-resolver-and-dnat "the sandbox's resolv.conf names the DNS helper alone and a query to 127.0.0.11 gets no answer; the host's nat table holds no rule for an rvi bridge" "$fails"
live_line L3.working-relay working-sandbox-relay-is-gone "with a listener started in the working sandbox BEFORE the detach, a connection from .4 to .3 fails and the network lists only .2, the helpers and .4"
fails=""
if command -v ip6tables >/dev/null && ip6tables -S INPUT >/dev/null 2>&1; then
  ip6tables -S INPUT 2>/dev/null | grep -qx -e '-A INPUT -i rvi+ -j DROP' || fails="no-ip6tables-INPUT-drop-for-rvi"
elif [[ -e /proc/net/if_inet6 && "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null)" != 1 ]]; then fails="ipv6-active-and-ip6tables-unusable"; fi
live_line L3.ipv6 no-ipv6-in-or-out "inside the sandbox: no global IPv6 address, no IPv6 route, an IPv6 connection to a public address fails; on the host: ip6tables drops INPUT from rvi+ (TS-SEAL-2, boot-stage2.sh)" "$fails"
live_line L3.no-route no-default-route-8888-metadata-gateway "inside the sandbox: no default route; connections to 8.8.8.8 (53 and 443), 169.254.169.254 and the gateway fail"
live_line L3.other-run another-run-unreachable "with a second run network up: the other run's helper and sandbox cannot be reached from .4"
live_line L3.multicast multicast-and-broadcast-stay-on-the-bridge "a send to 224.0.0.251, 239.255.255.250 and the /24 broadcast is heard by no listener on another run's bridge or on Docker's default bridge"
live_line L3.run-files run-files-not-writable-through-workspace "writing /etc/resolv.conf and /etc/hosts from the sandbox is denied, and resolv.conf still names the DNS helper alone"
live_line L3.spoofing helper-ignores-spoofed-and-neighbour-sources "a query from .3 and from a neighbour at .20 gets no answer and is not recorded (a forged .4 source can only add a name blindly: TS-SEAL-4, accepted)"

# ---- TS-L4: Postgres and MySQL start as non-root with no capabilities on tmpfs.
live_line L4.live helpers-start-non-root "start the catalog's Postgres image (slice 1: Postgres only, MySQL later) with the hardening profile: non-root, no capability, read-only root, tmpfs data, and it reaches health"
live_line L4.template-db template-db-reset-keeps-seeds "TS-RUN-3: after the seeds, a change is undone by the template_db reset and the seeded row is still there (the official image's local-socket trust)"

# ---- TS-L5: the proxy's egress bridge reaches only allowed names through the DNS firewall, and a private range fails.
# Read-only part: the rvb* walls the proxy's egress bridge relies on are present for every private range.
fails=""
for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8; do
  [[ -n "$(rule_at DOCKER-USER "$DOCKER_USER" "-i rvb+|-d $range|-j DROP")" ]] || fails="$fails no-rvb-drop-for-$range"
done
verdict L5.walls rvb-private-range-drops-present "${fails# }" "rvb+ drops for the six private, link-local and loopback ranges"
pending L5.live proxy-egress-reaches-allowed-names-only "start a throwaway rvb<hex> bridge with a probe: an allowed name through the DNS firewall resolves and connects, 10.x and 169.254.169.254 fail"

# ---- TS-L6: stale-run sweeps remove the networks and helpers of a killed worker.
# Read-only part: no object of the run family is left over on an idle worker.
fails=""
if have_docker; then
  left_c=$(dk ps -a -q --filter "label=$FAMILY_LABEL" 2>/dev/null | wc -l | tr -d ' ')
  left_n=$(dk network ls -q --filter "label=$FAMILY_LABEL" 2>/dev/null | wc -l | tr -d ' ')
  [[ "$left_c" == 0 ]] || fails="$fails containers=$left_c"
  [[ "$left_n" == 0 ]] || fails="$fails networks=$left_n"
else fails="no-docker"; fi
verdict L6.no-leftovers no-run-network-leftovers-on-an-idle-worker "${fails# }" "no container and no network carries the $FAMILY_LABEL label"
live_line L6.live killed-worker-sweep "start a run network with a helper, leave it as a killed worker does, run the worker-start sweep: the helper and network are gone"

# ---- TS-L7: the emulator image on a worker-class Linux instance: start time, idle and peak memory, and the memory limit holds.
mem_kb=$(awk '$1=="MemTotal:"{print $2}' /proc/meminfo 2>/dev/null || true)
if [[ -n "$mem_kb" ]]; then emit L7.host PASS host-memory-readable "MemTotal ${mem_kb} kB (the measured peak of the emulator is judged against this and the run cap services.maxMemMiB)"; else emit L7.host FAIL host-memory-readable "could not read /proc/meminfo"; fi
pending L7.live emulator-start-and-memory "run the Rovara local AWS image under its memory limit through a 1,000-call suite: start at most 0.5 s, idle at most 64 MB, peak at most 128 MB, median call at most 3 ms, and the limit holds"

# ---- TS-L8: a function runs as a process in its sandbox, cannot reach anything but the run's services network, and the emulator container holds no Docker socket.
# Read-only part: no running container of the run family has the Docker socket mounted.
fails=""
if have_docker; then
  for id in $(dk ps -q --filter "label=$FAMILY_LABEL" 2>/dev/null); do
    mounts=$(dk inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$id" 2>/dev/null || true)
    case "$mounts" in *docker.sock*) fails="$fails docker-socket-in-$id" ;; esac
  done
else fails="no-docker"; fi
verdict L8.no-socket no-docker-socket-in-run-containers "${fails# }" "no running container of the run family mounts docker.sock"
pending L8.live function-runs-as-a-process "start the function runner against the emulator: the function runs as a process, reaches only the services network, and the emulator container holds no Docker socket and no capability"

printf 'TSL SUMMARY pass=%s fail=%s pending=%s\n' "$PASS" "$FAIL" "$PENDING"
if [[ $FAIL -gt 0 ]]; then exit 1; fi
if [[ $PENDING -gt 0 ]]; then exit 3; fi
exit 0
