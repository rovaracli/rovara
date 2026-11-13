// TE-B1-fresh (H1b): the working sandbox's stop script, run for real by `sh` over a FAKE /proc (the script's PROC_ROOT seam) with a fake `kill`. It must keep exactly PID 1, itself and the sandbox's own sleep (the OLDEST child of PID 1 by start time) and
// kill everything else, whatever a program says about itself: a command line of "sleep infinity" or an empty one, a name with parentheses and spaces. The live proof on a real kernel is scripts/linux-check-fresh-round.sh FR6.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STOP_SANDBOX_PROGRAMS_SCRIPT } from "../../packages/worker/src/fresh-check-round.js";

let dir: string;
let proc: string;
let killLog: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "stop-script-"))); proc = join(dir, "proc"); mkdirSync(proc); killLog = join(dir, "kills.log"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

interface Fake { pid: number; ppid: number; start: number; cmdline: string; comm?: string; state?: string; survives?: boolean }
function plant(fakes: readonly Fake[]): void {
  for (const fake of fakes) {
    mkdirSync(join(proc, String(fake.pid)));
    // pid (comm) state ppid, then fields 5..21, then starttime (field 22)
    const fields = [fake.state ?? "S", String(fake.ppid), ...Array.from({ length: 17 }, () => "0"), String(fake.start), "0", "0"];
    writeFileSync(join(proc, String(fake.pid), "stat"), `${String(fake.pid)} (${fake.comm ?? "prog"}) ${fields.join(" ")}\n`);
    writeFileSync(join(proc, String(fake.pid), "cmdline"), fake.cmdline.split(" ").join("\0"));
  }
}
/** Runs the script with a fake `kill` that logs `<signal> <pid>` and, for -9, removes the process from the fake /proc unless it is marked as surviving. */
function run(survivors: readonly number[] = []) {
  const prelude = `kill() { echo "$1 $2" >> '${killLog}'; if [ "$1" = -9 ]; then case " ${survivors.join(" ")} " in *" $2 "*) ;; *) rm -rf "$PROC_ROOT/$2";; esac; fi; }\n`;
  const result = spawnSync("sh", ["-c", prelude + STOP_SANDBOX_PROGRAMS_SCRIPT], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", PROC_ROOT: proc } });
  const log = existsSync(killLog) ? readFileSync(killLog, "utf8").trim().split("\n").filter((line) => line !== "") : [];
  return { stdout: result.stdout.trim(), status: result.status, log, killed: (signal: string) => log.filter((line) => line.startsWith(`${signal} `)).map((line) => Number(line.split(" ")[1])).sort((a, b) => a - b) };
}

const SANDBOX: Fake[] = [
  { pid: 1, ppid: 0, start: 10, cmdline: "/usr/bin/tini -- sleep infinity", comm: "tini" },
  { pid: 9, ppid: 1, start: 11, cmdline: "sleep infinity", comm: "sleep" },
];

describe("the stop script's own behaviour", () => {
  it("kills a leftover whose command line says 'sleep infinity', one with an empty command line and one whose name has parentheses and spaces; keeps PID 1 and the sandbox's own sleep", () => {
    plant([...SANDBOX,
      { pid: 20, ppid: 1, start: 500, cmdline: "sleep infinity", comm: "sleep" },            // a loop that renamed itself
      { pid: 21, ppid: 1, start: 600, cmdline: "", comm: "x" },                               // an empty command line
      { pid: 22, ppid: 1, start: 700, cmdline: "node", comm: "a) b (c" },                     // a name that breaks naive parsing
      { pid: 23, ppid: 20, start: 800, cmdline: "sleep infinity ", comm: "bash" },           // a child of a leftover
    ]);
    const result = run();
    expect(result.killed("-9")).toEqual([20, 21, 22, 23]);
    expect(result.killed("-STOP")).toEqual([20, 21, 22, 23]);
    expect(result.stdout).toBe("REMAINING:0");
    // frozen first, then killed: no program can fork or respawn while the others are killed
    expect(result.log.findIndex((line) => line.startsWith("-9 "))).toBeGreaterThan(result.log.map((line) => line.startsWith("-STOP ")).lastIndexOf(true));
    expect(existsSync(join(proc, "1"))).toBe(true);
    expect(existsSync(join(proc, "9"))).toBe(true);
  });
  it("the sandbox's sleep is the OLDEST child of PID 1 by start time, not the lowest PID or the one with the right name", () => {
    // the real sleep has a HIGH pid (pids wrap) and the oldest start; a younger loop with a low pid and the same name is not it
    plant([
      { pid: 1, ppid: 0, start: 10, cmdline: "tini", comm: "tini" },
      { pid: 900, ppid: 1, start: 11, cmdline: "sleep infinity", comm: "sleep" },
      { pid: 5, ppid: 1, start: 4_000, cmdline: "sleep infinity", comm: "sleep" },
    ]);
    const result = run();
    expect(result.killed("-9")).toEqual([5]);
    expect(existsSync(join(proc, "900"))).toBe(true);
  });
  it("zombies are not killed again, and a process that is not a child of PID 1 is killed too", () => {
    plant([...SANDBOX, { pid: 30, ppid: 1, start: 50, cmdline: "", state: "Z" }, { pid: 31, ppid: 777, start: 60, cmdline: "worker" }]);
    const result = run();
    expect(result.killed("-9")).toEqual([31]);
    expect(result.stdout).toBe("REMAINING:0");
  });
  it("a program that survives the kill is reported: REMAINING is not 0", () => {
    plant([...SANDBOX, { pid: 40, ppid: 1, start: 90, cmdline: "sleep infinity" }]);
    const result = run([40]);
    expect(result.stdout).toBe("REMAINING:1");
    expect(result.killed("-9")).toEqual([40, 40, 40]);
  });
  it("a sandbox with nothing else running prints REMAINING:0 and kills nothing", () => {
    plant(SANDBOX);
    const result = run();
    expect(result.log).toEqual([]);
    expect(result.stdout).toBe("REMAINING:0");
  });
  it("uses no single quote (the Linux check embeds it inside single quotes)", () => {
    expect(STOP_SANDBOX_PROGRAMS_SCRIPT).not.toContain("'");
    appendFileSync(killLog, "");
  });
});
