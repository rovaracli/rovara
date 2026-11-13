// Owner decision 123: the worker's side of the company's internal address list. Stage 2 of the boot writes `rovara-private-allow` (one heredoc of boot-stage2.sh), which the launcher runs at every worker start as root,
// before the worker container: it resolves each name once, checks every address it got, and opens exactly those address:port pairs (TCP) on the rvbtask bridge in a chain of its own. This runs that heredoc unchanged
// against a fake iptables (its rules in a file) and a fake getent (answers from a file), so the rule set, the pinning and the refusals are checked on any machine. Also: the launch carries the list only for a named
// environment, after the configuration's header, in a form no shell character can enter.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ec2WorkerUserData, type Ec2WorkerBootConfig } from "@rovara-code/contracts";
import { PRIVATE_ADDRESS_CIDRS_BOOT_PATTERN, PRIVATE_ADDRESS_RANGES, PRIVATE_ADDRESS_RESERVED_BOOT_VARIABLE, PRIVATE_ADDRESS_ROUTED_BOOT_VARIABLE, WORKER_NETWORK_RANGES, checkPrivateAddress } from "@agentx/cloud-contracts";
import { TASK_SANDBOX_BRIDGE } from "../../packages/worker/src/task-network.js";
import { TSL_SELFTEST_BOOT_VARIABLE, readTslSelftestOn, readSu1CheckOn, SU1_CHECK_BOOT_VARIABLE, workerUserDataWithPrivateAddresses } from "../../packages/broker/src/aws/private-address-launch.js";

const stage2 = readFileSync(new URL("../../packages/worker/ec2/boot-stage2.sh", import.meta.url), "utf8");
const step = /cat >\/usr\/local\/libexec\/rovara-private-allow <<'PRIVATEALLOW'\n([\s\S]*?)\nPRIVATEALLOW/.exec(stage2)?.[1] ?? "";
const launcher = /cat >\/usr\/local\/libexec\/agentx-worker-start <<'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/.exec(stage2)?.[1] ?? "";
const CHAIN = "ROVARA-PRIVATE-ALLOW";
const JUMP = `DOCKER-USER -i ${TASK_SANDBOX_BRIDGE} -j ${CHAIN}`;

// A fake netfilter tool: one line per rule ("CHAIN rest", in chain order), chains in a list. -I puts the rule first in its chain (or at position N with `-I CHAIN N`), -A last, -D removes the first exact match, -S lists one
// chain as iptables does (`-N CHAIN` then `-A CHAIN ...`). FAKE_FAIL_APPEND makes -A of a rule containing that text fail.
const FAKE_IPTABLES = `#!/bin/bash
rules="$FAKE_DIR/rules"; chains="$FAKE_DIR/chains"; touch "$rules" "$chains"
grep -qx DOCKER-USER "$chains" || echo DOCKER-USER >>"$chains"
op=$1; shift; chain=$1; shift
position=0
if [[ $op == -I && "\${1:-}" =~ ^[0-9]+$ ]]; then position=$1; shift; fi
rule="$chain $*"
case $op in
  -N) grep -qx "$chain" "$chains" && exit 1; echo "$chain" >>"$chains" ;;
  -S) grep -qx "$chain" "$chains" || exit 1; echo "-N $chain"; grep "^$chain " "$rules" | sed 's/^/-A /' ;;
  -F) grep -qx "$chain" "$chains" || exit 1; grep -v "^$chain " "$rules" >"$rules.new"; mv "$rules.new" "$rules" ;;
  -C) grep -qxF -- "$rule" "$rules" ;;
  -D) grep -qxF -- "$rule" "$rules" || exit 1; awk -v r="$rule" 'done || $0 != r { print; next } { done = 1 }' "$rules" >"$rules.new"; mv "$rules.new" "$rules" ;;
  -I) grep -qx "$chain" "$chains" || exit 1
      awk -v c="$chain " -v p="$position" -v r="$rule" 'BEGIN { if (p < 1) p = 1 } index($0, c) == 1 { n += 1; if (n == p && !done) { print r; done = 1 } } { print } END { if (!done) print r }' "$rules" >"$rules.new"
      mv "$rules.new" "$rules" ;;
  -A) grep -qx "$chain" "$chains" || exit 1; if [[ -n "\${FAKE_FAIL_APPEND:-}" && "$rule" == *"$FAKE_FAIL_APPEND"* ]]; then exit 1; fi; printf '%s\\n' "$rule" >>"$rules" ;;
  *) exit 2 ;;
esac
`;
// getent ahostsv4 -- NAME: the lines glibc prints (three per address), from FAKE_DIR/dns ("name address address ..."). It insists on the `--` (review L5: a name can never be read as an option).
const FAKE_GETENT = `#!/bin/bash
[[ "$1" == ahostsv4 && "$2" == -- ]] || exit 2
line=$(grep "^$3 " "$FAKE_DIR/dns") || exit 2
for address in \${line#* }; do printf '%s STREAM %s\\n%s DGRAM\\n%s RAW\\n' "$address" "$3" "$address" "$address"; done
`;

