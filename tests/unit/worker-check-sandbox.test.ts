// TS16: the sealed check sandbox's arguments, files and DNS helper arguments (check-sandbox.ts; test-services.md 4.0.2). Nothing starts Docker: the functions are pure, and the one reader uses a fake docker.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECK_SANDBOX_HOSTNAME, RESERVED_RUN_ALIASES, SEALED_DNS_HELPER_ENTRY, SEALED_DNS_STATE_FILE, SINKHOLE_ALIAS,
  checkSandboxArgProblems, checkSandboxHostsFile, checkSandboxNames, checkSandboxPlan, checkSandboxResolvConf, checkSandboxRunArgs, parseSealedDnsRecord, readSealedDnsRecord, sealedDnsHelperRunArgs, writeCheckSandboxFiles,
  type CheckSandboxInput, type CheckSandboxNetwork,
} from "../../packages/worker/src/check-sandbox.js";
import { RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_WORKSPACE_LABEL, runNetworkAddresses, runNetworkHelperIp, runNetworkLabelArgs, runNetworkName } from "../../packages/worker/src/run-network.js";
import { SealedDnsHelper } from "../../packages/worker/src/setup-dns-watch.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { TASK_SANDBOX_NETWORK, taskSandboxRunArgs } from "../../packages/worker/src/task-sandbox.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const WS = "0123456789abcdef";
const SLOT = 5;
const ROOT = "/workspace/project";

function network(overrides: Partial<CheckSandboxNetwork> = {}): CheckSandboxNetwork {
  const addresses = runNetworkAddresses(SLOT);
  return {
    name: runNetworkName(RUN), slot: SLOT, subnet: addresses.subnet, dnsHelperIp: addresses.dnsHelperIp, workingSandboxIp: addresses.workingSandboxIp, checkSandboxIp: addresses.checkSandboxIp,
    labelArgs: () => runNetworkLabelArgs({ runId: RUN, workspace: WS, createdAt: 1_800_000_000_000, expiresAt: 1_800_000_900_000 }),
    ...overrides,
  };
}
const helper = (index: number) => runNetworkHelperIp(SLOT, index);
function input(overrides: Partial<CheckSandboxInput> = {}): CheckSandboxInput {
  return {
    net: network(), taskId: "task-1", image: "worker:img", rootPath: ROOT, maskedPaths: ["/workspace/.agentx-state"], hostCpus: 4, hostMemoryBytes: 16 * 2 ** 30,
    filesDir: "/run/rovara/check-1", helpers: [{ alias: "postgres", address: helper(1) }, { alias: "aws", address: helper(2) }], sinkholeIp: helper(0), ...overrides,
  };
}
const FILES = { resolvConfPath: "/run/rovara/check-1/resolv.conf", hostsPath: "/run/rovara/check-1/hosts" };
const valuesOf = (args: readonly string[], flag: string) => args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));
const config = (code: string) => expect.objectContaining({ code, message: expect.any(String) });

