// The sealed check sandbox (test services, TS16; design test-services.md 4.0.2, 4.0.3 and 12, owner Q3). DEPLOYMENT CODE: nothing here has been run against Docker (this build starts no Docker); the Linux checks
// TS-L1 to TS-L3 and TS-L6 (scripts/linux-check-test-services.sh) AND the sealed-sandbox checks listed below MUST pass on linux-runtime or a staging worker before the `tx` switch is turned on. Nothing calls this module yet:
// the ServiceRunner (TS17) takes `checkSandboxPlan()` and starts the two containers it describes, only when `tx` is on.
//
// What it builds, as pure data (no process is started here):
//   - the sealed check sandbox's `docker run` arguments: attached to the run's services network ONLY (`--network rovara-svc-...` with the fixed address .4, never the default bridge, never the working-egress network, no
//     published port, no extra network, no `--dns`), with the sandbox hardening of task sandboxes (it IS `taskSandboxRunArgs`: non-root user, no capability, no-new-privileges, pids/cpu/memory limits, the workspace as the only
//     mount) plus two read-only mounts that the run owns: a /etc/resolv.conf that names the DNS helper at .2 alone, and a /etc/hosts with the run's helper names and addresses. This copies the E2E host
//     (docker-application-host.ts, "Docker 25 does not forward the queries of a container that is only on internal networks"): the embedded resolver is never consulted for a name that is not in the hosts file;
//   - the contents of those two files, and the path they are written to (`writeCheckSandboxFiles`);
//   - the DNS helper's `docker run` arguments: the same container hardening as the setup run's helper (setup-network.ts `helperRunArgs`), on the services network at .2, running the SEALED mode of the name server
//     (sealed-dns-helper.ts -> `SealedDnsHelper` in setup-dns-watch.ts): a static table, the sinkhole for every other name, no upstream, served addresses .3 and .4 only;
//   - a reader for the helper's record of unknown names (`readSealedDnsRecord`).
//
// WHY THE SANDBOX CANNOT REACH ANYTHING BUT THE RUN: the services network is `--internal` and its bridge is named `rvi*`, which the boot firewall walls (boot.sh `wall_off_containers`); the sandbox is on that network and no other, and
// its only name server is the sealed helper, which has no upstream and answers every unknown name with the sinkhole. `checkSandboxRunArgs` re-checks its own result (`checkSandboxArgProblems`) and throws if a future change to
// the task sandbox's arguments would add a second network, a published port, a DNS option, an added capability, or a docker socket.
//
// NOT HERE (other tasks): the run's connection variables (`--env-file` on a worker tmpfs, per `docker exec`, TS15/TS17); the test-account proxy and its name (TS27); starting the helpers and the sinkhole (TS14/TS17); the
// sinkhole's own record of calls (name, port, count: the fake server image in record-only mode, TS23).
//
// MUST RUN BEFORE `tx` IS ON (linux-runtime or a staging worker; these are the live part of TS-L3, which scripts/linux-check-test-services.sh still reports PENDING):
//   1. `--ip` .4 is accepted on the internal /24 although the network's `--ip-range` is the upper half (the sandbox and the helpers take fixed low addresses);
//   2. a bind mount over /etc/resolv.conf and over /etc/hosts of a container that has no `--dns` and sits only on the internal network is honoured (read-only, as the sandbox's user cannot change it);
//   3. from inside the sealed sandbox: a name in the table resolves to its helper and a connection to it works; an unknown name resolves to the sinkhole and a connection to it reaches the sinkhole (and is counted);
//      a public address, 8.8.8.8 port 53, the gateway .1 on every port, another run's helper, the metadata address and the host's resolver all fail; there is no default route out of the run;
//   4. the DNS helper binds .2:53 as uid 1000 (`net.ipv4.ip_unprivileged_port_start=53`, no capability) and answers .3 and .4 only: a query from the helper's neighbours (.16 and up) gets no answer;
//   5. the helper makes no outbound connection of its own (tcpdump on its interface while the sandbox asks unknown names).
import { isIP } from "node:net";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentXError } from "@agentx/contracts";
import { RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_WORKSPACE_LABEL, runNetworkAddresses, runNetworkHelperIp, type ServicesNetwork } from "./run-network.js";
import { SEALED_DNS_TABLE_MAX } from "./setup-dns-watch.js";
import type { DockerCli } from "./swebench/containers.js";
import { SANDBOX_FILE_OPS_NODE, TASK_SANDBOX_NETWORK, taskSandboxRunArgs } from "./task-sandbox.js";

