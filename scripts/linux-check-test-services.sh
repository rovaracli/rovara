#!/bin/bash
# TS-L1 to TS-L8: the Linux checks for test services (switch `tx`; design test-services.md section 12/13; task TS37). Deferred checks: they must pass on linux-runtime or a staging worker before `tx` is turned on.
# THIS IS A SKELETON. Nothing here has been run against a real worker yet. It does the READ-ONLY part of each check now (the host's firewall rules, Docker's inventory, address-range use, leftovers) and prints
# PENDING for the part that needs a throwaway run network, helper or probe container, which the full version adds once the run layer (TS14 helper launcher, TS16 sealed sandbox) exists. A PENDING line is
# never a pass: `tx` stays off until every line is PASS.
#
# WHAT IT DOES. READ-ONLY: it reads iptables, interfaces, routes, /etc/docker/daemon.json, Docker's inventory (ps, network ls, network inspect, inspect, version) and /proc/meminfo, and changes none of them. It starts no container, makes no network,
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
ALL_RULES=$(iptables -S 2>/dev/null || true)
DAEMON_JSON=/etc/docker/daemon.json

# bash CIDR helpers: cidr_overlaps A B is true when the two ranges share an address
to_int() { local IFS=.; set -- $1; echo $(( ($1 << 24) + ($2 << 16) + ($3 << 8) + $4 )); }
cidr_overlaps() { local ai ap bi bp p mask; ai=$(to_int "${1%/*}"); ap=${1#*/}; bi=$(to_int "${2%/*}"); bp=${2#*/}; p=$(( ap < bp ? ap : bp )); mask=$(( (0xffffffff << (32 - p)) & 0xffffffff )); [[ $(( ai & mask )) -eq $(( bi & mask )) ]]; }
# version_at_least A B: dotted version A >= B (numeric parts only)
version_at_least() { local IFS=.; local -a a=($1) b=($2); local i; for i in 0 1 2; do local x=${a[i]:-0} y=${b[i]:-0}; x=${x//[!0-9]/}; y=${y//[!0-9]/}; if (( ${x:-0} > ${y:-0} )); then return 0; fi; if (( ${x:-0} < ${y:-0} )); then return 1; fi; done; return 0; }

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
pending L1.live helper-reachable-internet-not "start a throwaway run network (rvi<hex>, --internal) with a helper and a sandbox; the sandbox reaches the helper on its port, the helper reaches no public address, no private range and not the gateway"
pending L1.live-other-run another-runs-helper-unreachable "start two throwaway run networks with a helper each: a sandbox on the first cannot reach the second's helper (by address or through the gateway), in either direction, while it still reaches its own"

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
pending L2.live dual-homed-sandbox "start a sandbox on both networks: run aliases resolve on the services network, an allowed public name resolves, and a helper cannot send traffic through the sandbox to the working network"

# ---- TS-L3: the sealed check sandbox with a run-owned resolv.conf reaches only the DNS helper, the run's names and the proxy.
pending L3.live sealed-sandbox-reaches-only-the-run "start a sandbox on the services network alone with a read-only resolv.conf naming the DNS helper: a run name resolves, an unknown name goes to the sinkhole, an IP literal on the internet fails"
# The reviewer's TS-L3 list (TS16 review, 2026-11-03; also in the header of packages/worker/src/check-sandbox.ts). Each is a live probe from inside the sealed check sandbox (.4) of a throwaway run network, after
# detachWorkingSandbox() has taken the working sandbox (.3) off it.
pending L3.embedded-resolver docker-embedded-resolver-and-dnat "the sandbox's resolv.conf names the DNS helper alone: a query to 127.0.0.11 gets no answer, and 'iptables -t nat' on the host holds no DNAT rule for the run bridge's embedded resolver ports"
pending L3.working-relay working-sandbox-relay-is-gone "with a listener (nc -l) started in the working sandbox BEFORE the detach and another bound to .3 afterwards: a connection from .4 to .3 on that port fails, 'docker network inspect' lists only .2, the helpers and .4, and startCheckSandbox refuses while the working sandbox is still attached"
pending L3.ipv6 no-ipv6-in-or-out "inside the sandbox: no router advertisement gives an address or a route (sysctl accept_ra=0 or no RA seen with tcpdump), no global IPv6 address, an IPv6 connection to a public address fails; on the host: boot.sh's ip6tables INPUT rule drops the run bridge (review L4 is outside this lane; see DEFERRED-CHECKS)"
pending L3.no-route no-default-route-8888-metadata-gateway "inside the sandbox: 'ip route' shows only the run's /24; connections to 8.8.8.8 (53 and 443), 169.254.169.254 and the gateway .1 (every port) fail"
pending L3.other-run another-run-unreachable "with a second run network up: the other run's helpers, sandboxes and DNS helper cannot be reached from .4, by address or by name"
pending L3.multicast multicast-and-broadcast-stay-on-the-bridge "inside the sandbox: a send to 224.0.0.251, 239.255.255.250 and the /24 broadcast reaches nothing outside the run (tcpdump on the host's uplink sees none of it)"
pending L3.run-files run-files-not-writable-through-workspace "resolv.conf and hosts are outside the workspace root or under a masked path: from inside the sandbox, writing through the workspace to the host path fails, and 'cat /etc/resolv.conf' still names .2 alone after the attempt"
pending L3.spoofing helper-ignores-spoofed-and-neighbour-sources "a query from .3 (detached working sandbox re-attached for the probe) and from a helper at .16 gets no answer and is not recorded; a forged source .4 sent with IP_FREEBIND from a neighbour can only add a name to the record (blind), and no reply reaches the sender"

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
