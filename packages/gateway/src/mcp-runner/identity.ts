// Stdio MCP host redesign (fix round 1, m2): the runner programs refuse to run as root. "Root" is any of the four ids being 0: the user, the effective user, the group or the
// effective group. ECS `user: "10003"` with no group runs as gid 0, so a check of the uid alone is not enough.
/**
 * A runner program was started as root and refused. It carries the fixed code `root`, so the program's last line (and the Linux job that reads it) can say WHY it stopped, instead of one
 * catch-all line that a missing setting or an unreachable controller would print just the same.
 */
export class RootRefusedError extends Error {
  readonly code = "root" as const;
  constructor(what: string) {
    super(`${what} must not run as root`);
    this.name = "RootRefusedError";
  }
}

export interface RootIds {
  getuid?: (() => number | undefined) | undefined;
  geteuid?: (() => number | undefined) | undefined;
  getgid?: (() => number | undefined) | undefined;
  getegid?: (() => number | undefined) | undefined;
}

/** Whether this process is root by any of its ids. An id the platform has none of is not 0. Ids not given are read from the process. */
export function runsAsRoot(ids: RootIds = {}): boolean {
  const read = [ids.getuid ?? (() => process.getuid?.()), ids.geteuid ?? (() => process.geteuid?.()), ids.getgid ?? (() => process.getgid?.()), ids.getegid ?? (() => process.getegid?.())];
  return read.some((get) => get() === 0);
}
