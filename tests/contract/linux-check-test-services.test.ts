import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// scripts/linux-check-test-services.sh (TS37): the read-only skeleton of the Linux checks TS-L1 to TS-L8. It runs here against fake iptables, ip and docker tools (the script fixes its own PATH, so the test runs a copy whose
// PATH line points at the fakes). Nothing starts Docker; the fake docker logs every call so the test can prove the script only ever reads.
const scriptText = readFileSync(new URL("../../scripts/linux-check-test-services.sh", import.meta.url), "utf8");
const PATH_LINE = /^export LC_ALL=C PATH=.*$/mu;

const GOOD_DOCKER_USER = [
  "-P DOCKER-USER ACCEPT",
  "-A DOCKER-USER -d 169.254.169.254/32 -j DROP",
  "-A DOCKER-USER -i rvi+ ! -o rvi+ -j DROP",
  ...["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"].map((range) => `-A DOCKER-USER -i rvb+ -d ${range} -j DROP`),
].join("\n");
const GOOD_INPUT = ["-P INPUT ACCEPT", "-A INPUT -i rvb+ -j DROP", "-A INPUT -i rvi+ -j DROP"].join("\n");

interface World { dockerUser?: string; input?: string; routes?: string; docker?: boolean; agentxTaskInternal?: string; networks?: Record<string, string>; familyNetworks?: string[]; familyContainers?: string[]; mounts?: Record<string, string> }

function run(world: World = {}, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "ts-linux-check-"));
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  const tool = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  const files = { "docker-user": world.dockerUser ?? GOOD_DOCKER_USER, input: world.input ?? GOOD_INPUT, routes: world.routes ?? "default via 10.0.0.1 dev eth0\n10.0.0.0/24 dev eth0 proto kernel\n172.17.0.0/16 dev docker0 proto kernel\n" };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  tool("iptables", `echo "$@" >> "${dir}/iptables.calls"\n[ "$1" = "-S" ] || exit 2\ncase "$2" in DOCKER-USER) cat "${dir}/docker-user" ;; INPUT) cat "${dir}/input" ;; *) exit 1 ;; esac`);
  tool("ip", `[ "$1 $2 $3" = "-4 route show" ] || exit 2\ncat "${dir}/routes"`);
  const listing = (items: string[]) => items.map((item) => `${item}\n`).join("");
  const networks = world.networks ?? { n1: "172.17.0.0/16" };
  writeFileSync(join(dir, "networks"), listing(Object.entries(networks).map(([id, subnet]) => `${id}=${subnet}`)));
  writeFileSync(join(dir, "family-networks"), listing(world.familyNetworks ?? []));
  writeFileSync(join(dir, "family-containers"), listing(world.familyContainers ?? []));
  writeFileSync(join(dir, "mounts"), listing(Object.entries(world.mounts ?? {}).map(([id, mount]) => `${id}=${mount}`)));
  writeFileSync(join(dir, "meminfo"), "MemTotal:       16384000 kB\nMemFree:         8000000 kB\n");
  // The fake docker answers only what the script is meant to ask, and logs every call.
  tool("docker", [
    `echo "$@" >> "${dir}/docker.calls"`,
    `case "$1 $2" in`,
    `  "network ls") if [ "$3" = "-q" ] && [ "$4" = "--filter" ]; then cat "${dir}/family-networks"; else cut -d= -f1 "${dir}/networks"; fi ;;`,
    `  "network inspect") if [ "$3" = "--format" ] && [ "$5" = "agentx-task" ]; then echo "${world.agentxTaskInternal ?? "false"}"; else grep "^$5=" "${dir}/networks" | cut -d= -f2; fi ;;`,
    `  "ps -a") cat "${dir}/family-containers" ;;`,
    `  "ps -q") cut -d= -f1 "${dir}/mounts" ;;`,
    `  "inspect --format") grep "^$4=" "${dir}/mounts" | cut -d= -f2 ;;`,
    `  *) echo "unexpected docker call: $*" >&2; exit 9 ;;`,
    `esac`,
  ].join("\n"));
  const withFakes = scriptText.replace(PATH_LINE, `export LC_ALL=C PATH=${bin}:/usr/bin:/bin\nDOCKER_FAKE=${world.docker === false ? "" : join(bin, "docker")}`).replaceAll("/proc/meminfo", join(dir, "meminfo")).replace(/^DOCKER=\$\(cat \/etc\/agentx\/docker-path.*$/mu, `DOCKER="$DOCKER_FAKE"`).replace(/^\[\[ "\$DOCKER" == \/\* && -x "\$DOCKER" \]\].*$/mu, "");
  writeFileSync(join(dir, "script.sh"), withFakes);
  const result = spawnSync("/bin/bash", [join(dir, "script.sh"), ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  const read = (name: string) => { try { return readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const lines2 = result.stdout.split("\n").filter((line) => line.startsWith("TSL "));
  const byId = (id: string) => lines2.find((line) => line.startsWith(`TSL ${id} `));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, lines: lines2, byId, dockerCalls: read("docker.calls"), iptablesCalls: read("iptables.calls") };
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
    for (const id of ["L1.walls", "L1.range", "L2.egress-network", "L5.walls", "L6.no-leftovers", "L7.host", "L8.no-socket"]) expect(r.byId(id), id).toMatch(/^TSL \S+ PASS /u);
    for (let n = 1; n <= 8; n += 1) expect(r.byId(`L${String(n)}.live`), `L${String(n)}.live`).toMatch(/^TSL \S+ PENDING /u);
    expect(r.lines.at(-1)).toMatch(/^TSL SUMMARY pass=7 fail=0 pending=8$/u);
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
    for (const call of r.dockerCalls) expect(call, call).toMatch(/^(?:network ls|network inspect|ps|inspect)\b/u);
    for (const call of r.iptablesCalls) expect(call, call).toMatch(/^-S (?:DOCKER-USER|INPUT)$/u);
    expect(run({}, ["--anything"]).status).toBe(2);
    // The text holds no command that starts, creates, changes or deletes anything.
    const code = scriptText.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\bdk (?:run|create|rm|start|stop|kill|exec|pull|load|build|network (?:create|rm|connect|disconnect)|volume)\b/u);
    expect(code).not.toMatch(/\biptables -(?:A|I|D|F|X|P|N|R)\b/u);
    expect(code).not.toMatch(/\baws\b|secretsmanager|curl |wget |ssh /u);
    // It writes no file: once quoted text is taken out, the only redirections are to /dev/null or to a descriptor.
    const bare = code.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/gu, '""').split("\n").map((line) => line.replace(/\s#.*$/u, "")).join("\n");
    expect(bare.match(/\d?>>?\s*(?!\/dev\/null|&)\S+/gu) ?? []).toEqual([]);
  });
});
