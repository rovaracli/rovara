import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// scripts/linux-check-test-services.sh (TS37): the read-only skeleton of the Linux checks TS-L1 to TS-L8. It runs here against fake iptables, ip and docker tools (the script fixes its own PATH, so the test runs a copy whose
// PATH line points at the fakes). Nothing starts Docker; the fake docker logs every call so the test can prove the script only ever reads.
const scriptText = readFileSync(new URL("../../scripts/linux-check-test-services.sh", import.meta.url), "utf8");
const PATH_LINE = /^export LC_ALL=C PATH=.*$/mu;
/** The script without its two marked live blocks (the driver's launcher and the call that is made only when TSL_DIR is set): everything else must stay read-only. */
const readOnlyPart = scriptText.replace(/^# BEGIN LIVE:[\s\S]*?^# END LIVE$/mu, "").replace(/^# BEGIN LIVE CALL$[\s\S]*?^# END LIVE CALL$/mu, "");

const GOOD_DOCKER_USER = [
  "-P DOCKER-USER ACCEPT",
  "-A DOCKER-USER -d 169.254.169.254/32 -j DROP",
  "-A DOCKER-USER -i rvi+ -o rvi+ -m physdev ! --physdev-is-bridged -j DROP",
  "-A DOCKER-USER -i rvi+ ! -o rvi+ -j DROP",
  ...["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"].map((range) => `-A DOCKER-USER -i rvb+ -d ${range} -j DROP`),
].join("\n");
const GOOD_INPUT = ["-P INPUT ACCEPT", "-A INPUT -i rvb+ -j DROP", "-A INPUT -i rvi+ -j DROP"].join("\n");

// What Docker's own chains look like in `iptables -S` (the iptables-nft front end of Amazon Linux 2023 prints the same).
const GOOD_CHAINS = ["-P FORWARD DROP", "-N DOCKER", "-N DOCKER-ISOLATION-STAGE-1", "-N DOCKER-USER", "-A FORWARD -j DOCKER-USER", "-A FORWARD -j DOCKER-ISOLATION-STAGE-1"].join("\n");

const GOOD_DAEMON = JSON.stringify({ "data-root": "/data", "default-address-pools": [{ base: "172.18.0.0/15", size: 24 }, { base: "172.20.0.0/14", size: 24 }, { base: "172.28.0.0/16", size: 24 }, { base: "192.168.0.0/16", size: 24 }] }, null, 2);

interface World {
  nat?: string; ip6input?: string | null; ipv6Active?: boolean; liveLines?: string; pullList?: string; pullFails?: boolean; liveDir?: boolean; pullBlocked?: boolean; imds?: string | null; daemonJson?: string; iptablesVersion?: string; chains?: string; dockerVersion?: string; familyBridges?: Record<string, string>; dockerChainRules?: string[]; dockerUser?: string; input?: string; routes?: string; docker?: boolean; agentxTaskInternal?: string; networks?: Record<string, string>; familyNetworks?: string[]; familyContainers?: string[]; mounts?: Record<string, string> }

function run(world: World = {}, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ts-linux-check-"));
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  const tool = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  const files = { "docker-user": world.dockerUser ?? GOOD_DOCKER_USER, input: world.input ?? GOOD_INPUT, routes: world.routes ?? "default via 10.0.0.1 dev eth0\n10.0.0.0/24 dev eth0 proto kernel\n172.17.0.0/16 dev docker0 proto kernel\n" };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "chains"), `${world.chains ?? GOOD_CHAINS}\n`);
  writeFileSync(join(dir, "daemon.json"), world.daemonJson ?? GOOD_DAEMON);
  writeFileSync(join(dir, "docker-chain-rules"), (world.dockerChainRules ?? []).map((rule) => `${rule}\n`).join(""));
  tool("iptables", [
    `echo "$@" >> "${dir}/iptables.calls"`,
    `if [ "$1" = "--version" ]; then echo "${world.iptablesVersion ?? "iptables v1.8.8 (nf_tables)"}"; exit 0; fi`,
    `if [ "$1 $2 $3" = "-t nat -S" ]; then cat "${dir}/nat"; exit 0; fi`,
    `[ "$1" = "-S" ] || exit 2`,
    `case "$2" in "") cat "${dir}/chains" "${dir}/docker-user" "${dir}/input" "${dir}/docker-chain-rules" ;; DOCKER-USER) cat "${dir}/docker-user" ;; INPUT) cat "${dir}/input" ;; *) exit 1 ;; esac`,
  ].join("\n"));
  writeFileSync(join(dir, "nat"), world.nat ?? "-P PREROUTING ACCEPT\n-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE\n");
  writeFileSync(join(dir, "ip6input"), `${world.ip6input ?? "-P INPUT ACCEPT\n-A INPUT -i rvi+ -j DROP"}\n`);
  if (world.ip6input !== null) tool("ip6tables", [`echo "$@" >> "${dir}/ip6tables.calls"`, `[ "$1 $2" = "-S INPUT" ] || exit 2`, `cat "${dir}/ip6input"`].join("\n"));
  writeFileSync(join(dir, "if_inet6"), "");
  writeFileSync(join(dir, "disable_ipv6"), "0\n");
  // for the live parts: the tools the delivered driver's launcher uses
  tool("aws", `echo "aws $@" >> "${dir}/aws.calls"; if [ "$2" = batch-get-image ]; then printf '{"schemaVersion":2}'; else echo fake-token; fi`);
  tool("curl", world.imds === null ? "exit 22" : `case "$*" in *"-X PUT"*) echo imds-token ;; *) echo '${world.imds ?? '{"accountId" : "944937319445", "region" : "us-west-2"}'}' ;; esac`);
  tool("timeout", `while [ "\${1#--}" != "$1" ]; do shift; done; shift; exec "$@"`);
  tool("stat", `echo 100`);
  writeFileSync(join(dir, "live-lines"), world.liveLines ?? "");
  writeFileSync(join(dir, "pull-list"), world.pullList ?? "944937319445.dkr.ecr.us-west-2.amazonaws.com/rovara-catalog/staging/svc/postgres@sha256:" + "b".repeat(64) + "\n");
  writeFileSync(join(dir, "worker-image"), "944937319445.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@sha256:" + "a".repeat(64) + "\n");
  writeFileSync(join(dir, "worker.env"), "AWS_REGION=us-west-2\n");
  tool("ip", `[ "$1 $2 $3" = "-4 route show" ] || exit 2\ncat "${dir}/routes"`);
  const listing = (items: string[]) => items.map((item) => `${item}\n`).join("");
  const networks = world.networks ?? { n1: "172.17.0.0/16" };
  writeFileSync(join(dir, "networks"), listing(Object.entries(networks).map(([id, subnet]) => `${id}=${subnet}`)));
  writeFileSync(join(dir, "family-networks"), listing(world.familyNetworks ?? []));
  writeFileSync(join(dir, "family-containers"), listing(world.familyContainers ?? []));
  writeFileSync(join(dir, "mounts"), listing(Object.entries(world.mounts ?? {}).map(([id, mount]) => `${id}=${mount}`)));
  writeFileSync(join(dir, "bridges"), listing(Object.entries(world.familyBridges ?? {}).map(([id, bridge]) => `${id}=${bridge}`)));
  writeFileSync(join(dir, "meminfo"), "MemTotal:       16384000 kB\nMemFree:         8000000 kB\n");
  // The fake docker answers only what the script is meant to ask, and logs every call.
  tool("docker", [
    `echo "$@" >> "${dir}/docker.calls"`,
    `if [ -n "\${DOCKER_CONFIG:-}" ]; then echo "$1 $DOCKER_CONFIG" >> "${dir}/docker.config"; fi`,
    `if [ "$1" = run ]; then last="\${!#}"; if [ "$last" = pull-list ]; then ${world.pullFails === true ? "echo boom; exit 1" : world.pullBlocked === true ? "echo 'BLOCKED: no trusted catalog key'; exit 3" : `cat "${dir}/pull-list"`}; exit 0; fi; cat "${dir}/live-lines"; exit 0; fi`,
    `case "$1" in login|logout|pull) exit 0 ;; esac`,
    `case "$1 $2" in`,
    `  "rm -f") exit 0 ;;`,
    `  "network rm") exit 0 ;;`,
    `  "network ls") if [ "$3" = "-q" ] && [ "$4" = "--filter" ]; then cat "${dir}/family-networks"; else cut -d= -f1 "${dir}/networks"; fi ;;`,
    `  "version --format") echo "${world.dockerVersion ?? "25.0.8"}" ;;`,
    `  "network inspect") if [ "$3" = "--format" ] && [[ "$4" == *Options* ]]; then grep "^$5=" "${dir}/bridges" | cut -d= -f2; elif [ "$3" = "--format" ] && [ "$5" = "agentx-task" ]; then echo "${world.agentxTaskInternal ?? "false"}"; else grep "^$5=" "${dir}/networks" | cut -d= -f2; fi ;;`,
    `  "ps -a") cat "${dir}/family-containers" ;;`,
    `  "ps -q") cut -d= -f1 "${dir}/mounts" ;;`,
    `  "inspect --format") grep "^$4=" "${dir}/mounts" | cut -d= -f2 ;;`,
    `  *) echo "unexpected docker call: $*" >&2; exit 9 ;;`,
    `esac`,
  ].join("\n"));
  const withFakes = scriptText.replace(PATH_LINE, `export LC_ALL=C PATH=${bin}:/usr/bin:/bin\nDOCKER_FAKE=${world.docker === false ? "" : join(bin, "docker")}`).replaceAll("/proc/meminfo", join(dir, "meminfo")).replaceAll("/proc/net/if_inet6", world.ipv6Active === true ? join(dir, "if_inet6") : join(dir, "no-if_inet6")).replaceAll("/proc/sys/net/ipv6/conf/all/disable_ipv6", join(dir, "disable_ipv6")).replaceAll("/etc/agentx/worker-image", join(dir, "worker-image")).replaceAll("/etc/agentx/worker.env", join(dir, "worker.env")).replace("DAEMON_JSON=/etc/docker/daemon.json", `DAEMON_JSON=${join(dir, "daemon.json")}`).replace(/^DOCKER=\$\(cat \/etc\/agentx\/docker-path.*$/mu, `DOCKER="$DOCKER_FAKE"`).replace(/^\[\[ "\$DOCKER" == \/\* && -x "\$DOCKER" \]\].*$/mu, "");
  writeFileSync(join(dir, "script.sh"), withFakes);
  const result = spawnSync("/bin/bash", [join(dir, "script.sh"), ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", ...extraEnv } });
  const read = (name: string) => { try { return readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const lines2 = result.stdout.split("\n").filter((line) => line.startsWith("TSL "));
  const byId = (id: string) => lines2.find((line) => line.startsWith(`TSL ${id} `));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, lines: lines2, byId, dockerCalls: read("docker.calls"), iptablesCalls: read("iptables.calls"), ip6tablesCalls: read("ip6tables.calls"), awsCalls: read("aws.calls"), dockerConfigs: read("docker.config"), dir };
}

describe("scripts/linux-check-test-services.sh", () => {
  it("is valid bash and names the eight checks of the design", () => {
    expect(spawnSync("bash", ["-n"], { input: scriptText, encoding: "utf8" }).status).toBe(0);
    for (let n = 1; n <= 8; n += 1) expect(scriptText).toContain(`TS-L${String(n)}`);
  });

  it("on a worker with the walls in place: every read-only part passes, every live part is PENDING (never a pass), and the exit status says unfinished", () => {
    const r = run();
    expect(r.stderr).toBe("");
    const fails = r.lines.filter((line) => line.startsWith("TSL ") && / FAIL /u.test(line));
    expect(fails, r.stdout).toEqual([]);
    for (const id of ["L1.walls", "L1.isolation", "L1.docker-version", "L1.iptables-backend", "L1.range", "L1.pools", "L2.egress-network", "L5.walls", "L6.no-leftovers", "L7.host", "L8.no-socket"]) expect(r.byId(id), id).toMatch(/^TSL \S+ PASS /u);
    for (let n = 1; n <= 8; n += 1) expect(r.byId(`L${String(n)}.live`), `L${String(n)}.live`).toMatch(/^TSL \S+ PENDING /u);
    for (const id of ["L1.live-other-run", "L1.internal-drops"]) expect(r.byId(id), id).toMatch(/^TSL \S+ PENDING /u);
    expect(r.byId("L1.live-other-run")).toContain("another-runs-helper-unreachable");
    // 10 earlier pending parts plus the eight TS-L3 reviewer-list probes (TS16 review round, ee09d8994); the T4 round added L4.template-db.
    for (const id of ["L3.embedded-resolver", "L3.working-relay", "L3.ipv6", "L3.no-route", "L3.other-run", "L3.multicast", "L3.run-files", "L3.spoofing"]) expect(r.byId(id), id).toMatch(/^TSL \S+ PENDING /u);
    expect(r.lines.at(-1)).toMatch(/^TSL SUMMARY pass=11 fail=0 pending=19$/u);
    expect(r.status).toBe(3);
  });

  it("fails L1 when the rvi forward drop or the input drop is missing, and when a rule opens an rvi bridge above the drop", () => {
    const noForward = run({ dockerUser: GOOD_DOCKER_USER.replace("-A DOCKER-USER -i rvi+ ! -o rvi+ -j DROP\n", "") });
    expect(noForward.byId("L1.walls")).toMatch(/ FAIL .*no-DOCKER-USER-rvi-drop/u);
    const noInput = run({ input: "-P INPUT ACCEPT\n-A INPUT -i rvb+ -j DROP" });
    expect(noInput.byId("L1.walls")).toMatch(/ FAIL .*no-INPUT-rvi-drop/u);
    const opened = run({ dockerUser: GOOD_DOCKER_USER.replace("-A DOCKER-USER -i rvi+ ! -o rvi+ -j DROP", "-A DOCKER-USER -i rvi+ -d 172.30.0.0/16 -j RETURN\n-A DOCKER-USER -i rvi+ ! -o rvi+ -j DROP") });
    expect(opened.byId("L1.walls")).toMatch(/ FAIL .*rvi-opened-above-the-drop/u);
    const openedInput = run({ input: "-P INPUT ACCEPT\n-A INPUT -i rvi+ -j ACCEPT\n-A INPUT -i rvi+ -j DROP" });
    expect(openedInput.byId("L1.walls")).toMatch(/ FAIL .*rvi-opened-above-the-input-drop/u);
    expect(noForward.status).toBe(1);
  });

  it("L3: fails when the rvi-to-rvi isolation drop is missing or hidden by a RETURN above it", () => {
    const isolation = "-A DOCKER-USER -i rvi+ -o rvi+ -m physdev ! --physdev-is-bridged -j DROP\n";
    expect(run({ dockerUser: GOOD_DOCKER_USER.replace(isolation, "") }).byId("L1.isolation")).toMatch(/ FAIL .*no-rvi-to-rvi-isolation-drop/u);
    // The plain "may not leave rvi" drop is not the isolation drop.
    expect(run({ dockerUser: GOOD_DOCKER_USER.replace(isolation, "-A DOCKER-USER -i rvi+ -o rvi+ -j DROP\n") }).byId("L1.isolation")).toMatch(/ FAIL /u);
    // The same match without the inversion drops what stays inside one bridge: not the isolation drop.
    expect(run({ dockerUser: GOOD_DOCKER_USER.replace(isolation, "-A DOCKER-USER -i rvi+ -o rvi+ -m physdev --physdev-is-bridged -j DROP\n") }).byId("L1.isolation")).toMatch(/ FAIL .*no-rvi-to-rvi-isolation-drop/u);
    expect(run({ dockerUser: GOOD_DOCKER_USER.replace(isolation, `-A DOCKER-USER -i rvi+ -o rvi+ -j RETURN\n${isolation}`) }).byId("L1.isolation")).toMatch(/ FAIL .*rvi-opened-above-the-isolation-drop/u);
  });

  it("L3: Docker must have the CVE-2024-29018 fix (GHSA-mq39-4gv4-mvpx: 26.0.0 or later, 25.0.5 or later, 23.0.11 or later; 24.x has none)", () => {
    for (const version of ["26.0.0", "27.3.1", "28.0.4", "25.0.5", "25.0.8", "25.0.18", "23.0.11", "26.0.0-rc3"]) expect(run({ dockerVersion: version }).byId("L1.docker-version"), version).toMatch(/ PASS /u);
    for (const version of ["25.0.4", "25.0.3", "23.0.10", "20.10.25"]) expect(run({ dockerVersion: version }).byId("L1.docker-version"), version).toMatch(/ FAIL .*older-than/u);
    // The advisory's 26.x cut-off is 26.0.0-rc3: the earlier release candidates are still vulnerable.
    for (const version of ["26.0.0-rc1", "26.0.0-rc2"]) expect(run({ dockerVersion: version }).byId("L1.docker-version"), version).toMatch(/ FAIL .*pre-release-before-rc3/u);
    // The cut-off and its source are written next to the gate, and the superseded 25.0.4 is gone from it.
    expect(scriptText).toContain("GHSA-mq39-4gv4-mvpx");
    expect(scriptText).toMatch(/version_at_least "\$version" 25\.0\.5/u);
    expect(scriptText).not.toMatch(/version_at_least "\$version" 25\.0\.4/u);
    // 24.x has no fixed release at all, and says so (even 24.0.9, which is newer than 23.0.11).
    for (const version of ["24.0.9", "24.0.0"]) expect(run({ dockerVersion: version }).byId("L1.docker-version"), version).toMatch(/ FAIL .*has-no-fix/u);
    expect(run({ dockerVersion: "" }).byId("L1.docker-version")).toMatch(/ FAIL .*unreadable/u);
  });

  it("L3: the backend's name is no requirement (Amazon Linux 2023 is iptables-nft); Docker's chains and the FORWARD jump must be listed by the same iptables", () => {
    expect(run({ iptablesVersion: "iptables v1.8.8 (nf_tables)" }).byId("L1.iptables-backend")).toMatch(/ PASS .*nf_tables/u);
    expect(run({ iptablesVersion: "iptables v1.8.8 (legacy)" }).byId("L1.iptables-backend")).toMatch(/ PASS /u);
    // Docker on the other backend: this iptables lists none of Docker's chains.
    expect(run({ chains: "-P FORWARD ACCEPT" }).byId("L1.iptables-backend")).toMatch(/ FAIL .*no-DOCKER-USER-chain.*FORWARD-does-not-jump.*no-docker-chain/u);
    expect(run({ chains: GOOD_CHAINS.replace("-A FORWARD -j DOCKER-USER\n", "") }).byId("L1.iptables-backend")).toMatch(/ FAIL .*FORWARD-does-not-jump-to-DOCKER-USER/u);
    expect(run({ chains: GOOD_CHAINS.replace(/-N DOCKER\n|-N DOCKER-ISOLATION-STAGE-1\n/gu, "") }).byId("L1.iptables-backend")).toMatch(/ FAIL .*no-docker-chain/u);
    // Docker 28 names its forwarding chain DOCKER-FORWARD.
    expect(run({ chains: "-N DOCKER-FORWARD\n-N DOCKER-USER\n-A FORWARD -j DOCKER-USER" }).byId("L1.iptables-backend")).toMatch(/ PASS /u);
  });

  it("L3: for a run network that exists, Docker's own drops naming its bridge must be present; an idle worker is PENDING, not a pass", () => {
    const network = { networks: { n7: "172.30.7.0/24" }, familyNetworks: ["n7"], familyBridges: { n7: "rvi0123abcd" } };
    expect(run(network).byId("L1.internal-drops")).toMatch(/ FAIL .*no-docker-internal-drop-for-rvi0123abcd/u);
    const withDrops = run({ ...network, dockerChainRules: ["-A DOCKER-ISOLATION-STAGE-1 ! -s 172.30.7.0/24 -o rvi0123abcd -j DROP", "-A DOCKER-ISOLATION-STAGE-1 ! -d 172.30.7.0/24 -i rvi0123abcd -j DROP"] });
    expect(withDrops.byId("L1.internal-drops")).toMatch(/ PASS .*1 run network/u);
    // The firewall unit's own DOCKER-USER and INPUT lines about rvi do not count as Docker's drops.
    expect(run({ ...network, dockerUser: `${GOOD_DOCKER_USER}\n-A DOCKER-USER -i rvi0123abcd -j DROP` }).byId("L1.internal-drops")).toMatch(/ FAIL /u);
    expect(run({ ...network, familyBridges: { n7: "eth9" } }).byId("L1.internal-drops")).toMatch(/ FAIL .*has-no-rvi-bridge/u);
  });

  it("M1: daemon.json must set address pools that leave 172.29/16, 172.30/16, 172.17/16 and 10.42/16 alone", () => {
    expect(run().byId("L1.pools")).toMatch(/ PASS /u);
    expect(run({ daemonJson: JSON.stringify({ "data-root": "/data" }) }).byId("L1.pools")).toMatch(/ FAIL .*no-default-address-pools/u);
    expect(run({ daemonJson: "" }).byId("L1.pools")).toMatch(/ FAIL /u);
    const pool = (base: string) => JSON.stringify({ "default-address-pools": [{ base, size: 24 }] });
    for (const [base, reserved] of [["172.16.0.0/12", "172.29.0.0/16"], ["172.30.0.0/16", "172.30.0.0/16"], ["172.29.4.0/22", "172.29.0.0/16"], ["10.0.0.0/8", "10.42.0.0/16"], ["172.17.0.0/16", "172.17.0.0/16"]] as const) {
      expect(run({ daemonJson: pool(base) }).byId("L1.pools"), base).toMatch(new RegExp(` FAIL .*overlaps-${reserved.replace(/[./]/gu, "\\$&")}`, "u"));
    }
    expect(run({ daemonJson: pool("172.31.0.0/16") }).byId("L1.pools")).toMatch(/ PASS /u);
  });

  it("fails L1.range when a route or a Docker network outside the run family holds 172.30.x, and passes for a run network of the family and for an rvi route", () => {
    expect(run({ routes: "172.30.5.0/24 dev eth1 proto kernel\n" }).byId("L1.range")).toMatch(/ FAIL .*route\(172\.30\.5\.0\/24\)/u);
    expect(run({ networks: { n1: "172.17.0.0/16", n2: "172.30.9.0/24" } }).byId("L1.range")).toMatch(/ FAIL .*docker-network\(n2\)/u);
    expect(run({ routes: "172.30.5.0/24 dev rvi0123abcd proto kernel linkdown\n", networks: { n2: "172.30.9.0/24" }, familyNetworks: ["n2"] }).byId("L1.range")).toMatch(/ PASS /u);
  });

  it("fails L2 when the working egress network is internal, L5 when a private range is not dropped, L6 with leftovers and L8 with a Docker socket", () => {
    expect(run({ agentxTaskInternal: "true" }).byId("L2.egress-network")).toMatch(/ FAIL .*agentx-task-internal=true/u);
    expect(run({ dockerUser: GOOD_DOCKER_USER.replace("-A DOCKER-USER -i rvb+ -d 10.0.0.0/8 -j DROP\n", "") }).byId("L5.walls")).toMatch(/ FAIL .*no-rvb-drop-for-10\.0\.0\.0\/8/u);
    expect(run({ familyContainers: ["c1", "c2"], familyNetworks: ["n9"] }).byId("L6.no-leftovers")).toMatch(/ FAIL .*containers=2.*networks=1/u);
    expect(run({ mounts: { c1: "/var/run/docker.sock /data" } }).byId("L8.no-socket")).toMatch(/ FAIL .*docker-socket-in-c1/u);
  });

  it("without Docker it fails the parts that read Docker and still runs the rest", () => {
    const r = run({ docker: false });
    for (const id of ["L1.range", "L2.egress-network", "L6.no-leftovers", "L8.no-socket"]) expect(r.byId(id), id).toMatch(/ FAIL .*no-docker/u);
    expect(r.byId("L1.walls")).toMatch(/ PASS /u);
  });

  it("is read-only: it only ever asks docker to list and inspect, iptables to print rules, and refuses any argument", () => {
    const r = run({ familyContainers: ["c1"], mounts: { c1: "/x" }, familyNetworks: ["n9"] });
    expect(r.dockerCalls.length).toBeGreaterThan(3);
    for (const call of r.dockerCalls) expect(call, call).toMatch(/^(?:network ls|network inspect|ps|inspect|version)\b/u);
    for (const call of r.iptablesCalls) expect(call, call).toMatch(/^(?:-S(?: (?:DOCKER-USER|INPUT))?|-t nat -S|--version)$/u);
    for (const call of r.ip6tablesCalls) expect(call, call).toBe("-S INPUT");
    expect(r.awsCalls).toEqual([]);
    expect(run({}, ["--anything"]).status).toBe(2);
    // The text holds no command that starts, creates, changes or deletes anything.
    const code = readOnlyPart.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\bdk (?:run|create|rm|start|stop|kill|exec|pull|load|build|network (?:create|rm|connect|disconnect)|volume)\b/u);
    expect(code).not.toMatch(/\biptables -(?:A|I|D|F|X|P|N|R)\b/u);
    expect(code).not.toMatch(/\baws\b|secretsmanager|curl |wget |ssh /u);
    // It writes no file: once quoted text, comments and arithmetic comparisons are taken out, the only redirections are to /dev/null or to a descriptor.
    const bare = code.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/gu, '""').split("\n").map((line) => line.replace(/\s#.*$/u, "")).join("\n").replace(/\(\([^\n]*?\)\)/gu, "(())");
    expect(bare.match(/\d?>>?\s*(?!\/dev\/null|&)\S+/gu) ?? []).toEqual([]);
  });
});

describe("scripts/linux-check-test-services.sh, live parts", () => {
  const LIVE_IDS = ["L1.live", "L1.live-other-run", "L2.live", "L3.live", "L3.embedded-resolver", "L3.working-relay", "L3.ipv6", "L3.no-route", "L3.other-run", "L3.multicast", "L3.run-files", "L3.spoofing", "L4.live", "L4.template-db", "L6.live"];
  const driverLines = (status: (id: string) => string = () => "PASS", ids: string[] = LIVE_IDS) => `${ids.map((id) => `TSL ${id} ${status(id)} name-of-${id} | what the driver saw`).join("\n")}\n`;
  const delivered: string[] = [];
  afterAll(() => { for (const dir of delivered) rmSync(dir, { recursive: true, force: true }); });
  const deliver = () => {
    const dir = mkdtempSync("/var/tmp/tsl.");
    delivered.push(dir);
    writeFileSync(join(dir, "live.mjs"), "// the driver\n");
    writeFileSync(join(dir, "catalog.json"), "{}\n");
    writeFileSync(join(dir, "catalog.sig.json"), "{}\n");
    return dir;
  };
  const live = (world: World = {}, env: Record<string, string> = {}) => run({ ipv6Active: true, ...world }, [], { TSL_DIR: deliver(), ...env });

  it("prints the driver's lines in place of the PENDING ones, and counts them", () => {
    const r = live({ liveLines: driverLines() });
    for (const id of LIVE_IDS) expect(r.byId(id), id).toMatch(new RegExp(`^TSL ${id.replace(".", "\\.")} PASS name-of-`, "u"));
    expect(r.byId("L3.live")).toContain("what the driver saw");
    // what stays PENDING: L1.internal-drops (no run network on an idle host), L5, L7, L8
    expect(r.lines.at(-1)).toMatch(/^TSL SUMMARY pass=\d+ fail=0 pending=4$/u);
    expect(r.status).toBe(3);
  });
  it("starts the driver the way the header says: no network, no capability, read-only, the pinned image by digest, a login that is removed again, and a cleanup by the throwaway workspace label", () => {
    const r = live({ liveLines: driverLines() });
    const runCalls = r.dockerCalls.filter((call) => call.startsWith("run "));
    expect(runCalls).toHaveLength(2);
    for (const call of runCalls) {
      expect(call).toContain("--network none");
      expect(call).toContain("--cap-drop ALL");
      expect(call).toContain("--security-opt no-new-privileges");
      expect(call).toContain("--read-only");
      expect(call).toMatch(/@sha256:a{64} /u);
    }
    expect(r.dockerCalls).toContain(`pull --quiet 944937319445.dkr.ecr.us-west-2.amazonaws.com/rovara-catalog/staging/svc/postgres@sha256:${"b".repeat(64)}`);
    expect(r.dockerCalls.findIndex((call) => call.startsWith("login "))).toBeLessThan(r.dockerCalls.findIndex((call) => call.startsWith("pull ")));
    // no logout: the worker's own registry login on the host is never touched; the check logs in to a Docker config directory of its own, which is gone when the script ends
    expect(r.dockerCalls.some((call) => call.startsWith("logout "))).toBe(false);
    const configs = [...new Set(r.dockerConfigs.map((row) => row.split(" ")[1]))];
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatch(/^\/var\/tmp\/tsl-docker\.[A-Za-z0-9]{6}$/u);
    expect(existsSync(configs[0]!)).toBe(false);
    expect(r.dockerConfigs.some((row) => row.startsWith("login "))).toBe(true);
    expect(r.dockerCalls).toContain("ps -a -q --filter label=rovara.run-network.workspace=7e57c4ec7e57c4ec");
    expect(r.dockerCalls).toContain("network ls -q --filter label=rovara.run-network.workspace=7e57c4ec7e57c4ec");
    expect(r.awsCalls).toEqual([
      "aws ecr get-login-password --region us-west-2",
      `aws ecr batch-get-image --region us-west-2 --repository-name rovara-catalog/staging/svc/postgres --image-ids imageDigest=sha256:${"b".repeat(64)} --query images[0].imageManifest --output text`,
    ]);
    // the account comes from the instance identity document and goes to the driver, which trusts the staging-only key only for it
    expect(runCalls[0]).toContain("-e TSL_ACCOUNT_ID=944937319445");
    expect(runCalls[0]).toContain("-e TSL_MANIFESTS=/opt/agentx/tsl-manifests");
    expect(r.stdout).not.toContain("fake-token");
  });
  it("an unreadable identity document gives the driver no account (so the staging-only key is not trusted), and a missing trusted key is reported as BLOCKED, never a pass", () => {
    expect(live({ imds: null, liveLines: driverLines() }).dockerCalls.find((call) => call.startsWith("run "))).toContain("-e TSL_ACCOUNT_ID= ");
    const r = live({ pullBlocked: true });
    expect(r.stdout).toContain("TSL BLOCKED BLOCKED: no trusted catalog key");
    for (const id of LIVE_IDS) expect(r.byId(id), id).toMatch(/ FAIL .*BLOCKED: no trusted catalog key/u);
    expect(r.dockerCalls.some((call) => call.startsWith("pull "))).toBe(false);
    expect(r.awsCalls).toEqual([]);
    expect(r.status).toBe(1);
  });
  it("a live item the driver gave no line for is a FAIL, never a PENDING", () => {
    const r = live({ liveLines: driverLines(() => "PASS", LIVE_IDS.filter((id) => id !== "L6.live")) });
    expect(r.byId("L6.live")).toMatch(/^TSL L6\.live FAIL .*no result/u);
  });
  it("a FAIL from the driver stays a FAIL, and a status it should not give is a FAIL", () => {
    const r = live({ liveLines: driverLines((id) => (id === "L4.live" ? "FAIL" : id === "L2.live" ? "MAYBE" : "PASS")) });
    expect(r.byId("L4.live")).toMatch(/^TSL L4\.live FAIL /u);
    expect(r.byId("L2.live")).toMatch(/^TSL L2\.live FAIL /u);
    expect(r.status).toBe(1);
  });
  it("when the driver cannot start (the pull list fails), the operator sees why, and every live item is a FAIL", () => {
    const r = live({ pullFails: true });
    expect(r.stdout).toMatch(/TSL ERROR pull-list: boom/u);
    for (const id of LIVE_IDS) expect(r.byId(id), id).toMatch(/ FAIL /u);
  });
  it("refuses a driver that names an image outside the environment's catalog, before it pulls anything", () => {
    const r = live({ pullList: `944937319445.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@sha256:${"c".repeat(64)}\n` });
    expect(r.stdout).toContain("outside the environment's catalog");
    expect(r.dockerCalls.some((call) => call.startsWith("pull "))).toBe(false);
  });
  it("adds its host checks to the driver's answer: the ip6tables INPUT drop for rvi+, and no nat rule for an rvi bridge", () => {
    const noDrop = live({ liveLines: driverLines(), ip6input: "-P INPUT ACCEPT" });
    expect(noDrop.byId("L3.ipv6")).toMatch(/^TSL L3\.ipv6 FAIL .*no-ip6tables-INPUT-drop-for-rvi.*driver: what the driver saw/u);
    const nat = live({ liveLines: driverLines(), nat: "-P PREROUTING ACCEPT\n-A POSTROUTING -s 172.30.4.0/24 -j MASQUERADE" });
    expect(nat.byId("L3.embedded-resolver")).toMatch(/^TSL L3\.embedded-resolver FAIL .*nat-table/u);
    // without the driver the host check still reports what it can
    expect(run({ ipv6Active: true, ip6input: "-P INPUT ACCEPT" }).byId("L3.ipv6")).toMatch(/ FAIL .*no-ip6tables-INPUT-drop-for-rvi/u);
    expect(run({ ipv6Active: false, ip6input: null }).byId("L3.ipv6")).toMatch(/ PENDING /u);
    expect(run({ ipv6Active: true, ip6input: null }).byId("L3.ipv6")).toMatch(/ FAIL .*ipv6-active-and-ip6tables-unusable/u);
  });
  it("takes only a delivered directory and a plain environment name", () => {
    expect(run({}, [], { TSL_DIR: "/tmp/elsewhere" }).status).toBe(2);
    expect(run({}, [], { TSL_ENV: "Staging; rm -rf /" }).status).toBe(2);
  });
  it("without the driver, the live items are PENDING and nothing is pulled or started", () => {
    const r = run({ ipv6Active: true });
    for (const id of LIVE_IDS) expect(r.byId(id), id).toMatch(/ PENDING /u);
    expect(r.dockerCalls.every((call) => /^(?:network ls|network inspect|ps|inspect|version)\b/u.test(call))).toBe(true);
  });
});


describe("no SSM on staging workers", () => {
  const script = readFileSync(new URL("../../scripts/linux-check-test-services.sh", import.meta.url), "utf8");
  const driver = readFileSync(new URL("../../scripts/linux-check-test-services-live.ts", import.meta.url), "utf8");
  it("both say staging workers are not SSM-managed and name where each check is proven instead", () => {
    for (const text of [script, driver]) expect(text).toMatch(/NO SSM ON STAGING WORKERS/u);
    for (const id of ["L1", "L2", "L3", "L4", "L5", "L6", "L7, L8"]) expect(script, id).toMatch(new RegExp(`^#   ${id} `, "mu"));
    for (const place of ["worker_start report", "escape project", "run_end reports", "linux-runtime CI", "bootFacts"]) expect(script, place).toContain(place);
    expect(script).toContain("scripts/staging-test-services-e2e.sh");
  });
});
