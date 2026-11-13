#!/bin/bash
# TE-B1-fresh: the Linux check for the fresh (NOT sealed) check round (packages/worker/src/fresh-check-round.ts). It starts a sandbox with the very `docker run` arguments `freshSandboxRunArgs` makes (a unit test judges the arguments
# this script uses with `freshSandboxArgProblems`, so the two cannot drift) and proves, on a real Linux Docker daemon:
#   FR1 the user is not root and the sandbox has no capability and no-new-privileges;
#   FR2 the working root's files are not readable from the fresh sandbox (they are world-readable on the host; only the mount hides them), nor is the worker's run directory, nor the docker socket;
#   FR3 the export (committed files only) IS what the sandbox sees at the working root's path, and it can write there;
#   FR4 the sandbox is on one network only;
#   FR5 the working sandbox cannot connect to the fresh one on the walled bridge (inter-container traffic off), which is why the working sandbox is not paused; a control network WITH inter-container traffic shows the probe can connect;
#   FR6 after the round the container is gone, and so is the export.
# Output: one line per check, `FRESH <id> PASS|FAIL <name> | <detail>`, then `FRESH SUMMARY pass=<p> fail=<f>`. Exit 0 only when every line is PASS, 1 on any FAIL, 2 on a usage or setup error.
#
# HERMETIC. It calls only `docker` (and mkdir, mktemp, chmod, printf, rm, test, grep, tr, cut, sed, sleep, sha256sum or shasum from the base system). It calls no `nft`, `ip6tables`, `ip` or `iptables`, reads no secret, makes no AWS call and never touches colima:
# the daemon is whatever `docker` already points at. It creates containers and networks of its own (named agentx-fresh-linuxcheck-*) and removes them.
# Needs: FRESH_IMAGE (an image with /usr/bin/tini, sh and node, run as 1000:1000: the worker image). Optional: FRESH_BASE (a directory the Docker daemon can bind-mount; default: a new one under /tmp), FRESH_NETWORK (default agentx-task; created
# with inter-container traffic off if it does not exist, and removed again only if this script made it).
set -u
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}

[[ $# -eq 0 ]] || { printf 'FRESH ERROR this script takes no arguments\n'; exit 2; }
IMAGE=${FRESH_IMAGE:-}
[[ -n "$IMAGE" && "$IMAGE" =~ ^[A-Za-z0-9._:/@-]{1,250}$ ]] || { printf 'FRESH ERROR FRESH_IMAGE must name the sandbox image\n'; exit 2; }
NET=${FRESH_NETWORK:-agentx-task}
[[ "$NET" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$ ]] || { printf 'FRESH ERROR FRESH_NETWORK is not a network name\n'; exit 2; }
if [[ -n "${FRESH_BASE:-}" ]]; then BASE=$FRESH_BASE; MADE_BASE=0; else BASE=$(mktemp -d /tmp/fresh-round-check.XXXXXX) || { printf 'FRESH ERROR no scratch directory\n'; exit 2; }; MADE_BASE=1; fi
[[ "$BASE" =~ ^/[A-Za-z0-9._/-]{1,200}$ ]] || { printf 'FRESH ERROR FRESH_BASE is not a plain path\n'; exit 2; }

PASS=0; FAIL=0
emit() { # emit <id> <PASS|FAIL> <name> <detail>
  local detail
  detail=$(printf '%s' "$4" | tr '\r\n\t' '   ' | cut -c1-300)
  printf 'FRESH %s %s %s | %s\n' "$1" "$2" "$3" "$detail"
  case "$2" in PASS) PASS=$((PASS + 1)) ;; *) FAIL=$((FAIL + 1)) ;; esac
}
verdict() { if [[ -z "$3" ]]; then emit "$1" PASS "$2" "$4"; else emit "$1" FAIL "$2" "$3"; fi; }

SETTLE=${FRESH_SETTLE_SECONDS:-2}   # how long a listener gets to start
[[ "$SETTLE" =~ ^[0-9]{1,2}$ ]] || { printf 'FRESH ERROR FRESH_SETTLE_SECONDS is not a number\n'; exit 2; }
SUFFIX=$(printf '%08x' "$RANDOM$RANDOM" | cut -c1-8)
ROOT="$BASE/workspace"                              # the WORKING root, as the worker sees it
RUNDIR="$BASE/run-directory"                        # the worker's own run directory (outside the workspace)
EXPORT="$ROOT/.agentx/fresh-check/linuxcheck-$SUFFIX"
NAME="agentx-fresh-linuxcheck-$SUFFIX"
WORKING="agentx-fresh-linuxcheck-working-$SUFFIX"
MADE_NET=0
CONTROL_NET="agentx-fresh-linuxcheck-open-$SUFFIX"
MADE_CONTROL=0