function bench(options: { list?: string; vpc?: string | null; dns?: Record<string, string[]>; seed?: readonly string[]; reserved?: string; routed?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "rovara-private-allow-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "iptables"), FAKE_IPTABLES); chmodSync(join(bin, "iptables"), 0o755);
  writeFileSync(join(bin, "getent"), FAKE_GETENT); chmodSync(join(bin, "getent"), 0o755);
  const write = (dns: Record<string, string[]>, list: string | undefined, vpc: string | null | undefined) => {
    writeFileSync(join(directory, "dns"), Object.entries(dns).map(([name, addresses]) => `${name} ${addresses.join(" ")}\n`).join(""));
    if (list !== undefined) writeFileSync(join(directory, "list"), `${list}\n`);
    if (vpc !== null) writeFileSync(join(directory, "vpc"), `${vpc ?? "10.42.0.0/16"}\n`);
  };
  write(options.dns ?? {}, options.list, options.vpc);
  // Review L3: the launch's reserved and routed ranges, one per line; a file that is not written is a setting that was not given (an empty routed file is a setting with no usable range).
  if (options.reserved !== undefined) writeFileSync(join(directory, "reserved"), options.reserved === "" ? "" : `${options.reserved}\n`);
  if (options.routed !== undefined) writeFileSync(join(directory, "routed"), options.routed === "" ? "" : `${options.routed}\n`);
  // Rules already in place (block_imds's setup walls, the firewall unit's), in chain order.
  if (options.seed !== undefined) writeFileSync(join(directory, "rules"), options.seed.map((rule) => `${rule}\n`).join(""));
  const read = (name: string) => { try { return readFileSync(join(directory, name), "utf8").trim(); } catch { return undefined; } };
  const run = (env: Record<string, string> = {}) => {
    const result = spawnSync("/bin/bash", ["-c", step], {
      env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: directory, ROVARA_PRIVATE_ADDRESSES_FILE: join(directory, "list"), ROVARA_VPC_CIDRS_FILE: join(directory, "vpc"), ROVARA_PRIVATE_RESERVED_CIDRS_FILE: join(directory, "reserved"), ROVARA_PRIVATE_ROUTED_CIDRS_FILE: join(directory, "routed"), ROVARA_PRIVATE_ADDRESS_PINS_FILE: join(directory, "pins"), ROVARA_PRIVATE_ADDRESS_FACTS_FILE: join(directory, "facts"), ...env }, encoding: "utf8",
    });
    const rules = readFileSync(join(directory, "rules"), "utf8").split("\n").filter(Boolean);
    const chain = rules.filter((rule) => rule.startsWith(`${CHAIN} `)).map((rule) => rule.slice(CHAIN.length + 1));
    return { status: result.status, stderr: result.stderr, rules, chain, accepts: chain.filter((rule) => rule.endsWith("-j ACCEPT")), pins: read("pins"), facts: read("facts") };
  };
  return { run, redo: (dns: Record<string, string[]>) => write(dns, undefined, undefined) };
}
const accept = (address: string, port: number) => `-d ${address}/32 -p tcp --dport ${String(port)} -j ACCEPT`;

