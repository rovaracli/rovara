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
import { PRIVATE_ADDRESS_RANGES, WORKER_NETWORK_RANGES, checkPrivateAddress } from "@agentx/cloud-contracts";
import { TASK_SANDBOX_BRIDGE } from "../../packages/worker/src/task-network.js";
import { workerUserDataWithPrivateAddresses } from "../../packages/broker/src/aws/private-address-launch.js";

const stage2 = readFileSync(new URL("../../packages/worker/ec2/boot-stage2.sh", import.meta.url), "utf8");
const step = /cat >\/usr\/local\/libexec\/rovara-private-allow <<'PRIVATEALLOW'\n([\s\S]*?)\nPRIVATEALLOW/.exec(stage2)?.[1] ?? "";
const launcher = /cat >\/usr\/local\/libexec\/agentx-worker-start <<'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/.exec(stage2)?.[1] ?? "";
const CHAIN = "ROVARA-PRIVATE-ALLOW";
const JUMP = `DOCKER-USER -i ${TASK_SANDBOX_BRIDGE} -j ${CHAIN}`;

// A fake netfilter tool: one line per rule ("CHAIN rest"), chains in a list; -I puts the rule first in its chain, -A last. FAKE_FAIL_APPEND makes -A of a rule containing that text fail.
const FAKE_IPTABLES = `#!/bin/bash
rules="$FAKE_DIR/rules"; chains="$FAKE_DIR/chains"; touch "$rules" "$chains"
grep -qx DOCKER-USER "$chains" || echo DOCKER-USER >>"$chains"
op=$1; shift; chain=$1; shift; rule="$chain $*"
case $op in
  -N) grep -qx "$chain" "$chains" && exit 1; echo "$chain" >>"$chains" ;;
  -S) grep -qx "$chain" "$chains" ;;
  -F) grep -qx "$chain" "$chains" || exit 1; grep -v "^$chain " "$rules" >"$rules.new"; mv "$rules.new" "$rules" ;;
  -C) grep -qxF -- "$rule" "$rules" ;;
  -I) grep -qx "$chain" "$chains" || exit 1; { printf '%s\\n' "$rule"; cat "$rules"; } >"$rules.new"; mv "$rules.new" "$rules" ;;
  -A) grep -qx "$chain" "$chains" || exit 1; if [[ -n "\${FAKE_FAIL_APPEND:-}" && "$rule" == *"$FAKE_FAIL_APPEND"* ]]; then exit 1; fi; printf '%s\\n' "$rule" >>"$rules" ;;
  *) exit 2 ;;
esac
`;
// getent ahostsv4 NAME: the lines glibc prints (three per address), from FAKE_DIR/dns ("name address address ...").
const FAKE_GETENT = `#!/bin/bash
[[ "$1" == ahostsv4 ]] || exit 2
line=$(grep "^$2 " "$FAKE_DIR/dns") || exit 2
for address in \${line#* }; do printf '%s STREAM %s\\n%s DGRAM\\n%s RAW\\n' "$address" "$2" "$address" "$address"; done
`;

function bench(options: { list?: string; vpc?: string | null; dns?: Record<string, string[]> } = {}) {
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
  const run = (env: Record<string, string> = {}) => {
    const result = spawnSync("/bin/bash", ["-c", step], {
      env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: directory, ROVARA_PRIVATE_ADDRESSES_FILE: join(directory, "list"), ROVARA_VPC_CIDRS_FILE: join(directory, "vpc"), ...env }, encoding: "utf8",
    });
    const rules = readFileSync(join(directory, "rules"), "utf8").split("\n").filter(Boolean);
    const chain = rules.filter((rule) => rule.startsWith(`${CHAIN} `)).map((rule) => rule.slice(CHAIN.length + 1));
    return { status: result.status, stderr: result.stderr, rules, chain, accepts: chain.filter((rule) => rule.endsWith("-j ACCEPT")) };
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