/** Where the image keeps the sealed helper's program (environments/base/Dockerfile copies the worker's dist). */
export const SEALED_DNS_HELPER_ENTRY = "/opt/agentx/packages/worker/dist/sealed-dns-helper.js";
/** Where the helper writes the unknown names it was asked; the worker reads it with one fixed `docker exec <helper> cat`. */
export const SEALED_DNS_STATE_FILE = "/state/unknown.json";
/** The name the sinkhole (the fake server image in record-only mode) has in the run's hosts file and in the sealed table. */
export const SINKHOLE_ALIAS = "sinkhole";
/** The check sandbox's host name inside the container, so a program that looks up its own name finds .4 in the hosts file. */
export const CHECK_SANDBOX_HOSTNAME = "check";
/** The reserved names no dependency may take (the name server, the sandboxes, the proxy, the sinkhole, the loopback name). */
export const RESERVED_RUN_ALIASES: ReadonlySet<string> = new Set([SINKHOLE_ALIAS, CHECK_SANDBOX_HOSTNAME, "localhost", "dns", "dns-helper", "working", "proxy", "test-account-proxy", "gateway", "aws-metadata"]);
/** The most unknown names the worker reads back from the helper's file. */
export const SEALED_DNS_RECORD_NAMES_MAX = 200;
/** The sealed helper's container limits (copied from the setup run's helper). */
const DNS_HELPER_PIDS = "64";
const DNS_HELPER_MEMORY = "128m";
const DNS_HELPER_CPUS = "0.5";
const DOCKER_CALL_TIMEOUT_MS = 60_000;
const ALIAS = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/u;
const SERVICES_NETWORK_NAME = /^rovara-svc-[0-9a-f]{12}$/u;
const SAFE_HOST_PATH = /^\/[A-Za-z0-9_./-]{1,500}$/u;
/** The service helpers of a slot: 32 addresses, .16 to .47 (run-network.ts). */
const HELPER_COUNT = 32;

/** The part of a started services network (`ServicesNetwork`, run-network.ts) this module reads. */
export type CheckSandboxNetwork = Pick<ServicesNetwork, "name" | "slot" | "subnet" | "dnsHelperIp" | "workingSandboxIp" | "checkSandboxIp" | "labelArgs">;

/** A name on the run's services network and the address it has: a dependency's alias and the helper's address. */
export interface RunHostEntry {
  alias: string;
  address: string;
}

export interface CheckSandboxInput {
  /** The run's started services network. */
  net: CheckSandboxNetwork;
  /** The operation the sandbox serves (labels the container like every task sandbox). */
  taskId: string;
  /** The worker's own image: it is the sandbox image and carries the sealed helper's program. */
  image: string;
  /** The workspace root, mounted at its own path as in every task sandbox. */
  rootPath: string;
  /** Folders of the workspace volume that are the worker's, not the project's (workspace-state.ts). */
  maskedPaths: readonly string[];
  hostCpus?: number;
  hostMemoryBytes?: number;
  /** A directory the run owns on the worker, where `resolv.conf` and `hosts` are written (`writeCheckSandboxFiles`). An absolute path of plain characters. */
  filesDir: string;
  /** The run's dependencies: each alias and the address of the helper that serves it (.16 to .47 of the run's network). */
  helpers: readonly RunHostEntry[];
  /** The sinkhole's address: one of the helper addresses (.16 to .47). */
  sinkholeIp: string;
}

export interface CheckSandboxPlan {
  /** The sandbox container's name (derived from the network's, a hash). */
  sandboxName: string;
  /** The DNS helper container's name. */
  dnsHelperName: string;
  /** The sandbox's attachment: the run's services network and the fixed address .4 (nothing else). The ServiceRunner takes this as its parameter. */
  network: { name: string; ip: string };
  /** The run's names: the dependencies and the sinkhole. This is the hosts file's list and the DNS helper's static table. */
  names: readonly RunHostEntry[];
  /** The content of the sandbox's /etc/resolv.conf: the DNS helper at .2 alone. */
  resolvConf: string;
  /** The content of the sandbox's /etc/hosts. */
  hosts: string;
  resolvConfPath: string;
  hostsPath: string;
  /** `docker run` arguments of the sealed check sandbox. */
  sandboxRunArgs: string[];
  /** `docker run` arguments of the DNS helper in sealed mode. */
  dnsHelperRunArgs: string[];
}

