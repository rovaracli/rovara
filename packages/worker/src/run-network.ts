// The per-run services network (test services, TS13; design test-services.md 4.0.1 and 4.0.6). DEPLOYMENT CODE: nothing here has been run against Docker (this build starts no Docker); the Linux checks
// TS-L1 to TS-L3 and TS-L6 (scripts/linux-check-test-services.sh) MUST pass on linux-runtime or a staging worker before the `tx` switch is turned on. Nothing calls this module yet.
//
// What it is: one Docker `--internal` bridge per run, on a fixed /24 of its own (172.30.<slot>.0/24), whose host interface is named `rvi<8 hex>`. That name is the whole point. The boot firewall already walls every `rvi*` bridge
// (packages/worker/ec2/boot.sh `wall_off_containers`: `DOCKER-USER -i rvi+ ! -o rvi+ -j DROP` and `INPUT -i rvi+ -j DROP`), so traffic between a sandbox and a service helper on the same bridge passes, and nothing on it can reach the
// host, a private range, the metadata address or the internet. THIS MODULE ADDS NO FIREWALL RULE and the design relies on that (tests/contract/run-network-walls.test.ts reads the boot scripts to prove it).
//
// What it reuses from setup-network.ts (the setup run's network, which it generalises): the slot hash (`setupNetworkSlot`) and slot count, the workspace key, the "this subnet or interface name is taken, try the next slot"
// rule (`isSlotCollision`), and the Docker call timeout. What differs, and why: the range (172.30 here, 172.29 there), the bridge prefix (`rvi`, internal, against `rvbs`, which has an outbound leg for the setup run's allowed
// websites), `--internal`, and the labels. The labels are this module's own (`rovara.run-network*`), not `rovara.run` (the end-to-end checker's) and not `agentx.setup-run` (the setup run's), so each of the three sweeps can only ever
// see its own objects.
//
// Addresses in a slot: gateway .1, DNS helper .2, working sandbox .3, check sandbox .4, test-account proxy .8, service helpers .16 to .47 (32 of them).
//
// No repository-controlled string reaches a docker argument: the run id must be plain (letters, digits, hyphens; it is only ever hashed), the workspace must be a 16-hex key, every name and the bridge are hashes, the addresses come from a
// number, and the ids the sweep passes on must pass a plain-id check. A dependency's alias (`postgres`) is not part of this module; the helper launcher (TS14) must validate it before it uses `--network-alias`.
import { createHash } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import type { DockerCli } from "./swebench/containers.js";
import { DOCKER_CALL_TIMEOUT_MS, SETUP_NETWORK_SLOTS, isSlotCollision, setupNetworkSlot } from "./setup-network.js";

/** The family label; its value is the network's name (a hash of the run id). Every container and the network of a run carry it. */
export const RUN_NETWORK_LABEL = "rovara.run-network";
/** When the run's network was made, in milliseconds since the epoch; the sweep ages objects by it. */
export const RUN_NETWORK_CREATED_LABEL = "rovara.run-network.created";
/** The key of the worker's workspace, so a worker never removes another worker's objects on a shared Docker daemon. */
export const RUN_NETWORK_WORKSPACE_LABEL = "rovara.run-network.workspace";
export const RUN_NETWORK_FIRST_OCTETS = "172.30";
export const RUN_NETWORK_SLOTS = SETUP_NETWORK_SLOTS;
/** The host interface prefix: the boot firewall walls `rvi*` bridges. */
export const RUN_NETWORK_BRIDGE_PREFIX = "rvi";
/** How long past a round's budget a run is kept before a sweep treats it as left behind by a killed worker. */
export const RUN_NETWORK_STALE_MARGIN_MS = 15 * 60_000;
const HELPER_FIRST = 16;
const HELPER_LAST = 47;
const SLOT_ATTEMPTS = 8;
const FAILURE_SENTENCE = "AgentX could not set up the network for the test services";
const SAFE_RUN_ID = /^[A-Za-z0-9-]{1,64}$/u;
const WORKSPACE_KEY = /^[0-9a-f]{16}$/u;
const NETWORK_NAME = /^rovara-svc-[0-9a-f]{12}$/u;
const SAFE_DOCKER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

const digest = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex");

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw agentXError("CONFIG_INVALID", "not a run id for a services network");
}
function assertWorkspace(workspace: string): void {
  if (!WORKSPACE_KEY.test(workspace)) throw agentXError("CONFIG_INVALID", "not a workspace key for a services network");
}

/** The network's Docker name: a hash of the run id, never the id itself. */
export function runNetworkName(runId: string): string {
  assertRunId(runId);
  return `rovara-svc-${digest("run-network-name", runId).slice(0, 12)}`;
}

