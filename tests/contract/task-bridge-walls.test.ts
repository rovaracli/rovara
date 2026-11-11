import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TASK_SANDBOX_BRIDGE, TASK_SANDBOX_NETWORK, isWalledTaskNetwork, taskNetworkCreateArgs } from "../../packages/worker/src/task-network.js";
import { WALLED_DOCKER_PATH } from "../../packages/worker/src/devcontainer.js";

// TASK-BRIDGE-UNWALLED: the task sandbox network (and the dev containers that join it) must be a bridge whose host interface the EC2 boot firewall matches. The firewall matches by interface
// name (`-i rvb+`), and Docker names an unnamed network br-<hex>, which no rule matches. These tests tie the name AgentX gives the bridge to the firewall text in boot.sh and boot-stage2.sh, so
// neither side can change alone: every drop that applies to a build bridge must apply to the interface the task network is created with.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const bootScript = read("packages/worker/ec2/boot.sh");
const stage2 = read("packages/worker/ec2/boot-stage2.sh");
const firewall = /cat >\/usr\/local\/libexec\/rovara-container-firewall <<'FIREWALL'\n([\s\S]*?)\nFIREWALL/.exec(bootScript)?.[1] ?? "";

const FAKE = `#!/bin/bash
state="$FAKE_DIR/$(basename "$0").rules"; touch "$state"
op=$1; shift; rule="$*"
case $op in
  -C) grep -qxF -- "$rule" "$state" ;;
  -I) { printf '%s\\n' "$rule"; cat "$state"; } >"$state.new"; mv "$state.new" "$state" ;;
  *) exit 2 ;;
esac
`;

function applyFirewall(): { iptables: string[]; ip6tables: string[]; status: number | null; stderr: string } {
  const directory = mkdtempSync(join(tmpdir(), "rovara-task-bridge-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  for (const tool of ["iptables", "ip6tables"]) { writeFileSync(join(bin, tool), FAKE); chmodSync(join(bin, tool), 0o755); }
  const result = spawnSync("/bin/bash", ["-c", firewall], { env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: directory }, encoding: "utf8" });
  const rules = (tool: string) => { try { return readFileSync(join(directory, `${tool}.rules`), "utf8").split("\n").filter(Boolean); } catch { return []; } };
  return { iptables: rules("iptables"), ip6tables: rules("ip6tables"), status: result.status, stderr: result.stderr };
}

/** Whether an iptables `-i` name (`rvb+` is a prefix wildcard, as in iptables) matches an interface. */
const interfaceMatches = (pattern: string, name: string) => (pattern.endsWith("+") ? name.startsWith(pattern.slice(0, -1)) : pattern === name);
/** The rules of `chain` that carry `-i <pattern>` with a pattern matching `name`, as the rest of each rule. */
const rulesFor = (rules: readonly string[], chain: string, name: string) =>
  rules.flatMap((rule) => { const found = new RegExp(`^${chain} -i (\\S+) (.*)$`, "u").exec(rule); return found !== null && interfaceMatches(found[1]!, name) ? [found[2]!] : []; });

describe("the task sandbox bridge is walled by the boot firewall", () => {
  const run = applyFirewall();

  it("is created with a fixed, rvb-prefixed interface name that fits a Linux interface name (15 characters)", () => {
    expect(TASK_SANDBOX_NETWORK).toBe("agentx-task");
    expect(TASK_SANDBOX_BRIDGE).toMatch(/^rvb[a-z0-9]+$/u);
    expect(TASK_SANDBOX_BRIDGE.length).toBeLessThanOrEqual(15);
    expect(taskNetworkCreateArgs()).toEqual(["network", "create", "--driver", "bridge", "--opt", `com.docker.network.bridge.name=${TASK_SANDBOX_BRIDGE}`, "--opt", "com.docker.network.bridge.enable_icc=false", TASK_SANDBOX_NETWORK]);
  });

  it("is one segment shared by every task's containers, so inter-container traffic is off (enable_icc=false), and what the worker accepts as that network says so", () => {
    expect(taskNetworkCreateArgs().join(" ")).toContain("--opt com.docker.network.bridge.enable_icc=false");
    const options = (given: Record<string, unknown>) => `bridge ${JSON.stringify(given)} false`;
    expect(isWalledTaskNetwork(options({ "com.docker.network.bridge.name": "rvbtask", "com.docker.network.bridge.enable_icc": "false" }))).toBe(true);
    expect(isWalledTaskNetwork(options({ "com.docker.network.bridge.name": "rvbtask" }))).toBe(false);
    expect(isWalledTaskNetwork(options({ "com.docker.network.bridge.enable_icc": "false" }))).toBe(false);
    expect(isWalledTaskNetwork(options({ "com.docker.network.bridge.name": "rvbtask", "com.docker.network.bridge.enable_icc": "true" }))).toBe(false);
  });

  it("applies the firewall in this test, so the checks below look at real rules", () => {
    expect(run.status, run.stderr).toBe(0);
    expect(run.iptables.length).toBeGreaterThan(8);
  });

  it("is covered by the drop of every private, link-local and loopback range", () => {
    const drops = rulesFor(run.iptables, "DOCKER-USER", TASK_SANDBOX_BRIDGE).filter((rule) => rule.endsWith("-j DROP"));
    for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"]) {
      expect(drops, range).toContain(`-d ${range} -j DROP`);
    }
  });

  it("is covered by the host INPUT drop, which has no port or address condition (so the host's own :8080 and its gateway address are dropped), over IPv4 and IPv6", () => {
    expect(rulesFor(run.iptables, "INPUT", TASK_SANDBOX_BRIDGE)).toEqual(["-j DROP"]);
    expect(rulesFor(run.ip6tables, "INPUT", TASK_SANDBOX_BRIDGE)).toEqual(["-j DROP"]);
  });

  it("keeps the metadata drop for every interface, and opens nothing toward the host or private ranges except the resolver's port 53", () => {
    expect(run.iptables).toContain("DOCKER-USER -d 169.254.169.254/32 -j DROP");
    const opened = rulesFor(run.iptables, "DOCKER-USER", TASK_SANDBOX_BRIDGE).filter((rule) => !rule.endsWith("-j DROP"));
    expect(opened.length).toBeGreaterThan(0);
    for (const rule of opened) expect(rule).toMatch(/^-d [0-9.]+ -p (udp|tcp) --dport 53 -j RETURN$/u);
    // No rule lets a task-bridge packet through by interface alone (a bare ACCEPT/RETURN for the bridge would void the range drops).
    expect(rulesFor(run.iptables, "DOCKER-USER", TASK_SANDBOX_BRIDGE).filter((rule) => /^-j (ACCEPT|RETURN)$/u.test(rule))).toEqual([]);
  });

  it("is also covered where boot-stage2.sh repeats the IPv6 host drop after Docker's restart", () => {
    const block = /wall_ipv6_into_host\(\) \{[\s\S]*?\n\}\n/u.exec(stage2)?.[0] ?? "";
    expect(block).toContain("for bridge in rvb+ rvi+; do");
    expect(interfaceMatches("rvb+", TASK_SANDBOX_BRIDGE)).toBe(true);
  });

  it("is not covered by any rule through the default bridge or an unnamed Docker bridge, which is why the name matters", () => {
    for (const unwalled of ["docker0", "br-0123456789ab"]) expect(rulesFor(run.iptables, "DOCKER-USER", unwalled).filter((rule) => rule.includes("-d 10.0.0.0/8"))).toEqual([]);
  });
});

