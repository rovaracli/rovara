import { readFileSync } from "node:fs";
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

  for (const name of ["boot.sh", "boot-legacy.sh"] as const) {
    it(`${name}: the only firewall lines that name an rvi bridge are the two existing DROPs`, () => {
      const lines = firewallOf(scripts[name]).split("\n").filter(mentionsRvi).map((line) => line.trim());
      expect(lines).toEqual([
        "f iptables DOCKER-USER -i rvi+ ! -o rvi+ -j DROP",
        'for i in rvb+ rvi+; do f iptables INPUT -i $i -j DROP; ! command -v ip6tables >/dev/null || f ip6tables INPUT -i $i -j DROP || echo "ip6tables $i rule failed" >&2; done',
      ]);
    });
  }

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
    const args = runNetworkCreateArgs({ runId: "11111111-1111-4111-8111-111111111111", slot: 5, workspace: "0123456789abcdef", createdAt: 1 });
    expect(args).toContain("--internal");
    expect(args).toContain(`com.docker.network.bridge.name=${runNetworkBridge("11111111-1111-4111-8111-111111111111", 5)}`);
    expect(runNetworkAddresses(5).subnet.startsWith("172.30.")).toBe(true);
    expect(runNetworkAddresses(5).subnet.startsWith("172.29.")).toBe(false);
  });
});
