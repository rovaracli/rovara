#!/bin/bash
# TS-SEAL egress capture, "Layer A" of TS-SEAL-EGRESS-TCPDUMP-PLAN.md, for the Docker 25 leg of linux-runtime. SOURCED by scripts/ci-test-services-linux.sh when TSL_EGRESS_CAPTURE=1 (it defines functions and runs nothing).
# While the checks run, tcpdump records every interface of the CI host (-i any -nn -e). Two probes with one random TOKEN per run make the verdict mean something:
#   - SEALED: a container on a sealed-style network (--internal, bridge named rvi<8 hex>, the check sandbox's flags: user 1000:1000, every capability dropped, no-new-privileges, read-only, pids limit, no --dns) asks Docker's embedded
#     resolver 127.0.0.11 directly for TOKEN-sealed.invalid, and tries to send to the gateway (inside the /24) and to 8.8.8.8 (no route).
#   - CONTROL: a container on an ordinary (not internal) network looks up TOKEN-control.invalid through its resolver AND asks 1.1.1.1 directly. This one MUST be seen on the uplink. If it is not, the capture is blind and the verdict
#     is FAIL (never a pass).
# The verdict is ONE fixed line, `TSL L3.egress-capture PASS|FAIL <name> | <detail>`, which the job's judge requires to be PASS. It holds with or without a per-round DROP of 127.0.0.11 (the seal5 lane): the sealed token must not leave
# either way. Nothing but the text summary is kept; the pcap is never uploaded (it is deleted with the job's temp directory).
#
# PASS needs all of: the control token on the uplink; the sealed token on NO interface; the capture not truncated and the sealed probe's own result present; no 172.16/12 or 192.168/16 source address on the uplink (other than the
# uplink's own addresses); on the probe's rvi bridge at least one packet seen (the capture sees the bridge) and none to a destination outside the bridge's /24 (ARP and IPv6 are not IPv4 flows and are not counted).
# Input to the verdict is tcpdump's text (-nn -e -r file), so it can be tested without tcpdump.

readonly EG_CAPTURE_MAX_PACKETS=1000000
readonly EG_SNAPLEN=160
readonly EG_SEALED_SUBNET_PREFIX=172.30.254
readonly EG_SEALED_NETWORK=tsl-egress-sealed
readonly EG_OPEN_NETWORK=tsl-egress-open

eg_log() { printf 'ci-egress-capture: %s\n' "$*" >&2; }

# The probe program run inside both containers: node, from the worker image. argv: mode name gateway.
read -r -d '' EG_PROBE_JS <<'JS' || true
const dns = require("node:dns"), dgram = require("node:dgram");
const [mode, name, gateway] = process.argv.slice(1);
const out = {};
const done = () => console.log(JSON.stringify(out));
const ask = (label, servers, next) => { const r = new dns.Resolver({ timeout: 2000, tries: 1 }); if (servers) r.setServers(servers); r.resolve4(name, (e, a) => { out[label] = e ? e.code : (a || []).length; next(); }); };
const send = (label, host, port, next) => { const s = dgram.createSocket("udp4"); s.on("error", (e) => { out[label] = e.code; try { s.close(); } catch {} next(); }); s.send("x", port, host, (e) => { out[label] = e ? e.code : "sent"; try { s.close(); } catch {} next(); }); };
if (mode === "sealed") ask("embedded", ["127.0.0.11"], () => send("gateway", gateway, 9, () => send("public", "8.8.8.8", 53, done)));
else ask("system", null, () => ask("direct", ["1.1.1.1"], done));
JS