/** The host interface name, `rvi` and 8 hex of a hash of the run id and the slot (so the next slot's attempt also gets a new name if a name was the collision). 11 of the 15 characters an interface name may have. */
export function runNetworkBridge(runId: string, slot: number): string {
  assertRunId(runId);
  assertSlot(slot);
  return `${RUN_NETWORK_BRIDGE_PREFIX}${digest("run-network-bridge", runId, String(slot)).slice(0, 8)}`;
}

function assertSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > RUN_NETWORK_SLOTS) throw agentXError("CONFIG_INVALID", "not a services network slot");
}

export interface RunNetworkAddresses {
  subnet: string;
  gateway: string;
  dnsHelperIp: string;
  workingSandboxIp: string;
  checkSandboxIp: string;
  proxyIp: string;
}

/** The addresses of a slot. */
export function runNetworkAddresses(slot: number): RunNetworkAddresses {
  assertSlot(slot);
  const base = `${RUN_NETWORK_FIRST_OCTETS}.${String(slot)}`;
  return { subnet: `${base}.0/24`, gateway: `${base}.1`, dnsHelperIp: `${base}.2`, workingSandboxIp: `${base}.3`, checkSandboxIp: `${base}.4`, proxyIp: `${base}.8` };
}

/** The address of the service helper with this index (0 to 31): .16 to .47 of the slot. */
export function runNetworkHelperIp(slot: number, index: number): string {
  assertSlot(slot);
  if (!Number.isInteger(index) || index < 0 || index > HELPER_LAST - HELPER_FIRST) throw agentXError("CONFIG_INVALID", "not a service helper index");
  return `${RUN_NETWORK_FIRST_OCTETS}.${String(slot)}.${String(HELPER_FIRST + index)}`;
}

export interface RunNetworkLabelInput {
  runId: string;
  /** `setupWorkspaceKey(rootPath)`: 16 hex. */
  workspace: string;
  /** Milliseconds since the epoch, when the network was made. */
  createdAt: number;
}

/** The three labels every object of a run carries. A helper started by the launcher (TS14) must pass them to `docker run`, or the sweep cannot find it. */
export function runNetworkLabelArgs(input: RunNetworkLabelInput): string[] {
  assertWorkspace(input.workspace);
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) throw agentXError("CONFIG_INVALID", "not a creation time");
  return ["--label", `${RUN_NETWORK_LABEL}=${runNetworkName(input.runId)}`, "--label", `${RUN_NETWORK_CREATED_LABEL}=${String(input.createdAt)}`, "--label", `${RUN_NETWORK_WORKSPACE_LABEL}=${input.workspace}`];
}

/** The `docker network create` arguments: an internal bridge on the slot's /24, with the `rvi` host interface the boot firewall walls, and the family labels. */
export function runNetworkCreateArgs(input: RunNetworkLabelInput & { slot: number }): string[] {
  const addresses = runNetworkAddresses(input.slot);
  return [
    "network", "create", "--driver", "bridge", "--internal", "--subnet", addresses.subnet, "--gateway", addresses.gateway,
    "--opt", `com.docker.network.bridge.name=${runNetworkBridge(input.runId, input.slot)}`,
    ...runNetworkLabelArgs(input), runNetworkName(input.runId),
  ];
}

/** The age after which a run's objects are stale: the round's budget plus 15 minutes. */
export function servicesNetworkStaleAfterMs(roundBudgetMs: number): number {
  if (!Number.isSafeInteger(roundBudgetMs) || roundBudgetMs <= 0) throw agentXError("CONFIG_INVALID", "not a round budget");
  return roundBudgetMs + RUN_NETWORK_STALE_MARGIN_MS;
}

const dockerCall = (docker: DockerCli) => (args: string[]) => docker.run(args, { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));

const LIST_FORMAT = `{{.ID}}\t{{.Label "${RUN_NETWORK_LABEL}"}}\t{{.Label "${RUN_NETWORK_CREATED_LABEL}"}}\t{{.Label "${RUN_NETWORK_WORKSPACE_LABEL}"}}`;

export interface SweepInput {
  /** `setupWorkspaceKey(rootPath)`. */
  workspace: string;
  /** Only objects at least this old are removed: `servicesNetworkStaleAfterMs(budget)` at an allocation, 0 at a worker's start (a restarted worker's own runs are all dead). */
  olderThanMs: number;
  now?: () => number;
}

/**
 * Removes the containers and then the networks of this workspace's runs that carry the run-network family label and are old enough. The filter goes to Docker, and every row is checked again here (family label value shaped like a
 * network name, workspace equal, readable creation time, plain id), so a daemon or a fake that ignores the filter still cannot make it remove an object of another family: the setup run's, the end-to-end checker's or any other.
 * Containers go first because a network with an endpoint cannot be removed. Answers how many Docker accepted; never throws on a Docker failure.
 */
