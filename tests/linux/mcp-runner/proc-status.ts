// Stdio MCP host redesign (T11): reading a process the way the Linux job needs to. Pure parsers and one walk over injected readers, so they are tested here on any machine; the Linux job
// feeds them the host's real /proc.

export interface ProcStatus {
  /** real, effective, saved, filesystem */
  uid: number[];
  gid: number[];
  noNewPrivs: number | undefined;
  caps: Record<"CapInh" | "CapPrm" | "CapEff" | "CapBnd" | "CapAmb", string | undefined>;
}

export function parseStatus(text: string): ProcStatus {
  const line = (name: string): string | undefined => new RegExp(`^${name}:\\s*(.*)$`, "mu").exec(text)?.[1]?.trim();
  const numbers = (value: string | undefined): number[] => (value === undefined ? [] : value.split(/\s+/u).filter(Boolean).map(Number));
  const noNewPrivs = line("NoNewPrivs");
  return {
    uid: numbers(line("Uid")), gid: numbers(line("Gid")), noNewPrivs: noNewPrivs === undefined ? undefined : Number(noNewPrivs),
    caps: { CapInh: line("CapInh"), CapPrm: line("CapPrm"), CapEff: line("CapEff"), CapBnd: line("CapBnd"), CapAmb: line("CapAmb") },
  };
}

export interface LimitValue { soft: string; hard: string }

/** The table of /proc/<pid>/limits: `Max open files            1024                 1024                 files`. A value is `unlimited` or a number. */
export function parseLimits(text: string): Record<string, LimitValue> {
  const out: Record<string, LimitValue> = {};
  for (const line of text.split("\n").slice(1)) {
    const match = /^(Max [a-z ]+?)\s{2,}(\S+)\s+(\S+)(?:\s+\S.*)?$/u.exec(line.trimEnd());
    if (match !== null) out[match[1]!] = { soft: match[2]!, hard: match[3]! };
  }
  return out;
}

/** The parent pid of a process, from its /proc/<pid>/stat (the command name sits in parentheses and may hold spaces and brackets, so the line is read after the LAST `)`). */
export function parentOf(statText: string): number | undefined {
  const end = statText.lastIndexOf(")");
  if (end < 0) return undefined;
  const fields = statText.slice(end + 2).split(" ");
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

/** Every process below `root` (children, their children, ...), not `root` itself. A process that disappears while being read is skipped. Bounded: it never returns more than 1,000. */
export function descendantsOf(root: number, pids: readonly number[], readStat: (pid: number) => string | undefined): number[] {
  const parent = new Map<number, number>();
  for (const pid of pids) {
    const text = readStat(pid);
    const ppid = text === undefined ? undefined : parentOf(text);
    if (ppid !== undefined) parent.set(pid, ppid);
  }
  const found: number[] = [];
  let frontier = [root];
  while (frontier.length > 0 && found.length < 1_000) {
    const next: number[] = [];
    for (const [pid, ppid] of parent) if (frontier.includes(ppid) && !found.includes(pid) && pid !== root) { found.push(pid); next.push(pid); }
    frontier = next;
  }
  return found;
}