function assertAlias(alias: string): void {
  if (!ALIAS.test(alias) || RESERVED_RUN_ALIASES.has(alias)) throw agentXError("CONFIG_INVALID", "not a name a test service may have on the run network");
}

/** True when `address` is one of the service helper addresses of this slot (.16 to .47). */
function isHelperAddress(slot: number, address: string): boolean {
  for (let index = 0; index < HELPER_COUNT; index += 1) if (runNetworkHelperIp(slot, index) === address) return true;
  return false;
}

/**
 * The run's names for the hosts file and the DNS table: every dependency alias (validated: strict regex, not reserved, once) at its helper's address (.16 to .47 of THIS run's slot), and the sinkhole.
 * Throws CONFIG_INVALID on anything else, so no repository-controlled string reaches a file or a docker argument unchecked.
 */
export function checkSandboxNames(net: Pick<CheckSandboxNetwork, "slot">, helpers: readonly RunHostEntry[], sinkholeIp: string): RunHostEntry[] {
  if (!isHelperAddress(net.slot, sinkholeIp)) throw agentXError("CONFIG_INVALID", "the sinkhole is one of the run's helper addresses");
  if (helpers.length + 1 > SEALED_DNS_TABLE_MAX) throw agentXError("CONFIG_INVALID", "too many test services for one run");
  const seen = new Set<string>();
  const names: RunHostEntry[] = [];
  for (const helper of helpers) {
    assertAlias(helper.alias);
    if (seen.has(helper.alias)) throw agentXError("CONFIG_INVALID", "a name is given to two test services");
    if (!isHelperAddress(net.slot, helper.address)) throw agentXError("CONFIG_INVALID", "a test service is not at one of the run's helper addresses");
    seen.add(helper.alias);
    names.push({ alias: helper.alias, address: helper.address });
  }
  names.push({ alias: SINKHOLE_ALIAS, address: sinkholeIp });
  return names;
}

/** The sandbox's /etc/resolv.conf: the DNS helper alone, no search domain (the E2E host's file). */
export function checkSandboxResolvConf(dnsHelperIp: string): string {
  if (isIP(dnsHelperIp) !== 4) throw agentXError("CONFIG_INVALID", "the DNS helper's address is an IPv4 address");
  return `nameserver ${dnsHelperIp}\noptions ndots:0 timeout:2 attempts:2\n`;
}

/** The sandbox's /etc/hosts: loopback, the sandbox itself, and the run's names. */
export function checkSandboxHostsFile(checkSandboxIp: string, names: readonly RunHostEntry[]): string {
  if (isIP(checkSandboxIp) !== 4) throw agentXError("CONFIG_INVALID", "the check sandbox's address is an IPv4 address");
  const lines = ["127.0.0.1 localhost", "::1 localhost ip6-localhost ip6-loopback", `${checkSandboxIp} ${CHECK_SANDBOX_HOSTNAME}`, ...names.map((entry) => `${entry.address} ${entry.alias}`)];
  return `${lines.join("\n")}\n`;
}

