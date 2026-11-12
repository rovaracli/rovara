// The docker arguments of one function sandbox, built from a typed spec and re-checked against an allow-list before anything runs (slice 4, lane W1). Adapted from the parked feat/s4-runner `functionSandboxRunArgs` and
// `functionSandboxArgProblems` (6a061898e): same approach (typed spec in, fixed profile out, an independent structural check that refuses every flag the profile does not emit), new profile (gVisor, AWS base image, agent
// as the entrypoint, `-i` for the stdin/stdout pipe, selectable /tmp and network).
//
// THE PROFILE (`docker run`):
//   -i                                  the agent's frames travel over this client's stdin and stdout; NOT --detach, NOT --rm (the container is inspected after a crash, then removed by name)
//   --runtime runsc                     gVisor under the root Docker daemon (design section 3)
//   --read-only                         the rootfs is the AWS Lambda base image, unpacked and never written
//   --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges, and the agent is told `-uid 993 -gid 993`: the agent (PID 1) is root with ONLY those two capabilities and runs the function's
//                                       runtime as uid 993 with none. gVisor delivers SIGSTOP from a same-uid process to PID 1, so a runtime on the agent's own uid could freeze its agent; on another uid every signal to PID 1 is EPERM and /proc/1 stays closed
//                                       (lane A1, PROTOCOL.md "Signals").
//   --memory = --memory-swap = MemorySize, --cpus pro rata, --pids-limit 256, --ulimit nofile=4096:4096, --log-driver none
//   --network none                      (or, when the caller says so, ONE named network at a fixed address with the run's /etc/hosts and an empty resolv.conf: see `SandboxNetwork`)
//   /tmp                                a size-capped tmpfs or a host directory the caller made (`SandboxScratch`)
//   read-only mounts                    code at /var/task, layers at /opt, the agent at /rovara/agent, optional extra files under /rovara/
//   --entrypoint /rovara/agent IMAGE <agent args>
// The function's environment (lane A1's agent takes its environment from the sandbox's own: _HANDLER, AWS_LAMBDA_*, the function's variables) travels in a 0600 `--env-file` the controller writes under the run's scratch folder and deletes
// once the sandbox is up, never as `-e NAME=VALUE`, which any process on the worker host could read from `ps`. The file format has no escaping, so a value with a newline, carriage return or NUL is refused. What reaches an argument
// is the path of that file, a hashed container name, checked paths and image refs, and nothing the function owns: no payload, no function name.
// Host paths are checked as text only (no `:` or `,`, which split mount specs); that they are the caller's own directories, not symlinks into elsewhere, is the code store's job (lane W2).

import { createHash } from "node:crypto";
import { isIP } from "node:net";

/** The agent runs as root with only CAP_SETUID and CAP_SETGID (below); it starts the function's runtime as RUNTIME_UID with no capabilities. */
export const AGENT_USER = "0:0";
export const AGENT_CAPABILITIES: readonly string[] = ["SETGID", "SETUID"];
export const RUNTIME_UID = 993;
export const RUNTIME_GID = 993;
/** The first arguments the agent always gets; a spec's own agent arguments follow them and may not name `-uid` or `-gid`. */
export const AGENT_IDENTITY_ARGS: readonly string[] = ["-uid", String(RUNTIME_UID), "-gid", String(RUNTIME_GID)];
export const SANDBOX_RUNTIME = "runsc";
export const SANDBOX_PIDS = "256";
export const SANDBOX_NOFILE = "4096:4096";
export const FUNCTION_LABEL = "rovara.function";
export const AGENT_CONTAINER_PATH = "/rovara/agent";
export const SANDBOX_TMPFS_MAX_MIB = 2_048;
export const SANDBOX_MAX_MEMORY_MB = 10_240;
const EXTRA_MOUNT_PREFIX = "/rovara/";

export class SandboxSpecError extends Error {
  constructor(readonly reason: string) {
    // Never echoes the offending value: it may be hostile text.
    super(`not a sound function sandbox: ${reason}`);
  }
}

