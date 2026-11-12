import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

// Every bash run in this file is hermetic, so it behaves the same on a macOS laptop and a Linux CI runner. PATH is the case's fakes plus ONE directory of links to the basic tools below (the host's own, GNU on
// Linux as on a worker), never /usr/bin, /sbin or /usr/sbin: a runner's real ip6tables, iptables, sysctl or systemctl can never be found. Code that reads /proc reads a fake one (fakeProc), never the host's.
const BASIC_TOOLS = ["awk", "basename", "cat", "chmod", "cp", "dirname", "grep", "head", "ln", "mkdir", "mktemp", "mv", "paste", "rm", "sed", "sort", "sync", "tail", "touch", "tr", "wc"];
/** Host tools that must never be reachable from a case: each is either faked in the case's own bin directory or deliberately absent. */
const HOST_ONLY_TOOLS = ["ip6tables", "iptables", "nft", "sysctl", "systemctl", "docker", "modprobe"];
let basicToolsDirectory: string | undefined;
const basicTools = () => {
  if (basicToolsDirectory !== undefined) return basicToolsDirectory;
  const directory = join(mkdtempSync(join(tmpdir(), "rovara-walls-tools-")), "bin");
  mkdirSync(directory);
  for (const tool of BASIC_TOOLS) {
    const found = ["/usr/bin", "/bin"].map((system) => join(system, tool)).find((path) => existsSync(path));
    if (found !== undefined) symlinkSync(found, join(directory, tool));
  }
  basicToolsDirectory = directory;
  return directory;
};
/** PATH for a case: its fakes first (if any), then the basic tools, and nothing else. */
const hermeticPath = (bin?: string) => (bin === undefined ? basicTools() : `${bin}:${basicTools()}`);
/** A fake /proc as ipv6_active reads it: IPv6 on (an AL2023 worker) or off. */
const fakeProc = (ipv6: boolean) => {
  const proc = mkdtempSync(join(tmpdir(), "rovara-walls-proc-"));
  for (const scope of ["all", "default"]) {
    mkdirSync(join(proc, "sys/net/ipv6/conf", scope), { recursive: true });
    writeFileSync(join(proc, "sys/net/ipv6/conf", scope, "disable_ipv6"), ipv6 ? "0\n" : "1\n");
  }
  mkdirSync(join(proc, "net"));
  if (ipv6) writeFileSync(join(proc, "net/if_inet6"), "00000000000000000000000000000001 01 80 10 80       lo\n");
  return proc;
};
/** Points stage 2 text that reads /proc at a fake one. */
const onFakeProc = (code: string, proc = fakeProc(true)) => code.replaceAll("/proc/", `${proc}/`);
/** True when bash code still names the host's /proc (an absolute /proc/ path, not one under a fake directory). */
const readsHostProc = (code: string) => /(?:^|[\s"'`$(<=])\/proc\//mu.test(code);

describe("the run network adds no firewall rule", () => {
  it("finds the firewall rules in the boot scripts", () => {
    expect(firewallOf(scripts["boot.sh"]).length).toBeGreaterThan(200);
    expect(firewallOf(scripts["boot-legacy.sh"]).length).toBeGreaterThan(200);
  });

  it("runs every case hermetically: the PATH the cases use finds the basic tools but no host firewall or system tool (a Linux runner has a real ip6tables in /usr/sbin), and no case reads the host's /proc", () => {
    const found = (tool: string) => spawnSync("/bin/bash", ["-c", `command -v ${tool}`], { env: { PATH: hermeticPath() }, encoding: "utf8" }).stdout.trim();
    for (const tool of HOST_ONLY_TOOLS) expect(found(tool), `${tool} is reachable from the cases' PATH`).toBe("");
    // the positive control: the same lookup does find what the cases need
    for (const tool of BASIC_TOOLS) expect(found(tool), `${tool} is missing from the cases' PATH`).not.toBe("");
    expect(readsHostProc(fn("ipv6_active"))).toBe(true);
    expect(readsHostProc(onFakeProc(fn("ipv6_active")))).toBe(false);
    // No case writes "a file" to /dev/stdout: spawnSync's stdout is a socket, which Linux will not reopen through /proc/self/fd (it passes on macOS only).
    expect(readFileSync(new URL(import.meta.url), "utf8")).not.toMatch(/WORKER_ENV_FILE=\/dev\//u);
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
      // Owner decision 123: the internal-address step names the run networks' range once, in the list of ranges it NEVER opens (its RETURN guards); nowhere else may it appear.
      const step = /cat >\/usr\/local\/libexec\/rovara-private-allow <<'PRIVATEALLOW'\n[\s\S]*?\nPRIVATEALLOW\n/u.exec(scripts[name])?.[0] ?? "";
      if (name === "boot-stage2.sh") {
        expect(step.length).toBeGreaterThan(1000);
        expect(step.split("\n").filter((line) => line.includes(`${RUN_NETWORK_FIRST_OCTETS}.`))).toEqual([expect.stringMatching(/^readonly WORKER="[0-9./ ]+"$/u)]);
      }
      expect(scripts[name].replace(step, "")).not.toContain(`${RUN_NETWORK_FIRST_OCTETS}.`);
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
    // The firewall unit reads the resolver addresses from resolv.conf: a fake one, not the runner's.
    writeFileSync(join(directory, "resolv.conf"), "nameserver 10.42.0.2\n");
    const env = { PATH: hermeticPath(bin), FAKE_DIR: directory };
    const unit = spawnSync("/bin/bash", ["-c", firewallOf(scripts[name]).replaceAll("/etc/resolv.conf", join(directory, "resolv.conf")).replaceAll("/run/systemd/resolve/resolv.conf", join(directory, "missing.conf"))], { env, encoding: "utf8" });
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
    // The withhold is written before the worker unit exists, so the worker never starts advertising test services on a host without the IPv6 drops.
    expect(at("withhold_test_services_for_ipv6")).toBeGreaterThan(at("wall_ipv6_into_host"));
    expect(at("withhold_test_services_for_ipv6")).toBeLessThan(at("write_worker_unit"));
    // Pulling the catalog images and writing the test services settings is not fatal; the metadata block and the run-network walls are (a failed IPv6 drop withholds test services instead).
    expect(main).toMatch(/if \[\[ \$\{AGENTX_ENVIRONMENT_KIND:-\} == named \]\]; then\n\s+if pull_catalog_images "\$region"; then\n\s+write_test_services_environment \|\| log [^\n]*\n\s+else\n\s+log [^\n]*\n\s+fi\n\s+set_docker_address_pools \|\| fail [^\n]*\n\s+metadata_blocked \|\| fail "the metadata block is missing after the Docker restart"\n\s+wall_between_run_networks \|\| fail [^\n]*\n\s+wall_ipv6_into_host \|\| withhold_test_services_for_ipv6 "\$\{IPV6_WALL_REASON:-ip6tables-unusable\}" \|\| fail [^\n]*\n\s+install_run_walls_unit \|\| fail [^\n]*\n\s+write_test_services_boot_facts \|\| log [^\n]*\n\s+write_private_addresses \|\| log [^\n]*\n\s+fi/u);
  });

  // TS-SEAL-2: the IPv6 INPUT drop for the run bridges, run for real against fake iptables and ip6tables that keep their rules in files.
  describe("the IPv6 drop into the host (TS-SEAL-2)", () => {
    // Inserted at the top, rvb+ first and rvi+ second, so the file lists rvi+ above rvb+.
    const RVI = "INPUT -i rvi+ -j DROP";
    const RVB = "INPUT -i rvb+ -j DROP";
    const ipv6Function = (proc = fakeProc(true)) => `${onFakeProc(/^ipv6_active\(\) \{\n[\s\S]*?^\}$/mu.exec(scripts["boot-stage2.sh"])?.[0] ?? "", proc)}\n${fn("wall_ipv6_into_host")}`;
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
      // The hermetic PATH holds the basic tools the step needs and no real ip6tables, so "missing" is missing on Linux too.
      const env = { PATH: hermeticPath(bin), FAKE_DIR: directory };
      const code = `${ipv6Function()}\nipv6_active() { ${options.ipv6Active ? "true" : "false"}; }\n${Array.from({ length: options.times ?? 1 }, () => "wall_ipv6_into_host").join("\n")}\n`;
      const ran = spawnSync("/bin/bash", ["-c", code], { env, encoding: "utf8" });
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
    it("reports failure (status 1) when ip6tables is missing or cannot be used while the host has IPv6, and success only when the host has none; stage 2 turns that failure into withheld test services, not a stop", () => {
      expect(wallIpv6({ ip6tables: "missing", ipv6Active: true }).status).not.toBe(0);
      expect(wallIpv6({ ip6tables: "unusable", ipv6Active: true }).status).not.toBe(0);
      expect(wallIpv6({ ip6tables: "missing", ipv6Active: false }).status).toBe(0);
      expect(wallIpv6({ ip6tables: "unusable", ipv6Active: false }).status).toBe(0);
    });
    it("reports failure when an insert fails (fail closed: the caller withholds test services), whichever bridge it was for", () => {
      const failing = (bridge: string) => {
        const directory = mkdtempSync(join(tmpdir(), "rovara-ipv6-fail-"));
        const bin = join(directory, "bin");
        spawnSync("mkdir", ["-p", bin]);
        writeFileSync(join(bin, "ip6tables"), `#!/bin/bash\nif [ "$1" = -S ]; then exit 0; fi\nif [ "$1" = -C ]; then exit 1; fi\ncase "$*" in *"${bridge}"*) exit 1 ;; esac\nexit 0\n`);
        chmodSync(join(bin, "ip6tables"), 0o755);
        return spawnSync("/bin/bash", ["-c", `${ipv6Function()}\nwall_ipv6_into_host`], { env: { PATH: hermeticPath(bin) }, encoding: "utf8" }).status;
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
        expect(readsHostProc(code)).toBe(false);
        return spawnSync("/bin/bash", ["-c", `${code}\nipv6_active`], { env: { PATH: hermeticPath() }, encoding: "utf8" }).status === 0;
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
      const env = { PATH: hermeticPath(bin), FAKE_DIR: directory };
      const get = (name: string) => /^\w+\(\) \{\n[\s\S]*?^\}$/mu.exec("")?.[0] ?? name;
      void get;
      const unit = (/^install_run_walls_unit\(\) \{\n[\s\S]*?^\}$/mu.exec(scripts["boot-stage2.sh"])?.[0] ?? "").replaceAll("/usr/local/libexec", join(directory, "libexec")).replaceAll("/etc/systemd/system", join(directory, "systemd"));
      const helpers = onFakeProc(["ipv6_active", "wall_between_run_networks", "wall_ipv6_into_host"].map((name) => new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "mu").exec(scripts["boot-stage2.sh"])?.[0] ?? "").join("\n"));
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
    it("on a restart of the walls unit, an IPv6 failure does not take the worker down: the unit exits 0, rewrites the withhold and the boot facts, and a failed run-network wall is still fatal", () => {
      const directory = mkdtempSync(join(tmpdir(), "rovara-walls-restart-"));
      const bin = join(directory, "bin");
      spawnSync("mkdir", ["-p", bin, join(directory, "libexec"), join(directory, "systemd")]);
      const tool = (name: string, body: string) => { writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755); };
      tool("iptables", FAKE.replace('op=$1; shift; rule="$*"', 'op=$1; shift; rule="$*"\n[ "$op" = -S ] && exit 0'));
      tool("ip6tables", "#!/bin/bash\nexit 3\n");
      const envFile = join(directory, "worker.env");
      // A fake systemctl that records each call with the worker.env it saw at that moment, so the order (withhold first, restart after) is checked.
      tool("systemctl", `#!/bin/bash\necho "$* :: $(grep -c '^AGENTX_TEST_SERVICES_NOT_PULLED=all$' "${envFile}") withheld" >> "${join(directory, "systemctl.log")}"\nexit 5\n`);
      const facts = '{"metadataBlocked":true,"runWalls":true,"ipv6Drops":true,"prepull":"ok","prepulled":1,"loggedOut":true,"dockerVersion":"25.0.5"}';
      writeFileSync(envFile, `AGENTX_FOO=1\nAGENTX_TEST_SERVICES_NOT_PULLED=svc/postgres\nAGENTX_TEST_SERVICES_BOOT_FACTS=${facts}\nAGENTX_BAR=2\n`);
      const env = { PATH: hermeticPath(bin), FAKE_DIR: directory };
      const names = ["install_run_walls_unit", "ipv6_active", "wall_between_run_networks", "wall_ipv6_into_host", "withhold_test_services_for_ipv6"];
      const code = onFakeProc(names.map((name) => new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "mu").exec(scripts["boot-stage2.sh"])?.[0] ?? "").join("\n"))
        .replaceAll("/usr/local/libexec", join(directory, "libexec")).replaceAll("/etc/systemd/system", join(directory, "systemd"));
      const setup = `FIREWALL_UNIT=f.service\nWORKER_UNIT=w.service\nRUN_WALLS_UNIT=r.service\nWORKER_ENV_FILE=${envFile}\ninstall() { mkdir -p "\${@: -1}"; }\nsystemctl() { :; }\n${code}\nipv6_active() { true; }\ninstall_run_walls_unit`;
      expect(spawnSync("/bin/bash", ["-c", setup], { env, encoding: "utf8" }).status).toBe(0);
      const scriptText = readFileSync(join(directory, "libexec/rovara-run-walls"), "utf8");
      const withholdCall = scriptText.indexOf("withhold_test_services_for_ipv6 \"${IPV6_WALL_REASON");
      expect(withholdCall).toBeGreaterThan(-1);
      expect(withholdCall).toBeLessThan(scriptText.indexOf("systemctl try-restart --no-block \"$WORKER_UNIT\" || true"));
      const ran = spawnSync("/bin/bash", [join(directory, "libexec/rovara-run-walls")], { env, encoding: "utf8" });
      expect(ran.status, ran.stderr).toBe(0);
      expect(ran.stderr).toContain("TEST SERVICES WITHHELD");
      // The running worker is restarted after the withhold is in the file (best effort: the fake systemctl fails and the unit still exits 0), not waited for.
      expect(readFileSync(join(directory, "systemctl.log"), "utf8")).toBe("try-restart --no-block w.service :: 1 withheld\n");
      // The replace was atomic: the file is private, and no temp file is left beside it.
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
      expect(readdirSync(directory).filter((name) => name.startsWith("worker.env."))).toEqual([]);
      const lines = readFileSync(envFile, "utf8").split("\n").filter(Boolean);
      expect(lines.filter((line) => line.startsWith("AGENTX_TEST_SERVICES_NOT_PULLED="))).toEqual(["AGENTX_TEST_SERVICES_NOT_PULLED=all"]);
      expect(lines).toEqual(expect.arrayContaining(["AGENTX_FOO=1", "AGENTX_BAR=2"]));
      const written = lines.find((line) => line.startsWith("AGENTX_TEST_SERVICES_BOOT_FACTS="))?.slice("AGENTX_TEST_SERVICES_BOOT_FACTS=".length) ?? "";
      expect(JSON.parse(written)).toMatchObject({ ipv6Drops: false, ipv6DropsReason: "ip6tables-unusable", metadataBlocked: true });
      // With a working ip6tables nothing is withheld and the worker is not restarted.
      tool("ip6tables", FAKE.replace('op=$1; shift; rule="$*"', 'op=$1; shift; rule="$*"\n[ "$op" = -S ] && exit 0'));
      rmSync(join(directory, "systemctl.log"));
      expect(spawnSync("/bin/bash", [join(directory, "libexec/rovara-run-walls")], { env, encoding: "utf8" }).status).toBe(0);
      expect(existsSync(join(directory, "systemctl.log"))).toBe(false);
      // The run-network wall (iptables) is still fatal in the unit.
      tool("iptables", "#!/bin/bash\nexit 1\n");
      expect(spawnSync("/bin/bash", [join(directory, "libexec/rovara-run-walls")], { env, encoding: "utf8" }).status).not.toBe(0);
    });
    it("withhold_test_services_for_ipv6 writes through a same-directory temp file moved over the target, and failing to write it is an error (the callers stop the boot / the unit)", () => {
      const body = fn("withhold_test_services_for_ipv6");
      expect(body).toContain('tmp=$(mktemp "$file.XXXXXX") || return 1');
      expect(body).toContain('mv -f "$tmp" "$file"');
      expect(body).not.toMatch(/>\s*"\$file"/u);
      const directory = mkdtempSync(join(tmpdir(), "rovara-withhold-"));
      const run = (file: string) => spawnSync("/bin/bash", ["-c", `log() { :; }\n${body}\nWORKER_ENV_FILE=${file}\nwithhold_test_services_for_ipv6 ip6tables-unusable`], { env: { PATH: hermeticPath() }, encoding: "utf8" });
      writeFileSync(join(directory, "worker.env"), "A=1\n");
      expect(run(join(directory, "worker.env")).status).toBe(0);
      expect(readFileSync(join(directory, "worker.env"), "utf8")).toBe("A=1\nAGENTX_TEST_SERVICES_NOT_PULLED=all\n");
      expect(run(join(directory, "missing-dir", "worker.env")).status).not.toBe(0);
    });
    it("the wall records why it failed in IPV6_WALL_REASON (a fixed word), and nothing when it succeeded", () => {
      const reasonOf = (bin: string, active: boolean) => spawnSync("/bin/bash", ["-c", `${ipv6Function()}\nipv6_active() { ${active ? "true" : "false"}; }\nwall_ipv6_into_host; echo "status=$? reason=$IPV6_WALL_REASON"`], { env: { PATH: hermeticPath(bin) }, encoding: "utf8" }).stdout.trim();
      const bin = (body: string | undefined) => {
        const directory = mkdtempSync(join(tmpdir(), "rovara-ipv6-reason-"));
        spawnSync("mkdir", ["-p", join(directory, "bin")]);
        if (body !== undefined) { writeFileSync(join(directory, "bin", "ip6tables"), body); chmodSync(join(directory, "bin", "ip6tables"), 0o755); }
        return join(directory, "bin");
      };
      expect(reasonOf(bin("#!/bin/bash\nexit 3\n"), true)).toBe("status=1 reason=ip6tables-unusable");
      expect(reasonOf(bin("#!/bin/bash\nif [ \"$1\" = -S ]; then exit 0; fi\nif [ \"$1\" = -C ]; then exit 1; fi\nexit 1\n"), true)).toBe("status=1 reason=rule-not-added");
      expect(reasonOf(bin("#!/bin/bash\nexit 0\n"), true)).toBe("status=0 reason=");
      expect(reasonOf(bin("#!/bin/bash\nexit 3\n"), false)).toBe("status=0 reason=");
    });
    it("the boot facts reuse the wall's result instead of probing ip6tables a second time", () => {
      // The facts go to a real file, as on a worker. Not /dev/stdout: spawnSync's stdout is a socket, and on Linux bash opens /dev/stdout as /proc/self/fd/1, which a socket refuses (ENXIO), so nothing was written there.
      const facts = (reason: string) => {
        const directory = mkdtempSync(join(tmpdir(), "rovara-boot-facts-"));
        const envFile = join(directory, "worker.env");
        const ran = spawnSync("/bin/bash", ["-c", `WORKER_ENV_FILE=${envFile}\nPREPULL_RESULT=none PREPULL_COUNT=0 PREPULL_LOGGED_OUT=false\nmetadata_blocked() { true; }\niptables() { return 0; }\ndocker() { echo 25.0.5; }\nip6tables() { echo "PROBED" >&2; return 0; }\nIPV6_WALL_REASON=${reason}\n${fn("write_test_services_boot_facts")}\nwrite_test_services_boot_facts`], { env: { PATH: hermeticPath() }, encoding: "utf8" });
        expect(ran.status, ran.stderr).toBe(0);
        return { stdout: existsSync(envFile) ? readFileSync(envFile, "utf8") : "", stderr: ran.stderr };
      };
      const failed = facts("rule-not-added");
      expect(failed.stdout).toContain('"ipv6Drops":false,"ipv6DropsReason":"rule-not-added"');
      expect(failed.stderr).not.toContain("PROBED");
      const fine = facts("");
      expect(fine.stdout).toContain('"ipv6Drops":true');
      expect(fine.stdout).not.toContain("ipv6DropsReason");
      expect(fine.stderr).not.toContain("PROBED");
    });
    it("withhold_test_services_for_ipv6 moves nothing over worker.env when a write to its temp file fails (a full disk), and the old file stays whole", () => {
      const directory = mkdtempSync(join(tmpdir(), "rovara-withhold-full-"));
      const target = join(directory, "worker.env");
      writeFileSync(target, "A=1\nAGENTX_TEST_SERVICES_NOT_PULLED=svc/postgres\n");
      // mktemp is replaced by a symlink to /dev/full (every write fails with ENOSPC); rm -f removes the link, never /dev/full.
      const code = `log() { :; }\nmktemp() { ln -s /dev/full "${directory}/full"; echo "${directory}/full"; }\nmv() { echo MOVED >> "${directory}/mv.log"; command mv "$@"; }\n${fn("withhold_test_services_for_ipv6")}\nWORKER_ENV_FILE=${target}\nwithhold_test_services_for_ipv6 rule-not-added`;
      const ran = spawnSync("/bin/bash", ["-c", code], { env: { PATH: hermeticPath() }, encoding: "utf8" });
      expect(ran.status).not.toBe(0);
      expect(existsSync(join(directory, "mv.log"))).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("A=1\nAGENTX_TEST_SERVICES_NOT_PULLED=svc/postgres\n");
      expect(existsSync(join(directory, "full"))).toBe(false);
      expect(fn("withhold_test_services_for_ipv6")).toContain('[[ $(tail -n 1 "$tmp") == AGENTX_TEST_SERVICES_NOT_PULLED=all ]]');
    });
    it("documents that the withhold is sticky for the instance's life", () => {
      expect(scripts["boot-stage2.sh"]).toMatch(/withhold is STICKY for the life of the instance \(it fails closed\)/u);
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
    const ran = spawnSync("/bin/bash", ["-c", `DOCKER_DATA_ROOT=/data\n${text}\nset_docker_address_pools`], { env: { PATH: hermeticPath(bin) }, encoding: "utf8" });
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