describe("the internal address step on the worker", () => {
  it("was found in boot-stage2.sh and is valid bash", () => {
    expect(step.length).toBeGreaterThan(1000);
    expect(spawnSync("bash", ["-n"], { input: step, encoding: "utf8" }).status).toBe(0);
  });

  it("opens exactly the listed address:port pairs, every address a name resolves to, TCP only, from the task bridge only", () => {
    const t = bench({ list: "nexus.corp.example:8081,10.20.0.15:443", dns: { "nexus.corp.example": ["10.60.0.7", "10.60.0.8"] } });
    const run = t.run();
    expect(run.status, run.stderr).toBe(0);
    expect(run.accepts.sort()).toEqual([accept("10.20.0.15", 443), accept("10.60.0.7", 8081), accept("10.60.0.8", 8081)].sort());
    // Reached from DOCKER-USER for rvbtask only (no setup, run or build bridge), and nothing else in DOCKER-USER was added.
    expect(run.rules.filter((rule) => rule.startsWith("DOCKER-USER "))).toEqual([JUMP]);
    // Every rule of the chain is a RETURN guard or one of those ACCEPTs: no other port, protocol or address.
    for (const rule of run.chain) expect(rule).toMatch(/^-d [0-9./]+ -j RETURN$|^-d [0-9.]+\/32 -p tcp --dport [0-9]+ -j ACCEPT$/u);
  });

  it("puts the never-opened ranges first, as RETURN guards above every ACCEPT", () => {
    const run = bench({ list: "10.20.0.15:443", vpc: "10.42.0.0/16\n10.43.0.0/16" }).run();
    const guards = run.chain.filter((rule) => rule.endsWith("-j RETURN")).map((rule) => rule.split(" ")[1]);
    expect(guards).toEqual(["0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", ...WORKER_NETWORK_RANGES, "10.42.0.0/16", "10.43.0.0/16"]);
    expect(run.chain.findIndex((rule) => rule.endsWith("-j ACCEPT"))).toBeGreaterThan(run.chain.findLastIndex((rule) => rule.endsWith("-j RETURN")));
  });

  it("refuses the whole entry when ANY address of a name is one that is never opened (the rebinding guard), and says why without the name", () => {
    const cases: Array<[string[], string]> = [
      [["10.60.0.7", "10.42.0.5"], "install_network"], [["169.254.169.254"], "metadata"], [["100.100.100.200"], "metadata"], [["127.0.0.1"], "never"], [["169.254.10.1"], "never"],
      [["8.8.8.8"], "not_private"], [["172.17.0.2"], "worker_network"], [["192.168.4.4"], "worker_network"],
    ];
    for (const [addresses, why] of cases) {
      const run = bench({ list: "nexus.corp.example:8081,10.20.0.15:443", dns: { "nexus.corp.example": addresses } }).run();
      expect(run.status, run.stderr).toBe(0);
      expect(run.accepts, addresses.join(",")).toEqual([accept("10.20.0.15", 443)]);
      expect(run.stderr).toContain(`entry 1: resolves to an address that is never opened (${why})`);
      expect(run.stderr).not.toContain("nexus");
    }
  });

  // Review L3: the launch's reserved ranges (private MCP servers, model endpoints) and routed ranges are applied to every address a name resolves to, as the contract applies them to an entry.
  it("refuses an address inside a reserved range (a name that resolves into one, or an IP) and puts the reserved ranges among the guards", () => {
    const run = bench({ list: "nexus.corp.example:8081,10.70.1.1:443,mcp.corp.example:443,10.20.0.15:443", reserved: "10.70.0.0/16\n10.71.4.0/24", dns: { "nexus.corp.example": ["10.60.0.7", "10.71.4.9"], "mcp.corp.example": ["10.70.9.9"] } }).run();
    expect(run.status, run.stderr).toBe(0);
    expect(run.accepts).toEqual([accept("10.20.0.15", 443)]);
    expect(run.stderr).toContain("entry 1: resolves to an address that is never opened (reserved_range)");
    expect(run.stderr).toContain("entry 2: resolves to an address that is never opened (reserved_range)");
    expect(run.stderr).toContain("entry 3: resolves to an address that is never opened (reserved_range)");
    const guards = run.chain.filter((rule) => rule.endsWith("-j RETURN")).map((rule) => rule.split(" ")[1]);
    expect(guards).toEqual(["0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", ...WORKER_NETWORK_RANGES, "10.42.0.0/16", "10.70.0.0/16", "10.71.4.0/24"]);
    // The install's own network still comes first in the answer.
    expect(bench({ list: "10.42.0.9:443", reserved: "10.42.0.0/16" }).run().stderr).toContain("(install_network)");
    // No reserved file: nothing changes.
    expect(bench({ list: "10.70.1.1:443" }).run().accepts).toEqual([accept("10.70.1.1", 443)]);
  });

  it("opens only addresses inside the routed ranges (every address of a name), and nothing at all when the routed setting holds no usable range", () => {
    const routed = "10.20.0.0/16\n10.60.0.0/16";
    const run = bench({ list: "nexus.corp.example:8081,10.20.0.15:443,10.30.0.1:443,split.corp.example:443", routed, dns: { "nexus.corp.example": ["10.60.0.7", "10.60.0.8"], "split.corp.example": ["10.20.0.9", "10.30.0.9"] } }).run();
    expect(run.status, run.stderr).toBe(0);
    expect(run.accepts.sort()).toEqual([accept("10.20.0.15", 443), accept("10.60.0.7", 8081), accept("10.60.0.8", 8081)].sort());
    expect(run.stderr).toContain("entry 3: resolves to an address that is never opened (not_routed)");
    expect(run.stderr).toContain("entry 4: resolves to an address that is never opened (not_routed)");
    // Reserved is judged before routed, as the contract does.
    expect(bench({ list: "10.20.5.5:443", routed, reserved: "10.20.5.0/24" }).run().stderr).toContain("(reserved_range)");
    // A routed file that is there but empty (the launch's value did not parse) allows nothing; one that is not there is a launch with no routed setting, as before.
    const empty = bench({ list: "10.20.0.15:443", routed: "" }).run();
    expect(empty.accepts).toEqual([]);
    expect(empty.stderr).toContain("(not_routed)");
    expect(bench({ list: "10.20.0.15:443", routed: "junk\n300.1.1.1/8" }).run().accepts).toEqual([]);
    expect(bench({ list: "10.30.0.1:443" }).run().accepts).toEqual([accept("10.30.0.1", 443)]);
  });

  it("never opens port 53 (DNS), whatever the entry, and says so without the name", () => {
    const run = bench({ list: "10.20.0.15:53,nexus.corp.example:53,10.20.0.16:5353", dns: { "nexus.corp.example": ["10.60.0.7"] } }).run();
    expect(run.status, run.stderr).toBe(0);
    expect(run.accepts).toEqual([accept("10.20.0.16", 5353)]);
    expect(run.stderr).toContain("entry 1: port 53 (DNS) is never opened; skipped");
    expect(run.stderr).toContain("entry 2: port 53 (DNS) is never opened; skipped");
    expect(run.stderr).not.toContain("nexus");
    expect(run.facts).toBe("entries=3,opened=1,skipped=2");
  });

  it("pins what a name resolved to at this start: a later answer opens nothing new until the next start, which drops the old pins", () => {
    const t = bench({ list: "nexus.corp.example:8081", dns: { "nexus.corp.example": ["10.60.0.7"] } });
    expect(t.run().accepts).toEqual([accept("10.60.0.7", 8081)]);
    // The name now answers with the install's own database. The wall holds addresses, not names, so nothing new is open; at the next start the name is resolved again, the rebinding is refused and the old pin is gone.
    t.redo({ "nexus.corp.example": ["10.42.3.3"] });
    const next = t.run();
    expect(next.accepts).toEqual([]);
    t.redo({ "nexus.corp.example": ["10.60.0.9"] });
    const moved = t.run();
    expect(moved.accepts).toEqual([accept("10.60.0.9", 8081)]);
    expect(moved.rules.filter((rule) => rule === JUMP)).toHaveLength(1);
  });

  it("opens nothing without the install's network, for a malformed list, or when a rule cannot be added (fail closed)", () => {
    const noNetwork = bench({ list: "10.20.0.15:443", vpc: null }).run();
    expect(noNetwork.accepts).toEqual([]);
    expect(noNetwork.stderr).toContain("(no_install_network)");
    for (const bad of ["10.20.0.15:443;reboot", "10.20.0.15", "NEXUS.corp:1", "a.b:1,"]) {
      const run = bench({ list: bad }).run();
      expect(run.status, bad).toBe(1);
      expect(run.accepts, bad).toEqual([]);
    }
    const failing = bench({ list: "10.20.0.15:443,10.20.0.16:443", dns: {} }).run({ FAKE_FAIL_APPEND: "10.20.0.16" });
    expect(failing.status).toBe(1);
    expect(failing.chain).toEqual([]);
    // No list at all: the chain exists and is empty.
    const none = bench().run();
    expect(none.status).toBe(0);
    expect(none.chain).toEqual([]);
  });

  it("refuses decimal, octal, hex and short address forms, and names that do not resolve", () => {
    const run = bench({ list: "167772161:80,012.0.0.1:80,0x0a.0.0.1:80,10.1:80,nexus.1:80,gone.corp.example:80" }).run();
    expect(run.status).toBe(0);
    expect(run.accepts).toEqual([]);
    expect(run.stderr.match(/not a plain IPv4 address/gu)).toHaveLength(5);
    expect(run.stderr).toContain("entry 6: did not resolve");
  });

  it("judges an address exactly as the contract does", () => {
    const addresses = ["10.20.0.15", "10.42.0.2", "10.43.255.1", "172.16.9.9", "172.17.0.1", "172.29.0.3", "172.31.0.1", "192.168.0.1", "100.64.0.1", "100.100.100.200", "100.127.255.254", "169.254.169.254", "169.254.170.2",
      "169.254.1.1", "127.0.0.1", "0.1.2.3", "8.8.8.8", "11.0.0.1", "172.15.255.255", "172.32.0.1", "100.128.0.1", "10.255.255.255"];
    // At most 16 entries per list: two runs.
    const opened = [addresses.slice(0, 11), addresses.slice(11)].flatMap((part) => bench({ list: part.map((address) => `${address}:443`).join(",") }).run().accepts).map((rule) => rule.split(" ")[1]!.replace("/32", "")).sort();
    const allowed = addresses.filter((address) => checkPrivateAddress(`${address}:443`, { vpcCidrs: ["10.42.0.0/16"], serviceHosts: [] }).ok).sort();
    expect(allowed.length).toBeGreaterThan(4);
    expect(opened).toEqual(allowed);
  });

  it("keeps its ranges equal to the contract's", () => {
    const value = (name: string) => new RegExp(`^readonly ${name}="([^"]*)"$`, "mu").exec(step)?.[1]?.split(" ") ?? [];
    expect(value("PRIVATE")).toEqual([...PRIVATE_ADDRESS_RANGES]);
    expect(value("WORKER")).toEqual([...WORKER_NETWORK_RANGES]);
    expect(value("METADATA").length).toBeGreaterThanOrEqual(6);
    for (const address of value("METADATA")) expect(checkPrivateAddress(`${address}:80`, { vpcCidrs: [], serviceHosts: [] })).toEqual({ ok: false, refusal: "metadata" });
    expect(new RegExp(`^readonly BRIDGE=${TASK_SANDBOX_BRIDGE}$`, "mu").test(step)).toBe(true);
  });

  it("writes the launch's reserved and routed ranges only when they are well formed, with the contract's own pattern, and a routed value that is not well formed leaves a file with no usable range", () => {
    const shellPattern = /local cidr_pattern='([^']+)'/u.exec(stage2)?.[1] ?? "";
    expect(shellPattern).not.toBe("");
    expect(stage2).toContain(`${PRIVATE_ADDRESS_RESERVED_BOOT_VARIABLE}:-`);
    expect(stage2).toContain(`${PRIVATE_ADDRESS_ROUTED_BOOT_VARIABLE}:-`);
    const inShell = (value: string) => spawnSync("bash", ["-c", `[[ "$1" =~ ${shellPattern} ]]`, "bash", value]).status === 0;
    for (const value of ["10.70.0.0/16", "10.70.0.0/16,10.71.4.0/24", Array.from({ length: 40 }, (_, index) => `10.${String(index)}.0.0/16`).join(",")]) {
      expect(inShell(value), value).toBe(true);
      expect(PRIVATE_ADDRESS_CIDRS_BOOT_PATTERN.test(value), value).toBe(true);
    }
    for (const value of ["10.70.0.0", "10.70.0.0/16,", "10.70.0.0/16;reboot", "a.b.c.d/8", "10.70.0.0/16 10.71.0.0/16", "$(x)/8", Array.from({ length: 41 }, (_, index) => `10.${String(index)}.0.0/16`).join(",")]) {
      expect(inShell(value), value).toBe(false);
      expect(PRIVATE_ADDRESS_CIDRS_BOOT_PATTERN.test(value), value).toBe(false);
    }
    expect(stage2).toMatch(/routed ranges are not well formed; no internal address is opened"; install -m 0600 \/dev\/null "\$ROUTED_CIDRS_FILE"/u);
    expect(stage2).toMatch(/reserved ranges are not well formed; no internal address is opened"; value=""/u);
  });

  it("is written by stage 2 for a named environment and run by the launcher before the worker starts, never fatally", () => {
    expect(stage2).toMatch(/write_test_services_boot_facts \|\| log [^\n]*\n\s*write_private_addresses \|\| log /u);
    const blockLine = launcher.indexOf("if named_environment; then block_imds");
    const stepLine = launcher.indexOf("/bin/bash /usr/local/libexec/rovara-private-allow || log");
    const startLine = launcher.indexOf('exec "$docker" "${args[@]}"');
    expect(blockLine).toBeGreaterThan(-1);
    expect(stepLine).toBeGreaterThan(blockLine);
    expect(startLine).toBeGreaterThan(stepLine);
    // The list file is written only when well formed, with the same pattern the launch uses.
    expect(stage2).toContain('[[ "$value" =~ ^[a-z0-9.-]{1,94}:[1-9][0-9]{0,4}(,[a-z0-9.-]{1,94}:[1-9][0-9]{0,4}){0,15}$ ]]');
  });
});