export type SandboxScratch =
  | { kind: "tmpfs"; sizeMb: number }
  /** A directory the caller made for this environment (disk-backed; the caller owns its size cap). */
  | { kind: "host-dir"; hostPath: string };

export type SandboxNetwork =
  | { mode: "none" }
  | { mode: "services"; name: string; ip: string; hostsFile: string; resolvConf: string };

export interface RunLabel { key: string; value: string }

export interface SandboxSpec {
  /** A short id of the environment, lowercase letters, digits and dashes. */
  environmentId: string;
  /** The runtime image by name, tag or digest, or an image id (`sha256:<64 hex>`). */
  image: string;
  /** The file the agent binary is at on the worker. Mounted read-only at /rovara/agent, which is the entrypoint. */
  agentHostPath: string;
  /** Arguments after the image: for the agent only (docker has stopped reading flags). Plain characters. */
  agentArgs?: readonly string[];
  /** The sandbox's whole environment: the reserved variables the controller adds plus the function's own. */
  environment: Readonly<Record<string, string>>;
  /** Where the controller wrote the environment file (mode 0600). The sandbox reads it once, at start. */
  envFile: string;
  codeHostPath: string;
  layersHostPath?: string;
  /** Extra read-only files under /rovara/ (for example the pinned qemu for an x86 function). */
  extraMounts?: ReadonlyArray<{ hostPath: string; containerPath: string }>;
  memoryMb: number;
  cpus: number;
  scratch: SandboxScratch;
  tmpExec: boolean;
  network: SandboxNetwork;
  /** The run's labels (the worker-start sweep finds the container by them). */
  labels: readonly RunLabel[];
}

const ENV_ID = /^[a-z0-9][a-z0-9-]{3,63}$/u;
const HOST_PATH = /^\/[A-Za-z0-9._/+-]{1,400}$/u;
const CONTAINER_PATH = /^\/rovara\/[A-Za-z0-9._/-]{1,100}$/u;
const AGENT_ARG = /^[A-Za-z0-9/][A-Za-z0-9._=:/+,@-]{0,199}$|^--$|^--?[A-Za-z][A-Za-z0-9-]{0,60}(?:=[A-Za-z0-9._:/+,@-]{0,150})?$/u;
const LABEL_KEY = /^[a-z][a-z0-9.-]{0,62}[a-z0-9]$/u;
const LABEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NETWORK_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/u;
const IMAGE_NAME = /^[a-z0-9][A-Za-z0-9._/:@-]{0,254}$/u;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
export const ENV_MAX_ENTRIES = 300;
export const ENV_MAX_VALUE = 8_192;
export const ENV_MAX_TOTAL = 80 * 1024;
const CONTAINER_NAME = /^rovara-fn-[0-9a-f]{16}$/u;

function validPath(path: string): boolean {
  return HOST_PATH.test(path) && !path.includes("//") && path.split("/").every((part) => part !== ".." && part !== ".");
}

/** An image reference docker would accept, and never anything that reads as a flag or splits into two words. */
export function validImageReference(image: string): boolean {
  if (IMAGE_ID.test(image)) return true;
  if (!IMAGE_NAME.test(image) || image.includes("//") || image.includes("..") || image.includes("@@")) return false;
  const at = image.indexOf("@");
  if (at >= 0 && !/^sha256:[a-f0-9]{64}$/u.test(image.slice(at + 1))) return false;
  return true;
}

export function sandboxContainerName(environmentId: string): string {
  return `rovara-fn-${createHash("sha256").update(`rovara-function-sandbox\0${environmentId}`).digest("hex").slice(0, 16)}`;
}

/** Lambda's rule: one vCPU at 1,769 MB, here clamped between `min` and `max`. */
export function functionCpus(memoryMb: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, memoryMb / 1_769)) * 100) / 100;
}

const tmpfsOptions = (spec: SandboxSpec, sizeMb: number): string => `rw,${spec.tmpExec ? "exec" : "noexec"},nosuid,nodev,mode=1777,size=${String(sizeMb)}m,uid=${String(RUNTIME_UID)},gid=${String(RUNTIME_GID)}`;

