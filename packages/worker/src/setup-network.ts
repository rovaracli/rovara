// The setup run's own network and DNS-watch helper (sh-setup-wire, SH14; owner decision 2026-11-01, "option A"; deferred check SH-1). DEPLOYMENT CODE: nothing here has been run against Docker (this build starts
// no Docker); the five Linux checks below MUST pass on linux-runtime or staging before the `su` switch is turned on.
//
// Why: a setup run needs to know which websites its commands could not reach, without reading any command output (repository- and network-controlled). The names come from DNS: a forwarder on the sandbox's
// resolver path records the names the real resolver (and the DNS firewall behind it) refused. The forwarder (`SetupDnsWatch`) must listen on an address the sandbox can reach and the worker must not be
// on the sandbox's network. So each run gets:
//   - a small bridge network of its own (`agentx-setup-<id>`), with a fixed /24 so every address is known beforehand: gateway .1, the helper .2, the sandbox .3;
//   - a HELPER container on that network, from the worker's own image, running `setup-dns-watch-helper.js`: it listens on .2 (UDP and TCP 53, which a user without capabilities may bind because of the
//     one namespaced sysctl below), serves ONLY the sandbox's address (.3), forwards every query to the container's own embedded resolver and writes the refused names to a file in its own tmpfs;
//   - the sandbox, started by `createSetupSandbox` with `--network <name> --ip .3 --dns .2`.
// The worker is never on this network; it reads the helper's file with one fixed `docker exec <helper> cat /state/blocked.json`. No repository string reaches any docker option: names are derived from the
// operation id by hashing, addresses from a number, and the only free text is the image name the worker was configured with.
//
// MUST RUN BEFORE `su` IS ON (linux-runtime or a staging worker; deferred check SH-1):
//   1. which namespace can bind .2:53 as uid 1000: the helper runs with `--sysctl net.ipv4.ip_unprivileged_port_start=53` and no capability; confirm it binds on the user-defined network;
//   2. the sandbox's /etc/resolv.conf is Docker's embedded 127.0.0.11 and its ExtServers list is exactly the helper's address (`--dns`);
//   3. queries reach the helper from the sandbox's own address (tcpdump on the helper), which is what `allowedSources` relies on;
//   4. NXDOMAIN and REFUSED from the DNS firewall reach the sandbox unchanged (the helper relays byte for byte), and a blocked name appears in blocked.json;
//   5. the embedded DNS does not fall back to the daemon's resolvers when the helper drops a query (a query from another source must get no answer, and the sandbox must not resolve around the helper).
//   Also: the boot firewall walls only `rvb+`/`rvi+` bridges, and these `br-*` networks are plain: the helper's address is reachable from every container on the same network only, which is the sandbox alone.
import { createHash } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import type { DockerCli } from "./swebench/containers.js";

const DOCKER_CALL_TIMEOUT_MS = 60_000;
export const SETUP_NETWORK_LABEL = "agentx.setup-run";
export const SETUP_NETWORK_FIRST_OCTET = "172.29";
export const SETUP_NETWORK_SLOTS = 253;
export const SETUP_HELPER_ENTRY = "/opt/agentx/packages/worker/dist/setup-dns-watch-helper.js";
const NODE = "/usr/local/bin/node";

export interface RunNetwork {
  name: string;
  subnet: string;
  gateway: string;
  helperName: string;
  helperIp: string;
  sandboxIp: string;
  /** The names the real resolver refused so far (the helper's file); never command output. */
  readBlocked(): Promise<string[]>;
  /** Removes the helper and the network. Idempotent; never throws. */
  stop(): Promise<void>;
}

/** The slot (1 to 253) a run starts looking for a free /24 at: a hash of the operation, so two runs rarely collide and a collision is retried at the next. */
export function setupNetworkSlot(taskId: string, attempt = 0): number {
  const first = createHash("sha256").update(`setup-network\0${taskId}`).digest().readUInt16BE(0);
  return ((first + attempt) % SETUP_NETWORK_SLOTS) + 1;
}

export const setupNetworkName = (taskId: string): string => `agentx-setup-${createHash("sha256").update(`setup-name\0${taskId}`).digest("hex").slice(0, 12)}`;