const SETUP_RULES = (/local -a setup_rules=\((.*)\)\n/u.exec(stage2)?.[1] ?? "").match(/"[^"]+"/gu)?.map((rule) => rule.slice(1, -1)) ?? [];
const FIREWALL_TAIL = ["DOCKER-USER -d 169.254.169.254/32 -j DROP", ...["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"].map((range) => `DOCKER-USER -i rvb+ -d ${range} -j DROP`)];
const SETUP_JUMP = `DOCKER-USER -i rvbs+ -j ${CHAIN}`;

describe("setup runs (review M3)", () => {
  // As the launcher leaves DOCKER-USER before this step: block_imds's metadata REJECT and setup walls on top, then the firewall unit's rules.
  const seeded = ["DOCKER-USER -d 169.254.169.254/32 -j REJECT", ...[...SETUP_RULES].reverse(), ...FIREWALL_TAIL];
  const order = (rules: readonly string[]) => rules.filter((rule) => rule.startsWith("DOCKER-USER "));

  it("reads block_imds's five setup walls", () => {
    expect(SETUP_RULES).toHaveLength(5);
    for (const rule of SETUP_RULES) expect(rule).toMatch(/^DOCKER-USER -i rvbs\+ /u);
  });

  it("reaches the chain from the setup bridges right BELOW every setup wall and above every range drop, and keeps it there on every run", () => {
    const t = bench({ list: "10.20.0.15:443", seed: seeded });
    for (let run = 0; run < 3; run += 1) {
      const result = t.run();
      expect(result.status, result.stderr).toBe(0);
      const rules = order(result.rules);
      expect(rules.filter((rule) => rule === SETUP_JUMP)).toHaveLength(1);
      const jump = rules.indexOf(SETUP_JUMP);
      for (const wall of SETUP_RULES) expect(rules.indexOf(wall), wall).toBeLessThan(jump);
      for (const drop of FIREWALL_TAIL) expect(rules.indexOf(drop), drop).toBeGreaterThan(jump);
      expect(rules.indexOf(JUMP)).toBe(0);
      expect(result.accepts).toEqual([accept("10.20.0.15", 443)]);
    }
  });

  it("moves a setup jump that sits above a setup wall back below them, and adds none when the setup walls are missing", () => {
    const misplaced = bench({ list: "10.20.0.15:443", seed: [SETUP_JUMP, ...seeded] }).run();
    const rules = order(misplaced.rules);
    expect(rules.filter((rule) => rule === SETUP_JUMP)).toHaveLength(1);
    for (const wall of SETUP_RULES) expect(rules.indexOf(wall)).toBeLessThan(rules.indexOf(SETUP_JUMP));
    const withoutWalls = bench({ list: "10.20.0.15:443", seed: ["DOCKER-USER -d 169.254.169.254/32 -j REJECT", SETUP_JUMP, ...FIREWALL_TAIL] }).run();
    expect(order(withoutWalls.rules)).not.toContain(SETUP_JUMP);
    expect(order(withoutWalls.rules)).toContain(JUMP);
  });
});