/** Throws SandboxSpecError (with a fixed reason, never the offending text) when the spec is not one the profile may run. */
export function validateSandboxSpec(spec: SandboxSpec): void {
  const fail = (reason: string): never => { throw new SandboxSpecError(reason); };
  if (!ENV_ID.test(spec.environmentId)) fail("environment id");
  if (!validImageReference(spec.image)) fail("image reference");
  for (const [what, path] of [["env file path", spec.envFile], ["agent path", spec.agentHostPath], ["code path", spec.codeHostPath], ...(spec.layersHostPath === undefined ? [] : [["layers path", spec.layersHostPath]])] as Array<[string, string]>) if (!validPath(path)) fail(what);
  for (const arg of spec.agentArgs ?? []) if (!AGENT_ARG.test(arg) || /^--?(?:uid|gid)(?:=|$)/u.test(arg)) fail("agent argument");
  if ((spec.agentArgs ?? []).length > 32) fail("agent argument count");
  const extras = spec.extraMounts ?? [];
  if (extras.length > 8) fail("extra mount count");
  const containerPaths = new Set<string>();
  for (const mount of extras) {
    if (!validPath(mount.hostPath) || !CONTAINER_PATH.test(mount.containerPath) || !mount.containerPath.startsWith(EXTRA_MOUNT_PREFIX) || mount.containerPath.includes("//") || mount.containerPath.split("/").some((part) => part === ".." || part === ".") || mount.containerPath === AGENT_CONTAINER_PATH || containerPaths.has(mount.containerPath)) fail("extra mount");
    containerPaths.add(mount.containerPath);
  }
  if (!Number.isInteger(spec.memoryMb) || spec.memoryMb < 6 || spec.memoryMb > SANDBOX_MAX_MEMORY_MB) fail("memory");
  if (!Number.isFinite(spec.cpus) || spec.cpus < 0.01 || spec.cpus > 16) fail("cpus");
  if (spec.scratch.kind === "tmpfs") {
    if (!Number.isInteger(spec.scratch.sizeMb) || spec.scratch.sizeMb < 1 || spec.scratch.sizeMb > SANDBOX_TMPFS_MAX_MIB) fail("scratch size");
  } else if (!validPath(spec.scratch.hostPath)) fail("scratch path");
  if (spec.network.mode === "services") {
    const net = spec.network;
    if (!NETWORK_NAME.test(net.name) || net.name === "host" || net.name === "bridge" || net.name === "none" || net.name.startsWith("container")) fail("network name");
    if (isIP(net.ip) !== 4 || !validPath(net.hostsFile) || !validPath(net.resolvConf)) fail("network files");
  }
  const keys = new Set<string>();
  for (const label of spec.labels) {
    if (!LABEL_KEY.test(label.key) || !LABEL_VALUE.test(label.value) || label.key === FUNCTION_LABEL || keys.has(label.key)) fail("label");
    keys.add(label.key);
  }
  if (spec.labels.length > 16) fail("label count");
  const names = Object.keys(spec.environment);
  if (names.length > ENV_MAX_ENTRIES) fail("environment size");
  let total = 0;
  for (const name of names) {
    const value = spec.environment[name];
    if (!ENV_NAME.test(name) || typeof value !== "string" || value.length > ENV_MAX_VALUE || /[\0\r\n]/u.test(value)) fail("environment entry");
    total += name.length + value!.length;
  }
  if (total > ENV_MAX_TOTAL) fail("environment size");
}

/** The text of the sandbox's environment file: one NAME=VALUE per line, names sorted. */
export const environmentFileContent = (spec: Pick<SandboxSpec, "environment">): string => `${Object.keys(spec.environment).sort().map((name) => `${name}=${spec.environment[name]!}`).join("\n")}\n`;

/** Mount options of a host-dir /tmp. `nosuid,nodev` cannot be asked of Docker for a bind mount (`-v` and `--mount` reject them, checked on Docker 29), and gVisor does not show them for a bind volume either; setuid files and device nodes are inert
 * anyway under --cap-drop ALL, no-new-privileges, the uid 993 owned leaf and the devices gVisor does not expose. */