/** The addresses of a slot. */
export function setupNetworkAddresses(slot: number): { subnet: string; gateway: string; helperIp: string; sandboxIp: string } {
  if (!Number.isInteger(slot) || slot < 1 || slot > SETUP_NETWORK_SLOTS) throw agentXError("CONFIG_INVALID", "not a setup network slot");
  const base = `${SETUP_NETWORK_FIRST_OCTET}.${String(slot)}`;
  return { subnet: `${base}.0/24`, gateway: `${base}.1`, helperIp: `${base}.2`, sandboxIp: `${base}.3` };
}

/** The `docker network create` arguments of a run's network. */
export function networkCreateArgs(name: string, taskId: string, addresses: ReturnType<typeof setupNetworkAddresses>): string[] {
  return ["network", "create", "--driver", "bridge", "--subnet", addresses.subnet, "--gateway", addresses.gateway, "--label", `${SETUP_NETWORK_LABEL}=${setupNetworkName(taskId)}`, name];
}

/** The `docker run` arguments of the helper: no capability, read-only, one tmpfs for its file, bounded, serving only the sandbox's address. `image` is the worker's own image. */
export function helperRunArgs(input: { name: string; network: string; taskId: string; image: string; addresses: ReturnType<typeof setupNetworkAddresses>; upstream: string }): string[] {
  return [
    "run", "--detach", "--name", input.name, "--label", `${SETUP_NETWORK_LABEL}=${setupNetworkName(input.taskId)}`,
    "--network", input.network, "--ip", input.addresses.helperIp,
    "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
    "--sysctl", "net.ipv4.ip_unprivileged_port_start=53",
    "--pids-limit", "64", "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.5",
    "--tmpfs", "/state:rw,noexec,nosuid,size=1m,uid=1000,gid=1000",
    "--entrypoint", NODE,
    input.image, SETUP_HELPER_ENTRY, "--listen", input.addresses.helperIp, "--source", input.addresses.sandboxIp, "--upstream", input.upstream, "--state", "/state/blocked.json",
  ];
}

export interface StartRunNetworkInput {
  taskId: string;
  /** The worker's own image (it carries node and the helper's script). */
  image: string;
  /** The resolver the helper forwards to: the helper container's own embedded resolver. */
  upstream?: string;
}

/** Makes the run's network and starts its helper. Any failure removes what was made and is reported as one fixed sentence (the docker error is not repeated to the person). */
export async function startRunNetwork(docker: DockerCli, input: StartRunNetworkInput): Promise<RunNetwork> {
  const name = setupNetworkName(input.taskId);
  const helperName = `${name}-dns`;
  const call = (args: string[]) => docker.run(args, { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
  let addresses: ReturnType<typeof setupNetworkAddresses> | undefined;
  for (let attempt = 0; attempt < 8 && addresses === undefined; attempt += 1) {
    const candidate = setupNetworkAddresses(setupNetworkSlot(input.taskId, attempt));
    const created = await call(networkCreateArgs(name, input.taskId, candidate));
    if (created.exitCode === 0) addresses = candidate;
    // A subnet another run has: try the next. Any other failure ends it.
    else if (!/pool overlaps|address already in use|overlap/iu.test(`${created.stderr}${created.stdout}`)) break;
  }
  const fail = async (): Promise<never> => {
    await call(["rm", "--force", helperName]);
    await call(["network", "rm", name]);
    throw agentXError("RUNTIME_UNAVAILABLE", "AgentX could not set up the network for the setup run");
  };
  if (addresses === undefined) return fail();
  const started = await call(helperRunArgs({ name: helperName, network: name, taskId: input.taskId, image: input.image, addresses, upstream: input.upstream ?? "127.0.0.11" }));
  if (started.exitCode !== 0) return fail();
  let stopped = false;
  return {
    name, ...addresses, helperName,
    async readBlocked() {
      const read = await call(["exec", helperName, "cat", "/state/blocked.json"]);
      if (read.exitCode !== 0) return [];
      try {
        const parsed: unknown = JSON.parse(read.stdout);
        return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string").slice(0, 50) : [];
      } catch { return []; }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await call(["rm", "--force", helperName]);
      await call(["network", "rm", name]);
    },
  };
}