export async function sweepServicesNetworks(docker: DockerCli, input: SweepInput): Promise<{ containers: number; networks: number }> {
  assertWorkspace(input.workspace);
  const call = dockerCall(docker);
  const now = (input.now ?? Date.now)();
  const filters = ["--filter", `label=${RUN_NETWORK_LABEL}`, "--filter", `label=${RUN_NETWORK_WORKSPACE_LABEL}=${input.workspace}`];
  const stale = async (list: string[]): Promise<string[]> => {
    const listed = await call([...list, ...filters, "--format", LIST_FORMAT]);
    if (listed.exitCode !== 0) return [];
    const found: string[] = [];
    for (const line of listed.stdout.split("\n")) {
      const [id, family, created, workspace] = line.split("\t");
      if (id === undefined || family === undefined || created === undefined || workspace === undefined) continue;
      if (!SAFE_DOCKER_ID.test(id) || !NETWORK_NAME.test(family) || workspace !== input.workspace || !/^\d{1,16}$/u.test(created)) continue;
      if (now - Number(created) >= input.olderThanMs) found.push(id);
    }
    return found;
  };
  const containers = await stale(["ps", "--all"]);
  let removedContainers = 0;
  if (containers.length > 0 && (await call(["rm", "--force", ...containers])).exitCode === 0) removedContainers = containers.length;
  let removedNetworks = 0;
  for (const id of await stale(["network", "ls"])) if ((await call(["network", "rm", id])).exitCode === 0) removedNetworks += 1;
  return { containers: removedContainers, networks: removedNetworks };
}

export interface StartServicesNetworkInput {
  /** The run's id (a task, Prove, nightly or checker round). Only ever hashed. */
  runId: string;
  /** `setupWorkspaceKey(rootPath)`. */
  workspace: string;
  /** The round's budget in milliseconds: runs older than this plus 15 minutes are swept at this allocation. */
  roundBudgetMs: number;
  now?: () => number;
}

export interface ServicesNetwork extends RunNetworkAddresses {
  name: string;
  bridge: string;
  slot: number;
  /** The address of service helper `index` (0 to 31). */
  helperIp(index: number): string;
  /** The labels a container of this run must be started with. */
  labelArgs(): string[];
  /** Removes the run's containers and then the network. Idempotent; never throws. */
  stop(): Promise<void>;
}

/** Sweeps stale runs, then makes the run's network on the first free slot. Any failure is one fixed sentence (the docker error is not repeated to the person). */
export async function startServicesNetwork(docker: DockerCli, input: StartServicesNetworkInput): Promise<ServicesNetwork> {
  assertRunId(input.runId);
  assertWorkspace(input.workspace);
  const olderThanMs = servicesNetworkStaleAfterMs(input.roundBudgetMs);
  const now = input.now ?? Date.now;
  const call = dockerCall(docker);
  // The sweep of every allocation: what a killed worker left behind frees its slot here. A failed sweep is not a failed start.
  await sweepServicesNetworks(docker, { workspace: input.workspace, olderThanMs, now }).catch(() => undefined);
  const createdAt = now();
  const name = runNetworkName(input.runId);
  let slot: number | undefined;
  for (let attempt = 0; attempt < SLOT_ATTEMPTS && slot === undefined; attempt += 1) {
    const candidate = setupNetworkSlot(input.runId, attempt);
    const created = await call(runNetworkCreateArgs({ runId: input.runId, slot: candidate, workspace: input.workspace, createdAt }));
    if (created.exitCode === 0) slot = candidate;
    // A subnet another network has, or a host interface name that is taken, is cured by the next slot. A network of this name (the same run twice) names no bridge and no pool, so it ends the start, and so does any other failure.
    else if (!isSlotCollision(`${created.stderr}${created.stdout}`)) break;
  }
  if (slot === undefined) throw agentXError("RUNTIME_UNAVAILABLE", FAILURE_SENTENCE);
  const labels = { runId: input.runId, workspace: input.workspace, createdAt };
  let stopped = false;
  return {
    name, bridge: runNetworkBridge(input.runId, slot), slot, ...runNetworkAddresses(slot),
    helperIp: (index: number) => runNetworkHelperIp(slot, index),
    labelArgs: () => runNetworkLabelArgs(labels),
    async stop() {
      if (stopped) return;
      stopped = true;
      const listed = await call(["ps", "--all", "--quiet", "--filter", `label=${RUN_NETWORK_LABEL}=${name}`]);
      const ids = listed.exitCode === 0 ? listed.stdout.split("\n").map((line) => line.trim()).filter((line) => SAFE_DOCKER_ID.test(line)) : [];
      if (ids.length > 0) await call(["rm", "--force", ...ids]);
      await call(["network", "rm", name]);
    },
  };
}