export const SCRATCH_MOUNT_OPTIONS = "rw";

interface Volumes { code: string; layers?: string; agent: string; extras: string[]; hosts?: string; resolv?: string; scratchDir?: string }

function expectedVolumes(spec: SandboxSpec): string[] {
  const volumes: Volumes = {
    code: `${spec.codeHostPath}:/var/task:ro`,
    agent: `${spec.agentHostPath}:${AGENT_CONTAINER_PATH}:ro`,
    extras: (spec.extraMounts ?? []).map((mount) => `${mount.hostPath}:${mount.containerPath}:ro`),
    ...(spec.layersHostPath === undefined ? {} : { layers: `${spec.layersHostPath}:/opt:ro` }),
    ...(spec.network.mode === "services" ? { hosts: `${spec.network.hostsFile}:/etc/hosts:ro`, resolv: `${spec.network.resolvConf}:/etc/resolv.conf:ro` } : {}),
    ...(spec.scratch.kind === "host-dir" ? { scratchDir: `${spec.scratch.hostPath}:/tmp:${SCRATCH_MOUNT_OPTIONS}` } : {}),
  };
  return [volumes.code, ...(volumes.layers === undefined ? [] : [volumes.layers]), volumes.agent, ...volumes.extras, ...(volumes.hosts === undefined ? [] : [volumes.hosts, volumes.resolv!]), ...(volumes.scratchDir === undefined ? [] : [volumes.scratchDir])];
}

const cpuText = (cpus: number): string => String(Math.round(cpus * 100) / 100);

/** The `docker run` arguments of one function sandbox. Throws when the spec is unsound or the result would not pass `sandboxArgProblems`. */
export function sandboxRunArgs(spec: SandboxSpec): string[] {
  validateSandboxSpec(spec);
  const memory = `${String(spec.memoryMb)}m`;
  const args: string[] = [
    "run", "-i", "--name", sandboxContainerName(spec.environmentId), "--hostname", "function", "--pull=never", "--runtime", SANDBOX_RUNTIME,
    ...spec.labels.flatMap((label) => ["--label", `${label.key}=${label.value}`]), "--label", `${FUNCTION_LABEL}=${spec.environmentId}`,
    ...(spec.network.mode === "none" ? ["--network", "none"] : ["--network", spec.network.name, "--ip", spec.network.ip]),
    "--user", AGENT_USER, "--cap-drop", "ALL", ...AGENT_CAPABILITIES.flatMap((capability) => ["--cap-add", capability]), "--security-opt", "no-new-privileges", "--read-only",
    "--memory", memory, "--memory-swap", memory, "--cpus", cpuText(spec.cpus), "--pids-limit", SANDBOX_PIDS, "--ulimit", `nofile=${SANDBOX_NOFILE}`,
    "--log-driver", "none",
    "--env-file", spec.envFile,
    ...(spec.scratch.kind === "tmpfs" ? ["--tmpfs", `/tmp:${tmpfsOptions(spec, spec.scratch.sizeMb)}`] : []),
    ...expectedVolumes(spec).flatMap((volume) => ["--volume", volume]),
    "--workdir", "/var/task", "--entrypoint", AGENT_CONTAINER_PATH, spec.image, ...AGENT_IDENTITY_ARGS, ...(spec.agentArgs ?? []),
  ];
  const problems = sandboxArgProblems(args, spec);
  if (problems.length > 0) throw new SandboxSpecError(`arguments are unsound: ${problems.join("; ")}`);
  return args;
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(["--env-file", "--name", "--hostname", "--runtime", "--label", "--network", "--ip", "--user", "--cap-drop", "--cap-add", "--security-opt", "--memory", "--memory-swap", "--cpus", "--pids-limit", "--ulimit", "--log-driver", "--tmpfs", "--volume", "--workdir", "--entrypoint"]);
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["-i", "--read-only"]);
const FORBIDDEN: ReadonlyMap<string, string> = new Map([
  ["--publish", "publishes a port"], ["-p", "publishes a port"], ["--publish-all", "publishes ports"], ["-P", "publishes ports"], ["--expose", "exposes a port"], ["--net", "names a network"], ["--link", "links a container"],
  ["--dns", "names a DNS server"], ["--dns-search", "names a search domain"], ["--dns-option", "sets a resolver option"], ["--add-host", "adds a host entry"], ["--privileged", "is privileged"],
  ["--device", "adds a device"], ["--pid", "shares a process namespace"], ["--ipc", "shares an IPC namespace"], ["--uts", "shares a UTS namespace"], ["--userns", "changes the user namespace"], ["--network-alias", "gives the sandbox an alias"],
  ["--mac-address", "sets a MAC address"], ["--ip6", "sets an IPv6 address"], ["--sysctl", "sets a kernel parameter"], ["--cgroupns", "changes the cgroup namespace"], ["-v", "adds a mount"], ["--mount", "adds a mount"],
  ["--volumes-from", "takes another container's mounts"], ["--group-add", "adds a group"], ["--cgroup-parent", "changes the cgroup"], ["--gpus", "adds a GPU"], ["--env", "sets an environment variable another way"],
  ["-e", "sets an environment variable on the command line"], ["--rm", "removes itself"], ["--detach", "detaches"], ["-d", "detaches"], ["-t", "allocates a terminal"], ["--tty", "allocates a terminal"], ["--oom-kill-disable", "turns off the memory limit"],
  ["--init", "starts an init"], ["--security-opt=seccomp=unconfined", "turns off seccomp"], ["--interactive", "spells -i another way"], ["--pull", "is not --pull=never"],
]);
const LIMIT = /^[0-9]+m$/u;
const CPU = /^[0-9]+(?:\.[0-9]{1,2})?$/u;
const FORBIDDEN_TEXT: readonly string[] = ["docker.sock", "/var/run/", "/run/docker", "containerd"];

