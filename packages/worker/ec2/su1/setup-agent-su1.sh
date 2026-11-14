#!/bin/bash
# SU-1 Linux checks 1-11 for the setup agent (switch `su`), to be run ON A STAGING WORKER. Deferred check SU-1 in the Plan 5 ledger (DEFERRED-CHECKS.md); the list is the one headed
# "SU-1 linux checks, updated (2026-11-02, Opus re-check of a03cd010d)" (checks 1-10) plus check 11 from "SU-1 addendum (2026-11-02)" (public-IP egress). Nothing here has been run against a real worker yet.
#
# WHAT IT DOES. READ-ONLY on the worker: it reads iptables, sysctls, interfaces, Docker's inventory and the worker's own settings files, and it changes none of them. The ONE thing it starts is what SU-1 describes:
# two throwaway setup-run networks (a /24 each, bridge rvbs<slot> with the same flags the worker uses, slots chosen from 230-250 that nothing holds), a DNS-watch helper on each (the worker's own image and the same
# flags as `helperRunArgs` in packages/worker/src/setup-network.ts) and short-lived probe containers on them (the worker image, node only, no capability, read-only, no mounts). Everything it starts carries the label
# agentx.su1-check=<run id> (never the worker's own agentx.setup-run labels, so the worker's leftover sweep neither removes nor counts them) and is removed on exit, also on an error or an interrupt; at its start it also
# removes anything still carrying the bare label key agentx.su1-check, which an earlier run killed before its cleanup left behind. The script itself writes one empty root-only lock file (/run/lock/agentx-su1-check.lock, taken with flock so a second copy refuses to start and cannot sweep the first one's objects); the delivery commands built by
# setup-agent-su1-report.ts --ssm-params put it into a root-only directory made with mktemp under /var/tmp and remove that directory when it ends. It sends nothing outside the host except the probes' DNS queries and
# TCP/TLS attempts. It uses no AWS access at all, and no secret: the one value it reads from /etc/agentx/worker.env is the sandbox image name.
#
# OUTPUT. One line per check, then a summary:
#   SU1 <n> PASS|FAIL <check_name> | <one line of evidence>
#   SU1 SUMMARY pass=<p> fail=<f> total=11 ...
# Exit status 0 only if all 11 are PASS. Checks 9 and 10 need a real model-driven setup run, which this read-only script does not start; they print FAIL here and are judged by setup-agent-su1-report.ts from the
# answer of a run the operator starts in the app (see below). Parse a transcript with: npx tsx scripts/staging-checks/setup-agent-su1-report.ts --output <file> [--evidence9 <file>] [--evidence10 <file> --stale-marker <marker>] [--turn-cents <n>].
#
# HOW AN OPERATOR RUNS IT ON A STAGING WORKER THROUGH SSM. Every AWS command goes through the staging guard (account 944937319445, us-west-2) and nothing else; run from the repository root on the Mac, on an
# IDLE worker (check 7 compares the verifier bridges' counters, so no verifier run may be live on it):
#   STAGING=$HOME/.local/share/rovara-tools/staging-aws.sh
#   1. find the worker (a running EC2 instance whose Name tag ends in -worker; take one that is an SSM managed node):
#        $STAGING aws ec2 describe-instances --filters Name=tag:Name,Values='*-worker' Name=instance-state-name,Values=running --query 'Reservations[].Instances[].[InstanceId,Tags[?Key==`Name`]|[0].Value]' --output text
#        $STAGING aws ssm describe-instance-information --query 'InstanceInformationList[].InstanceId' --output text    # the instance id must be listed; if it is not, stop: there is no other way in
#   2. build the command parameters (the script, base64 in short pieces, then the run) and send them (AWS-RunShellScript runs as root):
#        npx tsx scripts/staging-checks/setup-agent-su1-report.ts --ssm-params > "$TMPDIR/su1-params.json"
#        $STAGING aws ssm send-command --instance-ids <instance-id> --document-name AWS-RunShellScript --comment su1-linux-checks --timeout-seconds 900 --parameters file://"$TMPDIR/su1-params.json" --query Command.CommandId --output text
#      (to repeat check 2 after a Docker restart or a host restart, use `--ssm-params --script-args '--expect-docker-user-sha <sha printed by the first run>'`. For the full check 8: first run the script once while
#       a setup run is live in the app on two workspaces; its check 8 line lists each setup network with its workspace label and slot. Kill the worker's container for ONE of them (a separate send-command by the
#       operator, never this script), let the worker restart, then run with `--script-args '--expect-no-leftovers-for <killed workspace label> --expect-survivor <the other run's network name> --expect-slot-free <killed slot>'`:
#       the killed run's helper and network must be gone, the other run's helper must still run, and the killed slot must be free and is then taken by this script's own first throwaway run, which shows it is reused.)
#   3. read the answer (the output is kept under 24,000 characters, the most SSM returns):
#        $STAGING aws ssm get-command-invocation --command-id <command-id> --instance-id <instance-id> --query '[Status,StandardOutputContent]' --output text > "$TMPDIR/su1-out.txt"
#   4. the report (prints one PASS or FAIL per check 1-11 and exits non-zero unless all pass):
#        npx tsx scripts/staging-checks/setup-agent-su1-report.ts --output "$TMPDIR/su1-out.txt"
# CHECKS 9 AND 10 (the operator starts a throwaway setup run in the app on a staging project whose model is routed through the model proxy, then reads the answer with its own staging API token; the token is never
# pasted into a command or a file): 9 - set the project's setup budget to 50 cents (Setup limits), start the run, steer it to run a command with a large output (for example `yes | head -c 5000000`) and let it hit the
# budget; save `GET /v1/app/projects/<name>/setup-agent` as evidence9.json and pass --evidence9 (the run must end budget_used, with a counted spend above 0 and at most one turn over: --turn-cents, default 50).
# 10 - in the same or another run, have the run write an untracked kalmius/project.json in the importer's real format (packages/worker/src/setup-scan.ts importProjectFile), with commands that carry a marker only
# this file holds. As a person's command in the run (REPO is the project's repository name, as the setup screen shows it):
#       M=su1-stale-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n'); echo "$M"; mkdir -p kalmius && printf '{\n "setup": {"REPO": ["echo %s"]},\n "tests": {"REPO": ["echo %s-test"]}\n}\n' "$M" "$M" > kalmius/project.json
# (the echoed marker is the one to pass); let the run finish with a proposal, save the answer as evidence10.json and pass --evidence10 evidence10.json --stale-marker <the marker>. The judge fails if the proposal
# holds the marker or the path anywhere. Both checks read the answer only; nothing else of that run is touched.
#
# NOT COVERED (it cannot be done read-only): the "without Docker isolation chains" variant of check 4 (the rule that lets only port 53 of 172.29.0.0/16 through is checked present and ordered in check 2, and
# the second run's helper is probed with the chains in place), a REFUSED answer from the real DNS firewall (check 5 compares NXDOMAIN, which the helper relays the same way), the reboot and the Docker restart in
# check 2 and the kill in check 8 (the operator does them; the checks read the state afterwards).
set -u
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Total wall-clock cap, INCLUDING cleanup and the final KILL grace. Decimal
# seconds only: SU1_TIMEOUT_SECONDS defaults to 300 (10..900), and
# SU1_DOCKER_TIMEOUT_SECONDS defaults to 60 (1..60). Invalid values exit 2.
# An overall timeout exits 124 (TERM) or 137 (KILL); ordinary exits are unchanged.
# The last eight seconds are reserved: six for best-effort cleanup, one for
# an inner TERM->KILL, and one for the supervisor's final KILL. A hard kill
# may leave Docker objects (not clients); the next run's label sweep repairs
# them. No extra files are created. Both timeout layers stay in the caller's
# process group so an outer group TERM/KILL reaches every child.
SU1_TIMEOUT_SECONDS=${SU1_TIMEOUT_SECONDS-300}
SU1_DOCKER_TIMEOUT_SECONDS=${SU1_DOCKER_TIMEOUT_SECONDS-60}
if [[ ! "$SU1_TIMEOUT_SECONDS" =~ ^[1-9][0-9]{0,2}$ ]] ||
   [[ $SU1_TIMEOUT_SECONDS -lt 10 || $SU1_TIMEOUT_SECONDS -gt 900 ]]; then
  printf 'SU1 ERROR SU1_TIMEOUT_SECONDS wants seconds from 10 to 900\n'; exit 2
