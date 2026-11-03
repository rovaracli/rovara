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
  it("boot.sh: the only firewall lines that name an rvi bridge are the existing DROPs and the one rvi-to-rvi isolation DROP (IPv4, and IPv6 where Docker has the chain)", () => {
    expect(rviLines("boot.sh")).toEqual([
      "f iptables DOCKER-USER -i rvi+ ! -o rvi+ -j DROP",
      "f iptables DOCKER-USER -i rvi+ -o rvi+ -m physdev ! --physdev-is-bridged -j DROP",
      '! command -v ip6tables >/dev/null || ! ip6tables -S DOCKER-USER >/dev/null 2>&1 || f ip6tables DOCKER-USER -i rvi+ -o rvi+ -m physdev ! --physdev-is-bridged -j DROP || echo "ip6tables rvi isolation rule failed" >&2',
      INPUT_LOOP,
    ]);
  });
  it("boot-legacy.sh is the frozen pre-split script (pinned byte for byte in ec2-boot-stage2.test.ts, and the switches exist only in named environments): it keeps only the two original rvi DROPs", () => {
    expect(rviLines("boot-legacy.sh")).toEqual(["f iptables DOCKER-USER -i rvi+ ! -o rvi+ -j DROP", INPUT_LOOP]);
    expect(scripts["boot-legacy.sh"]).not.toContain("default-address-pools");
  });

  for (const name of ["boot.sh", "boot-legacy.sh", "boot-stage2.sh"] as const) {
    it(`${name}: no rule lets an rvi bridge through, and none names the run network's address range, labels or names`, () => {
      const rules = scripts[name].split("\n").filter((line) => /\b(?:iptables|ip6tables|nft)\b/u.test(line) && !line.trim().startsWith("#"));
      for (const line of rules.filter(mentionsRvi)) expect(line, line).not.toMatch(/-j (?:RETURN|ACCEPT)/u);
      expect(scripts[name]).not.toContain(`${RUN_NETWORK_FIRST_OCTETS}.`);
      expect(scripts[name]).not.toMatch(/rovara-svc|rovara\.run-network|run-network/u);
    });
  }

  it("boot-stage2.sh (the setup launcher's rules) names no rvi bridge at all: its exceptions are for rvbs bridges and 172.29 only", () => {
    const stage2 = scripts["boot-stage2.sh"].split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    expect(stage2.split("\n").filter(mentionsRvi)).toEqual([]);
    const block = /^block_imds\(\) \{\n[\s\S]*?^\}$/mu.exec(stage2)?.[0] ?? "";
    expect(block).toContain("rvbs+");
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
  const applied = (name: "boot.sh" | "boot-legacy.sh", withStage2: boolean) => {
    const directory = mkdtempSync(join(tmpdir(), "rovara-walls-"));
    const bin = join(directory, "bin");
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "iptables"), FAKE); chmodSync(join(bin, "iptables"), 0o755);
    const env = { PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: directory };
    const unit = spawnSync("/bin/bash", ["-c", firewallOf(scripts[name])], { env, encoding: "utf8" });
    expect(unit.status, unit.stderr).toBe(0);
    if (withStage2) {
      const block = /^block_imds\(\) \{\n[\s\S]*?^\}$/mu.exec(scripts["boot-stage2.sh"])?.[0] ?? "";
      const launcher = spawnSync("/bin/bash", ["-c", `${block}\nblock_imds`], { env, encoding: "utf8" });
      expect(launcher.status, launcher.stderr).toBe(0);
    }
    return readFileSync(join(directory, "iptables.rules"), "utf8").split("\n").filter((line) => line.startsWith("DOCKER-USER "));
  };
  const ISOLATION = "DOCKER-USER -i rvi+ -o rvi+ -m physdev ! --physdev-is-bridged -j DROP";
  for (const name of ["boot.sh"] as const) {
    it(`${name}: the rvi-to-rvi isolation DROP is installed, and no RETURN or ACCEPT above it (the unit's own, or the setup launcher's added after it) can match an rvi bridge`, () => {
      for (const withStage2 of [false, true]) {
        const rules = applied(name, withStage2);
        const at = rules.indexOf(ISOLATION);
        expect(at, rules.join("\n")).toBeGreaterThanOrEqual(0);
        for (const rule of rules.slice(0, at).filter((item) => /-j (?:RETURN|ACCEPT)$/u.test(item))) {
          // Every skip above it is for an rvb or rvbs bridge (the resolver, the setup helper) and so cannot match traffic that enters on an rvi bridge.
          expect(rule, rule).toMatch(/^DOCKER-USER -i rvbs?\+ /u);
        }
        // It is written once, and the plain "may not leave rvi" DROP is still there.
        expect(rules.filter((rule) => rule === ISOLATION)).toHaveLength(1);
        expect(rules).toContain("DOCKER-USER -i rvi+ ! -o rvi+ -j DROP");
      }
    });
  }

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
  for (const name of ["boot.sh"] as const) {
    it(`${name}: daemon.json sets default-address-pools that leave out 172.29/16, 172.30/16, 172.17/16 (docker0) and the VPC's 10.42/16, in /24s, with room for a thousand networks`, () => {
      const format = /printf '(\{"data-root"[^\n]*\})\\n' "\$DOCKER_DATA_ROOT" >\/etc\/docker\/daemon\.json/u.exec(scripts[name])?.[1] ?? "";
      const daemon = JSON.parse(format.replace("%s", "/data")) as { "data-root": string; "default-address-pools": Array<{ base: string; size: number }> };
      expect(daemon["data-root"]).toBe("/data");
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
  }
});