/**
 * What is wrong with `args` as the arguments of a function sandbox: an empty list when they are sound. An ALLOW-LIST: every flag must be one the profile emits (`--flag=value` is read as `--flag value`, an attached short form
 * such as `-p8080:80` as `-p`), single-valued flags occur once with exactly the expected value, the mounts are exactly the expected read-only files, the labels are the run's plus the environment's, and the tail after the image
 * is exactly the agent arguments the spec names.
 */
export function sandboxArgProblems(args: readonly string[], expected: SandboxSpec): string[] {
  const problems: string[] = [];
  const values = new Map<string, string[]>();
  const booleans: string[] = [];
  let imageAt = -1;
  if (args[0] !== "run") problems.push("is not a docker run command");
  let at = 1;
  while (at < args.length) {
    const token = args[at]!;
    at += 1;
    if (!token.startsWith("-")) { imageAt = at - 1; break; }
    let name: string;
    let inline: string | undefined;
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      name = equals < 0 ? token : token.slice(0, equals);
      inline = equals < 0 ? undefined : token.slice(equals + 1);
    } else {
      name = token.slice(0, 2);
      inline = token.length > 2 ? token.slice(2) : undefined;
    }
    if (name === "--pull" && inline === "never") {
      booleans.push("--pull");
    } else if (BOOLEAN_FLAGS.has(name) && inline === undefined) {
      booleans.push(name);
    } else if (VALUE_FLAGS.has(name)) {
      let value = inline;
      if (value === undefined) { value = args[at]; at += 1; }
      if (value === undefined) problems.push(`${name} has no value`);
      else values.set(name, [...(values.get(name) ?? []), value]);
    } else {
      const reason = FORBIDDEN.get(token) ?? FORBIDDEN.get(name);
      problems.push(reason === undefined ? `carries ${name}, which is not a flag of the function sandbox` : `carries ${name}, which ${reason}`);
      if (inline === undefined && args[at] !== undefined && !args[at]!.startsWith("-")) at += 1;
    }
  }
  const before = imageAt < 0 ? args : args.slice(0, imageAt);
  for (const flag of ["-i", "--pull", "--read-only"]) if (booleans.filter((found) => found === flag).length !== 1) problems.push(`does not carry ${flag} exactly once`);
  if (imageAt < 0) problems.push("has no image");
  else {
    if (args[imageAt] !== expected.image) problems.push("runs another image");
    const tail = args.slice(imageAt + 1);
    const wantedTail = [...AGENT_IDENTITY_ARGS, ...(expected.agentArgs ?? [])];
    if (tail.length !== wantedTail.length || tail.some((arg, index) => arg !== wantedTail[index])) problems.push("has something after the image other than the agent's arguments");
  }
  const of = (flag: string): string[] => values.get(flag) ?? [];
  const exactly = (flag: string, wanted: string, message: string): void => {
    const found = of(flag);
    if (found.length !== 1 || found[0] !== wanted) problems.push(message);
  };
  const memory = `${String(expected.memoryMb)}m`;
  exactly("--name", sandboxContainerName(expected.environmentId), "does not have the environment's own name");
  if (!of("--name").every((name) => CONTAINER_NAME.test(name))) problems.push("has a name that is not a sandbox name");
  exactly("--hostname", "function", "does not have the function host name");
  exactly("--runtime", SANDBOX_RUNTIME, "does not run under gVisor");
  exactly("--user", AGENT_USER, `does not run the agent as exactly one --user ${AGENT_USER}`);
  if (JSON.stringify([...of("--cap-add")].sort()) !== JSON.stringify([...AGENT_CAPABILITIES])) problems.push("does not add exactly CAP_SETUID and CAP_SETGID, nothing else");
  exactly("--cap-drop", "ALL", "does not drop every capability");
  exactly("--security-opt", "no-new-privileges", "does not hold exactly no-new-privileges as its security option");
  exactly("--memory", memory, "does not hold the function's memory");
  exactly("--memory-swap", memory, "does not hold memory and swap at one limit");
  exactly("--cpus", cpuText(expected.cpus), "does not hold the function's CPU share");
  exactly("--pids-limit", SANDBOX_PIDS, "does not hold the process limit");
  exactly("--ulimit", `nofile=${SANDBOX_NOFILE}`, "does not hold exactly the open-files limit");
  exactly("--log-driver", "none", "does not turn the log off");
  exactly("--workdir", "/var/task", "does not work in the code folder");
  exactly("--entrypoint", AGENT_CONTAINER_PATH, "does not start the agent");
  if (of("--memory").some((value) => !LIMIT.test(value)) || of("--memory-swap").some((value) => !LIMIT.test(value))) problems.push("has a memory limit that is not one plain limit");
  if (of("--cpus").some((value) => !CPU.test(value))) problems.push("has a --cpus that is not one plain number");
  if (expected.network.mode === "none") {
    exactly("--network", "none", "is not on --network none");
    if (of("--ip").length !== 0) problems.push("has an address on no network");
  } else {
    exactly("--network", expected.network.name, "not attached to the named network alone");
    exactly("--ip", expected.network.ip, "not at the environment's fixed address");
  }
  const tmpfs = of("--tmpfs");
  if (expected.scratch.kind === "tmpfs") {
    if (tmpfs.length !== 1 || tmpfs[0] !== `/tmp:${tmpfsOptions(expected, expected.scratch.sizeMb)}`) problems.push("does not hold exactly one size-capped /tmp");
  } else if (tmpfs.length !== 0) problems.push("has a tmpfs it was not given");
  const volumes = of("--volume");
  const wanted = expectedVolumes(expected);
  if (volumes.length !== wanted.length || !wanted.every((volume) => volumes.filter((found) => found === volume).length === 1)) problems.push("does not hold exactly the expected mounts");
  if (volumes.some((volume) => volume.split(":").length < 2 || volume.split(":").length > 3 || volume.split(":").slice(0, 2).some((part) => part.includes(",")))) problems.push("has a mount that is not one plain path pair");
  if (volumes.some((volume) => !volume.endsWith(":ro") && volume !== `${expected.scratch.kind === "host-dir" ? expected.scratch.hostPath : "\0"}:/tmp:${SCRATCH_MOUNT_OPTIONS}`)) problems.push("has a writable mount that is not the scratch folder");
  exactly("--env-file", expected.envFile, "does not read exactly the environment file of its environment");
  const labels = of("--label");
  const wantedLabels = [...expected.labels.map((label) => `${label.key}=${label.value}`), `${FUNCTION_LABEL}=${expected.environmentId}`];
  if (labels.length !== wantedLabels.length || !wantedLabels.every((label) => labels.filter((found) => found === label).length === 1)) problems.push("carries a label that is not the run's or the environment's, or one twice");
  if (before.some((arg) => FORBIDDEN_TEXT.some((part) => arg.includes(part)))) problems.push("names a docker socket path");
  return problems;
}

