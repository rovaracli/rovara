#!/bin/bash
# TS-L1 to TS-L8: the Linux checks for test services (switch `tx`; design test-services.md section 12/13; task TS37). Deferred checks: they must pass on linux-runtime or a staging worker before `tx` is turned on.
# THIS IS A SKELETON. Nothing here has been run against a real worker yet. It does the READ-ONLY part of each check now (the host's firewall rules, Docker's inventory, address-range use, leftovers) and prints
# PENDING for the part that needs a throwaway run network, helper or probe container, which the full version adds once the run layer (TS14 helper launcher, TS16 sealed sandbox) exists. A PENDING line is
# never a pass: `tx` stays off until every line is PASS.
#
# WHAT IT DOES. READ-ONLY: it reads iptables, interfaces, routes, Docker's inventory (ps, network ls, network inspect, info) and /proc/meminfo, and changes none of them. It starts no container, makes no network,
# writes no file, uses no AWS access and reads no secret. It never prints an environment variable.
#
# OUTPUT. One line per check part, then a summary:
#   TSL <id> PASS|FAIL|PENDING <check_name> | <one line of evidence>
#   TSL SUMMARY pass=<p> fail=<f> pending=<n>
# Exit status 0 only when every line is PASS; 1 when any line is FAIL; 3 when none failed but some are PENDING (the skeleton always ends here until the live parts exist).
#
# HOW AN OPERATOR RUNS IT ON A STAGING WORKER THROUGH SSM, like scripts/staging-checks/setup-agent-su1.sh. Every AWS command goes through the staging guard (account 944937319445, us-west-2) and nothing else; run from
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

DOCKER=$(cat /etc/agentx/docker-path 2>/dev/null || true)
[[ "$DOCKER" == /* && -x "$DOCKER" ]] || DOCKER=$(command -v docker || true)
have_docker() { [[ -n "$DOCKER" && -x "$DOCKER" ]]; }
dk() { "$DOCKER" "$@"; }

# The run network's labels and ranges (packages/worker/src/run-network.ts). Keep in step with it.
FAMILY_LABEL=rovara.run-network
RANGE_PREFIX=172.30.

# the line number of the first rule of chain $1 in rules text $2 that holds every |-separated token of $3 (iptables writes the options of a rule in its own order)
rule_at() { printf '%s\n' "$2" | awk -v chain="$1" -v toks="$3" 'BEGIN{n=split(toks,t,"|")} index($0,"-A " chain " ")==1{ok=1; for(i=1;i<=n;i++) if(index($0,t[i])==0){ok=0;break} if(ok){print NR; exit}}'; }
# the line numbers of rules of chain $1 in $2, before line $3, that accept or return traffic from an rvi bridge: such a rule above the DROP would hide it
rvi_opened_before() { printf '%s\n' "$2" | awk -v chain="$1" -v upto="$3" 'index($0,"-A " chain " ")==1 && NR<upto && index($0,"-i rvi")!=0 && $0 ~ /-j (ACCEPT|RETURN)( |$)/{printf "%s ", NR}'; }

DOCKER_USER=$(iptables -S DOCKER-USER 2>/dev/null || true)
INPUT_RULES=$(iptables -S INPUT 2>/dev/null || true)

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
pending L1.live helper-reachable-internet-not "start a throwaway run network (rvi<hex>, --internal) with a helper and a sandbox; the sandbox reaches the helper on its port, the helper reaches no public address, no private range and not the gateway"

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

# ---- TS-L2: the dual-homed working sandbox resolves run aliases and allowed public names; the helpers cannot use the sandbox as a route.
fails=""
if have_docker; then
  internal=$(dk network inspect --format '{{.Internal}}' agentx-task 2>/dev/null || true)
  [[ "$internal" == false ]] || fails="$fails agentx-task-internal=${internal:-missing}"
else fails="no-docker"; fi
verdict L2.egress-network working-egress-network-has-a-way-out "${fails# }" "agentx-task is not an internal network (the working sandbox's second leg)"
pending L2.live dual-homed-sandbox "start a sandbox on both networks: run aliases resolve on the services network, an allowed public name resolves, and a helper cannot send traffic through the sandbox to the working network"

# ---- TS-L3: the sealed check sandbox with a run-owned resolv.conf reaches only the DNS helper, the run's names and the proxy.
pending L3.live sealed-sandbox-reaches-only-the-run "start a sandbox on the services network alone with a read-only resolv.conf naming the DNS helper: a run name resolves, an unknown name goes to the sinkhole, an IP literal on the internet fails"

# ---- TS-L4: Postgres and MySQL start as non-root with no capabilities on tmpfs.
pending L4.live helpers-start-non-root "start the catalog's Postgres and MySQL images with the hardening profile (non-root user, --cap-drop ALL, read-only, tmpfs data): both reach health"

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
pending L6.live killed-worker-sweep "start a run network with a helper, kill the worker without a stop, restart it: the helper and network are gone after the next allocation's sweep and the slot is taken again by the next run"

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