describe("what the step hands the worker (review L1)", () => {
  it("writes the pinned name=address pairs (names only) and the counts", () => {
    const run = bench({ list: "nexus.corp.example:8081,10.20.0.15:443,gone.corp.example:443", dns: { "nexus.corp.example": ["10.60.0.7", "10.60.0.8"] } }).run();
    expect(run.pins).toBe("nexus.corp.example=10.60.0.7,nexus.corp.example=10.60.0.8");
    expect(run.facts).toBe("entries=3,opened=2,skipped=1");
    const none = bench().run();
    expect(none.pins).toBeUndefined();
    expect(none.facts).toBe("entries=0,opened=0,skipped=0");
    const failed = bench({ list: "nexus.corp.example:8081", dns: { "nexus.corp.example": ["10.60.0.7"] } }).run({ FAKE_FAIL_APPEND: "10.60.0.7" });
    expect(failed.pins).toBeUndefined();
    expect(failed.facts).toBe("entries=1,opened=0,skipped=1");
  });

  it("is passed to the worker container by the launcher only in its one written form", () => {
    const line = launcher.split("\n").find((text) => text.includes("AGENTX_PRIVATE_ADDRESS_HOSTS:")) ?? "";
    expect(line).toContain("if named_environment;");
    const patterns = [...line.matchAll(/"AGENTX_PRIVATE_ADDRESS_(?:HOSTS|FACTS):[^:]+:([^"]+)"/gu)].map((match) => new RegExp(match[1]!, "u"));
    expect(patterns).toHaveLength(2);
    const [hosts, facts] = patterns as [RegExp, RegExp];
    expect(hosts.test("nexus.corp.example=10.60.0.7,nexus.corp.example=10.60.0.8")).toBe(true);
    for (const bad of ["nexus=10.60.0.7;reboot", "nexus=10.60.0.7 --privileged", "NEXUS=10.0.0.1", ""]) expect(hosts.test(bad), bad).toBe(false);
    expect(facts.test("entries=3,opened=2,skipped=1")).toBe(true);
    expect(facts.test("entries=3,opened=2")).toBe(false);
    // Added after the setup isolation line and before the worker container starts.
    expect(launcher.indexOf("AGENTX_PRIVATE_ADDRESS_HOSTS:")).toBeGreaterThan(launcher.indexOf("AGENTX_SETUP_ISOLATION="));
    expect(launcher.indexOf("AGENTX_PRIVATE_ADDRESS_HOSTS:")).toBeLessThan(launcher.indexOf('exec "$docker" "${args[@]}"'));
  });

  it("docker-walled.sh gives every run, create and build the pinned --add-host entries, and none for a value out of form", () => {
    const directory = mkdtempSync(join(tmpdir(), "rovara-walled-hosts-"));
    writeFileSync(join(directory, "docker"), "#!/bin/sh\nprintf '%s\\n' \"$*\"\n");
    chmodSync(join(directory, "docker"), 0o755);
    const walled = new URL("../../packages/worker/ec2/docker-walled.sh", import.meta.url).pathname;
    const call = (hosts: string | undefined, ...args: string[]) => spawnSync("/bin/sh", [walled, ...args], { env: { PATH: `${directory}:/usr/bin:/bin`, ...(hosts === undefined ? {} : { AGENTX_PRIVATE_ADDRESS_HOSTS: hosts }) }, encoding: "utf8" }).stdout.trim();
    const pins = "nexus.corp.example=10.60.0.7,nexus.corp.example=10.60.0.8";
    const added = "--add-host nexus.corp.example:10.60.0.7 --add-host nexus.corp.example:10.60.0.8";
    expect(call(pins, "run", "image")).toBe(`run --network agentx-task --cap-drop NET_RAW ${added} image`);
    expect(call(pins, "container", "create", "image")).toBe(`container create --network agentx-task --cap-drop NET_RAW ${added} image`);
    expect(call(pins, "build", ".")).toContain(`build --network agentx-task ${added} .`);
    expect(call(undefined, "run", "image")).toBe("run --network agentx-task --cap-drop NET_RAW image");
    for (const bad of ["nexus=10.0.0.1 --privileged", "nexus=10.0.0.1;x", "nexus=abc", "=10.0.0.1", "nexus=", "*=1.2.3.4"]) expect(call(bad, "run", "image"), bad).toBe("run --network agentx-task --cap-drop NET_RAW image");
  });
});

