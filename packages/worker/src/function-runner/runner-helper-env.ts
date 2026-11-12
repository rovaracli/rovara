// The environment the local-aws helper's front needs to take part in the runner pipe (slice 4, lane W3). The front reads three settings (rovara-local-aws `front/runner_engine.go`):
//   ROVARA_AWS_RUNNER_SOCKET           the unix socket `runner-pipe` joins to (mode 0600, made by the front). Setting it turns the runner on (planned mode only).
//   ROVARA_AWS_RUNNER_STORE_DIR        where the front keeps the real packages of the functions it took over (and the layers it saw), content-addressed and reference counted.
//   ROVARA_AWS_RUNNER_STORE_MAX_BYTES  the store's cap (the front's default is 256 MiB; it refuses a package that does not fit).
//
// DECISION (the helper's /tmp is a 64 MiB tmpfs that counts against the helper's 512 MiB of memory):
//   - THE SOCKET lives in /tmp (a socket file takes no space there): `/tmp/rovara-runner/runner.sock`, the front's own default.
//   - THE STORE gets a DISK-BACKED directory: a folder of the run's scratch area on the worker, bind-mounted read-write into the helper at `RUNNER_STORE_MOUNT`, owned by the helper's user, 0700, removed with the run. With it the
//     store keeps the front's default 256 MiB (`RUNNER_STORE_DISK_MAX_BYTES`), a figure that costs the helper no memory (the files are on the worker's disk) and holds a numpy plus pandas layer set. The worker's own accounting
//     of that disk is the code store's ledger for what it unpacks; the front's copy is bounded by this cap and by the one run per helper.
//   - FALLBACK when no disk-backed directory can be given: the store lives in the tmpfs, so its cap must leave room for the socket and the front's other files and must not be memory the helper cannot spare:
//     `RUNNER_STORE_TMPFS_MAX_BYTES` (32 MiB, half of the tmpfs). A real numpy layer does not fit then; such a function stays unsupported ("a package of the function is no longer held") instead of breaking the helper.
//   The wiring in service-helpers.ts (the `local-aws` family) adds `runnerHelperEnv(...)` to the env file and, for a disk store, the one read-write mount; see `runnerStoreMount`.
import { posix } from "node:path";

export const RUNNER_SOCKET_PATH = "/tmp/rovara-runner/runner.sock";
export const RUNNER_STORE_MOUNT = "/rovara-runner-store";
export const RUNNER_STORE_DISK_MAX_BYTES = 256 * 1024 * 1024;
export const RUNNER_STORE_TMPFS_MAX_BYTES = 32 * 1024 * 1024;
const STORE_FALLBACK_DIR = "/tmp/rovara-runner-store";

export type RunnerStoreBacking = { kind: "disk"; maxBytes?: number } | { kind: "tmpfs"; maxBytes?: number };

export interface RunnerHelperEnvOptions {
  store: RunnerStoreBacking;
}

/** The `NAME=value` lines for the helper's env file. The values are fixed paths and a number: nothing from a function or a repository. */
export function runnerHelperEnv(options: RunnerHelperEnvOptions): string[] {
  const disk = options.store.kind === "disk";
  const cap = options.store.maxBytes ?? (disk ? RUNNER_STORE_DISK_MAX_BYTES : RUNNER_STORE_TMPFS_MAX_BYTES);
  if (!Number.isSafeInteger(cap) || cap < 1024 * 1024) throw new RangeError("the runner store cap must be at least 1 MiB");
  // The tmpfs is 64 MiB: a cap above half of it would let the store starve the socket and the front's own scratch files.
  if (!disk && cap > RUNNER_STORE_TMPFS_MAX_BYTES) throw new RangeError("a store in the helper's tmpfs is capped at 32 MiB");
  const dir = disk ? RUNNER_STORE_MOUNT : STORE_FALLBACK_DIR;
  if (!posix.isAbsolute(dir)) throw new RangeError("the runner store directory must be absolute");
  return [`ROVARA_AWS_RUNNER_SOCKET=${RUNNER_SOCKET_PATH}`, `ROVARA_AWS_RUNNER_STORE_DIR=${dir}`, `ROVARA_AWS_RUNNER_STORE_MAX_BYTES=${String(cap)}`];
}

/** The `docker run` arguments of the disk-backed store: `hostDir` is a folder the worker made for this helper (a checked absolute path, owned by the helper's user, mode 0700). Read-write, no exec, no setuid, no devices. */
export function runnerStoreMount(hostDir: string): string[] {
  if (!/^\/[A-Za-z0-9._/-]{1,200}$/u.test(hostDir) || hostDir.includes("//") || hostDir.split("/").some((part) => part === ".." || part === ".")) throw new RangeError("a runner store path");
  return ["-v", `${hostDir}:${RUNNER_STORE_MOUNT}:rw,nosuid,nodev,noexec`];
}
