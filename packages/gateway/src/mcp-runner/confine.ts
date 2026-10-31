// Stdio MCP host redesign (T4), design section 3: how the program of a package is started. The bridge never runs it directly; it runs it THROUGH the runner image's own
// `setpriv` and `prlimit`:
//
//   setpriv --no-new-privs --inh-caps=-all -- prlimit --nofile=1024 --nproc=256 --fsize=536870912 --core=0 -- node <bin> <args>
//
// No shell is involved, so no word of the package's arguments is ever interpreted. `no_new_privs` and an empty inheritable set mean the child cannot climb to more than it has (there is
// no setuid file in the image either: the image build strips them and a test checks). There is no `--bounding-set=-all`: dropping bounding bits needs CAP_SETPCAP, which the task
// does not have, so setpriv would refuse to start; the task is started with every capability dropped (cap-drop ALL), which already leaves the bounding set empty. The Linux CI
// job (T11) asserts `CapBnd: 0` from /proc. The limits are per process of this user; the task is one server, so they count only it.
// [I] the exact `setpriv` option spelling and the `prlimit` behaviour on Fargate are confirmed by the Linux CI job (T11), which reads /proc/<pid>/status and /limits.
export interface ConfineLimits { nofile: number; nproc: number; fsizeBytes: number }

export const CONFINE_LIMITS: ConfineLimits = { nofile: 1_024, nproc: 256, fsizeBytes: 512 * 1_048_576 };

export interface ConfineTools { setpriv: string; prlimit: string; node: string }

export const DEFAULT_CONFINE_TOOLS: ConfineTools = { setpriv: "/usr/bin/setpriv", prlimit: "/usr/bin/prlimit", node: "/usr/local/bin/node" };

/** The command line that starts `program` (a file inside the bundle) with `args`. */
export function confinedCommand(tools: ConfineTools, program: string, args: readonly string[], limits: ConfineLimits = CONFINE_LIMITS): { file: string; args: string[] } {
  return {
    file: tools.setpriv,
    args: [
      "--no-new-privs", "--inh-caps=-all", "--",
      tools.prlimit, `--nofile=${limits.nofile}`, `--nproc=${limits.nproc}`, `--fsize=${limits.fsizeBytes}`, "--core=0", "--",
      tools.node, program, ...args,
    ],
  };
}