/** The flags the sealed sandbox must never carry, and the reason. */
const FORBIDDEN_FLAGS: ReadonlyMap<string, string> = new Map([
  ["--publish", "publishes a port"], ["-p", "publishes a port"], ["--publish-all", "publishes ports"], ["-P", "publishes ports"], ["--expose", "exposes a port"],
  ["--net", "names a network"], ["--link", "links a container"], ["--dns", "names a DNS server"], ["--dns-search", "names a search domain"], ["--dns-option", "sets a resolver option"],
  ["--add-host", "adds a host entry (the hosts file is the run's own)"], ["--privileged", "is privileged"], ["--cap-add", "adds a capability"], ["--device", "adds a device"],
  ["--pid", "shares a process namespace"], ["--ipc", "shares an IPC namespace"], ["--uts", "shares a UTS namespace"], ["--userns", "changes the user namespace"], ["--network-alias", "gives the sandbox an alias"],
  ["--mac-address", "sets a MAC address"], ["--ip6", "sets an IPv6 address"], ["--sysctl", "sets a kernel parameter"], ["--cgroupns", "changes the cgroup namespace"],
]);
/** The flags of a task sandbox that take no value. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["--detach", "--init", "--read-only", "--rm", "--privileged", "--publish-all", "-P", "-d", "-i", "-t", "-it"]);
const FORBIDDEN_MOUNT_SUBSTRINGS: readonly string[] = ["docker.sock", "/var/run", "/run/docker"];

/**
 * What is wrong with `args` as the arguments of the sealed check sandbox: an empty list when they are sound. Checked over the whole argument list before the image: exactly one network, the run's, at the
 * fixed address .4; none of the forbidden flags; the hardening of task sandboxes present; only the three expected mounts (workspace, resolv.conf, hosts), the last two read-only; no docker socket.
 */
export function checkSandboxArgProblems(args: readonly string[], net: CheckSandboxNetwork, paths: { resolvConfPath: string; hostsPath: string; rootPath: string }): string[] {
  const problems: string[] = [];
  const entry = args.lastIndexOf("--entrypoint");
  const flags = entry < 0 ? args : args.slice(0, entry);
  const valuesOf = (flag: string): string[] => flags.flatMap((arg, index) => (index > 0 && flags[index - 1] === flag ? [arg] : []));
  const networks = valuesOf("--network");
  if (networks.length !== 1 || networks[0] !== net.name) problems.push("not attached to the run's services network alone");
  if (networks.some((network) => network === TASK_SANDBOX_NETWORK || network === "bridge" || network === "host" || network === "none" || network.startsWith("container:"))) problems.push("attached to a network with a route out");
  const ips = valuesOf("--ip");
  if (ips.length !== 1 || ips[0] !== net.checkSandboxIp) problems.push("not at the fixed check sandbox address");
  // Only an argument in a flag position is looked at: the value after a flag that takes one (a label, a path, an image) is not, unless it starts with a dash, which is always read as a flag (fail closed).
  for (let at = 0; at < flags.length; at += 1) {
    const arg = flags[at]!;
    if (!arg.startsWith("-")) continue;
    const name = arg.startsWith("--") ? arg.split("=")[0]! : arg;
    const reason = FORBIDDEN_FLAGS.get(name);
    if (reason !== undefined) problems.push(`carries ${name}, which ${reason}`);
    const next = flags[at + 1];
    if (!arg.includes("=") && !BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith("-")) at += 1;
  }
  for (const required of ["--cap-drop", "--user", "--pids-limit"]) if (!flags.includes(required)) problems.push(`lacks ${required}`);
  const capDrop = valuesOf("--cap-drop");
  if (capDrop.length !== 1 || capDrop[0] !== "ALL") problems.push("does not drop every capability");
  if (!valuesOf("--security-opt").includes("no-new-privileges") || valuesOf("--security-opt").length !== 1) problems.push("does not hold exactly no-new-privileges as its security option");
  const volumes = valuesOf("--volume");
  const expected = [`${paths.rootPath}:${paths.rootPath}`, `${paths.resolvConfPath}:/etc/resolv.conf:ro`, `${paths.hostsPath}:/etc/hosts:ro`];
  if (volumes.length !== 3 || !expected.every((volume) => volumes.includes(volume))) problems.push("does not hold exactly the workspace, resolv.conf and hosts mounts");
  if (flags.some((arg) => FORBIDDEN_MOUNT_SUBSTRINGS.some((part) => arg.includes(part)))) problems.push("mounts a docker socket path");
  return problems;
}

function assertHostPath(path: string): void {
  if (!SAFE_HOST_PATH.test(path) || path.split("/").some((part) => part === ".." || part === ".")) throw agentXError("CONFIG_INVALID", "not a plain absolute path for a run file");
}

/** The four run-network labels must all be there (TS-RN-3 rule 1): a container without them is invisible to the sweep. */
function assertAllLabels(labelArgs: readonly string[]): void {
  const keys = labelArgs.flatMap((arg, index) => (labelArgs[index - 1] === "--label" ? [arg.split("=")[0]!] : []));
  for (const key of [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL]) {
    if (!keys.includes(key)) throw agentXError("CONFIG_INVALID", "the run's network labels are incomplete");
  }
}