// ---- the commands that watch and end a sandbox

/** The container name rule for every command that takes one: only a name this module made. */
export const isSandboxContainerName = (name: string): boolean => CONTAINER_NAME.test(name);

const assertName = (name: string): void => { if (!isSandboxContainerName(name)) throw new SandboxSpecError("container name"); };

export const killArgs = (name: string): string[] => { assertName(name); return ["kill", "--signal", "KILL", name]; };
export const removeArgs = (name: string): string[] => { assertName(name); return ["rm", "--force", "--volumes", name]; };
export const inspectStateArgs = (name: string): string[] => { assertName(name); return ["inspect", "--format", "{{json .State}}", name]; };
export const inspectIdArgs = (name: string): string[] => { assertName(name); return ["inspect", "--format", "{{.Id}}", name]; };

/** Re-check for a control command before exec: one of the four above, on a sandbox name, and nothing else. */
export function controlArgProblems(args: readonly string[]): string[] {
  const name = args.at(-1) ?? "";
  if (!isSandboxContainerName(name)) return ["does not name a function sandbox"];
  const known = [killArgs(name), removeArgs(name), inspectStateArgs(name), inspectIdArgs(name)];
  return known.some((candidate) => candidate.length === args.length && candidate.every((arg, index) => arg === args[index])) ? [] : ["is not a fixed sandbox command"];
}