fi
if [[ ! "$SU1_DOCKER_TIMEOUT_SECONDS" =~ ^[1-9][0-9]?$ ]] ||
   [[ $SU1_DOCKER_TIMEOUT_SECONDS -gt 60 ]]; then
  printf 'SU1 ERROR SU1_DOCKER_TIMEOUT_SECONDS wants seconds from 1 to 60\n'; exit 2
fi
export SU1_TIMEOUT_SECONDS SU1_DOCKER_TIMEOUT_SECONDS

# Export one function rather than re-entering through a caller-set environment
# marker (which could accidentally bypass the supervisor). No new session or
# process group is created, and the original arguments/exit status are kept.
su1_main() {
set -u
SU1_END=$((SECONDS + SU1_TIMEOUT_SECONDS - 2))
SU1_CLEANING=0

dk() {
  local remaining=$((SU1_END - SECONDS - 1)) limit=$SU1_DOCKER_TIMEOUT_SECONDS
  # Cleanup shares the hard deadline but can spend the reserved six seconds.
  if [[ $SU1_CLEANING -eq 0 ]]; then remaining=$((remaining - 6)); fi
  [[ $remaining -gt 0 ]] || return 124
  (( limit <= remaining )) || limit=$remaining
  timeout --foreground --kill-after=1 "$limit" "$DOCKER" "$@"
}

EXPECT_SHA=""
EXPECT_LEFT_WS=""
EXPECT_SURVIVOR=""
EXPECT_SLOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-docker-user-sha) EXPECT_SHA="${2:-}"; shift 2 ;;
    --expect-no-leftovers-for) EXPECT_LEFT_WS="${2:-}"; shift 2 ;;
    --expect-survivor) EXPECT_SURVIVOR="${2:-}"; shift 2 ;;
    --expect-slot-free) EXPECT_SLOT="${2:-}"; shift 2 ;;
    *) printf 'SU1 ERROR unknown argument %s\n' "$1"; exit 2 ;;
  esac
