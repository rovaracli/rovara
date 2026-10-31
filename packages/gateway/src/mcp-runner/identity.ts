// Stdio MCP host redesign (fix round 1, m2): the runner programs refuse to run as root. "Root" is any of the four ids being 0: the user, the effective user, the group or the
// effective group. ECS `user: "10003"` with no group runs as gid 0, so a check of the uid alone is not enough.
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