describe("the launch's user data", () => {
  const config: Ec2WorkerBootConfig = {
    workspaceId: randomUUID(), generation: 2, volumeId: "vol-0123456789abcdef0", expectNewVolume: false, workerImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx/worker@sha256:${"b".repeat(64)}`,
    invokePublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+/9=", controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", modelProvider: "amazon-bedrock", modelId: "anthropic.claude-sonnet",
    promptCacheRetention: "short", logGroupName: "/agentx/staging/worker", environmentKind: "named", bootStage2Sha256: "c".repeat(64), modelProxyUrl: "http://internal-x.us-east-1.elb.amazonaws.com:4000",
  };
  const boot = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
  const text = (userData: string) => gunzipSync(Buffer.from(userData, "base64")).toString("utf8");

  it("is exactly the plain user data with no list, and carries the list after the header with one", () => {
    expect(workerUserDataWithPrivateAddresses(config, boot, [])).toBe(ec2WorkerUserData(config, boot));
    const lines = text(workerUserDataWithPrivateAddresses(config, boot, ["10.20.0.15:443", "nexus.corp.example:8081"])).split("\n");
    expect(lines[0]).toBe("#!/bin/bash");
    expect(lines[2]).toBe("export AGENTX_PRIVATE_ADDRESSES='10.20.0.15:443,nexus.corp.example:8081'");
    expect(lines.filter((line) => line.includes("AGENTX_PRIVATE_ADDRESSES"))).toHaveLength(1);
  });

  it("carries the reserved and routed ranges beside the list, in the same form, and never without a list", () => {
    const lines = text(workerUserDataWithPrivateAddresses(config, boot, ["10.20.0.15:443"], { reservedCidrs: ["10.70.0.0/16"], routedCidrs: ["10.20.0.0/16", "10.60.0.0/16"] })).split("\n");
    expect(lines.slice(2, 5)).toEqual(["export AGENTX_PRIVATE_ADDRESSES='10.20.0.15:443'", "export AGENTX_PRIVATE_ADDRESS_RESERVED_CIDRS='10.70.0.0/16'", "export AGENTX_PRIVATE_ADDRESS_ROUTED_CIDRS='10.20.0.0/16,10.60.0.0/16'"]);
    // Only the ones the install has.
    const routedOnly = text(workerUserDataWithPrivateAddresses(config, boot, ["10.20.0.15:443"], { routedCidrs: ["10.20.0.0/16"] }));
    expect(routedOnly).toContain("export AGENTX_PRIVATE_ADDRESS_ROUTED_CIDRS='10.20.0.0/16'");
    expect(routedOnly).not.toContain("RESERVED_CIDRS");
    // No list: exactly the plain user data, whatever ranges the install has.
    expect(workerUserDataWithPrivateAddresses(config, boot, [], { reservedCidrs: ["10.70.0.0/16"], routedCidrs: ["10.20.0.0/16"] })).toBe(ec2WorkerUserData(config, boot));
    for (const bad of ["10.20.0.0/16'; reboot; '", "10.20.0.0", "10.20.0.0/16,"]) expect(() => workerUserDataWithPrivateAddresses(config, boot, ["10.20.0.15:443"], { routedCidrs: [bad] }), bad).toThrow("do not fit");
  });

  it("refuses a value a shell could read, and a legacy launch", () => {
    expect(() => workerUserDataWithPrivateAddresses(config, boot, ["a.b:1';reboot;'"])).toThrow();
    const legacy: Ec2WorkerBootConfig = { ...config };
    delete legacy.environmentKind; delete legacy.bootStage2Sha256; delete legacy.modelProxyUrl;
    expect(() => workerUserDataWithPrivateAddresses(legacy, boot, ["10.20.0.15:443"])).toThrow();
  });

  it("fits under EC2's limit with the longest list", () => {
    const longest = Array.from({ length: 16 }, (_, index) => `${String(index).padStart(2, "0")}${"n".repeat(40)}.${"m".repeat(43)}.example:65535`);
    expect(Buffer.from(workerUserDataWithPrivateAddresses(config, boot, longest), "base64").length).toBeLessThan(12_000);
  });
});

// M1 (owner decision, 2026-11-12): the staging-only switch for the TS-L worker self-test. The launch adds `export AGENTX_TSL_SELFTEST='1'` after the header, beside the private address exports, only for a named
// environment whose settings prefix is exactly /agentx/staging/ and only when the operator's SSM parameter says `true`. The boot's own gate (boot-stage2.sh tsl_selftest_gate) still checks the rest.
describe("the launch's TS-L self-test switch", () => {
  const config: Ec2WorkerBootConfig = {
    workspaceId: randomUUID(), generation: 2, volumeId: "vol-0123456789abcdef0", expectNewVolume: false, workerImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx/worker@sha256:${"b".repeat(64)}`,
    invokePublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+/9=", controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", modelProvider: "amazon-bedrock", modelId: "anthropic.claude-sonnet",
    promptCacheRetention: "short", logGroupName: "/agentx/staging/worker", environmentKind: "named", bootStage2Sha256: "c".repeat(64), modelProxyUrl: "http://internal-x.us-east-1.elb.amazonaws.com:4000",
  };
  const boot = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
  const text = (userData: string) => gunzipSync(Buffer.from(userData, "base64")).toString("utf8");
  const on = { settingsPrefix: "/agentx/staging/" };
  const line = `export ${TSL_SELFTEST_BOOT_VARIABLE}='1'`;

  it("names the variable the boot gate reads, and the boot gate reads exactly 1", () => {
    expect(TSL_SELFTEST_BOOT_VARIABLE).toBe("AGENTX_TSL_SELFTEST");
    expect(stage2).toContain('[[ "${1-${AGENTX_TSL_SELFTEST:-}}" == 1 ]]');
  });

  it("adds the line after the header when on, with and without an internal address list", () => {
    const plain = text(workerUserDataWithPrivateAddresses(config, boot, [], {}, on)).split("\n");
    expect(plain[2]).toBe(line);
    expect(plain.filter((l) => l.includes("AGENTX_TSL_SELFTEST"))).toHaveLength(1);
    expect(plain.filter((l) => l.includes("AGENTX_PRIVATE_ADDRESSES"))).toHaveLength(0);
    const both = text(workerUserDataWithPrivateAddresses(config, boot, ["10.20.0.15:443"], { routedCidrs: ["10.20.0.0/16"] }, on)).split("\n");
    expect(both.slice(2, 5)).toEqual(["export AGENTX_PRIVATE_ADDRESSES='10.20.0.15:443'", "export AGENTX_PRIVATE_ADDRESS_ROUTED_CIDRS='10.20.0.0/16'", line]);
    // Without the switch, the private address output is what it was, minus nothing.
    const without = text(workerUserDataWithPrivateAddresses(config, boot, ["10.20.0.15:443"], { routedCidrs: ["10.20.0.0/16"] }));
    expect(both.filter((l) => l !== line).join("\n")).toBe(without);
  });

  it("is byte-identical to the plain user data when off (no switch, or a refused one)", () => {
    expect(workerUserDataWithPrivateAddresses(config, boot, [], {}, undefined)).toBe(ec2WorkerUserData(config, boot));
    expect(workerUserDataWithPrivateAddresses(config, boot, [], {})).toBe(ec2WorkerUserData(config, boot));
    for (const settingsPrefix of ["/agentx/production/", "/agentx/staging", "/agentx/staging/x/", "/agentx/Staging/", "/agentx/staging-2/", ""]) {
      expect(workerUserDataWithPrivateAddresses(config, boot, [], {}, { settingsPrefix }), settingsPrefix).toBe(ec2WorkerUserData(config, boot));
    }
  });

  it("is not added for a launch that is not a named environment's", () => {
    const legacy: Ec2WorkerBootConfig = { ...config };
    delete legacy.environmentKind; delete legacy.bootStage2Sha256; delete legacy.modelProxyUrl;
    expect(workerUserDataWithPrivateAddresses(legacy, boot, [], {}, on)).toBe(ec2WorkerUserData(legacy, boot));
    expect(text(workerUserDataWithPrivateAddresses(legacy, boot, [], {}, on))).not.toContain("AGENTX_TSL_SELFTEST");
  });

  it("keeps the user data size check when the line is added", () => {
    const longest = Array.from({ length: 16 }, (_, index) => `${String(index).padStart(2, "0")}${"n".repeat(40)}.${"m".repeat(43)}.example:65535`);
    expect(Buffer.from(workerUserDataWithPrivateAddresses(config, boot, longest, {}, on), "base64").length).toBeLessThan(12_000);
    // An oversized configuration still fails, switch or not (the check runs on the final text).
    const huge: Ec2WorkerBootConfig = { ...config, controlPlaneUrl: `https://${"a".repeat(60_000)}.example.com` };
    expect(() => workerUserDataWithPrivateAddresses(huge, boot, [], {}, on)).toThrow();
  });
});

