import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUN_NETWORK_BRIDGE_PREFIX, RUN_NETWORK_FIRST_OCTETS, runNetworkAddresses, runNetworkBridge, runNetworkCreateArgs } from "../../packages/worker/src/run-network.js";

// TS13 relies on the host firewall that already walls every `rvi*` bridge, and adds no rule of its own (test-services.md 4.0.1). These read the boot scripts as text to prove it: the only rules that name an `rvi` bridge are the
// two existing DROPs, nothing opens a hole for it, nothing names its address range or its labels, and the bridge the module creates falls under exactly those two rules and under none of the build/setup exceptions.
const read = (name: string) => readFileSync(new URL(`../../packages/worker/ec2/${name}`, import.meta.url), "utf8");
const scripts = { "boot.sh": read("boot.sh"), "boot-legacy.sh": read("boot-legacy.sh"), "boot-stage2.sh": read("boot-stage2.sh") };
const firewallOf = (script: string) => /cat >\/usr\/local\/libexec\/rovara-container-firewall <<'FIREWALL'\n([\s\S]*?)\nFIREWALL/.exec(script)?.[1] ?? "";
const mentionsRvi = (line: string) => /\brvi\b/u.test(line);

describe("the run network adds no firewall rule", () => {
  it("finds the firewall rules in the boot scripts", () => {
    expect(firewallOf(scripts["boot.sh"]).length).toBeGreaterThan(200);
    expect(firewallOf(scripts["boot-legacy.sh"]).length).toBeGreaterThan(200);
  });

  const INPUT_LOOP = 'for i in rvb+ rvi+; do f iptables INPUT -i $i -j DROP; ! command -v ip6tables >/dev/null || f ip6tables INPUT -i $i -j DROP || echo "ip6tables $i rule failed" >&2; done';
  const rviLines = (name: keyof typeof scripts) => firewallOf(scripts[name]).split("\n").map((line) => line.trim()).filter((line) => !line.startsWith("#") && mentionsRvi(line));
  it("boot.sh and boot-legacy.sh: the only firewall-unit lines that name an rvi bridge are the two original DROPs (the rvi-to-rvi wall is in stage 2, not in user data)", () => {
    for (const name of ["boot.sh", "boot-legacy.sh"] as const) expect(rviLines(name), name).toEqual(["f iptables DOCKER-USER -i rvi+ ! -o rvi+ -j DROP", INPUT_LOOP]);
    for (const name of ["boot.sh", "boot-legacy.sh"] as const) expect(scripts[name], name).not.toContain("default-address-pools");
    for (const name of ["boot.sh", "boot-legacy.sh"] as const) expect(scripts[name], name).not.toContain("--physdev-is-bridged");
  });

  for (const name of ["boot.sh", "boot-legacy.sh", "boot-stage2.sh"] as const) {
    it(`${name}: no rule lets an rvi bridge through, and none names the run network's address range, labels or names`, () => {
      const rules = scripts[name].split("\n").filter((line) => /\b(?:iptables|ip6tables|nft)\b/u.test(line) && !line.trim().startsWith("#"));
      for (const line of rules.filter(mentionsRvi)) expect(line, line).not.toMatch(/-j (?:RETURN|ACCEPT)/u);
      expect(scripts[name]).not.toContain(`${RUN_NETWORK_FIRST_OCTETS}.`);
      expect(scripts[name]).not.toMatch(/rovara-svc|rovara\.run-network|run-network/u);
    });
  }

  /** The non-comment lines of one top-level function of stage 2. */
  const fn = (name: string) => (new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "mu").exec(scripts["boot-stage2.sh"])?.[0] ?? "").split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  it("boot-stage2.sh: the setup launcher's rules (block_imds) name no rvi bridge, and the only other lines that do are the one wall function's", () => {
    const stage2 = scripts["boot-stage2.sh"].split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    const wall = fn("wall_between_run_networks");
    expect(wall).toContain("-i rvi+ -o rvi+");
    // TS-SEAL-2: the IPv6 INPUT drop is the one other function that names an rvi bridge.
    const ipv6 = fn("wall_ipv6_into_host");
    expect(ipv6).toContain("for bridge in rvb+ rvi+; do");
    expect(ipv6).toContain("ip6tables -I INPUT -i $bridge -j DROP");
    // The boot facts (reported to CloudWatch) only READ the two walls with `-C` checks; they add no rule.
    const facts = fn("write_test_services_boot_facts").split("\n").filter(mentionsRvi);
    for (const line of facts) {
      expect(line, line).toMatch(/\b(?:ip6tables|iptables) -C /u);
      expect(line, line).not.toMatch(/\b(?:ip6tables|iptables) -[AI] /u);
    }
    expect(stage2.split("\n").filter(mentionsRvi)).toEqual([...wall.split("\n").filter(mentionsRvi), ...ipv6.split("\n").filter(mentionsRvi), ...facts]);
    const block = fn("block_imds");
    expect(block).toContain("rvbs+");
    expect(block).not.toMatch(/\brvi\b/u);
    for (const range of block.match(/\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?/gu) ?? []) expect(range.startsWith("172.30."), range).toBe(false);
  });

  it("the bridge the module creates is matched by the interface patterns of the rvi walls read from boot.sh, and by no rvb+ pattern (build and setup bridges have exceptions an internal one must not inherit)", () => {
    // An iptables interface pattern ending in `+` matches every name that starts with what comes before it.
    const patterns = [...new Set(firewallOf(scripts["boot.sh"]).match(/-i (rv[a-z]+\+)/gu)?.map((match) => match.slice(3)) ?? [])];
    expect(patterns.sort()).toEqual(["rvb+", "rvi+"]);
    const matches = (pattern: string, name: string) => name.startsWith(pattern.slice(0, -1));
    for (const slot of [1, 77, 253]) for (const runId of ["11111111-1111-4111-8111-111111111111", "run-2", "a".repeat(64)]) {
      const bridge = runNetworkBridge(runId, slot);
      expect(bridge.length).toBeLessThanOrEqual(15);
      expect(matches("rvi+", bridge)).toBe(true);
      expect(matches("rvb+", bridge)).toBe(false);
      expect(bridge.startsWith(RUN_NETWORK_BRIDGE_PREFIX)).toBe(true);
    }
  });

  it("the run network is a Docker --internal bridge on a range of its own, outside the setup run's 172.29 exceptions", () => {
    const args = runNetworkCreateArgs({ runId: "11111111-1111-4111-8111-111111111111", slot: 5, workspace: "0123456789abcdef", createdAt: 1, expiresAt: 2 });
    expect(args).toContain("--internal");
    expect(args).toContain(`com.docker.network.bridge.name=${runNetworkBridge("11111111-1111-4111-8111-111111111111", 5)}`);
    expect(runNetworkAddresses(5).subnet.startsWith("172.30.")).toBe(true);
    expect(runNetworkAddresses(5).subnet.startsWith("172.29.")).toBe(false);
  });

  // The isolation DROP between two different rvi bridges (owner decision 2026-11-02, option A): run for real against a fake iptables that keeps rules in a file, like container-firewall.test.ts.
  const FAKE = `#!/bin/bash
state="$FAKE_DIR/$(basename "$0").rules"; touch "$state"
op=$1; shift; rule="$*"
case $op in
  -C) grep -qxF -- "$rule" "$state" ;;
  -I) { printf '%s\\n' "$rule"; cat "$state"; } >"$state.new"; mv "$state.new" "$state" ;;
  *) exit 2 ;;
esac
`;
  const applied = (name: "boot.sh" | "boot-legacy.sh", stage2Steps: Array<"wall" | "launcher">) => {
    const directory = mkdtempSync(join(tmpdir(), "rovara-walls-"));
    const bin = join(directory, "bin");
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "iptables"), FAKE); chmodSync(join(bin, "iptables"), 0o755);
    const env = { PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: directory };
    const unit = spawnSync("/bin/bash", ["-c", firewallOf(scripts[name])], { env, encoding: "utf8" });
    expect(unit.status, unit.stderr).toBe(0);
    // Stage 2, in its own order: the wall (stage2_main), then the launcher's block_imds (every worker start).
    for (const step of stage2Steps) {
      const code = step === "wall" ? `${/^wall_between_run_networks\(\) \{\n[\s\S]*?^\}$/mu.exec(scripts["boot-stage2.sh"])?.[0] ?? ""}\nwall_between_run_networks` : `${/^block_imds\(\) \{\n[\s\S]*?^\}$/mu.exec(scripts["boot-stage2.sh"])?.[0] ?? ""}\nblock_imds`;
      const ran = spawnSync("/bin/bash", ["-c", code], { env, encoding: "utf8" });
      expect(ran.status, ran.stderr).toBe(0);
    }
    return readFileSync(join(directory, "iptables.rules"), "utf8").split("\n").filter((line) => line.startsWith("DOCKER-USER "));
  };
  const ISOLATION = "DOCKER-USER -i rvi+ -o rvi+ -m physdev ! --physdev-is-bridged -j DROP";
  it("stage 2's wall is installed at the top of DOCKER-USER: no RETURN or ACCEPT above it (the firewall unit's, or the launcher's added after) can match an rvi bridge; it is written once even if run again", () => {
    for (const steps of [["wall"], ["wall", "launcher"], ["wall", "wall", "launcher"]] as const) {
      const rules = applied("boot.sh", [...steps]);
      const at = rules.indexOf(ISOLATION);
      expect(at, rules.join("\n")).toBeGreaterThanOrEqual(0);
      // Every skip above it is for an rvb or rvbs bridge (the resolver, the setup helper) and so cannot match traffic that enters on an rvi bridge.
      for (const rule of rules.slice(0, at).filter((item) => /-j (?:RETURN|ACCEPT)$/u.test(item))) expect(rule, rule).toMatch(/^DOCKER-USER -i rvbs?\+ /u);
      expect(rules.filter((rule) => rule === ISOLATION)).toHaveLength(1);
      expect(rules).toContain("DOCKER-USER -i rvi+ ! -o rvi+ -j DROP");
    }
    // Without the stage-2 step there is no such rule: it is not in the firewall unit.
    expect(applied("boot.sh", [])).not.toContain(ISOLATION);
  });
  it("stage 2 puts the pools and the wall in place in a named environment only, after the worker environment is written and before the worker unit exists (so before any Docker network of a run), and a failure stops the boot", () => {
    const main = fn("stage2_main");
    const at = (text: string) => main.indexOf(text);
    expect(at("write_worker_environment")).toBeGreaterThan(-1);
    expect(at("write_worker_environment")).toBeLessThan(at("set_docker_address_pools"));
    expect(at("set_docker_address_pools")).toBeLessThan(at("metadata_blocked"));
    expect(at("metadata_blocked")).toBeLessThan(at("wall_between_run_networks"));
    expect(at("wall_between_run_networks")).toBeLessThan(at("wall_ipv6_into_host"));
    expect(at("wall_ipv6_into_host")).toBeLessThan(at("install_run_walls_unit"));
    expect(at("install_run_walls_unit")).toBeLessThan(at("write_worker_unit"));
    expect(at("write_worker_unit")).toBeLessThan(at("systemctl enable --now"));
    expect(at("systemctl enable --now")).toBeLessThan(at("start_e2e_qualification"));
    // Pulling the catalog images and writing the test services settings is not fatal; every wall step is.
    expect(main).toMatch(/if \[\[ \$\{AGENTX_ENVIRONMENT_KIND:-\} == named \]\]; then\n\s+if pull_catalog_images "\$region"; then\n\s+write_test_services_environment \|\| log [^\n]*\n\s+else\n\s+log [^\n]*\n\s+fi\n\s+set_docker_address_pools \|\| fail [^\n]*\n\s+metadata_blocked \|\| fail "the metadata block is missing after the Docker restart"\n\s+wall_between_run_networks \|\| fail [^\n]*\n\s+wall_ipv6_into_host \|\| fail [^\n]*\n\s+install_run_walls_unit \|\| fail [^\n]*\n\s+write_test_services_boot_facts \|\| log [^\n]*\n\s+fi/u);
  });

  // TS-SEAL-2: the IPv6 INPUT drop for the run bridges, run for real against fake iptables and ip6tables that keep their rules in files.
  describe("the IPv6 drop into the host (TS-SEAL-2)", () => {
    // Inserted at the top, rvb+ first and rvi+ second, so the file lists rvi+ above rvb+.
    const RVI = "INPUT -i rvi+ -j DROP";
    const RVB = "INPUT -i rvb+ -j DROP";
    const ipv6Function = () => `${/^ipv6_active\(\) \{\n[\s\S]*?^\}$/mu.exec(scripts["boot-stage2.sh"])?.[0] ?? ""}\n${fn("wall_ipv6_into_host")}`;
    /** Runs the step with a fake ip6tables (or none, or one that cannot be used) and says whether IPv6 is active on the pretend host. */
    const wallIpv6 = (options: { ip6tables: "works" | "missing" | "unusable"; ipv6Active: boolean; times?: number; before?: string[] }) => {
      const directory = mkdtempSync(join(tmpdir(), "rovara-ipv6-"));
      const bin = join(directory, "bin");
      spawnSync("mkdir", ["-p", bin]);
      for (const tool of options.ip6tables === "missing" ? [] : ["ip6tables"]) {
        const body = options.ip6tables === "unusable" ? "#!/bin/bash\nexit 3\n" : FAKE.replace('op=$1; shift; rule="$*"', 'op=$1; shift; rule="$*"\n[ "$op" = -S ] && exit 0');
        writeFileSync(join(bin, tool), body); chmodSync(join(bin, tool), 0o755);
      }
      if (options.before !== undefined) writeFileSync(join(directory, "ip6tables.rules"), `${options.before.join("\n")}\n`);
      // /usr/bin and /bin hold the real tools the step needs (cat); a real ip6tables there would only be found if the fake is missing, so the missing case runs with a PATH that cannot reach it.
      const env = { PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: directory };
      const code = `${ipv6Function()}\nipv6_active() { ${options.ipv6Active ? "true" : "false"}; }\n${Array.from({ length: options.times ?? 1 }, () => "wall_ipv6_into_host").join("\n")}\n`;
      const ran = spawnSync("/bin/bash", ["-c", options.ip6tables === "missing" ? `command() { [ "$1" = -v ] && [ "$2" = ip6tables ] && return 1; builtin command "$@"; }\n${code}` : code], { env, encoding: "utf8" });
      let rules: string[] = [];
      try { rules = readFileSync(join(directory, "ip6tables.rules"), "utf8").split("\n").filter(Boolean); } catch { /* no rule file: nothing was inserted */ }
      return { status: ran.status, rules };
    };
    it("inserts the drop at the top of INPUT, once, however many times the step runs, and keeps a rule that is already there", () => {
      expect(wallIpv6({ ip6tables: "works", ipv6Active: true })).toEqual({ status: 0, rules: [RVI, RVB] });
      expect(wallIpv6({ ip6tables: "works", ipv6Active: true, times: 3 })).toEqual({ status: 0, rules: [RVI, RVB] });
      // a rule already there is kept and the other is added: each bridge is walled once
      expect(wallIpv6({ ip6tables: "works", ipv6Active: true, before: [RVI] })).toEqual({ status: 0, rules: [RVB, RVI] });
      expect(wallIpv6({ ip6tables: "works", ipv6Active: true, before: [RVB] })).toEqual({ status: 0, rules: [RVI, RVB] });
      expect(wallIpv6({ ip6tables: "works", ipv6Active: true, before: [RVB, RVI] })).toEqual({ status: 0, rules: [RVB, RVI] });
      expect(wallIpv6({ ip6tables: "works", ipv6Active: true, before: ["INPUT -i lo -j ACCEPT"] }).rules).toEqual([RVI, RVB, "INPUT -i lo -j ACCEPT"]);
    });
    it("stops the boot when ip6tables is missing or cannot be used while the host has IPv6, and lets it go on only when the host has none", () => {
      expect(wallIpv6({ ip6tables: "missing", ipv6Active: true }).status).not.toBe(0);
      expect(wallIpv6({ ip6tables: "unusable", ipv6Active: true }).status).not.toBe(0);
      expect(wallIpv6({ ip6tables: "missing", ipv6Active: false }).status).toBe(0);
      expect(wallIpv6({ ip6tables: "unusable", ipv6Active: false }).status).toBe(0);
    });
    it("fails the boot when an insert fails (fail closed), whichever bridge it was for", () => {
      const failing = (bridge: string) => {
        const directory = mkdtempSync(join(tmpdir(), "rovara-ipv6-fail-"));
        const bin = join(directory, "bin");
        spawnSync("mkdir", ["-p", bin]);
        writeFileSync(join(bin, "ip6tables"), `#!/bin/bash\nif [ "$1" = -S ]; then exit 0; fi\nif [ "$1" = -C ]; then exit 1; fi\ncase "$*" in *"${bridge}"*) exit 1 ;; esac\nexit 0\n`);
        chmodSync(join(bin, "ip6tables"), 0o755);
        return spawnSync("/bin/bash", ["-c", `${ipv6Function()}\nwall_ipv6_into_host`], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" }).status;
      };
      expect(failing("rvb+")).not.toBe(0);
      expect(failing("rvi+")).not.toBe(0);
    });
    it("counts IPv6 as off only when conf/all AND conf/default disable it, or the kernel has none", () => {
      const state = (input: { inet6: boolean; all?: string; default?: string }) => {
        const proc = mkdtempSync(join(tmpdir(), "rovara-proc-"));
        spawnSync("mkdir", ["-p", join(proc, "net"), join(proc, "sys/net/ipv6/conf/all"), join(proc, "sys/net/ipv6/conf/default")]);
        if (input.inet6) writeFileSync(join(proc, "net/if_inet6"), "");
        if (input.all !== undefined) writeFileSync(join(proc, "sys/net/ipv6/conf/all/disable_ipv6"), `${input.all}\n`);
        if (input.default !== undefined) writeFileSync(join(proc, "sys/net/ipv6/conf/default/disable_ipv6"), `${input.default}\n`);
        const code = (/^ipv6_active\(\) \{\n[\s\S]*?^\}$/mu.exec(scripts["boot-stage2.sh"])?.[0] ?? "").replaceAll("/proc/", `${proc}/`);
        return spawnSync("/bin/bash", ["-c", `${code}\nipv6_active`], { encoding: "utf8" }).status === 0;
      };
      expect(state({ inet6: true, all: "0", default: "0" })).toBe(true);
      expect(state({ inet6: true, all: "1", default: "0" })).toBe(true);
      expect(state({ inet6: true, all: "0", default: "1" })).toBe(true);
      expect(state({ inet6: true, all: "1", default: "1" })).toBe(false);
      expect(state({ inet6: false, all: "0", default: "0" })).toBe(false);
      // an unreadable setting is not "disabled"
      expect(state({ inet6: true })).toBe(true);
      expect(state({ inet6: true, all: "1" })).toBe(true);
    });
    it("is restored by a unit of its own after a reboot or a Docker restart (boot.sh is not touched), and the worker unit needs it in a named environment", () => {
      const directory = mkdtempSync(join(tmpdir(), "rovara-walls-unit-"));
      const bin = join(directory, "bin");
      spawnSync("mkdir", ["-p", bin, join(directory, "libexec"), join(directory, "systemd")]);
      for (const tool of ["iptables", "ip6tables"]) { writeFileSync(join(bin, tool), FAKE.replace('op=$1; shift; rule="$*"', 'op=$1; shift; rule="$*"\n[ "$op" = -S ] && exit 0')); chmodSync(join(bin, tool), 0o755); }
      const env = { PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: directory };
      const get = (name: string) => /^\w+\(\) \{\n[\s\S]*?^\}$/mu.exec("")?.[0] ?? name;
      void get;
      const unit = (/^install_run_walls_unit\(\) \{\n[\s\S]*?^\}$/mu.exec(scripts["boot-stage2.sh"])?.[0] ?? "").replaceAll("/usr/local/libexec", join(directory, "libexec")).replaceAll("/etc/systemd/system", join(directory, "systemd"));
      const helpers = ["ipv6_active", "wall_between_run_networks", "wall_ipv6_into_host"].map((name) => new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "mu").exec(scripts["boot-stage2.sh"])?.[0] ?? "").join("\n");
      const setup = `FIREWALL_UNIT=rovara-container-firewall.service\nWORKER_UNIT=agentx-worker.service\nRUN_WALLS_UNIT=rovara-run-walls.service\ninstall() { mkdir -p "\${@: -1}"; }\nsystemctl() { echo "systemctl $*" >> "${directory}/systemctl.log"; }\n${helpers}\nipv6_active() { true; }\n${unit}\ninstall_run_walls_unit`;
      const installed = spawnSync("/bin/bash", ["-c", setup], { env, encoding: "utf8" });
      expect(installed.status, installed.stderr).toBe(0);
      const unitText = readFileSync(join(directory, "systemd/rovara-run-walls.service"), "utf8");
      expect(unitText).toContain("Requires=docker.service rovara-container-firewall.service");
      expect(unitText).toContain("After=docker.service rovara-container-firewall.service");
      expect(unitText).toContain("Before=agentx-worker.service");
      expect(unitText).toContain("WantedBy=multi-user.target");
      expect(readFileSync(join(directory, "systemctl.log"), "utf8")).toContain("systemctl enable rovara-run-walls.service");
      // The script it wrote re-applies all three walls, any number of times, after the rules were lost.
      const script = join(directory, "libexec/rovara-run-walls");
      const rules = () => {
        const read = (name: string) => { try { return readFileSync(join(directory, name), "utf8").split("\n").filter(Boolean); } catch { return []; } };
        return { v4: read("iptables.rules"), v6: read("ip6tables.rules") };
      };
      const run = () => spawnSync("/bin/bash", [script], { env, encoding: "utf8" });
      expect(run().status).toBe(0);
      const first = rules();
      expect(first.v4).toContain(ISOLATION);
      expect(first.v6).toEqual(expect.arrayContaining([RVI, RVB]));
      expect(run().status).toBe(0);
      expect(rules()).toEqual(first);
      for (const name of ["iptables.rules", "ip6tables.rules"]) writeFileSync(join(directory, name), "");
      expect(run().status).toBe(0);
      expect(rules()).toEqual(first);
      // and the worker unit starts only with it: a drop-in beside the worker unit, which this stage's own text for the unit leaves as it was
      expect(readFileSync(join(directory, "systemd/agentx-worker.service.d/10-run-walls.conf"), "utf8")).toBe("[Unit]\nRequires=rovara-run-walls.service\nAfter=rovara-run-walls.service\n");
      expect(fn("write_worker_unit")).not.toContain("RUN_WALLS_UNIT");
      expect(fn("stage2_main")).toMatch(/if \[\[ \$\{AGENTX_ENVIRONMENT_KIND:-\} == named \]\]; then[\s\S]*install_run_walls_unit/u);
      expect(scripts["boot.sh"]).not.toContain("rovara-run-walls");
    });
    it("stage 2 is where it lives: boot.sh (at its size limit) holds only its best-effort rule, the INPUT drop is not allowed through (-j DROP only), and it runs after the address pools", () => {
      const main = fn("stage2_main");
      expect(main.indexOf("set_docker_address_pools")).toBeLessThan(main.indexOf("wall_ipv6_into_host"));
      expect(fn("wall_ipv6_into_host")).not.toMatch(/-j (?:RETURN|ACCEPT)/u);
      expect(scripts["boot.sh"]).not.toContain("wall_ipv6_into_host");
    });
  });

  it("the isolation DROP keeps traffic inside one bridge flowing: it matches only routed (not bridged) rvi-to-rvi packets, and a run network and an end-to-end network are each ONE bridge", () => {
    expect(ISOLATION).toContain("! --physdev-is-bridged");
    // The end-to-end checker makes exactly one internal (rvi) network per run, and every container of the run is on it (or on the rvb build network), so none of its flows crosses two rvi bridges.
    const host = readFileSync(new URL("../../packages/verifier/src/host/docker-application-host.ts", import.meta.url), "utf8");
    expect(host.match(/"network", "create", "--internal"/gu)).toHaveLength(1);
    expect(host.match(/\binternalBridge\b[^\n]*=/gu)?.length ?? 0).toBeGreaterThan(0);
    for (const call of host.match(/"--network", [A-Za-z]+/gu) ?? []) expect(call, call).toMatch(/--network", (?:network|on|buildNetwork|"none")/u);
  });

  // M1: Docker's own auto-allocated networks (the end-to-end checker's) must not take the setup run's 172.29/16, the run network's 172.30/16 or the VPC's 10.42/16.
  const cidr = (text: string) => { const [address, bits] = text.split("/"); const o = address!.split(".").map(Number); return { start: (((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!) >>> 0, bits: Number(bits) }; };
  const overlaps = (a: string, b: string) => { const x = cidr(a), y = cidr(b); const bits = Math.min(x.bits, y.bits); const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; return ((x.start & mask) >>> 0) === ((y.start & mask) >>> 0); };
  it("stage 2 writes daemon.json with the pools and only then restarts Docker, then runs the container firewall script again; the pools leave out 172.29/16, 172.30/16, 172.17/16 (docker0) and the VPC's 10.42/16, in /24s, with room for a thousand networks", () => {
    const directory = mkdtempSync(join(tmpdir(), "rovara-pools-"));
    const bin = join(directory, "bin");
    spawnSync("mkdir", ["-p", bin]);
    const log = join(directory, "calls.log");
    writeFileSync(join(bin, "systemctl"), `#!/bin/bash\necho "systemctl $*" >>"${log}"\ncat "${directory}/daemon.json" >>"${log}"\n`); chmodSync(join(bin, "systemctl"), 0o755);
    const text = (/^set_docker_address_pools\(\) \{\n[\s\S]*?^\}$/mu.exec(scripts["boot-stage2.sh"])?.[0] ?? "")
      .replaceAll("/etc/docker/daemon.json", join(directory, "daemon.json")).replace("bash /usr/local/libexec/rovara-container-firewall", `echo firewall-script >>"${log}"`);
    const ran = spawnSync("/bin/bash", ["-c", `DOCKER_DATA_ROOT=/data\n${text}\nset_docker_address_pools`], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
    expect(ran.status, ran.stderr).toBe(0);
    const daemon = JSON.parse(readFileSync(join(directory, "daemon.json"), "utf8")) as { "data-root": string; "default-address-pools": Array<{ base: string; size: number }> };
    expect(daemon["data-root"]).toBe("/data");
    const calls = readFileSync(log, "utf8");
    // The restart sees the new file (the file is printed right after the systemctl line), and the firewall script runs after it.
    expect(calls.indexOf("systemctl restart docker.service")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("systemctl restart docker.service")).toBeLessThan(calls.indexOf("default-address-pools"));
    expect(calls.indexOf("default-address-pools")).toBeLessThan(calls.indexOf("firewall-script"));
    const pools = daemon["default-address-pools"];
    expect(pools.length).toBeGreaterThan(0);
    let networks = 0;
    for (const pool of pools) {
      for (const reserved of ["172.29.0.0/16", "172.30.0.0/16", "172.17.0.0/16", "10.42.0.0/16", "172.31.0.0/16"]) expect(overlaps(pool.base, reserved), `${pool.base} overlaps ${reserved}`).toBe(false);
      expect(pool.size).toBe(24);
      expect(pool.size).toBeGreaterThan(cidr(pool.base).bits);
      networks += 2 ** (pool.size - cidr(pool.base).bits);
    }
    expect(networks).toBeGreaterThanOrEqual(1000);
    // Each pool lies in space no other part of the product claims: private 172.16/12 or 192.168/16 only.
    for (const pool of pools) expect(overlaps(pool.base, "172.16.0.0/12") || overlaps(pool.base, "192.168.0.0/16")).toBe(true);
  });
});