describe("the sealed check sandbox's run arguments", () => {
  const args = checkSandboxRunArgs(input(), FILES);

  it("is attached to the run's services network alone, at the fixed address .4", () => {
    expect(valuesOf(args, "--network")).toEqual([runNetworkName(RUN)]);
    expect(valuesOf(args, "--ip")).toEqual([runNetworkAddresses(SLOT).checkSandboxIp]);
    expect(runNetworkAddresses(SLOT).checkSandboxIp).toBe("172.30.5.4");
    expect(args).not.toContain(TASK_SANDBOX_NETWORK);
    for (const forbidden of ["bridge", "host", "none", "--net", "--publish", "-p", "--publish-all", "-P", "--expose", "--link", "--network-alias", "--add-host", "--privileged", "--cap-add", "--device", "--sysctl"]) expect(args, forbidden).not.toContain(forbidden);
    expect(args.some((arg) => arg.startsWith("--network="))).toBe(false);
  });

  it("names no DNS server of Docker's: the resolver file is the run's own", () => {
    for (const flag of ["--dns", "--dns-search", "--dns-option"]) expect(args).not.toContain(flag);
    expect(valuesOf(args, "--volume")).toEqual([`${ROOT}:${ROOT}`, `${FILES.resolvConfPath}:/etc/resolv.conf:ro`, `${FILES.hostsPath}:/etc/hosts:ro`]);
  });

  it("is the task sandbox's own hardening plus only the run's additions (hostname, the four labels, the two read-only files)", () => {
    const base = taskSandboxRunArgs({ name: `${runNetworkName(RUN)}-check`, taskId: "task-1", image: "worker:img", rootPath: ROOT, maskedPaths: ["/workspace/.agentx-state"], hostCpus: 4, hostMemoryBytes: 16 * 2 ** 30, network: { name: runNetworkName(RUN), ip: "172.30.5.4" } });
    const additions = ["--hostname", CHECK_SANDBOX_HOSTNAME, ...network().labelArgs(), "--volume", `${FILES.resolvConfPath}:/etc/resolv.conf:ro`, "--volume", `${FILES.hostsPath}:/etc/hosts:ro`];
    expect(args).toEqual([...base.slice(0, -6), ...additions, ...base.slice(-6)]);
    expect(valuesOf(args, "--user")).toEqual(["1000:1000"]);
    expect(valuesOf(args, "--cap-drop")).toEqual(["ALL"]);
    expect(valuesOf(args, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(valuesOf(args, "--pids-limit")).toEqual(["4096"]);
    expect(valuesOf(args, "--memory")).toEqual(["13107m"]);
    expect(valuesOf(args, "--cpus")).toEqual(["3"]);
    expect(args.slice(-4)).toEqual(["worker:img", "--", "sleep", "infinity"]);
  });

  it("carries all four run-network labels, so the sweep and stop() can find it", () => {
    const labels = valuesOf(args, "--label");
    for (const key of [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL]) expect(labels.some((label) => label.startsWith(`${key}=`)), key).toBe(true);
  });

  it("passes its own soundness check, and the check finds each unsound change", () => {
    const paths = { ...FILES, rootPath: ROOT };
    expect(checkSandboxArgProblems(args, network(), paths)).toEqual([]);
    const withBefore = (...extra: string[]) => [...args.slice(0, -6), ...extra, ...args.slice(-6)];
    const bad: Array<[string, string[]]> = [
      ["second network", withBefore("--network", "agentx-task")],
      ["publish", withBefore("--publish", "8080:80")],
      ["short publish", withBefore("-p", "8080:80")],
      ["dns", withBefore("--dns", "8.8.8.8")],
      ["dns equals form", withBefore("--dns=8.8.8.8")],
      ["add-host", withBefore("--add-host", "a:1.2.3.4")],
      ["cap-add", withBefore("--cap-add", "NET_ADMIN")],
      ["privileged", withBefore("--privileged")],
      ["device", withBefore("--device", "/dev/net/tun")],
      ["pid host", withBefore("--pid", "host")],
      ["a flag after a boolean flag", withBefore("--init", "--publish", "1:1")],
      ["a flag that starts a value", withBefore("--label", "--publish")],
      ["docker socket", withBefore("--volume", "/var/run/docker.sock:/var/run/docker.sock")],
      ["extra mount", withBefore("--volume", "/etc:/host-etc")],
      ["a writable resolv.conf", args.map((arg) => (arg === `${FILES.resolvConfPath}:/etc/resolv.conf:ro` ? `${FILES.resolvConfPath}:/etc/resolv.conf` : arg))],
      ["a writable hosts", args.map((arg) => (arg === `${FILES.hostsPath}:/etc/hosts:ro` ? `${FILES.hostsPath}:/etc/hosts` : arg))],
      ["host network", args.map((arg) => (arg === runNetworkName(RUN) ? "host" : arg))],
      ["the default bridge", args.map((arg) => (arg === runNetworkName(RUN) ? "bridge" : arg))],
      ["the task network", args.map((arg) => (arg === runNetworkName(RUN) ? TASK_SANDBOX_NETWORK : arg))],
      ["another address", args.map((arg) => (arg === "172.30.5.4" ? "172.30.5.3" : arg))],
      ["no ip", args.filter((arg, index) => arg !== "--ip" && args[index - 1] !== "--ip")],
      ["no cap-drop", args.filter((arg, index) => arg !== "--cap-drop" && args[index - 1] !== "--cap-drop")],
      ["a different cap-drop", args.map((arg) => (arg === "ALL" ? "NET_RAW" : arg))],
      ["no no-new-privileges", args.map((arg) => (arg === "no-new-privileges" ? "seccomp=unconfined" : arg))],
      ["no user", args.filter((arg, index) => arg !== "--user" && args[index - 1] !== "--user")],
      ["no pids limit", args.filter((arg, index) => arg !== "--pids-limit" && args[index - 1] !== "--pids-limit")],
    ];
    for (const [name, changed] of bad) expect(checkSandboxArgProblems(changed, network(), paths), name).not.toEqual([]);
    // Each rule says so in its own words (so one rule cannot hide behind another).
    const said = (changed: string[]) => checkSandboxArgProblems(changed, network(), paths).join(" | ");
    expect(said(withBefore("--network", "some-other-net"))).toMatch(/services network alone/u);
    expect(said(args.map((arg) => (arg === runNetworkName(RUN) ? "bridge" : arg)))).toMatch(/route out/u);
    expect(said(args.map((arg) => (arg === runNetworkName(RUN) ? "host" : arg)))).toMatch(/route out/u);
    expect(said(withBefore("--network", "container:abc"))).toMatch(/route out/u);
    expect(said(withBefore("--volume", "/var/run/docker.sock:/s"))).toMatch(/docker socket/u);
    expect(said(withBefore("--volume", "/x/docker.sock:/s"))).toMatch(/docker socket/u);
    expect(said(args.map((arg) => (arg === "172.30.5.4" ? "172.30.5.3" : arg)))).toMatch(/fixed check sandbox address/u);
    expect(said(args.map((arg) => (arg === "ALL" ? "NET_RAW" : arg)))).toMatch(/every capability/u);
    expect(said(args.map((arg) => (arg === "no-new-privileges" ? "seccomp=unconfined" : arg)))).toMatch(/no-new-privileges/u);
    expect(said(withBefore("--publish", "1:1"))).toMatch(/publishes a port/u);
    expect(said(withBefore("--volume", "/etc:/e"))).toMatch(/exactly the workspace/u);
    expect(said(args.filter((arg, index) => arg !== "--user" && args[index - 1] !== "--user"))).toMatch(/lacks --user/u);
  });

  it("a label whose text looks like a flag is a value, not a flag", () => {
    const odd = checkSandboxRunArgs(input({ taskId: "not-a-flag" }), FILES);
    expect(checkSandboxArgProblems(odd, network(), { ...FILES, rootPath: ROOT })).toEqual([]);
  });

  it("refuses a network that is not the run's address plan or has lost a label", () => {
    expect(() => checkSandboxRunArgs(input({ net: network({ checkSandboxIp: "172.30.5.9" }) }), FILES)).toThrow(config("CONFIG_INVALID"));
    expect(() => checkSandboxRunArgs(input({ net: network({ dnsHelperIp: "172.30.5.9" }) }), FILES)).toThrow(config("CONFIG_INVALID"));
    expect(() => checkSandboxRunArgs(input({ net: network({ subnet: "172.30.6.0/24" }) }), FILES)).toThrow(config("CONFIG_INVALID"));
    expect(() => checkSandboxRunArgs(input({ net: network({ name: TASK_SANDBOX_NETWORK }) }), FILES)).toThrow(config("CONFIG_INVALID"));
    expect(() => checkSandboxRunArgs(input({ net: network({ name: "bridge" }) }), FILES)).toThrow(config("CONFIG_INVALID"));
    for (const name of ["my-own-net", "rovara-svc-xyz", "rovara-svc-0123456789abc", "rovara-svc-0123456789ab-x", "--network"]) expect(() => checkSandboxRunArgs(input({ net: network({ name }) }), FILES), name).toThrow(config("CONFIG_INVALID"));
    for (const key of [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL]) {
      const labels = network().labelArgs();
      const without = labels.filter((arg, index) => !arg.startsWith(`${key}=`) && !(labels[index + 1]?.startsWith(`${key}=`) && arg === "--label"));
      expect(() => checkSandboxRunArgs(input({ net: network({ labelArgs: () => without }) }), FILES), key).toThrow(config("CONFIG_INVALID"));
    }
  });

  it("refuses a path that is not a plain absolute path, or two files at one path", () => {
    for (const bad of ["relative/resolv.conf", "/a/../b", "/a/./b", "/a:b", "/a,b", "/a b", "", "/", "/a/\n/b", `/${"a".repeat(600)}`]) {
      expect(() => checkSandboxRunArgs(input(), { ...FILES, resolvConfPath: bad }), bad).toThrow(config("CONFIG_INVALID"));
      expect(() => checkSandboxRunArgs(input(), { ...FILES, hostsPath: bad }), bad).toThrow(config("CONFIG_INVALID"));
    }
    expect(() => checkSandboxRunArgs(input(), { resolvConfPath: FILES.hostsPath, hostsPath: FILES.hostsPath })).toThrow(config("CONFIG_INVALID"));
  });
});

describe("the run's names, resolv.conf and hosts file", () => {
  it("lists every dependency at its helper's address, and the sinkhole", () => {
    expect(checkSandboxNames(network(), input().helpers, helper(0))).toEqual([{ alias: "postgres", address: "172.30.5.17" }, { alias: "aws", address: "172.30.5.18" }, { alias: SINKHOLE_ALIAS, address: "172.30.5.16" }]);
  });

  it("names the DNS helper at .2 alone in resolv.conf, with no search domain and no second server", () => {
    expect(checkSandboxResolvConf("172.30.5.2")).toBe("nameserver 172.30.5.2\noptions ndots:0 timeout:2 attempts:2\n");
    const plan = checkSandboxPlan(input());
    expect(plan.resolvConf.match(/^nameserver /gmu)).toHaveLength(1);
    expect(plan.resolvConf).not.toMatch(/search|domain|127\.0\.0\.11/u);
    expect(() => checkSandboxResolvConf("not-an-ip")).toThrow(config("CONFIG_INVALID"));
    expect(() => checkSandboxResolvConf("fd00::2")).toThrow(config("CONFIG_INVALID"));
  });

  it("writes the hosts file with loopback, the sandbox itself and the run's names", () => {
    expect(checkSandboxPlan(input()).hosts).toBe("127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n172.30.5.4 check\n172.30.5.17 postgres\n172.30.5.18 aws\n172.30.5.16 sinkhole\n");
    expect(checkSandboxHostsFile("172.30.5.4", [])).toBe("127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n172.30.5.4 check\n");
  });

  it("refuses an alias that is not a plain name, is reserved, or is given twice", () => {
    const names = (helpers: CheckSandboxInput["helpers"]) => () => checkSandboxNames(network(), helpers, helper(0));
    expect(names([{ alias: "my-db2", address: helper(1) }])).not.toThrow();
    for (const bad of ["", "A", "Postgres", "1db", "db-", "-db", "d", "a.b", "a_b", "db db", "db\n127.0.0.1 evil", "--privileged", "x".repeat(33), "db;rm", "../x"]) expect(names([{ alias: bad, address: helper(1) }]), JSON.stringify(bad)).toThrow(config("CONFIG_INVALID"));
    for (const reserved of RESERVED_RUN_ALIASES) expect(names([{ alias: reserved, address: helper(1) }]), reserved).toThrow(config("CONFIG_INVALID"));
    expect([...RESERVED_RUN_ALIASES]).toEqual(expect.arrayContaining([SINKHOLE_ALIAS, "localhost", "dns", "proxy", "check", "working"]));
    expect(names([{ alias: "db", address: helper(1) }, { alias: "db", address: helper(2) }])).toThrow(config("CONFIG_INVALID"));
  });

  it("refuses an address that is not one of THIS run's helper addresses (.16 to .47)", () => {
    const names = (address: string, sinkhole = helper(0)) => () => checkSandboxNames(network(), [{ alias: "db", address }], sinkhole);
    expect(names("172.30.5.47")).not.toThrow();
    expect(names("172.30.5.16")).not.toThrow();
    for (const bad of ["172.30.5.1", "172.30.5.2", "172.30.5.3", "172.30.5.4", "172.30.5.8", "172.30.5.15", "172.30.5.48", "172.30.6.17", "172.29.5.17", "8.8.8.8", "169.254.169.254", "127.0.0.1", "172.30.5.17\n1.2.3.4 x", "", "::1"]) {
      expect(names(bad), JSON.stringify(bad)).toThrow(config("CONFIG_INVALID"));
      expect(names(helper(1), bad), `sinkhole ${JSON.stringify(bad)}`).toThrow(config("CONFIG_INVALID"));
    }
  });

  it("refuses more names than the sealed table holds", () => {
    const many = Array.from({ length: 300 }, (_, index) => ({ alias: `svc${String(index)}-x`, address: helper(1) }));
    expect(() => checkSandboxNames(network(), many, helper(0))).toThrow(config("CONFIG_INVALID"));
  });
});

describe("the DNS helper's run arguments (sealed mode)", () => {
  const args = sealedDnsHelperRunArgs({ net: network(), image: "worker:img", helpers: input().helpers, sinkholeIp: helper(0) });

  it("is on the services network at .2, with all four labels, and nothing else attached", () => {
    expect(valuesOf(args, "--network")).toEqual([runNetworkName(RUN)]);
    expect(valuesOf(args, "--ip")).toEqual(["172.30.5.2"]);
    expect(valuesOf(args, "--name")).toEqual([`${runNetworkName(RUN)}-dns`]);
    expect(valuesOf(args, "--label")).toEqual(valuesOf(network().labelArgs(), "--label"));
    for (const forbidden of ["--publish", "-p", "--publish-all", "-P", "--dns", "--add-host", "--privileged", "--cap-add", "--device", "--net", "--link", "--upstream", "bridge", "host", TASK_SANDBOX_NETWORK]) expect(args, forbidden).not.toContain(forbidden);
  });

  it("has the setup helper's hardening", () => {
    expect(valuesOf(args, "--user")).toEqual(["1000:1000"]);
    expect(valuesOf(args, "--cap-drop")).toEqual(["ALL"]);
    expect(valuesOf(args, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(args).toContain("--read-only");
    expect(args).toContain("--pull=never");
    expect(valuesOf(args, "--sysctl")).toEqual(["net.ipv4.ip_unprivileged_port_start=53"]);
    expect(valuesOf(args, "--pids-limit")).toEqual(["64"]);
    expect(valuesOf(args, "--memory")).toEqual(["128m"]);
    expect(valuesOf(args, "--memory-swap")).toEqual(["128m"]);
    expect(valuesOf(args, "--cpus")).toEqual(["0.5"]);
    expect(valuesOf(args, "--tmpfs")).toEqual(["/state:rw,noexec,nosuid,size=1m,uid=1000,gid=1000"]);
  });

  it("runs the sealed program, serving .3 and .4 only, with the sinkhole, the table and no upstream", () => {
    const program = args.slice(args.indexOf("worker:img"));
    expect(program).toEqual(["worker:img", SEALED_DNS_HELPER_ENTRY, "--listen", "172.30.5.2", "--source", "172.30.5.3", "--source", "172.30.5.4", "--sinkhole", "172.30.5.16",
      "--host", "postgres=172.30.5.17", "--host", "aws=172.30.5.18", "--host", "sinkhole=172.30.5.16", "--state", SEALED_DNS_STATE_FILE]);
    expect(program).not.toContain("--upstream");
    expect(valuesOf(args, "--entrypoint")).toEqual(["/usr/local/bin/node"]);
  });

  it("refuses a network that is not the run's address plan", () => {
    expect(() => sealedDnsHelperRunArgs({ net: network({ dnsHelperIp: "172.30.5.9" }), image: "i", helpers: input().helpers, sinkholeIp: helper(0) })).toThrow(config("CONFIG_INVALID"));
  });

  it("validates the names itself when it is called on its own: a bad alias, a stray address or a public sinkhole never reaches a docker argument", () => {
    const make = (helpers: CheckSandboxInput["helpers"], sinkholeIp = helper(0)) => () => sealedDnsHelperRunArgs({ net: network(), image: "i", helpers, sinkholeIp });
    expect(make(input().helpers)).not.toThrow();
    expect(make([{ alias: "--privileged", address: helper(1) }])).toThrow(config("CONFIG_INVALID"));
    expect(make([{ alias: "db", address: "8.8.8.8" }])).toThrow(config("CONFIG_INVALID"));
    expect(make([{ alias: "sinkhole", address: helper(1) }])).toThrow(config("CONFIG_INVALID"));
    expect(make(input().helpers, "8.8.8.8")).toThrow(config("CONFIG_INVALID"));
  });
});

describe("the plan the ServiceRunner takes", () => {
  it("gathers the attachment, the files and both containers' arguments", () => {
    const plan = checkSandboxPlan(input());
    expect(plan.network).toEqual({ name: runNetworkName(RUN), ip: "172.30.5.4" });
    expect(plan.sandboxName).toBe(`${runNetworkName(RUN)}-check`);
    expect(plan.dnsHelperName).toBe(`${runNetworkName(RUN)}-dns`);
    expect(plan.resolvConfPath).toBe("/run/rovara/check-1/resolv.conf");
    expect(plan.hostsPath).toBe("/run/rovara/check-1/hosts");
    expect(plan.sandboxRunArgs).toEqual(checkSandboxRunArgs(input(), { resolvConfPath: plan.resolvConfPath, hostsPath: plan.hostsPath }));
    expect(valuesOf(plan.sandboxRunArgs, "--name")).toEqual([plan.sandboxName]);
  });

  it("refuses a files directory that is not a plain absolute path", () => {
    for (const bad of ["relative", "/a/../b", "/a:b", ""]) expect(() => checkSandboxPlan(input({ filesDir: bad })), bad).toThrow(config("CONFIG_INVALID"));
  });

  it("the hosts file and the DNS table list the same names and addresses, and the helper serves exactly those (an unknown name goes to the sinkhole and is counted)", async () => {
    const plan = checkSandboxPlan(input());
    const table = Object.fromEntries(plan.names.map((entry) => [entry.alias, entry.address]));
    const hostLines = plan.hosts.split("\n").filter((line) => line.startsWith("172.30.5.") && !line.endsWith(" check"));
    expect(hostLines).toEqual(plan.names.map((entry) => `${entry.address} ${entry.alias}`));
    const dns = new SealedDnsHelper({ listenAddress: "127.0.0.1", allowLoopback: true, port: 0, names: table, sinkholeAddress: "172.30.5.16", allowedSources: ["127.0.0.1"] });
    const { port } = await dns.start();
    try {
      const { createSocket } = await import("node:dgram");
      const ask = (name: string) => new Promise<string>((resolve) => {
        const client = createSocket("udp4");
        const packet = Buffer.concat([Buffer.from([0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0, 0, 1, 0, 1])]);
        client.on("message", (reply) => { client.close(); resolve([...reply.subarray(reply.length - 4)].join(".")); });
        client.send(packet, port, "127.0.0.1");
      });
      expect(await ask("postgres")).toBe("172.30.5.17");
      expect(await ask("aws")).toBe("172.30.5.18");
      expect(await ask("api.some-vendor.com")).toBe("172.30.5.16");
      expect(dns.unknownNames()).toEqual([{ name: "api.some-vendor.com", queries: 1 }]);
    } finally {
      await dns.stop();
    }
  });
});

describe("the run-owned files", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

  it("writes both files with the plan's content, readable by the sandbox's user and not writable by it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "check-sandbox-"));
    dirs.push(dir);
    const plan = checkSandboxPlan(input({ filesDir: dir }));
    await writeCheckSandboxFiles(plan);
    expect(await readFile(plan.resolvConfPath, "utf8")).toBe(plan.resolvConf);
    expect(await readFile(plan.hostsPath, "utf8")).toBe(plan.hosts);
    for (const path of [plan.resolvConfPath, plan.hostsPath]) expect((await stat(path)).mode & 0o777).toBe(0o644);
  });

  it("does not overwrite an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "check-sandbox-"));
    dirs.push(dir);
    const plan = checkSandboxPlan(input({ filesDir: dir }));
    await writeFile(plan.hostsPath, "planted");
    await expect(writeCheckSandboxFiles(plan)).rejects.toThrow(/EEXIST/u);
    expect(await readFile(plan.hostsPath, "utf8")).toBe("planted");
  });
});

describe("the helper's record of unknown names", () => {
  it("parses the file the helper writes", () => {
    expect(parseSealedDnsRecord(JSON.stringify({ unknown: [{ name: "api.vendor.com", queries: 3 }, { name: "postgress", queries: 1 }], dropped: 2, unrecorded: 1 }))).toEqual({ unknown: [{ name: "api.vendor.com", queries: 3 }, { name: "postgress", queries: 1 }], dropped: 2, unrecorded: 1 });
  });

  it("gives an empty record for anything that is not exactly that shape, and keeps no name that is not a plain name", () => {
    const empty = { unknown: [], dropped: 0, unrecorded: 0 };
    for (const text of ["", "not json", "null", "[]", "42", '"x"']) expect(parseSealedDnsRecord(text), text).toEqual(empty);
    const parsed = parseSealedDnsRecord(JSON.stringify({ unknown: [{ name: "ok.test", queries: 1 }, { name: "Evil Name", queries: 1 }, { name: "a\nb", queries: 1 }, { name: "x", queries: 0 }, { name: "y", queries: -1 }, { name: 5, queries: 1 }, null, "z", { name: "no-count" }], dropped: -3, unrecorded: "many" }));
    expect(parsed).toEqual({ unknown: [{ name: "ok.test", queries: 1 }], dropped: 0, unrecorded: 0 });
  });

  it("keeps at most 200 names", () => {
    const text = JSON.stringify({ unknown: Array.from({ length: 500 }, (_, index) => ({ name: `n${String(index)}.test`, queries: 1 })), dropped: 0, unrecorded: 0 });
    expect(parseSealedDnsRecord(text).unknown).toHaveLength(200);
  });

  it("reads it with one fixed docker exec, and a failed read gives an empty record", async () => {
    const calls: string[][] = [];
    const docker = (result: { exitCode: number; stdout: string }): DockerCli => ({ run: (args) => { calls.push([...args]); return Promise.resolve({ ...result, stderr: "" }); } });
    const helperName = `${runNetworkName(RUN)}-dns`;
    const ok = await readSealedDnsRecord(docker({ exitCode: 0, stdout: JSON.stringify({ unknown: [{ name: "a.test", queries: 2 }], dropped: 0, unrecorded: 0 }) }), helperName);
    expect(ok.unknown).toEqual([{ name: "a.test", queries: 2 }]);
    expect(calls).toEqual([["exec", helperName, "cat", SEALED_DNS_STATE_FILE]]);
    expect(await readSealedDnsRecord(docker({ exitCode: 1, stdout: "" }), helperName)).toEqual({ unknown: [], dropped: 0, unrecorded: 0 });
    expect(await readSealedDnsRecord({ run: () => Promise.reject(new Error("boom")) }, helperName)).toEqual({ unknown: [], dropped: 0, unrecorded: 0 });
    await expect(readSealedDnsRecord(docker({ exitCode: 0, stdout: "{}" }), "some-other-container")).rejects.toThrow(config("CONFIG_INVALID"));
    await expect(readSealedDnsRecord(docker({ exitCode: 0, stdout: "{}" }), "--all")).rejects.toThrow(config("CONFIG_INVALID"));
  });
});