describe("the TS-L self-test switch reader", () => {
  const NAME = "/agentx/staging/tsl-selftest";
  const reader = (answer: () => Promise<{ Parameter?: { Value?: string } }>) => {
    const sent: unknown[] = [];
    const logged: string[] = [];
    return { read: () => readTslSelftestOn({ send: async (command) => { sent.push(command); return answer(); } }, NAME, (l) => { logged.push(l); }), sent, logged };
  };

  it("is off when the parameter is absent, silently", async () => {
    const r = reader(async () => { throw Object.assign(new Error("not found"), { name: "ParameterNotFound" }); });
    expect(await r.read()).toBe(false);
    expect(r.logged).toEqual([]);
  });

  it("is on only for exactly `true`, asking for that one parameter by name", async () => {
    const r = reader(async () => ({ Parameter: { Value: "true" } }));
    expect(await r.read()).toBe(true);
    expect((r.sent[0] as { input: { Name: string } }).input).toEqual({ Name: NAME });
    expect(r.logged).toEqual([]);
  });

  it("is off for false (silently) and for any other value (logged without the value)", async () => {
    const off = reader(async () => ({ Parameter: { Value: "false" } }));
    expect(await off.read()).toBe(false);
    expect(off.logged).toEqual([]);
    for (const value of ["TRUE", "True", " true", "true ", "1", "yes", "", "maybe"]) {
      const junk = reader(async () => ({ Parameter: { Value: value } }));
      expect(await junk.read(), JSON.stringify(value)).toBe(false);
      expect(junk.logged, JSON.stringify(value)).toHaveLength(1);
      expect(JSON.parse(junk.logged[0]!)).toEqual({ component: "session-steps", event: "tsl_selftest.switch_unreadable", level: "error", reason: "value" });
      if (value.trim() !== "") expect(junk.logged[0]).not.toContain(value);
    }
    expect(await reader(async () => ({})).read()).toBe(false);
  });

  it("is off when the read fails, logging the error's name only", async () => {
    for (const name of ["AccessDeniedException", "ThrottlingException", "InternalServerError"]) {
      const failing = reader(async () => { throw Object.assign(new Error(`secret detail ${name}`), { name }); });
      expect(await failing.read(), name).toBe(false);
      expect(failing.logged).toHaveLength(1);
      expect(failing.logged[0]).toContain(name);
      expect(failing.logged[0]).not.toContain("secret detail");
    }
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point: anything thrown, not only an Error
    expect(await reader(async () => { throw "nope"; }).read()).toBe(false);
  });
});