cleanup() {
  docker rm --force "$NAME" "$WORKING" "$NAME-open-a" "$NAME-open-b" >/dev/null 2>&1
  [[ $MADE_CONTROL -eq 1 ]] && docker network rm "$CONTROL_NET" >/dev/null 2>&1
  [[ $MADE_NET -eq 1 ]] && docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$EXPORT" "$RUNDIR" "$ROOT" 2>/dev/null
  [[ $MADE_BASE -eq 1 ]] && rm -rf "$BASE" 2>/dev/null
  return 0
}
trap cleanup EXIT

# ---- the host side: a working root with files of the agent's (readable by everyone, so only the mount can hide them), a run directory, and the export
mkdir -p "$ROOT/.agentx" "$ROOT/repo" "$RUNDIR" "$EXPORT/repo" || { printf 'FRESH ERROR cannot make the scratch directories\n'; exit 2; }
printf 'agent working file\n' > "$ROOT/repo/untracked-by-agent.txt"
printf 'worker state\n' > "$ROOT/.agentx/state.json"
printf 'run directory file\n' > "$RUNDIR/run-secret.txt"
printf 'committed\n' > "$EXPORT/repo/committed.txt"
chmod -R a+rX "$ROOT" "$RUNDIR"
chmod 0777 "$EXPORT" "$EXPORT/repo"   # the container's user (1000) writes here; on a worker the directory is the worker's own (also 1000)

ensure_network() { # ensure_network <name> <icc: true|false> <made-flag-variable>
  docker network inspect "$1" >/dev/null 2>&1 && return 0
  docker network create --driver bridge --opt "com.docker.network.bridge.enable_icc=$2" "$1" >/dev/null 2>&1 || return 1
  printf -v "$3" '%s' 1
}
ensure_network "$NET" false MADE_NET || { printf 'FRESH ERROR cannot make the network %s\n' "$NET"; exit 2; }
ICC=$(docker network inspect --format '{{index .Options "com.docker.network.bridge.enable_icc"}}' "$NET" 2>/dev/null)

# ---- the sandbox, with the arguments freshSandboxRunArgs makes (names, limits and labels as the worker gives them)
# the workspace label is the first 16 hex digits of the sha256 of the working root's path (workspaceKey in task-sandbox.ts)
if command -v sha256sum >/dev/null 2>&1; then WSKEY=$(printf '%s' "$ROOT" | sha256sum | cut -c1-16); else WSKEY=$(printf '%s' "$ROOT" | shasum -a 256 | cut -c1-16); fi
RUN_ARGS=(run --detach --name "$NAME" --label "agentx.task=linuxcheck" --label "agentx.workspace=$WSKEY" --label "rovara.check-round=fresh"
  --network "$NET" --user 1000:1000 --cpus 1 --memory 1024m --memory-swap 1024m --pids-limit 4096 --cap-drop ALL --security-opt no-new-privileges
  --volume "$EXPORT:$ROOT" --workdir "$ROOT" --entrypoint /usr/bin/tini "$IMAGE" -- sleep infinity)
if ! docker "${RUN_ARGS[@]}" >/dev/null 2>&1; then emit FR0 FAIL start "the fresh sandbox did not start"; printf 'FRESH SUMMARY pass=%s fail=%s\n' "$PASS" "$FAIL"; exit 1; fi
fx() { docker exec "$NAME" "$@" 2>&1; }

# FR1: not root, no capability, no-new-privileges
FAILS=""
UIDOUT=$(fx id -u | tr -d '[:space:]')
[[ "$UIDOUT" == "1000" ]] || FAILS="$FAILS user is '$UIDOUT' (want 1000);"
CAP=$(fx sh -c 'grep -E "^CapEff:" /proc/self/status | tr -d "[:space:]"')
[[ "$CAP" == "CapEff:0000000000000000" ]] || FAILS="$FAILS capabilities are $CAP;"
NNP=$(fx sh -c 'grep -E "^NoNewPrivs:" /proc/self/status | tr -d "[:space:]"')
[[ "$NNP" == "NoNewPrivs:1" ]] || FAILS="$FAILS $NNP;"
verdict FR1 user_and_privileges "$FAILS" "uid 1000, CapEff 0, NoNewPrivs 1"

# FR2: nothing of the working root, the worker's run directory or the docker socket is readable
FAILS=""
for path in "$ROOT/repo/untracked-by-agent.txt" "$ROOT/.agentx/state.json" "$RUNDIR/run-secret.txt" /var/run/docker.sock; do
  if fx test -e "$path" >/dev/null; then FAILS="$FAILS $path is visible;"; fi