# eg_prepare DIR: random token, the uplink, tcpdump present. Sets EG_DIR EG_TOKEN EG_UPLINK EG_UPLINK_IPS EG_BRIDGE.
eg_prepare() {
  EG_DIR=$1
  mkdir -p "$EG_DIR" || return 1
  EG_TOKEN=egress$(head -c6 /dev/urandom | od -An -tx1 | tr -d ' \n')
  EG_BRIDGE=rvi$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')
  EG_UPLINK=$(ip -o -4 route show default | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')
  [[ -n "$EG_UPLINK" ]] || { eg_log "no default-route interface"; return 1; }
  EG_UPLINK_IPS=$(ip -o -4 addr show dev "$EG_UPLINK" | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')
  if ! command -v tcpdump >/dev/null; then
    local n
    for n in 1 2 3; do apt-get install -y -qq tcpdump >/dev/null 2>&1 && break; apt-get update -qq >/dev/null 2>&1 || true; sleep $((n * 3)); done
  fi
  command -v tcpdump >/dev/null || { eg_log "tcpdump could not be installed"; return 1; }
  eg_log "token $EG_TOKEN, uplink $EG_UPLINK ($EG_UPLINK_IPS), probe bridge $EG_BRIDGE, $(tcpdump --version 2>&1 | head -n1)"
}

# eg_capture_start: bounded in packets (EG_CAPTURE_MAX_PACKETS) and bytes per packet (EG_SNAPLEN) and in time (the step's own limit stops the job).
eg_capture_start() {
  : > "$EG_DIR/tcpdump.err"
  tcpdump -i any -nn -e -s "$EG_SNAPLEN" -U -c "$EG_CAPTURE_MAX_PACKETS" -w "$EG_DIR/all.pcap" 2> "$EG_DIR/tcpdump.err" &
  EG_TCPDUMP_PID=$!
  local n
  for n in $(seq 1 20); do grep -q 'listening on' "$EG_DIR/tcpdump.err" && return 0; kill -0 "$EG_TCPDUMP_PID" 2>/dev/null || break; sleep 0.5; done
  eg_log "tcpdump did not start: $(tr '\n' ' ' < "$EG_DIR/tcpdump.err")"
  return 1
}

# eg_probes WORKER_IMAGE: the sealed query and the positive control. Always removes what it made.
eg_probes() {
  local image=$1 common sealed_out control_out
  : > "$EG_DIR/probe-sealed.json"; : > "$EG_DIR/probe-control.json"
  docker network rm "$EG_SEALED_NETWORK" "$EG_OPEN_NETWORK" >/dev/null 2>&1 || true
  # The sealed network: internal, on a /24 of its own, with an rvi bridge name, so the boot firewall's rvi walls apply to it exactly as to a run's network.
  docker network create --internal --driver bridge --subnet "$EG_SEALED_SUBNET_PREFIX.0/24" --gateway "$EG_SEALED_SUBNET_PREFIX.1" --opt "com.docker.network.bridge.name=$EG_BRIDGE" "$EG_SEALED_NETWORK" >/dev/null || { eg_log "could not create the sealed probe network"; return 1; }
  docker network create --driver bridge "$EG_OPEN_NETWORK" >/dev/null || { eg_log "could not create the control network"; docker network rm "$EG_SEALED_NETWORK" >/dev/null 2>&1 || true; return 1; }
  common=(--rm --cap-drop ALL --security-opt no-new-privileges --read-only --pids-limit 4096 --entrypoint /usr/local/bin/node)
  timeout --foreground 60 docker run "${common[@]}" --network "$EG_SEALED_NETWORK" --ip "$EG_SEALED_SUBNET_PREFIX.4" --user 1000:1000 "$image" -e "$EG_PROBE_JS" sealed "$EG_TOKEN-sealed.invalid" "$EG_SEALED_SUBNET_PREFIX.1" > "$EG_DIR/probe-sealed.json" 2> "$EG_DIR/probe-sealed.err" || eg_log "the sealed probe exited non-zero"
  timeout --foreground 60 docker run "${common[@]}" --network "$EG_OPEN_NETWORK" --user 1000:1000 "$image" -e "$EG_PROBE_JS" control "$EG_TOKEN-control.invalid" x > "$EG_DIR/probe-control.json" 2> "$EG_DIR/probe-control.err" || eg_log "the control probe exited non-zero"
  docker network rm "$EG_SEALED_NETWORK" "$EG_OPEN_NETWORK" >/dev/null 2>&1 || true
  eg_log "sealed probe: $(cat "$EG_DIR/probe-sealed.json") | control probe: $(cat "$EG_DIR/probe-control.json")"
}

# eg_cleanup: on exit, whatever happened: stop tcpdump if it still runs and remove the probe networks.
eg_cleanup() {
  [[ -z "${EG_TCPDUMP_PID:-}" ]] || kill "$EG_TCPDUMP_PID" 2>/dev/null || true
  docker network rm "$EG_SEALED_NETWORK" "$EG_OPEN_NETWORK" >/dev/null 2>&1 || true
}

# eg_capture_stop: let the last packets land, stop tcpdump, render it as text. EG_PACKETS = packets captured.
eg_capture_stop() {
  sleep 3
  kill -INT "$EG_TCPDUMP_PID" 2>/dev/null || true
  wait "$EG_TCPDUMP_PID" 2>/dev/null || true
  EG_PACKETS=$(sed -n 's/^\([0-9][0-9]*\) packets captured.*/\1/p' "$EG_DIR/tcpdump.err" | tail -n1)
  tcpdump -nn -e -r "$EG_DIR/all.pcap" > "$EG_DIR/all.txt" 2>/dev/null || true
}

# eg_verdict TEXT_FILE: prints ONE line `TSL L3.egress-capture PASS|FAIL ...` (and the evidence counts) from tcpdump's text. Reads EG_TOKEN EG_UPLINK EG_UPLINK_IPS EG_BRIDGE EG_PACKETS EG_DIR.
# Packet lines look like `12:00:00.000001 <iface> In|Out ifindex N <mac> ethertype IPv4 (0x0800), length N: <src>[.port] > <dst>[.port]: ...` (the Linux cooked v2 header of `-i any`).
eg_verdict() {
  local txt=$1 fails="" flows ctl_up sealed_any lan_src bridge_n bridge_out probe
  flows=$(mktemp "${TMPDIR:-/tmp}/eg-flows.XXXXXX")
  sed -nE 's/^[0-9:.]+ +([^ ]+) +(In|Out) .*ethertype IPv4 \(0x0800\), length [0-9]+: ([0-9]+(\.[0-9]+){3})(\.[0-9]+)? > ([0-9]+(\.[0-9]+){3})(\.[0-9]+)?:.*/\1 \3 \6/p' "$txt" > "$flows"
  grep -q "[^[:space:]]" "$txt" || fails="$fails capture-empty"
  probe=$(cat "${EG_DIR:-/nonexistent}/probe-sealed.json" 2>/dev/null || true)
  [[ "$probe" == \{* ]] || fails="$fails sealed-probe-gave-no-result"
  if [[ -n "${EG_PACKETS:-}" && "$EG_PACKETS" -ge "$EG_CAPTURE_MAX_PACKETS" ]]; then fails="$fails capture-truncated-at-${EG_CAPTURE_MAX_PACKETS}-packets"; fi
  ctl_up=$(grep -E "^[0-9:.]+ +${EG_UPLINK} " "$txt" | grep -c -- "${EG_TOKEN}-control" || true)
  [[ "${ctl_up:-0}" -ge 1 ]] || fails="$fails capture-blind-control-not-seen-on-the-uplink"
  sealed_any=$(grep -c -- "${EG_TOKEN}-sealed" "$txt" || true)
  [[ "${sealed_any:-0}" -eq 0 ]] || fails="$fails sealed-token-seen-${sealed_any}-times"
  # Container addresses (172.16/12, 192.168/16) as the SOURCE of a packet on the uplink, other than the uplink's own addresses.
  lan_src=$(awk -v up="$EG_UPLINK" -v own=" ${EG_UPLINK_IPS} " '$1 == up && ($2 ~ /^172\.(1[6-9]|2[0-9]|3[01])\./ || $2 ~ /^192\.168\./) && index(own, " " $2 " ") == 0 { n++ } END { print n + 0 }' "$flows")
  [[ "$lan_src" -eq 0 ]] || fails="$fails container-address-as-source-on-the-uplink-${lan_src}-packets"
  bridge_n=$(awk -v b="$EG_BRIDGE" '$1 == b { n++ } END { print n + 0 }' "$flows")
  [[ "$bridge_n" -ge 1 ]] || fails="$fails capture-blind-nothing-seen-on-the-rvi-bridge"
  bridge_out=$(awk -v b="$EG_BRIDGE" -v p="$EG_SEALED_SUBNET_PREFIX." '$1 == b && index($3, p) != 1 { n++ } END { print n + 0 }' "$flows")
  [[ "$bridge_out" -eq 0 ]] || fails="$fails rvi-bridge-packets-to-outside-the-run-subnet-${bridge_out}"
  if [[ -z "$fails" ]]; then
    printf 'TSL L3.egress-capture PASS no-packet-left-the-host-for-a-non-run-address | control seen on %s (%s lines); sealed token seen 0 times; 0 container-source packets on the uplink; %s packets on %s, all inside %s.0/24; %s packets captured; sealed probe %s\n' \
      "$EG_UPLINK" "$ctl_up" "$bridge_n" "$EG_BRIDGE" "$EG_SEALED_SUBNET_PREFIX" "${EG_PACKETS:-?}" "$probe"
  else
    printf 'TSL L3.egress-capture FAIL no-packet-left-the-host-for-a-non-run-address | %s\n' "${fails# }"
  fi
  rm -f "$flows"
  [[ -z "$fails" ]]
}