describe("the SU-1 self-test switch reader", () => {
  const NAME = "/agentx/staging/su1-check";
  const reader = (answer: () => Promise<{ Parameter?: { Value?: string } }>) => {
    const sent: unknown[] = [];
    const logged: string[] = [];
    return { read: () => readSu1CheckOn({ send: async (command) => { sent.push(command); return answer(); } }, NAME, (l) => { logged.push(l); }), sent, logged };
  };

  it("is off when the parameter is absent, silently", async () => {
    const r = reader(async () => { throw Object.assign(new Error("not found"), { name: "ParameterNotFound" }); });
    expect(await r.read()).toBe(false);
    expect(r.logged).toEqual([]);
  });

  it("is on only for exactly `true`, asking for that one parameter by name", async () => {
    const r = reader(async () => ({ Parameter: { Value: "true" } }));
    expect(await r.read()).toBe(true);
    expect((r.sent[0] as { input: { Name: string } }).input).toEqual({ Name: NAME });
    expect(r.logged).toEqual([]);
  });

  it("is off for false (silently) and for any other value (logged without the value)", async () => {
    const off = reader(async () => ({ Parameter: { Value: "false" } }));
    expect(await off.read()).toBe(false);
    expect(off.logged).toEqual([]);
    for (const value of ["TRUE", "True", " true", "true ", "1", "yes", "", "maybe"]) {
      const junk = reader(async () => ({ Parameter: { Value: value } }));
      expect(await junk.read(), JSON.stringify(value)).toBe(false);
      expect(junk.logged, JSON.stringify(value)).toHaveLength(1);
      expect(JSON.parse(junk.logged[0]!)).toEqual({ component: "session-steps", event: "su1_check.switch_unreadable", level: "error", reason: "value" });
      if (value.trim() !== "" && value !== "1") expect(junk.logged[0]).not.toContain(value);
    }
    expect(await reader(async () => ({})).read()).toBe(false);
  });

  it("is off when the read fails, logging the error's name only", async () => {
    for (const name of ["AccessDeniedException", "ThrottlingException", "InternalServerError"]) {
      const failing = reader(async () => { throw Object.assign(new Error(`secret detail ${name}`), { name }); });
      expect(await failing.read(), name).toBe(false);
      expect(failing.logged).toHaveLength(1);
      expect(failing.logged[0]).toContain(name);
      expect(failing.logged[0]).not.toContain("secret detail");
    }
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point: anything thrown, not only an Error
    expect(await reader(async () => { throw "nope"; }).read()).toBe(false);
  });
});

describe("the launch's SU-1 check switch", () => {
  const config: Ec2WorkerBootConfig = {
    workspaceId: randomUUID(), generation: 2, volumeId: "vol-0123456789abcdef0", expectNewVolume: false, workerImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx/worker@sha256:${"b".repeat(64)}`,
    invokePublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+/9=", controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", modelProvider: "amazon-bedrock", modelId: "anthropic.claude-sonnet",
    promptCacheRetention: "short", logGroupName: "/agentx/staging/worker", environmentKind: "named", bootStage2Sha256: "c".repeat(64), modelProxyUrl: "http://internal-x.us-east-1.elb.amazonaws.com:4000",
  };
  const boot = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
  const text = (userData: string) => gunzipSync(Buffer.from(userData, "base64")).toString("utf8");
  const on = { settingsPrefix: "/agentx/staging/" };
  const line = `export ${SU1_CHECK_BOOT_VARIABLE}='1'`;

  it("names the variable the boot gate reads, and the boot gate reads exactly 1", () => {
    expect(SU1_CHECK_BOOT_VARIABLE).toBe("AGENTX_SU1_CHECK");
    expect(stage2).toContain('tsl_selftest_gate "${AGENTX_SU1_CHECK:-}"');
  });

  it("adds the line after the header when on, with and without an internal address list", () => {
    const plain = text(workerUserDataWithPrivateAddresses(config, boot, [], {}, undefined, on)).split("\n");
    expect(plain[2]).toBe(line);
    expect(plain.filter((l) => l.includes("AGENTX_SU1_CHECK"))).toHaveLength(1);
    expect(plain.filter((l) => l.includes("AGENTX_PRIVATE_ADDRESSES"))).toHaveLength(0);
    const both = text(workerUserDataWithPrivateAddresses(config, boot, ["10.20.0.15:443"], { routedCidrs: ["10.20.0.0/16"] }, undefined, on)).split("\n");
    expect(both.slice(2, 5)).toEqual(["export AGENTX_PRIVATE_ADDRESSES='10.20.0.15:443'", "export AGENTX_PRIVATE_ADDRESS_ROUTED_CIDRS='10.20.0.0/16'", line]);
    // Without the switch, the private address output is what it was, minus nothing.
    const without = text(workerUserDataWithPrivateAddresses(config, boot, ["10.20.0.15:443"], { routedCidrs: ["10.20.0.0/16"] }));
    expect(both.filter((l) => l !== line).join("\n")).toBe(without);
  });

  it("is byte-identical to the plain user data when off (no switch, or a refused one)", () => {
    expect(workerUserDataWithPrivateAddresses(config, boot, [], {}, undefined, undefined)).toBe(ec2WorkerUserData(config, boot));
    expect(workerUserDataWithPrivateAddresses(config, boot, [], {})).toBe(ec2WorkerUserData(config, boot));
    for (const settingsPrefix of ["/agentx/production/", "/agentx/staging", "/agentx/staging/x/", "/agentx/Staging/", "/agentx/staging-2/", ""]) {
      expect(workerUserDataWithPrivateAddresses(config, boot, [], {}, undefined, { settingsPrefix }), settingsPrefix).toBe(ec2WorkerUserData(config, boot));
    }
  });

  it("is not added for a launch that is not a named environment's", () => {
    const legacy: Ec2WorkerBootConfig = { ...config };
    delete legacy.environmentKind; delete legacy.bootStage2Sha256; delete legacy.modelProxyUrl;
    expect(workerUserDataWithPrivateAddresses(legacy, boot, [], {}, undefined, on)).toBe(ec2WorkerUserData(legacy, boot));
    expect(text(workerUserDataWithPrivateAddresses(legacy, boot, [], {}, undefined, on))).not.toContain("AGENTX_SU1_CHECK");
  });

  it("keeps the user data size check when the line is added", () => {
    const longest = Array.from({ length: 16 }, (_, index) => `${String(index).padStart(2, "0")}${"n".repeat(40)}.${"m".repeat(43)}.example:65535`);
    expect(Buffer.from(workerUserDataWithPrivateAddresses(config, boot, longest, {}, undefined, on), "base64").length).toBeLessThan(12_000);
    // An oversized configuration still fails, switch or not (the check runs on the final text).
    const huge: Ec2WorkerBootConfig = { ...config, controlPlaneUrl: `https://${"a".repeat(60_000)}.example.com` };
    expect(() => workerUserDataWithPrivateAddresses(huge, boot, [], {}, undefined, on)).toThrow();
  });
});