done
LISTING=$(fx ls -A "$ROOT")
case "$LISTING" in *untracked-by-agent*|*.agentx*) FAILS="$FAILS the working root's own entries are listed;" ;; esac
verdict FR2 working_root_and_run_directory_not_readable "$FAILS" "the agent's untracked file, the worker's state, the run directory and the docker socket are all absent from the sandbox"

# FR3: the export is what is there, and it is writable
FAILS=""
[[ "$(fx cat "$ROOT/repo/committed.txt")" == "committed" ]] || FAILS="$FAILS the committed file is not at the working root's path;"
fx sh -c "printf written > '$ROOT/repo/written-by-check.txt'" >/dev/null || FAILS="$FAILS the export is not writable;"
[[ "$(fx pwd)" == "$ROOT" ]] || FAILS="$FAILS the working directory is not the root's path;"
verdict FR3 the_export_is_the_root "$FAILS" "the committed file is at the working root's path and the sandbox can write there"

# FR4: one network
NETS=$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$NAME" 2>/dev/null | tr -s ' ' | sed 's/ *$//')
verdict FR4 one_network "$([[ "$NETS" == "$NET" ]] || printf 'networks are: %s' "$NETS")" "only $NET"

# FR5: inter-container traffic. A listener in the fresh sandbox; a stand-in working sandbox on the same network tries to connect.
FAILS=""
docker run --detach --name "$WORKING" --network "$NET" --user 1000:1000 --entrypoint /usr/bin/tini "$IMAGE" -- sleep infinity >/dev/null 2>&1 || FAILS="$FAILS the stand-in working sandbox did not start;"
docker exec --detach "$NAME" node -e "require('net').createServer(c=>c.end('hi')).listen(8099,'0.0.0.0')" >/dev/null 2>&1
sleep "$SETTLE"
ADDR=$(docker inspect --format "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$NAME" 2>/dev/null)
PROBE="const s=require('net').connect({host:'$ADDR',port:8099,timeout:3000});s.on('data',()=>{console.log('CONNECTED');process.exit(0)});s.on('timeout',()=>process.exit(3));s.on('error',()=>process.exit(4));"
if [[ "$ICC" == "false" ]]; then
  OUT=$(docker exec "$WORKING" node -e "$PROBE" 2>&1)
  case "$OUT" in *CONNECTED*) FAILS="$FAILS the working sandbox reached the fresh sandbox on $NET;" ;; esac
  LOCAL=$(docker exec "$NAME" node -e "const s=require('net').connect({host:'127.0.0.1',port:8099,timeout:3000});s.on('data',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',()=>process.exit(4));" 2>&1)
  case "$LOCAL" in *CONNECTED*) ;; *) FAILS="$FAILS the listener did not answer even on loopback (the probe proves nothing);" ;; esac
else
  FAILS="$FAILS $NET has inter-container traffic ON (enable_icc=$ICC): not the walled bridge;"
fi
# the control: on a network WITH inter-container traffic, the same probe connects, so the probe can tell
if ensure_network "$CONTROL_NET" true MADE_CONTROL; then
  docker run --detach --name "$NAME-open-a" --network "$CONTROL_NET" --user 1000:1000 --entrypoint /usr/bin/tini "$IMAGE" -- sleep infinity >/dev/null 2>&1
  docker run --detach --name "$NAME-open-b" --network "$CONTROL_NET" --user 1000:1000 --entrypoint /usr/bin/tini "$IMAGE" -- sleep infinity >/dev/null 2>&1
  docker exec --detach "$NAME-open-a" node -e "require('net').createServer(c=>c.end('hi')).listen(8099,'0.0.0.0')" >/dev/null 2>&1
  sleep "$SETTLE"
  OPEN=$(docker inspect --format "{{(index .NetworkSettings.Networks \"$CONTROL_NET\").IPAddress}}" "$NAME-open-a" 2>/dev/null)
  OUT=$(docker exec "$NAME-open-b" node -e "${PROBE//$ADDR/$OPEN}" 2>&1)
  case "$OUT" in *CONNECTED*) ;; *) FAILS="$FAILS the control network did not let the probe connect (the probe proves nothing);" ;; esac
else
  FAILS="$FAILS the control network could not be made;"
fi
verdict FR5 working_sandbox_cannot_reach_the_fresh_one "$FAILS" "blocked on $NET (enable_icc=$ICC), connected on the control network: no pause needed"

# FR6: the container and the export are gone after the round
FAILS=""
docker rm --force "$NAME" >/dev/null 2>&1
if docker container inspect "$NAME" >/dev/null 2>&1; then FAILS="$FAILS the container is still there;"; fi
rm -rf "$EXPORT"
[[ ! -e "$EXPORT" ]] || FAILS="$FAILS the export is still there;"
verdict FR6 container_and_export_gone "$FAILS" "docker has no $NAME and the export directory is removed"

printf 'FRESH SUMMARY pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
