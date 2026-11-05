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
# WHAT A PASS MEANS, AND WHAT IT DOES NOT. PASS needs all of: the system-resolver lookup AND the direct 1.1.1.1 query of the control both seen on the uplink (so the capture sees the uplink and the path a container's lookup takes); the sealed token on
# NO interface (the host's loopback included, so even a query handed to a local resolver is caught); the capture running to the end, not truncated, with a readable packet count; the sealed probe's own result proving the query was sent and got
# no answer (embedded: ETIMEOUT, ESERVFAIL, ENOTFOUND, ENODATA or EREFUSED, never an address; public: no route; gateway: sent); no 172.16/12 or 192.168/16 SOURCE address on an outgoing uplink packet; on the probe's rvi bridge at least one IPv4
# packet seen (the capture sees the bridge) and none to a destination outside the bridge's /24 (multicast, broadcast and 0.0.0.0 are the segment's own); on ANY rvi* bridge no IPv6 packet other than link-local (fe80::/10, ff02::/16) or `::`.
# It does NOT show that nothing masqueraded left the host: traffic from an ordinary (non-internal) Docker network is source-NATed to the host address, so it carries the host's IP on the uplink and is not told apart by address (the sealed token
# check is what covers DNS for that path); an --internal network has no masquerade and no route, so a container address as a source on the uplink can only be a leak. The name of the PASS says exactly this.
# Input to the verdict is tcpdump's text (-nn -e -r file), so it can be tested without tcpdump. Tokens are matched case-insensitively (a resolver may randomise the case of a query name). The names are under .example, not .invalid: a local
# systemd-resolved can answer .invalid itself, which would make the control look blind on a healthy runner.

# Re-sourcing is harmless (the constants are readonly once).
if [[ -z "${EG_CAPTURE_MAX_PACKETS:-}" ]]; then
  readonly EG_CAPTURE_MAX_PACKETS=1000000
  readonly EG_SNAPLEN=160
  readonly EG_SEALED_SUBNET_PREFIX=172.30.254
  readonly EG_SEALED_NETWORK=tsl-egress-sealed
  readonly EG_OPEN_NETWORK=tsl-egress-open
  readonly EG_SEALED_CONTAINER=tsl-egress-sealed-probe
  readonly EG_OPEN_CONTAINER=tsl-egress-control-probe
  readonly EG_EVIDENCE_LINES=40
fi

eg_log() { printf 'ci-egress-capture: %s\n' "$*" >&2; }

# The probe program run inside both containers: node, from the worker image. argv: mode name gateway. Sealed: name is the full query name. Control: name is the token; it asks <token>-control.example through the container's own resolver and <token>-direct.example from 1.1.1.1.
read -r -d '' EG_PROBE_JS <<'JS' || true
const dns = require("node:dns"), dgram = require("node:dgram");
const [mode, name, gateway] = process.argv.slice(1);
const out = {};
const done = () => console.log(JSON.stringify(out));
const ask = (label, qname, servers, next) => { const r = new dns.Resolver({ timeout: 2000, tries: 1 }); if (servers) r.setServers(servers); r.resolve4(qname, (e, a) => { out[label] = e ? e.code : (a || []).length; next(); }); };
const send = (label, host, port, next) => { const s = dgram.createSocket("udp4"); s.on("error", (e) => { out[label] = e.code; try { s.close(); } catch {} next(); }); s.send("x", port, host, (e) => { out[label] = e ? e.code : "sent"; try { s.close(); } catch {} next(); }); };
const later = (ms, next) => setTimeout(next, ms);
if (mode === "sealed") ask("embedded", name, ["127.0.0.11"], () => send("gateway", gateway, 9, () => later(1500, () => send("gateway2", gateway, 9, () => later(500, () => send("public", "8.8.8.8", 53, done))))));
else ask("system", name + "-control.example", null, () => ask("direct", name + "-direct.example", ["1.1.1.1"], done));
JS