// ---- the services network (M2): only an internal network, and an address inside the part of its subnet set aside for function sandboxes

export const networkInspectArgs = (name: string): string[] => {
  if (!NETWORK_NAME.test(name) || name === "host" || name === "bridge" || name === "none" || name.startsWith("container")) throw new SandboxSpecError("network name");
  return ["network", "inspect", "--format", "{{json .Internal}} {{range .IPAM.Config}}{{.Subnet}} {{end}}", name];
};

export interface AddressRange { first: number; last: number }
/** Function sandboxes take .64 to .127 of the run's /24 (design section 3). */
export const DEFAULT_SANDBOX_ADDRESS_RANGE: AddressRange = { first: 64, last: 127 };

const ipv4ToInt = (ip: string): number => ip.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);

/** What is wrong with the network `docker network inspect` described, for a sandbox at `ip`. Empty when sound. `output` is the command's stdout. */
export function servicesNetworkProblems(output: string, ip: string, range: AddressRange = DEFAULT_SANDBOX_ADDRESS_RANGE): string[] {
  const parts = output.trim().split(/\s+/u);
  if (parts[0] !== "true") return ["the network is not internal"];
  if (isIP(ip) !== 4) return ["the address is not IPv4"];
  const subnets = parts.slice(1).filter((part) => /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/u.test(part));
  const address = ipv4ToInt(ip);
  const inside = subnets.some((subnet) => {
    const [base, bits] = subnet.split("/") as [string, string];
    const prefix = Number(bits);
    if (isIP(base) !== 4 || prefix < 16 || prefix > 30) return false;
    const size = 2 ** (32 - prefix);
    const start = Math.floor(ipv4ToInt(base) / size) * size;
    return address >= start && address < start + size;
  });
  if (!inside) return ["the address is not in the network's subnet"];
  const host = address % 256;
  if (host < range.first || host > range.last) return ["the address is outside the range set aside for function sandboxes"];
  return [];
}