done
[[ -z "$EXPECT_SHA" || "$EXPECT_SHA" =~ ^[a-f0-9]{64}$ ]] || { printf 'SU1 ERROR --expect-docker-user-sha wants 64 hex digits\n'; exit 2; }
[[ -z "$EXPECT_LEFT_WS" || "$EXPECT_LEFT_WS" =~ ^[A-Za-z0-9_.:/-]{1,128}$ ]] || { printf 'SU1 ERROR --expect-no-leftovers-for wants a workspace label\n'; exit 2; }
[[ -z "$EXPECT_SURVIVOR" || "$EXPECT_SURVIVOR" =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || { printf 'SU1 ERROR --expect-survivor wants a network name\n'; exit 2; }
[[ -z "$EXPECT_SLOT" || "$EXPECT_SLOT" =~ ^([1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-3])$ ]] || { printf 'SU1 ERROR --expect-slot-free wants a slot from 1 to 253\n'; exit 2; }

PASS=0; FAIL=0
emit() { # emit <n> <PASS|FAIL> <name> <detail>
  local detail
  detail=$(printf '%s' "$4" | tr '\r\n\t' '   ' | cut -c1-400)
  printf 'SU1 %s %s %s | %s\n' "$1" "$2" "$3" "$detail"
  if [[ "$2" == PASS ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
}
verdict() { # verdict <n> <name> <failures-string> <pass-detail>
  if [[ -z "$3" ]]; then emit "$1" PASS "$2" "$4"; else emit "$1" FAIL "$2" "$3"; fi
}

RUN=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
SU1_LABEL="agentx.su1-check=$RUN"
DOCKER=$(cat /etc/agentx/docker-path 2>/dev/null || true)
[[ "$DOCKER" == /* && -x "$DOCKER" ]] || DOCKER=$(command -v docker || true)
WORKER_IMAGE=$(cat /etc/agentx/worker-image 2>/dev/null || true)
SANDBOX_IMAGE=$(sed -n 's/^AGENTX_SANDBOX_IMAGE=//p' /etc/agentx/worker.env 2>/dev/null | head -1)
NODE=/usr/local/bin/node
HELPER_ENTRY=/opt/agentx/packages/worker/dist/setup-dns-watch-helper.js
PUBLIC_NAME=registry.npmjs.org
NX_NAME="su1-$RUN.invalid"

# ---- the probe: a node program run in a throwaway container; prints one line per test. Its text is also run by tests/unit/staging-su1-report.test.ts against a local stub (nothing else of this file is).
read -r -d '' PROBE_JS <<'PROBE_END'
const dgram=require('dgram'),net=require('net'),tls=require('tls'),fs=require('fs'),dns=require('dns');
const cfg=JSON.parse(process.argv[1]);
const enc=(name,id)=>{const b=[Buffer.from([id>>8,id&255,1,0,0,1,0,0,0,0,0,0])];for(const p of name.split('.')){b.push(Buffer.from([p.length]),Buffer.from(p));}b.push(Buffer.from([0,0,1,0,1]));return Buffer.concat(b);};
const dec=(m)=>({rcode:m.readUInt16BE(2)&15,an:m.readUInt16BE(6)});
const fmt=(l,s,x)=>l+' '+s+(x?' '+x:'');
const udpq=(t)=>new Promise(res=>{const s=dgram.createSocket('udp4');let done=false;const end=(v)=>{if(done)return;done=true;clearTimeout(timer);try{s.close();}catch(e){}res(v);};const timer=setTimeout(()=>end(fmt(t.label,'timeout')),t.ms||3000);s.on('message',(m)=>{try{const d=dec(m);end(fmt(t.label,'answer','rcode='+d.rcode+' an='+d.an));}catch(e){end(fmt(t.label,'bad'));}});s.on('error',(e)=>end(fmt(t.label,e.code||'error')));s.send(enc(t.name,4660),t.port||53,t.host,(e)=>{if(e)end(fmt(t.label,e.code||'error'));});});
const tcpq=(t)=>new Promise(res=>{let done=false,buf=Buffer.alloc(0);const s=net.connect({host:t.host,port:t.port||53});const end=(v)=>{if(done)return;done=true;clearTimeout(timer);s.destroy();res(v);};const timer=setTimeout(()=>end(fmt(t.label,'timeout')),t.ms||3000);s.on('connect',()=>{const q=enc(t.name,4661);const h=Buffer.alloc(2);h.writeUInt16BE(q.length);s.write(Buffer.concat([h,q]));});s.on('data',(d)=>{buf=Buffer.concat([buf,d]);if(buf.length>=2&&buf.length>=2+buf.readUInt16BE(0)){try{const x=dec(buf.subarray(2));end(fmt(t.label,'answer','rcode='+x.rcode+' an='+x.an));}catch(e){end(fmt(t.label,'bad'));}}});s.on('error',(e)=>end(fmt(t.label,e.code||'error')));s.on('close',()=>end(fmt(t.label,'closed')));});
const conn=(t)=>new Promise(res=>{let done=false;const s=net.connect({host:t.host,port:t.port});const end=(v)=>{if(done)return;done=true;clearTimeout(timer);s.destroy();res(v);};const timer=setTimeout(()=>end(fmt(t.label,'timeout')),t.ms||3000);s.on('connect',()=>end(fmt(t.label,'open')));s.on('error',(e)=>end(fmt(t.label,e.code||'error')));});
const tlsq=(t)=>new Promise(res=>{let done=false;const s=tls.connect({host:t.host,port:t.port||443,servername:t.servername,rejectUnauthorized:false});const end=(v)=>{if(done)return;done=true;clearTimeout(timer);s.destroy();res(v);};const timer=setTimeout(()=>end(fmt(t.label,'timeout')),t.ms||5000);s.on('secureConnect',()=>end(fmt(t.label,'handshake')));s.on('error',(e)=>end(fmt(t.label,e.code||'error')));});
const lookup=(t)=>new Promise(res=>{const timer=setTimeout(()=>res(fmt(t.label,'timeout')),t.ms||6000);dns.lookup(t.name,{family:4},(e,a)=>{clearTimeout(timer);res(e?fmt(t.label,e.code||'error'):fmt(t.label,'resolved',a));});});
const file=(t)=>Promise.resolve(fmt(t.label,'file',JSON.stringify(fs.readFileSync(t.path,'utf8')).slice(0,1500)));
const kinds={udpq,tcpq,conn,tls:tlsq,lookup,file};
Promise.all(cfg.tests.map((t)=>kinds[t.kind](t).catch((e)=>fmt(t.label,'error',String(e&&e.code||e))))).then((lines)=>{console.log(lines.join('\n'));process.exit(0);});
setTimeout(()=>process.exit(0),30000);
PROBE_END

# ---- cleanup: everything this run started, by its label
cleanup() {
  SU1_CLEANING=1
  [[ -n "${DOCKER:-}" && -x "${DOCKER:-}" ]] || return 0
  local ids
  ids=$(dk ps -a -q --filter "label=$SU1_LABEL" 2>/dev/null) || ids=""
  [[ -z "$ids" ]] || dk rm -f $ids >/dev/null 2>&1
  ids=$(dk network ls -q --filter "label=$SU1_LABEL" 2>/dev/null) || ids=""
  [[ -z "$ids" ]] || dk network rm $ids >/dev/null 2>&1
  return 0
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP

field() { printf '%s\n' "$1" | awk -v l="$2" '$1==l{print $2; exit}'; }               # status word of a probe line
rcode_of() { printf '%s\n' "$1" | sed -n "s/^$2 answer rcode=\([0-9]*\) an=.*/\1/p" | head -1; }
an_of() { printf '%s\n' "$1" | sed -n "s/^$2 answer rcode=[0-9]* an=\([0-9]*\).*/\1/p" | head -1; }
# the labels among $2... whose status in probe output $1 is "open" or "answer" (something got through)
got_through() { local out=$1 l s bad=""; shift; for l in "$@"; do s=$(field "$out" "$l"); if [[ -z "$s" ]]; then bad="$bad $l=no-result"; elif [[ "$s" == open || "$s" == answer || "$s" == handshake ]]; then bad="$bad $l=$s"; fi; done; printf '%s' "${bad# }"; }
statuses() { local out=$1 l; shift; for l in "$@"; do printf '%s=%s ' "$l" "$(field "$out" "$l")"; done; }
# the labels among $2... whose status in probe output $1 is anything but "timeout": a DROP wall answers nothing, so a refusal, an answer or a missing line all mean something else is in the way
not_timeout() { local out=$1 l s bad=""; shift; for l in "$@"; do s=$(field "$out" "$l"); [[ "$s" == timeout ]] || bad="$bad $l=${s:-no-result}"; done; printf '%s' "${bad# }"; }
# the first line number, in the rules text $2 (iptables -S of chain $1), of a rule of that chain that holds every token of $3 (separated by |): iptables writes the options of a rule in its own order
rule_at() { printf '%s\n' "$2" | awk -v chain="$1" -v toks="$3" 'BEGIN{n=split(toks,t,"|")} index($0,"-A " chain " ")==1{ok=1; for(i=1;i<=n;i++) if(index($0,t[i])==0){ok=0;break} if(ok){print NR; exit}}'; }
# the line numbers of the rules of chain $1, in the rules text $2, before line $3, that accept or return traffic from an rvb interface (rvb+, rvbs+, rvb<hex>): such a rule above a DROP hides it
accepts_before() { printf '%s\n' "$2" | awk -v chain="$1" -v upto="$3" 'index($0,"-A " chain " ")==1 && NR<upto && index($0,"-i rvb")!=0 && $0 ~ /-j (ACCEPT|RETURN)( |$)/{printf "%s ", NR}'; }
# take_lock <file>: a root-only file held with flock on file descriptor 9 for as long as this process lives; fails when another copy of this script holds it
take_lock() { local old rc; old=$(umask); umask 077; exec 9>>"$1"; rc=$?; umask "$old"; [[ $rc -eq 0 ]] && flock -n 9; }
pkts() { iptables -L DOCKER-USER -n -v -x 2>/dev/null | grep -E -m1 -- "$1" | awk '{print $1}'; }   # packet counter of the first rule matching the pattern

# ---- host facts
HOST=$(hostname 2>/dev/null || echo unknown)
printf 'SU1 START run=%s host=%s kernel=%s docker=%s image=%s sandbox_image_set=%s\n' "$RUN" "$HOST" "$(uname -r)" "$([[ -n "$DOCKER" ]] && dk version --format '{{.Server.Version}}' 2>/dev/null || echo none)" "$([[ -n "$WORKER_IMAGE" ]] && echo yes || echo no)" "$([[ -n "$SANDBOX_IMAGE" ]] && echo yes || echo no)"

READY=1
if [[ $EUID -ne 0 ]]; then READY=0; REASON="not root"; fi
if [[ "$(uname -s)" != Linux ]]; then READY=0; REASON="not Linux"; fi
if [[ -z "$DOCKER" || ! -x "$DOCKER" ]]; then READY=0; REASON="no docker CLI"; fi
if [[ -z "$WORKER_IMAGE" ]]; then READY=0; REASON="no /etc/agentx/worker-image"; fi
if [[ $READY -eq 1 ]] && ! dk info >/dev/null 2>&1; then READY=0; REASON="docker daemon not reachable"; fi
if [[ $READY -eq 1 ]] && ! command -v iptables >/dev/null 2>&1; then READY=0; REASON="no iptables"; fi

# one copy at a time: a second copy would sweep the first one's throwaway objects and share its slots
LOCK_FILE=/run/lock/agentx-su1-check.lock; [[ -d /run/lock ]] || LOCK_FILE=/var/tmp/agentx-su1-check.lock
if [[ $READY -eq 1 ]]; then
  if ! command -v flock >/dev/null 2>&1; then READY=0; REASON="no flock"
  elif ! take_lock "$LOCK_FILE"; then READY=0; REASON="another copy of this script is running (lock $LOCK_FILE)"; fi
fi

if [[ $READY -ne 1 ]]; then
  for n in 1 2 3 4 5 6 7 8 9 10 11; do emit "$n" FAIL not_run "cannot run on this host: $REASON"; done
  printf 'SU1 SUMMARY pass=%s fail=%s total=11 run=%s host=%s\n' "$PASS" "$FAIL" "$RUN" "$HOST"
  exit 1
fi

# ---- anything an earlier run of this script left (it was killed before its cleanup ran): everything with the bare label key, whatever the run id
OLD=$(dk ps -a -q --filter 'label=agentx.su1-check' 2>/dev/null); [[ -z "$OLD" ]] || dk rm -f $OLD >/dev/null 2>&1
OLD=$(dk network ls -q --filter 'label=agentx.su1-check' 2>/dev/null); [[ -z "$OLD" ]] || dk network rm $OLD >/dev/null 2>&1

# ---- check 1: br_netfilter / bridge-nf-call-iptables, recorded with the real Docker on this host
BNF=$(cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null || echo unreadable)
MOD=$(lsmod 2>/dev/null | awk '$1=="br_netfilter"{print "loaded"}'); MOD=${MOD:-not-loaded}
if [[ "$BNF" == 0 || "$BNF" == 1 ]]; then
  emit 1 PASS br_netfilter "recorded host=$HOST kernel=$(uname -r) docker=$(dk version --format '{{.Server.Version}}' 2>/dev/null) br_netfilter=$MOD bridge-nf-call-iptables=$BNF"
else
  emit 1 FAIL br_netfilter "bridge-nf-call-iptables is $BNF (br_netfilter=$MOD): the in-bridge rules of the firewall cannot be judged"
fi

# ---- the throwaway runs: two networks, a helper on each
used_subnets=$({ net_ids=$(dk network ls -q 2>/dev/null); for net_id in $net_ids; do dk network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$net_id" 2>/dev/null; done; ip -4 route 2>/dev/null | awk '{print $1}'; } | tr ' ' '\n')
SLOT_A=""; SLOT_B=""; SLOT_HELD=""
# check 8 after a kill and a restart: the killed run's slot must be free again, and the first throwaway run takes exactly that slot to show it is reused
if [[ -n "$EXPECT_SLOT" ]]; then
  if printf '%s\n' "$used_subnets" | grep -q -F "172.29.$EXPECT_SLOT.0/24" || [[ -e /sys/class/net/rvbs$EXPECT_SLOT ]]; then SLOT_HELD="slot $EXPECT_SLOT is still held (a network or its bridge remains)"; else SLOT_A=$EXPECT_SLOT; fi
fi
for s in $(seq 250 -1 230); do
  [[ "$s" != "$SLOT_A" ]] || continue
  if ! printf '%s\n' "$used_subnets" | grep -q -F "172.29.$s.0/24" && [[ ! -e /sys/class/net/rvbs$s ]]; then
    if [[ -z "$SLOT_A" ]]; then SLOT_A=$s; elif [[ -z "$SLOT_B" ]]; then SLOT_B=$s; break; fi
  fi
done
NET_A="agentx-su1-$RUN-a"; NET_B="agentx-su1-$RUN-b"
SETUP_OK=1; SETUP_WHY=""
make_run() { # make_run <net> <slot> -> creates the network and its helper
  local net=$1 slot=$2 base="172.29.$2"
  dk network create --driver bridge --subnet "$base.0/24" --gateway "$base.1" --opt "com.docker.network.bridge.name=rvbs$slot" --label "$SU1_LABEL" "$net" >/dev/null 2>&1 || return 1
  dk run --detach --name "$net-dns" --label "$SU1_LABEL" --network "$net" --ip "$base.2" --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --read-only \
    --sysctl net.ipv4.ip_unprivileged_port_start=53 --pids-limit 64 --memory 128m --memory-swap 128m --cpus 0.5 --tmpfs /state:rw,noexec,nosuid,size=1m,uid=1000,gid=1000 \
    --entrypoint "$NODE" "$WORKER_IMAGE" "$HELPER_ENTRY" --listen "$base.2" --source "$base.3" --upstream 127.0.0.11 --state /state/blocked.json >/dev/null 2>&1 || return 1
}
if [[ -z "$SLOT_A" || -z "$SLOT_B" ]]; then SETUP_OK=0; SETUP_WHY="no free setup network slots (230-250)"
elif ! make_run "$NET_A" "$SLOT_A"; then SETUP_OK=0; SETUP_WHY="could not start the throwaway run A (network or helper)"
elif ! make_run "$NET_B" "$SLOT_B"; then SETUP_OK=0; SETUP_WHY="could not start the throwaway run B (network or helper)"
fi
sleep 3
A="172.29.$SLOT_A"; B="172.29.$SLOT_B"

probe() { # probe <net> <ip> <dns> <config-json>   -> prints the probe's lines
  dk run --rm --label "$SU1_LABEL" --network "$1" --ip "$2" --dns "$3" --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --read-only \
    --pids-limit 64 --memory 128m --memory-swap 128m --cpus 0.5 --entrypoint "$NODE" "$WORKER_IMAGE" -e "$PROBE_JS" "$4" 2>&1
}
t() { printf '{"label":"%s","kind":"%s"%s}' "$1" "$2" "${3:+,$3}"; }   # t <label> <kind> <json members>

# addresses the sandbox must not reach
HOST_IPS=$(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -v '^127\.' | head -8)
PRIMARY=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)
VPC_ADDRS=""
if [[ "$PRIMARY" == 10.* ]]; then base3=${PRIMARY%.*}; VPC_ADDRS="$base3.1 $base3.2"; fi
RESOLVERS=$(awk '$1=="nameserver"&&$2~/^[0-9.]+$/{print $2}' /etc/resolv.conf /run/systemd/resolve/resolv.conf 2>/dev/null | sort -u | head -4)

OUT1=""; OUT2=""; OUT3=""; BEFORE_10=""; BEFORE_IMDS=""; VERIFIER_BEFORE=""; VERIFIER_AFTER=""; LEFTOVER_BEFORE=""
verifier_stats() { local i; for i in /sys/class/net/rvb[0-9a-f]*; do [[ -d "$i" ]] || continue; case "${i##*/}" in rvbs*) continue ;; esac; printf '%s rx=%s tx=%s\n' "${i##*/}" "$(cat "$i/statistics/rx_packets" 2>/dev/null)" "$(cat "$i/statistics/tx_packets" 2>/dev/null)"; done; }

if [[ $SETUP_OK -eq 1 ]]; then
  VERIFIER_BEFORE=$(verifier_stats)
  BEFORE_10=$(pkts 'rvb\+ +\* +0\.0\.0\.0/0 +10\.0\.0\.0/8')
  BEFORE_IMDS=$(pkts '169\.254\.169\.254')
  # probe 1: the sandbox (.3, resolver = the helper .2)
  T=()
  T+=("$(t pub_udp udpq "\"host\":\"$A.2\",\"name\":\"$PUBLIC_NAME\"")" "$(t pub_tcp tcpq "\"host\":\"$A.2\",\"name\":\"$PUBLIC_NAME\"")")
  T+=("$(t nx_udp udpq "\"host\":\"$A.2\",\"name\":\"$NX_NAME\"")" "$(t nx_tcp tcpq "\"host\":\"$A.2\",\"name\":\"$NX_NAME\"")")
  T+=("$(t resolv file "\"path\":\"/etc/resolv.conf\"")" "$(t lookup_pub lookup "\"name\":\"$PUBLIC_NAME\"")")
  T+=("$(t gw_udp53 udpq "\"host\":\"$A.1\",\"name\":\"$PUBLIC_NAME\"")")
  for p in 22 53 80 443 2375 8080; do T+=("$(t gw_$p conn "\"host\":\"$A.1\",\"port\":$p")"); done
  for p in 22 80 5353 8080; do T+=("$(t helper_$p conn "\"host\":\"$A.2\",\"port\":$p")"); done
  T+=("$(t other_helper_udp53 udpq "\"host\":\"$B.2\",\"name\":\"$PUBLIC_NAME\"")" "$(t other_helper_tcp53 tcpq "\"host\":\"$B.2\",\"name\":\"$PUBLIC_NAME\"")" "$(t other_helper_conn53 conn "\"host\":\"$B.2\",\"port\":53")")
  T+=("$(t imds_80 conn '"host":"169.254.169.254","port":80')")
  n=0; for ip in $HOST_IPS; do n=$((n + 1)); for p in 22 8080; do T+=("$(t "hostip${n}_$p" conn "\"host\":\"$ip\",\"port\":$p")"); done; T+=("$(t "hostip${n}_udp53" udpq "\"host\":\"$ip\",\"name\":\"$PUBLIC_NAME\"")"); done
  n=0; for ip in $VPC_ADDRS; do n=$((n + 1)); for p in 53 80 443; do T+=("$(t "vpc${n}_$p" conn "\"host\":\"$ip\",\"port\":$p")"); done; done
  n=0; for ip in $RESOLVERS; do n=$((n + 1)); T+=("$(t "resolver${n}_udp53" udpq "\"host\":\"$ip\",\"name\":\"$PUBLIC_NAME\"")" "$(t "resolver${n}_tcp53" tcpq "\"host\":\"$ip\",\"name\":\"$PUBLIC_NAME\"")"); done
  T+=("$(t pub_ip_tls_1 tls '"host":"1.1.1.1","port":443,"servername":"su1-not-allowed.example.net"')" "$(t pub_ip_tls_2 tls '"host":"8.8.8.8","port":443,"servername":"su1-not-allowed.example.net"')")
  T+=("$(t pub_ip_tcp_1 conn '"host":"1.1.1.1","port":443')")
  CFG1="{\"tests\":[$(IFS=,; echo "${T[*]}")]}"
  OUT1=$(probe "$NET_A" "$A.3" "$A.2" "$CFG1")
  # a second source on the same network (.4): the helper serves only the sandbox's address
  OUT2=$(probe "$NET_A" "$A.4" "$A.2" "{\"tests\":[$(t other_udp udpq "\"host\":\"$A.2\",\"name\":\"$PUBLIC_NAME\""),$(t other_tcp tcpq "\"host\":\"$A.2\",\"name\":\"$PUBLIC_NAME\"")]}")
  AFTER_10=$(pkts 'rvb\+ +\* +0\.0\.0\.0/0 +10\.0\.0\.0/8')
  AFTER_IMDS=$(pkts '169\.254\.169\.254')
  VERIFIER_AFTER=$(verifier_stats)
fi

# ---- check 2: DOCKER-USER order with the run live; its digest is printed so a rerun after a Docker restart or a reboot can compare
if [[ $SETUP_OK -ne 1 ]]; then
  emit 2 FAIL docker_user_order "$SETUP_WHY"
else
  RULES=$(iptables -S DOCKER-USER 2>/dev/null)
  at() { rule_at DOCKER-USER "$RULES" "$1"; }
  I_IMDS=$(at '-d 169.254.169.254/32|-j ')
  I_CT=$(at '-i rvbs+|-o rvbs+|--ctstate|ESTABLISHED|-j RETURN')
  I_PU=$(at '-i rvbs+|-o rvbs+|physdev|-d 172.29.0.0/16|-p udp|--dport 53|-j RETURN')
  I_PT=$(at '-i rvbs+|-o rvbs+|physdev|-d 172.29.0.0/16|-p tcp|--dport 53|-j RETURN')
  I_XU=$(at '-i rvbs+|-s 172.29.0.3/255.255.0.255|-p udp|--dport 53|-j DROP')
  I_XT=$(at '-i rvbs+|-s 172.29.0.3/255.255.0.255|-p tcp|--dport 53|-j DROP')
  I_R16=$(at '-d 172.16.0.0/12|-j DROP')
  I_R10=$(at '-d 10.0.0.0/8|-j DROP')
  I_VPC=$(at '-i rvb+|--dport 53|-j RETURN')
  INPUT_RULES=$(iptables -S INPUT 2>/dev/null)
  I_INPUT=$(rule_at INPUT "$INPUT_RULES" '-i rvb+|-j DROP')
  HIDING=""; [[ -z "$I_INPUT" ]] || HIDING=$(accepts_before INPUT "$INPUT_RULES" "$I_INPUT")
  MISSING=""
  for pair in "I_IMDS:metadata-reject" "I_CT:conntrack-return" "I_PU:physdev-udp53-return" "I_PT:physdev-tcp53-return" "I_XU:rvbs-udp53-drop" "I_XT:rvbs-tcp53-drop" "I_R16:range-172.16-drop" "I_R10:range-10-drop" "I_INPUT:input-rvb-drop"; do
    var=${pair%%:*}; [[ -n "${!var}" ]] || MISSING="$MISSING ${pair#*:}"
  done
  ORDER=""
  if [[ -z "$MISSING" ]]; then
    [[ $I_IMDS -lt $I_CT ]] || ORDER="$ORDER metadata-not-above-conntrack"
    [[ $I_CT -lt $I_R16 && $I_PU -lt $I_R16 && $I_PT -lt $I_R16 ]] || ORDER="$ORDER returns-not-above-172.16-drop"
    [[ $I_CT -lt $I_R10 && $I_PU -lt $I_R10 ]] || ORDER="$ORDER returns-not-above-10-drop"
    [[ -z "$I_VPC" || ( $I_XU -lt $I_VPC && $I_XT -lt $I_VPC ) ]] || ORDER="$ORDER rvbs-53-drop-below-vpc-dns-return"
  fi
  [[ -z "${HIDING% }" ]] || ORDER="$ORDER input-rvb-accept-or-return-above-the-drop:line(s)${HIDING% }"
  FWD=$(iptables -S FORWARD 2>/dev/null | grep -n -E -- '-j (DOCKER-USER|DOCKER-ISOLATION-STAGE-1|DOCKER)$' | sed 's/^\([0-9]*\):.* -j /\1 /' | tr '\n' ' ')
  FWD_OK=""
  case "$FWD" in *"DOCKER-USER"*"DOCKER-ISOLATION-STAGE-1"*) ;; *) FWD_OK="FORWARD jumps are not DOCKER-USER before DOCKER-ISOLATION-STAGE-1 ($FWD)" ;; esac
  SHA=$(printf '%s\n%s\n%s\n' "$RULES" "$FWD" "$(printf '%s\n' "$INPUT_RULES" | grep -F -- '-i rvb+')" | sha256sum | cut -c1-64)
  SHA_NOTE=""
  if [[ -n "$EXPECT_SHA" && "$EXPECT_SHA" != "$SHA" ]]; then SHA_NOTE="DOCKER-USER digest $SHA differs from the expected $EXPECT_SHA"; fi
  DETAIL=""; [[ -z "$MISSING" ]] || DETAIL="missing rules:$MISSING"; [[ -z "$ORDER" ]] || DETAIL="$DETAIL order:$ORDER"; [[ -z "$FWD_OK" ]] || DETAIL="$DETAIL $FWD_OK"; [[ -z "$SHA_NOTE" ]] || DETAIL="$DETAIL $SHA_NOTE"
  verdict 2 docker_user_order "${DETAIL# }" "order ok with a run live; DOCKER-USER digest=$SHA$([[ -n "$EXPECT_SHA" ]] && echo ' (equal to the expected one)' || echo ' (rerun with --expect-docker-user-sha after a Docker restart and after a host restart)')"
fi

# ---- check 3: dig @helper answers over UDP and TCP (the reply path)
if [[ $SETUP_OK -ne 1 ]]; then emit 3 FAIL helper_reply_path "$SETUP_WHY"; else
  F=""
  [[ "$(dk inspect -f '{{.State.Running}}' "$NET_A-dns" 2>/dev/null)" == true ]] || F="helper not running ($(dk logs --tail 3 "$NET_A-dns" 2>&1 | tr '\n' ' '))"
  for l in pub_udp pub_tcp; do
    [[ "$(rcode_of "$OUT1" $l)" == 0 && "$(an_of "$OUT1" $l)" -ge 1 ]] 2>/dev/null || F="$F $l=$(field "$OUT1" $l)"
  done
  verdict 3 helper_reply_path "${F# }" "sandbox $A.3 got a NOERROR answer for $PUBLIC_NAME from $A.2 over UDP and TCP; the helper runs as uid 1000 and bound :53"
fi

# ---- check 4: what the sandbox must NOT reach
if [[ $SETUP_OK -ne 1 ]]; then emit 4 FAIL sandbox_walls "$SETUP_WHY"; else
  # Every wall but the metadata address is a DROP, which answers nothing: anything but a timeout means the packet met something else. The metadata address is a REJECT: it only must not be open.
  LABELS=(gw_udp53 gw_22 gw_53 gw_80 gw_443 gw_2375 gw_8080 helper_22 helper_80 helper_5353 helper_8080 other_helper_udp53 other_helper_tcp53 other_helper_conn53)
  for l in $(printf '%s\n' "$OUT1" | awk '$1 ~ /^(hostip|vpc|resolver)[0-9]+_/{print $1}'); do LABELS+=("$l"); done
  F=$(not_timeout "$OUT1" "${LABELS[@]}")
  G=$(got_through "$OUT1" imds_80)
  [[ -z "$G" ]] || F="$F $G"
  F=${F# }
  C=""
  if [[ -n "$BEFORE_IMDS" && -n "${AFTER_IMDS:-}" && "$AFTER_IMDS" -le "$BEFORE_IMDS" ]] 2>/dev/null; then C="$C metadata-rule-counter-did-not-move"; fi
  if [[ "$PRIMARY" == 10.* ]]; then if [[ -z "$BEFORE_10" || -z "${AFTER_10:-}" || "$AFTER_10" -le "$BEFORE_10" ]] 2>/dev/null; then C="$C range-10-drop-counter-did-not-move"; fi; fi
  [[ -z "$F" ]] || F="not dropped (timeout expected): $F"
  verdict 4 sandbox_walls "${F}${C}" "gateway (any of 7 probes), the host's addresses, the VPC and its resolvers, $B.2:53 of a second run and the helper off port 53 all timed out (dropped); 169.254.169.254 not open; $((${#LABELS[@]} + 1)) probes; counters moved"
fi

# ---- check 5: a public name resolves, a blocked (NXDOMAIN) name is recorded, and the answer reaches the sandbox unchanged
if [[ $SETUP_OK -ne 1 ]]; then emit 5 FAIL dns_answers "$SETUP_WHY"; else
  F=""
  [[ "$(rcode_of "$OUT1" pub_udp)" == 0 ]] || F="public name not resolved"
  UP=$(dk exec "$NET_A-dns" "$NODE" -e "$PROBE_JS" "{\"tests\":[$(t up_nx udpq "\"host\":\"127.0.0.11\",\"name\":\"$NX_NAME\"")]}" 2>&1)
  UP_RC=$(rcode_of "$UP" up_nx)
  for l in nx_udp nx_tcp; do [[ "$(rcode_of "$OUT1" $l)" == "${UP_RC:-x}" && -n "$UP_RC" ]] || F="$F $l=$(field "$OUT1" $l)/rcode=$(rcode_of "$OUT1" $l) differs from the upstream's rcode=${UP_RC:-none}"; done
  SEEN=""
  for _ in 1 2 3 4 5 6; do SEEN=$(dk exec "$NET_A-dns" cat /state/blocked.json 2>/dev/null); printf '%s' "$SEEN" | grep -q -F "$NX_NAME" && break; sleep 1; done
  printf '%s' "$SEEN" | grep -q -F "$NX_NAME" || F="$F blocked name not in blocked.json"
  verdict 5 dns_answers "${F# }" "public name NOERROR, $NX_NAME rcode=${UP_RC:-?} unchanged over UDP and TCP and listed in blocked.json (a REFUSED answer cannot be produced read-only)"
fi

# ---- check 6: no fallback to the daemon's resolvers; queries come from the sandbox's own address
if [[ $SETUP_OK -ne 1 ]]; then emit 6 FAIL no_fallback "$SETUP_WHY"; else
  F=""
  RESOLV=$(printf '%s\n' "$OUT1" | sed -n 's/^resolv file //p' | head -1)
  printf '%s' "$RESOLV" | grep -q -F 'nameserver 127.0.0.11' || F="resolv.conf is not Docker's embedded 127.0.0.11"
  EXT=$(printf '%s' "$RESOLV" | sed -n 's/.*ExtServers: \[\([^]]*\)\].*/\1/p' | grep -o -E '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | sort -u | tr '\n' ' ')
  [[ "${EXT% }" == "$A.2" ]] || F="$F ExtServers is [${EXT% }] not [$A.2]"
  [[ "$(field "$OUT1" lookup_pub)" == resolved ]] || F="$F the sandbox's own lookup of $PUBLIC_NAME failed with the helper up"
  for l in other_udp other_tcp; do [[ "$(field "$OUT2" $l)" != answer ]] || F="$F a query from another address ($A.4) was answered ($l)"; done
  # the helper goes away: the sandbox must NOT resolve around it (a different public name, so no cache can answer)
  dk stop -t 1 "$NET_A-dns" >/dev/null 2>&1
  OUT3=$(probe "$NET_A" "$A.3" "$A.2" "{\"tests\":[$(t fallback_lookup lookup "\"name\":\"example.org\",\"ms\":8000")]}")
  [[ "$(field "$OUT3" fallback_lookup)" != resolved ]] || F="$F with the helper stopped the sandbox still resolved example.org (fallback to the daemon's resolvers)"
  verdict 6 no_fallback "${F# }" "resolv.conf is 127.0.0.11 with ExtServers [$A.2] only; only $A.3 is served ($A.4 is not); with the helper stopped nothing resolves ($(field "$OUT3" fallback_lookup))"