# eg_prepare DIR: random token, the uplink, tcpdump present. Sets EG_DIR EG_TOKEN EG_UPLINK EG_UPLINK_IPS EG_BRIDGE.
eg_prepare() {
  EG_DIR=$1
  mkdir -p "$EG_DIR" || return 1
  chmod 0755 "$EG_DIR" || return 1
  EG_TOKEN=egress$(head -c6 /dev/urandom | od -An -tx1 | tr -d ' \n')
  EG_BRIDGE=rvi$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')
  EG_UPLINK=$(ip -o -4 route show default | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')
  [[ -n "$EG_UPLINK" ]] || { eg_log "no default-route interface"; return 1; }
  EG_UPLINK_IPS=$(ip -o -4 addr show dev "$EG_UPLINK" | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')
  if ! command -v tcpdump >/dev/null; then
    local n
    for n in 1 2 3; do DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tcpdump >/dev/null 2>&1 && break; DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true; sleep $((n * 3)); done
  fi
  command -v tcpdump >/dev/null || { eg_log "tcpdump could not be installed"; return 1; }
  eg_log "token $EG_TOKEN, uplink $EG_UPLINK ($EG_UPLINK_IPS), probe bridge $EG_BRIDGE, $(tcpdump --version 2>&1 | head -n1)"
}

# eg_capture_start: runs as root (-Z root: tcpdump would otherwise drop to its own user before it opens the file, and the directory is root's); bounded in packets (EG_CAPTURE_MAX_PACKETS) and bytes per packet (EG_SNAPLEN) and in time (the step's own limit stops the job).
eg_capture_start() {
  : > "$EG_DIR/tcpdump.err"
  tcpdump -Z root -i any -nn -e -s "$EG_SNAPLEN" -U -c "$EG_CAPTURE_MAX_PACKETS" -w "$EG_DIR/all.pcap" 2> "$EG_DIR/tcpdump.err" &
  EG_TCPDUMP_PID=$!
  local n
  for n in $(seq 1 20); do grep -q 'listening on' "$EG_DIR/tcpdump.err" && return 0; kill -0 "$EG_TCPDUMP_PID" 2>/dev/null || break; sleep 0.5; done
  eg_log "tcpdump did not start: $(tr '\n' ' ' < "$EG_DIR/tcpdump.err")"
  return 1
}

# eg_probes WORKER_IMAGE: the sealed query and the positive control. Always removes what it made.
eg_probes() {
  local image=$1 common
  : > "$EG_DIR/probe-sealed.json"; : > "$EG_DIR/probe-control.json"
  docker rm -f "$EG_SEALED_CONTAINER" "$EG_OPEN_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$EG_SEALED_NETWORK" "$EG_OPEN_NETWORK" >/dev/null 2>&1 || true
  # The sealed network: internal, on a /24 of its own, with an rvi bridge name, so the boot firewall's rvi walls apply to it exactly as to a run's network.
  docker network create --internal --driver bridge --subnet "$EG_SEALED_SUBNET_PREFIX.0/24" --gateway "$EG_SEALED_SUBNET_PREFIX.1" --opt "com.docker.network.bridge.name=$EG_BRIDGE" "$EG_SEALED_NETWORK" >/dev/null || { eg_log "could not create the sealed probe network"; return 1; }
  docker network create --driver bridge "$EG_OPEN_NETWORK" >/dev/null || { eg_log "could not create the control network"; docker network rm "$EG_SEALED_NETWORK" >/dev/null 2>&1 || true; return 1; }
  common=(--rm --cap-drop ALL --security-opt no-new-privileges --read-only --pids-limit 4096 --entrypoint /usr/local/bin/node)
  timeout --foreground 60 docker run "${common[@]}" --name "$EG_SEALED_CONTAINER" --network "$EG_SEALED_NETWORK" --ip "$EG_SEALED_SUBNET_PREFIX.4" --user 1000:1000 "$image" -e "$EG_PROBE_JS" sealed "$EG_TOKEN-sealed.example" "$EG_SEALED_SUBNET_PREFIX.1" > "$EG_DIR/probe-sealed.json" 2> "$EG_DIR/probe-sealed.err" || eg_log "the sealed probe exited non-zero"
  timeout --foreground 60 docker run "${common[@]}" --name "$EG_OPEN_CONTAINER" --network "$EG_OPEN_NETWORK" --user 1000:1000 "$image" -e "$EG_PROBE_JS" control "$EG_TOKEN" x > "$EG_DIR/probe-control.json" 2> "$EG_DIR/probe-control.err" || eg_log "the control probe exited non-zero"
  docker network rm "$EG_SEALED_NETWORK" "$EG_OPEN_NETWORK" >/dev/null 2>&1 || true
  eg_log "sealed probe: $(cat "$EG_DIR/probe-sealed.json") | control probe: $(cat "$EG_DIR/probe-control.json")"
}

# eg_cleanup: on exit, whatever happened: stop tcpdump if it still runs, remove the probe containers and networks, and delete the pcap (it is never kept).
eg_cleanup() {
  [[ -z "${EG_TCPDUMP_PID:-}" ]] || kill "$EG_TCPDUMP_PID" 2>/dev/null || true
  docker rm -f "$EG_SEALED_CONTAINER" "$EG_OPEN_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$EG_SEALED_NETWORK" "$EG_OPEN_NETWORK" >/dev/null 2>&1 || true
  [[ -z "${EG_DIR:-}" ]] || rm -f "$EG_DIR/all.pcap"
}

# eg_capture_stop: let the last packets land, stop tcpdump, render it as text. EG_PACKETS = packets captured.
eg_capture_stop() {
  sleep 3
  # tcpdump must still be running now: if it is gone it died, or reached its packet cap, and the end of the round is not in the file.
  if kill -0 "$EG_TCPDUMP_PID" 2>/dev/null; then EG_TCPDUMP_ALIVE=1; kill -INT "$EG_TCPDUMP_PID" 2>/dev/null || true; else EG_TCPDUMP_ALIVE=0; fi
  wait "$EG_TCPDUMP_PID" 2>/dev/null || true
  EG_PACKETS=$(sed -n 's/^\([0-9][0-9]*\) packets captured.*/\1/p' "$EG_DIR/tcpdump.err" | tail -n1)
  tcpdump -Z root -nn -e -r "$EG_DIR/all.pcap" > "$EG_DIR/all.txt" 2>/dev/null || true
}

# eg_verdict TEXT_FILE: prints ONE verdict line `TSL L3.egress-capture PASS|FAIL ...`; on FAIL it adds up to EG_EVIDENCE_LINES lines `egress-evidence: ...` (interface, direction and addresses of the offending packets, the sealed token's own
# lines, the probes' stderr; never a payload) so a failed run can be diagnosed from the log. Reads EG_TOKEN EG_UPLINK EG_UPLINK_IPS EG_BRIDGE EG_PACKETS EG_DIR (and EG_TCPDUMP_ALIVE, default 1).
# Packet lines look like `12:00:00.000001 <iface> <In|Out|B|M|P> ifindex N <mac> ethertype IPv4 (0x0800), length N: <src>[.port] > <dst>[.port]: ...` (the Linux cooked v2 header of `-i any`).
eg_verdict() {
  local txt=$1 fails="" flows flows6 ev sys_up direct_up sealed_any lan_src bridge_n bridge_out v6_n probe f
  flows=$(mktemp "${TMPDIR:-/tmp}/eg-flows.XXXXXX"); flows6=$(mktemp "${TMPDIR:-/tmp}/eg-flows6.XXXXXX"); ev=$(mktemp "${TMPDIR:-/tmp}/eg-evidence.XXXXXX")
  # flows: iface direction source destination (IPv4); flows6: the same for IPv6.
  sed -nE 's/^[0-9:.]+ +([^ ]+) +([A-Za-z]+) .*ethertype IPv4 \(0x0800\), length [0-9]+: ([0-9]+(\.[0-9]+){3})(\.[0-9]+)? > ([0-9]+(\.[0-9]+){3})(\.[0-9]+)?:.*/\1 \2 \3 \6/p' "$txt" > "$flows"
  sed -nE 's/^[0-9:.]+ +([^ ]+) +([A-Za-z]+) .*ethertype IPv6 \(0x86dd\), length [0-9]+: ([0-9a-fA-F:]+)(\.[0-9]+)? > ([0-9a-fA-F:]+)(\.[0-9]+)?:.*/\1 \2 \3 \5/p' "$txt" > "$flows6"
  grep -q "[^[:space:]]" "$txt" || fails="$fails capture-empty"
  [[ "${EG_TCPDUMP_ALIVE:-1}" == 1 ]] || fails="$fails tcpdump-was-not-running-at-the-end"
  [[ "${EG_PACKETS:-}" =~ ^[0-9]+$ ]] || fails="$fails capture-packet-count-unreadable"
  if [[ "${EG_PACKETS:-}" =~ ^[0-9]+$ && "$EG_PACKETS" -ge "$EG_CAPTURE_MAX_PACKETS" ]]; then fails="$fails capture-truncated-at-${EG_CAPTURE_MAX_PACKETS}-packets"; fi
  # The sealed probe must prove the query was SENT and got NO answer: an address, a missing key, a refused connection or a missing route proves nothing.
  probe=$(cat "${EG_DIR:-/nonexistent}/probe-sealed.json" 2>/dev/null || true)
  if [[ "$probe" != \{* ]]; then fails="$fails sealed-probe-gave-no-result"
  else
    printf '%s' "$probe" | grep -Eq '"embedded":"(ETIMEOUT|ESERVFAIL|ENOTFOUND|ENODATA|EREFUSED)"' || fails="$fails sealed-probe-embedded-query-not-sent-or-answered"
    printf '%s' "$probe" | grep -Eq '"public":"(ENETUNREACH|EHOSTUNREACH|ENETDOWN)"' || fails="$fails sealed-probe-public-address-had-a-route"
    printf '%s' "$probe" | grep -Eq '"gateway":"sent"' || fails="$fails sealed-probe-gateway-packet-not-sent"
  fi
  sys_up=$(grep -E "^[0-9:.]+ +${EG_UPLINK} " "$txt" | grep -ic -- "${EG_TOKEN}-control" || true)
  [[ "${sys_up:-0}" -ge 1 ]] || fails="$fails capture-blind-system-lookup-not-seen-on-the-uplink"
  direct_up=$(grep -E "^[0-9:.]+ +${EG_UPLINK} " "$txt" | grep -ic -- "${EG_TOKEN}-direct" || true)
  [[ "${direct_up:-0}" -ge 1 ]] || fails="$fails capture-blind-direct-query-not-seen-on-the-uplink"
  sealed_any=$(grep -ic -- "${EG_TOKEN}-sealed" "$txt" || true)
  if [[ "${sealed_any:-0}" -ne 0 ]]; then fails="$fails sealed-token-seen-${sealed_any}-times"; grep -i -- "${EG_TOKEN}-sealed" "$txt" | head -n "$EG_EVIDENCE_LINES" | cut -c1-200 | sed 's/^/sealed-token-line: /' >> "$ev"; fi
  # Container addresses (172.16/12, 192.168/16) as the SOURCE of an OUTGOING packet on the uplink, other than the uplink's own addresses. (Incoming packets carry the peers' addresses.)
  awk -v up="$EG_UPLINK" -v own=" ${EG_UPLINK_IPS} " '$1 == up && $2 == "Out" && ($3 ~ /^172\.(1[6-9]|2[0-9]|3[01])\./ || $3 ~ /^192\.168\./) && index(own, " " $3 " ") == 0 { print "uplink-container-source: " $0 }' "$flows" > "$flows.lan"
  lan_src=$(wc -l < "$flows.lan" | tr -d ' ')
  [[ "$lan_src" -eq 0 ]] || { fails="$fails container-address-as-source-on-the-uplink-${lan_src}-packets"; head -n "$EG_EVIDENCE_LINES" "$flows.lan" >> "$ev"; }
  # The bridge is seen when the sealed probe's own address (.4) shows on it: its IPv4 packet to the gateway, or its ARP for the gateway. A first packet to the gateway waits for ARP, so on a
  # short-lived container the ARP may be all there is (CI run 42090076679: zero IPv4 lines on the bridge). Anything else on the bridge does not count: it must be the probe.
  bridge_n=$(awk -v b="$EG_BRIDGE" -v a="$EG_SEALED_SUBNET_PREFIX.4" '$2 == b && ((/ ethertype ARP / && index($0, " tell " a ",") > 0) || (/ ethertype IPv4 / && index($0, ": " a ".") > 0)) { n++ } END { print n + 0 }' "$txt")
  if [[ "$bridge_n" -lt 1 ]]; then
    fails="$fails capture-blind-nothing-seen-on-the-rvi-bridge"
    # So the next blind run can be diagnosed: lines per interface, and what the rvi interfaces carried (headers only; the snap length keeps payloads out).
    awk '{ c[$2]++ } END { for (i in c) print "lines-per-interface: " i " " c[i] }' "$txt" | sort | head -n 12 >> "$ev"
    awk '$2 ~ /^(rvi|veth)/' "$txt" | head -n 10 | cut -c1-200 | sed 's/^/rvi-or-veth-line: /' >> "$ev"
  fi
  # Destinations outside the probe bridge's /24. Multicast (224/4), broadcast and 0.0.0.0 are the segment's own and are not counted.
  awk -v b="$EG_BRIDGE" -v p="$EG_SEALED_SUBNET_PREFIX." '$1 == b && index($4, p) != 1 && $4 !~ /^(22[4-9]|23[0-9])\./ && $4 != "255.255.255.255" && $4 != "0.0.0.0" { print "rvi-outside-subnet: " $0 }' "$flows" > "$flows.out"
  bridge_out=$(wc -l < "$flows.out" | tr -d ' ')
  [[ "$bridge_out" -eq 0 ]] || { fails="$fails rvi-bridge-packets-to-outside-the-run-subnet-${bridge_out}"; head -n "$EG_EVIDENCE_LINES" "$flows.out" >> "$ev"; }
  # IPv6 on ANY rvi* bridge: only link-local (fe80::/10), ff02::/16 and the unspecified address.
  awk '$1 ~ /^rvi/ && !($3 ~ /^([fF][eE][89abAB][0-9a-fA-F]:|[fF][fF]02:|::$)/ && $4 ~ /^([fF][eE][89abAB][0-9a-fA-F]:|[fF][fF]02:|::$)/) { print "rvi-ipv6: " $0 }' "$flows6" > "$flows.v6"
  v6_n=$(wc -l < "$flows.v6" | tr -d ' ')
  [[ "$v6_n" -eq 0 ]] || { fails="$fails rvi-bridge-non-link-local-ipv6-${v6_n}-packets"; head -n "$EG_EVIDENCE_LINES" "$flows.v6" >> "$ev"; }
  if [[ -z "$fails" ]]; then
    printf 'TSL L3.egress-capture PASS no-sealed-token-or-container-source-leak-seen | control lookup seen on %s (%s lines) and direct query (%s lines); sealed token seen 0 times on any interface; 0 container-source packets leaving the uplink; %s IPv4 packets on %s, all inside %s.0/24; no non-link-local IPv6 on any rvi bridge; %s packets captured; sealed probe %s\n' \
      "$EG_UPLINK" "$sys_up" "$direct_up" "$bridge_n" "$EG_BRIDGE" "$EG_SEALED_SUBNET_PREFIX" "${EG_PACKETS:-?}" "$probe"
  else
    printf 'TSL L3.egress-capture FAIL no-sealed-token-or-container-source-leak-seen | %s\n' "${fails# }"
    for f in "$EG_DIR/probe-sealed.err" "$EG_DIR/probe-control.err" "$EG_DIR/tcpdump.err"; do
      if [[ -s "$f" ]]; then printf 'probe-stderr %s: %s\n' "$(basename "$f")" "$(head -c 400 "$f" | tr '\n' ' ')" >> "$ev"; fi
    done
    head -n "$EG_EVIDENCE_LINES" "$ev" | cut -c1-240 | sed 's/^/egress-evidence: /'
  fi
  rm -f "$flows" "$flows.lan" "$flows.out" "$flows.v6" "$flows6" "$ev"
  [[ -z "$fails" ]]
}