/** The network must be exactly the address plan of its slot (run-network.ts): a hand-made object with another address is refused. */
function assertNetwork(net: CheckSandboxNetwork): void {
  if (!SERVICES_NETWORK_NAME.test(net.name)) throw agentXError("CONFIG_INVALID", "not a run services network");
  const plan = runNetworkAddresses(net.slot);
  if (net.subnet !== plan.subnet || net.dnsHelperIp !== plan.dnsHelperIp || net.workingSandboxIp !== plan.workingSandboxIp || net.checkSandboxIp !== plan.checkSandboxIp) {
    throw agentXError("CONFIG_INVALID", "the run network does not have the addresses of its slot");
  }
  assertAllLabels(net.labelArgs());
}

/** The arguments of the sealed check sandbox. Throws when the result would not pass `checkSandboxArgProblems`. */
export function checkSandboxRunArgs(input: CheckSandboxInput, files: { resolvConfPath: string; hostsPath: string }): string[] {
  assertNetwork(input.net);
  assertHostPath(files.resolvConfPath);
  assertHostPath(files.hostsPath);
  if (files.resolvConfPath === files.hostsPath) throw agentXError("CONFIG_INVALID", "the run's two files have two paths");
  const base = taskSandboxRunArgs({
    name: `${input.net.name}-check`, taskId: input.taskId, image: input.image, rootPath: input.rootPath, maskedPaths: input.maskedPaths,
    ...(input.hostCpus === undefined ? {} : { hostCpus: input.hostCpus }), ...(input.hostMemoryBytes === undefined ? {} : { hostMemoryBytes: input.hostMemoryBytes }),
    network: { name: input.net.name, ip: input.net.checkSandboxIp },
  });
  // The run's own arguments go in front of the entrypoint. The tail of a task sandbox's arguments is fixed (`--entrypoint tini <image> -- sleep infinity`); if it ever changes, this refuses instead of guessing.
  const tail = base.slice(-6);
  if (tail[0] !== "--entrypoint" || tail[2] !== input.image || tail[3] !== "--") throw agentXError("CONFIG_INVALID", "the task sandbox's arguments changed shape");
  const args = [
    ...base.slice(0, -6), "--hostname", CHECK_SANDBOX_HOSTNAME, ...input.net.labelArgs(),
    "--volume", `${files.resolvConfPath}:/etc/resolv.conf:ro`, "--volume", `${files.hostsPath}:/etc/hosts:ro`, ...tail,
  ];
  const problems = checkSandboxArgProblems(args, input.net, { ...files, rootPath: input.rootPath });
  if (problems.length > 0) throw agentXError("CONFIG_INVALID", `the sealed check sandbox's arguments are unsound: ${problems.join("; ")}`);
  return args;
}

/** The `docker run` arguments of the DNS helper in sealed mode: the setup helper's hardening, the services network at .2, all four labels, serving .3 and .4 only. */
export function sealedDnsHelperRunArgs(input: { net: CheckSandboxNetwork; image: string; helpers: readonly RunHostEntry[]; sinkholeIp: string }): string[] {
  assertNetwork(input.net);
  const { net } = input;
  const names = checkSandboxNames(net, input.helpers, input.sinkholeIp);
  return [
    "run", "--detach", "--pull=never", "--name", `${net.name}-dns`, ...net.labelArgs(),
    "--network", net.name, "--ip", net.dnsHelperIp,
    "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
    "--sysctl", "net.ipv4.ip_unprivileged_port_start=53",
    "--pids-limit", DNS_HELPER_PIDS, "--memory", DNS_HELPER_MEMORY, "--memory-swap", DNS_HELPER_MEMORY, "--cpus", DNS_HELPER_CPUS,
    "--tmpfs", "/state:rw,noexec,nosuid,size=1m,uid=1000,gid=1000",
    "--entrypoint", SANDBOX_FILE_OPS_NODE,
    input.image, SEALED_DNS_HELPER_ENTRY, "--listen", net.dnsHelperIp, "--source", net.workingSandboxIp, "--source", net.checkSandboxIp, "--sinkhole", input.sinkholeIp,
    ...names.flatMap((entry) => ["--host", `${entry.alias}=${entry.address}`]), "--state", SEALED_DNS_STATE_FILE,
  ];
}