fi

# ---- check 7: the rvbs<slot> bridge exists; the verifier's rvb<hex> bridges see no traffic from this
if [[ $SETUP_OK -ne 1 ]]; then emit 7 FAIL bridges "$SETUP_WHY"; else
  F=""
  [[ -d /sys/class/net/rvbs$SLOT_A && -d /sys/class/net/rvbs$SLOT_B ]] || F="rvbs$SLOT_A or rvbs$SLOT_B is missing"
  [[ "$VERIFIER_BEFORE" == "$VERIFIER_AFTER" ]] || F="$F verifier bridge counters moved: before=[$(printf '%s' "$VERIFIER_BEFORE" | tr '\n' ';')] after=[$(printf '%s' "$VERIFIER_AFTER" | tr '\n' ';')]"
  NV=$(printf '%s\n' "$VERIFIER_BEFORE" | grep -c . || true)
  verdict 7 bridges "${F# }" "bridges rvbs$SLOT_A and rvbs$SLOT_B exist (named as boot.sh walls rvb*); $NV verifier bridge(s) compared, counters unchanged$([[ "$NV" == 0 ]] && echo ' (none present: run again while a verifier run is live on another worker to compare)')"
fi

# ---- check 8: no orphaned setup helper or network; after a kill and a restart (the operator does both): the killed run's objects are gone, its slot is free and was reused here, another workspace's run survives
{
  F=""
  CONTAINERS=$(dk ps -a --filter 'label=agentx.setup-run' --format '{{.Names}}' 2>/dev/null)
  NETWORKS=$(dk network ls --filter 'label=agentx.setup-run' --format '{{.Name}}' 2>/dev/null)
  NETLIST=""
  for n in $NETWORKS; do
    ws=$(dk network inspect -f '{{index .Labels "agentx.setup-workspace"}}' "$n" 2>/dev/null)
    slot=$(dk network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$n" 2>/dev/null | sed -n 's/^172\.29\.\([0-9]*\)\.0\/24$/\1/p')
    NETLIST="$NETLIST $n(workspace=${ws:-none},slot=${slot:-none})"
  done
  # a helper whose network is gone, a network with no helper: the sweep at a worker's start removes both
  for name in $CONTAINERS; do printf '%s\n' "$NETWORKS" | grep -q -x -F "${name%-dns}" || F="$F helper-without-network:$name"; done
  for name in $NETWORKS; do printf '%s\n' "$CONTAINERS" | grep -q -x -F "$name-dns" || F="$F network-without-helper:$name"; done
  N_C=$(printf '%s\n' "$CONTAINERS" | grep -c . || true); N_N=$(printf '%s\n' "$NETWORKS" | grep -c . || true)
  AFTER=""
  if [[ -n "$EXPECT_LEFT_WS" ]]; then
    AFTER="$AFTER killed run's workspace $EXPECT_LEFT_WS has nothing left;"
    LEFT=$(dk ps -a -q --filter "label=agentx.setup-workspace=$EXPECT_LEFT_WS" 2>/dev/null; dk network ls -q --filter "label=agentx.setup-workspace=$EXPECT_LEFT_WS" 2>/dev/null)
    [[ -z "$LEFT" ]] || F="$F objects of the killed run's workspace $EXPECT_LEFT_WS remain ($(printf '%s' "$LEFT" | tr '\n' ' '))"
  fi
  if [[ -n "$EXPECT_SURVIVOR" ]]; then
    AFTER="$AFTER the run on $EXPECT_SURVIVOR survived;"
    printf '%s\n' "$NETWORKS" | grep -q -x -F "$EXPECT_SURVIVOR" || F="$F the surviving run's network $EXPECT_SURVIVOR is gone"
    [[ "$(dk inspect -f '{{.State.Running}}' "$EXPECT_SURVIVOR-dns" 2>/dev/null)" == true ]] || F="$F the surviving run's helper $EXPECT_SURVIVOR-dns is not running"
  fi
  if [[ -n "$EXPECT_SLOT" ]]; then
    AFTER="$AFTER slot $EXPECT_SLOT is free and a new run took it;"
    [[ -z "$SLOT_HELD" ]] || F="$F $SLOT_HELD"
    [[ $SETUP_OK -eq 1 && "$SLOT_A" == "$EXPECT_SLOT" ]] || F="$F slot $EXPECT_SLOT could not be reused by a new run (${SETUP_WHY:-not used})"
  fi
  verdict 8 leftover_sweep "${F# }" "$N_C setup helper(s) and $N_N setup network(s) of the worker, none orphaned:${NETLIST:- none};${AFTER:- for the full check kill the worker mid-run, restart it, then rerun with --expect-no-leftovers-for LABEL --expect-survivor NETWORK --expect-slot-free N, taking LABEL, NETWORK and N from this line before the kill}"
}

# ---- checks 9 and 10 need a live model-driven setup run, which this read-only script does not start
emit 9 FAIL budget_with_zero_cost_proxy "not judged here: needs a live setup run on a proxy-routed model; judged by setup-agent-su1-report.ts with --evidence9 and the answer of that run"
emit 10 FAIL stale_untracked_project_json "not judged here: needs a live setup run that wrote an untracked kalmius/project.json; judged by setup-agent-su1-report.ts with --evidence10, the answer of that run, and --stale-marker"

# ---- check 11: direct egress to a public IP that is not an allowed website (the DNS watcher does not enforce it)
if [[ $SETUP_OK -ne 1 ]]; then emit 11 FAIL public_ip_egress "$SETUP_WHY"; else
  F=$(got_through "$OUT1" pub_ip_tls_1 pub_ip_tls_2)
  [[ -z "$F" ]] || F="a TLS handshake with an unlisted server name completed: $F (plain TCP to 1.1.1.1:443: $(field "$OUT1" pub_ip_tcp_1)); allowed-websites egress is not enforced at the IP level here"
  verdict 11 public_ip_egress "$F" "no TLS handshake with 1.1.1.1 or 8.8.8.8 for an unlisted server name ($(statuses "$OUT1" pub_ip_tls_1 pub_ip_tls_2 pub_ip_tcp_1)); egress to unlisted sites is enforced below the DNS watcher"
fi

printf 'SU1 SUMMARY pass=%s fail=%s total=11 run=%s host=%s\n' "$PASS" "$FAIL" "$RUN" "$HOST"
[[ $FAIL -eq 0 ]]

}
export -f su1_main
# The cap includes the one-second escalation; never use timeout's default
# separate process group here. This also bounds non-Docker work in the script.
exec timeout --foreground --kill-after=1 "$((SU1_TIMEOUT_SECONDS - 1))" /bin/bash -c 'su1_main "$@"' su1 "$@"