describe("the docker wrapper the devcontainer CLI uses on an EC2 worker", () => {
  const wrapper = new URL("../../packages/worker/ec2/docker-walled.sh", import.meta.url).pathname;

  /** Runs the wrapper over a fake `docker` that prints DOCKER_BUILDKIT=<value> and then its arguments, one per line. */
  function wrappedRun(args: string[], environment: Record<string, string> = {}): { status: number | null; lines: string[]; stderr: string } {
    const directory = mkdtempSync(join(tmpdir(), "rovara-docker-walled-"));
    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), '#!/bin/sh\nprintf "DOCKER_BUILDKIT=%s\\n" "${DOCKER_BUILDKIT:-unset}"\nfor a in "$@"; do printf "%s\\n" "$a"; done\n');
    chmodSync(join(bin, "docker"), 0o755);
    const result = spawnSync(wrapper, args, { env: { PATH: `${bin}:/usr/bin:/bin`, ...environment }, encoding: "utf8" });
    return { status: result.status, lines: result.stdout.split("\n").slice(1, -1), stderr: result.stderr };
  }
  function wrapped(args: string[]): string[] {
    const run = wrappedRun(args);
    expect(run.status, run.stderr).toBe(0);
    return run.lines;
  }

  it("is executable, valid sh, and at the path the worker looks for in the image (the whole packages/worker folder is copied into it)", () => {
    expect(statSync(wrapper).mode & 0o111).not.toBe(0);
    expect(spawnSync("sh", ["-n", wrapper]).status).toBe(0);
    expect(WALLED_DOCKER_PATH).toBe("/opt/agentx/packages/worker/ec2/docker-walled.sh");
    expect(read("environments/base/Dockerfile")).toContain("COPY --from=build /opt/agentx/packages/worker ./packages/worker");
  });

  it("names the same network as the worker", () => {
    expect(read("packages/worker/ec2/docker-walled.sh")).toContain(`network=${TASK_SANDBOX_NETWORK}\n`);
  });

  it("puts --network and --cap-drop NET_RAW on docker run and docker create, before every other argument", () => {
    const walled = ["--network", "agentx-task", "--cap-drop", "NET_RAW"];
    expect(wrapped(["run", "--sig-proxy=false", "-a", "STDOUT", "--mount", "type=bind,source=/w,target=/w", "image", "-c", "echo"]))
      .toEqual(["run", ...walled, "--sig-proxy=false", "-a", "STDOUT", "--mount", "type=bind,source=/w,target=/w", "image", "-c", "echo"]);
    expect(wrapped(["create", "--rm", "image"])).toEqual(["create", ...walled, "--rm", "image"]);
    expect(wrapped(["container", "run", "-d", "image"])).toEqual(["container", "run", ...walled, "-d", "image"]);
    expect(wrapped(["container", "create", "image"])).toEqual(["container", "create", ...walled, "image"]);
  });

  it("puts --network on every spelling of docker build, with the classic builder forced (DOCKER_BUILDKIT=0, whatever the worker's environment says), because build containers run the Dockerfile's RUN steps", () => {
    for (const [args, expected] of [
      [["build", "-f", "Dockerfile", "-t", "x", "."], ["build", "--network", "agentx-task", "-f", "Dockerfile", "-t", "x", "."]],
      [["image", "build", "-t", "x", "."], ["image", "build", "--network", "agentx-task", "-t", "x", "."]],
      [["builder", "build", "."], ["builder", "build", "--network", "agentx-task", "."]],
    ] as const) {
      for (const environment of [{}, { DOCKER_BUILDKIT: "1" }]) {
        const run = wrappedRun([...args], environment);
        expect(run.status, run.stderr).toBe(0);
        expect(run.lines).toEqual(expected);
      }
    }
    expect(read("packages/worker/ec2/docker-walled.sh")).toContain("DOCKER_BUILDKIT=0");
    // The forced value is what the real docker sees.
    const directory = mkdtempSync(join(tmpdir(), "rovara-docker-walled-env-"));
    mkdirSync(join(directory, "bin"));
    writeFileSync(join(directory, "bin", "docker"), '#!/bin/sh\nprintf "%s" "${DOCKER_BUILDKIT:-unset}"\n');
    chmodSync(join(directory, "bin", "docker"), 0o755);
    expect(spawnSync(wrapper, ["build", "."], { env: { PATH: `${join(directory, "bin")}:/usr/bin:/bin`, DOCKER_BUILDKIT: "1" }, encoding: "utf8" }).stdout).toBe("0");
  });

  it("refuses buildx, whose BuildKit builder cannot put build containers on a named network, instead of building on docker0", () => {
    for (const args of [["buildx", "build", "."], ["buildx", "version"], ["buildx"]]) {
      const run = wrappedRun(args);
      expect(run.status, args.join(" ")).toBe(1);
      expect(run.lines).toEqual([]);
      expect(run.stderr).toContain("docker buildx is not available on this worker");
    }
  });

  it("refuses a docker option before the command, so `--context x run`, `-H host build` and the like cannot slip past the rewrite (the devcontainer CLI emits none)", () => {
    for (const args of [["--context", "other", "run", "image"], ["-H", "tcp://elsewhere:2375", "build", "."], ["--host=unix:///x.sock", "run", "image"], ["--config", "/tmp/c", "create", "image"], ["-c", "x", "container", "run", "image"], ["--debug", "ps"], ["-v"], ["--help"]]) {
      const run = wrappedRun(args);
      expect(run.status, args.join(" ")).toBe(1);
      expect(run.lines, `docker was run for ${args.join(" ")}`).toEqual([]);
      expect(run.stderr).toContain("is not available on this worker");
    }
  });

  it("refuses a build with a --network / --net of its own anywhere among its arguments, in every spelling and form, instead of relying on the added one coming first", () => {
    for (const verb of [["build"], ["image", "build"], ["builder", "build"]]) {
      for (const own of [["--network", "bridge"], ["--network=bridge"], ["--net", "host"], ["--net=host"], ["--network", "agentx-task"], ["--network=agentx-task"]]) {
        for (const args of [[...verb, ...own, "."], [...verb, "-t", "x", "-f", "Dockerfile", ...own, "."], [...verb, "-t", "x", ".", ...own]]) {
          const run = wrappedRun(args);
          expect(run.status, args.join(" ")).toBe(1);
          expect(run.lines, `docker was run for ${args.join(" ")}`).toEqual([]);
          expect(run.stderr).toContain("a build with its own --net");
        }
      }
    }
    // Other options that merely mention a network are not touched.
    expect(wrapped(["build", "--build-arg", "network=1", "--label", "net=2", "."])).toEqual(["build", "--network", "agentx-task", "--build-arg", "network=1", "--label", "net=2", "."]);
  });

  it("passes every other command through unchanged", () => {
    for (const args of [["inspect", "--type", "container", "abc"], ["exec", "-i", "abc", "true"], ["ps", "-a"], ["container", "ls"], ["image", "ls"], ["builder", "prune"], ["network", "create", "x"], ["version"], []]) {
      expect(wrapped(args)).toEqual(args);
    }
  });
});