/**
 * Everything the ServiceRunner needs to attach the sealed check sandbox to a run's services network: the names, the two files' content and paths, and the two containers' `docker run` arguments. Pure: it starts nothing
 * and writes nothing (`writeCheckSandboxFiles` writes the two files). Throws CONFIG_INVALID on any name, address, path or network that is not sound.
 */
export function checkSandboxPlan(input: CheckSandboxInput): CheckSandboxPlan {
  assertNetwork(input.net);
  assertHostPath(input.filesDir);
  const names = checkSandboxNames(input.net, input.helpers, input.sinkholeIp);
  const resolvConfPath = join(input.filesDir, "resolv.conf");
  const hostsPath = join(input.filesDir, "hosts");
  return {
    sandboxName: `${input.net.name}-check`, dnsHelperName: `${input.net.name}-dns`,
    network: { name: input.net.name, ip: input.net.checkSandboxIp },
    names, resolvConf: checkSandboxResolvConf(input.net.dnsHelperIp), hosts: checkSandboxHostsFile(input.net.checkSandboxIp, names),
    resolvConfPath, hostsPath,
    sandboxRunArgs: checkSandboxRunArgs(input, { resolvConfPath, hostsPath }),
    dnsHelperRunArgs: sealedDnsHelperRunArgs({ net: input.net, image: input.image, helpers: input.helpers, sinkholeIp: input.sinkholeIp }),
  };
}

/** Writes the two files of a plan into its run-owned directory, which must already exist: new files only (an existing one is an error), mode 0644 so the sandbox's user can read and cannot change them. */
export async function writeCheckSandboxFiles(plan: Pick<CheckSandboxPlan, "resolvConf" | "hosts" | "resolvConfPath" | "hostsPath">): Promise<void> {
  for (const [path, content] of [[plan.resolvConfPath, plan.resolvConf], [plan.hostsPath, plan.hosts]] as const) {
    await writeFile(path, content, { flag: "wx", mode: 0o644 });
    await chmod(path, 0o644);
  }
}

export interface SealedDnsRecord {
  /** The unknown names the run asked for, in the order first seen, each with the number of address lookups. */
  unknown: { name: string; queries: number }[];
  /** Unknown names not kept because the helper's record was full. */
  dropped: number;
  /** Address lookups of unknown names whose text was not a plain name. */
  unrecorded: number;
}

const RECORD_NAME = /^[a-z0-9_.-]{1,253}$/u;

/** The helper's record from its file's text. Anything that is not exactly the expected shape gives an empty record: never a throw, never a name that is not a plain name. */
export function parseSealedDnsRecord(text: string): SealedDnsRecord {
  const empty: SealedDnsRecord = { unknown: [], dropped: 0, unrecorded: 0 };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return empty; }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const record = parsed as { unknown?: unknown; dropped?: unknown; unrecorded?: unknown };
  const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
  const unknown = Array.isArray(record.unknown)
    ? record.unknown.flatMap((item: unknown) => {
      const row = item as { name?: unknown; queries?: unknown } | null;
      return typeof row === "object" && row !== null && typeof row.name === "string" && RECORD_NAME.test(row.name) && count(row.queries) > 0 ? [{ name: row.name, queries: count(row.queries) }] : [];
    }).slice(0, SEALED_DNS_RECORD_NAMES_MAX)
    : [];
  return { unknown, dropped: count(record.dropped), unrecorded: count(record.unrecorded) };
}

/** Reads the sealed helper's record with one fixed `docker exec <helper> cat /state/unknown.json`. A failed read gives an empty record. */
export async function readSealedDnsRecord(docker: DockerCli, dnsHelperName: string): Promise<SealedDnsRecord> {
  if (!SERVICES_NETWORK_NAME.test(dnsHelperName.replace(/-dns$/u, ""))) throw agentXError("CONFIG_INVALID", "not a sealed DNS helper's name");
  const read = await docker.run(["exec", dnsHelperName, "cat", SEALED_DNS_STATE_FILE], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => ({ exitCode: -1, stdout: "", stderr: "" }));
  return read.exitCode === 0 ? parseSealedDnsRecord(read.stdout) : { unknown: [], dropped: 0, unrecorded: 0 };
}
