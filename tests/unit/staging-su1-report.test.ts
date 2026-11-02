// SU-1: the operator's side of the staging Linux checks (scripts/staging-checks/setup-agent-su1.sh and setup-agent-su1-report.ts). The script itself is NEVER run here (it is for a staging worker, through SSM): these
// tests parse its output format, judge the two live-run checks, build the SSM parameters, read the script's text for what it must not do, check its syntax with `bash -n` (which runs nothing) and run its embedded
// probe program (plain node) against a stub DNS server on this machine.
import { execFile, execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { createServer, type Server } from "node:net";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  SSM_CHUNK_CHARS, SU1_CHECKS, allPass, finalRows, formatReport, judgeBudgetRun, judgeStaleFile, parseSu1Output, ssmCommands,
} from "../../scripts/staging-checks/setup-agent-su1-report.js";

const SCRIPT = "scripts/staging-checks/setup-agent-su1.sh";
const text = readFileSync(SCRIPT, "utf8");
const line = (n: number, status: "PASS" | "FAIL", detail = "evidence") => `SU1 ${String(n)} ${status} ${SU1_CHECKS[n - 1]!.name} | ${detail}`;
const transcript = (statuses: Record<number, "PASS" | "FAIL"> = {}, run = "abc123") => [
  "Success",
  `SU1 START run=${run} host=ip-10-0-1-5 kernel=6.1 docker=25.0 image=yes sandbox_image_set=yes`,
  ...SU1_CHECKS.map(({ n }) => line(n, statuses[n] ?? "PASS")),
  "SU1 SUMMARY pass=11 fail=0 total=11 run=abc123 host=ip-10-0-1-5",
].join("\n");

describe("reading the script's output", () => {
  it("reads all eleven checks, the host and the summary", () => {
    const parsed = parseSu1Output(transcript());
    expect([...parsed.rows.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(parsed).toMatchObject({ run: "abc123", host: "ip-10-0-1-5", summary: { pass: 11, fail: 0, total: 11 }, problems: [] });
    expect(parsed.rows.get(4)).toEqual({ n: 4, name: "sandbox_walls", status: "PASS", detail: "evidence" });
    expect(allPass(finalRows(parsed))).toBe(true);
  });

  it("a FAIL stays a FAIL and the report lists every check once", () => {
    const rows = finalRows(parseSu1Output(transcript({ 4: "FAIL", 11: "FAIL" })));
    expect(rows.filter((row) => row.status === "FAIL").map((row) => row.n)).toEqual([4, 11]);
    expect(allPass(rows)).toBe(false);
    const report = formatReport(rows, parseSu1Output(transcript({ 4: "FAIL", 11: "FAIL" }))).split("\n");
    expect(report).toHaveLength(12);
    expect(report[3]).toBe("FAIL  4 sandbox_walls: evidence");
    expect(report[11]).toBe("9 of 11 checks passed (host ip-10-0-1-5, run abc123).");
  });

  it("a check missing from a cut-off output is a FAIL, never a pass", () => {
    const cut = transcript().split("\n").slice(0, 8).join("\n");
    const rows = finalRows(parseSu1Output(cut));
    expect(rows.map((row) => row.status)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "FAIL", "FAIL", "FAIL", "FAIL", "FAIL"]);
    expect(rows[10]!.detail).toContain("24,000");
    expect(allPass(rows)).toBe(false);
  });

  it("reads only the last run when several were pasted, and ignores lines that are not results", () => {
    const both = `${transcript({ 3: "FAIL" }, "first1")}\nsh: line 4: foo: command not found\n${transcript({}, "second")}`;
    const parsed = parseSu1Output(both);
    expect(parsed.run).toBe("second");
    expect(allPass(finalRows(parsed))).toBe(true);
  });

  it("a result with another name than its check's, a number out of range, or a repeat is a problem and does not count", () => {
    const parsed = parseSu1Output([
      "SU1 START run=x host=h",
      "SU1 1 PASS wrong_name | nope",
      "SU1 12 PASS br_netfilter | nope",
      line(2, "PASS"), line(2, "FAIL"),
    ].join("\n"));
    expect(parsed.rows.has(1)).toBe(false);
    expect(parsed.rows.get(2)!.status).toBe("PASS");
    expect(parsed.problems).toEqual(["check 1 is named wrong_name, expected br_netfilter", "check 12 is not one of 1-11", "check 2 appears twice in one run"]);
    expect(allPass(finalRows(parsed))).toBe(false);
  });
});

describe("checks 9 and 10 are judged from a live run's answer", () => {
  const run = (over: Record<string, unknown> = {}, summary: Record<string, unknown> = {}) => ({
    status: "ready", limits: { budgetCents: 50 }, stop: "budget_used", summary: { stop: "budget_used", spendCents: 60, commandsRun: 9, ...summary }, ...over,
  });

  it("9: PASS when the run ended budget_used with a counted spend at most one turn over the budget", () => {
    expect(judgeBudgetRun(run()).status).toBe("PASS");
    expect(judgeBudgetRun(run({}, { spendCents: 50 })).status).toBe("PASS");
    expect(judgeBudgetRun(run({ status: "failed" })).status).toBe("PASS");
  });
  it("9: FAIL for a run that ended another way, counted nothing, overshot by more than a turn, or is not finished", () => {
    expect(judgeBudgetRun(run({}, { stop: "proposed" })).detail).toContain("proposed, not budget_used");
    expect(judgeBudgetRun(run({ stop: undefined }, { stop: undefined })).status).toBe("FAIL");
    expect(judgeBudgetRun(run({}, { spendCents: 0 })).detail).toContain("must still be counted");
    expect(judgeBudgetRun(run({}, { spendCents: 101 })).detail).toContain("more than one turn");
    expect(judgeBudgetRun(run({}, { spendCents: 101 }), 60).status).toBe("PASS");
    expect(judgeBudgetRun(run({ status: "running" })).detail).toContain("not finished");
    expect(judgeBudgetRun(run({ limits: { budgetCents: 0 } })).status).toBe("FAIL");
    expect(judgeBudgetRun("nope").status).toBe("FAIL");
    expect(judgeBudgetRun(null).status).toBe("FAIL");
  });

  const answer = (proposal: unknown, status = "ready") => ({ status, proposal });
  it("10: PASS when the stale file was written and the proposal never names it", () => {
    expect(judgeStaleFile(answer({ setup: [{ id: "a", from: [{ path: "package.json" }] }] }), true).status).toBe("PASS");
    expect(judgeStaleFile(answer({ setup: [] }, "failed"), true).status).toBe("PASS");
  });
  it("10: FAIL when the proposal names the file in any form, when there is no proposal, or when nobody says the file was written", () => {
    expect(judgeStaleFile(answer({ knowledge: [{ from: [{ path: "kalmius/project.json" }] }] }), true).detail).toContain("names kalmius/project.json");
    expect(judgeStaleFile(answer({ notes: "see KALMIUS/Project.json" }), true).status).toBe("FAIL");
    expect(judgeStaleFile(answer(undefined), true).detail).toContain("no proposal");
    expect(judgeStaleFile(answer({ setup: [] }), false).detail).toContain("--stale-file-created");
    expect(judgeStaleFile(answer({ setup: [] }, "running"), true).status).toBe("FAIL");
  });

  it("the evidence replaces the script's own FAIL for 9 and 10 only", () => {
    const parsed = parseSu1Output(transcript({ 9: "FAIL", 10: "FAIL" }));
    expect(allPass(finalRows(parsed))).toBe(false);
    const rows = finalRows(parsed, { evidence9: run(), evidence10: answer({ setup: [] }), staleFileCreated: true });
    expect(allPass(rows)).toBe(true);
    // The other checks are not touched by evidence.
    expect(allPass(finalRows(parseSu1Output(transcript({ 5: "FAIL", 9: "FAIL", 10: "FAIL" })), { evidence9: run(), evidence10: answer({ setup: [] }), staleFileCreated: true }))).toBe(false);
  });
});

describe("the SSM parameters", () => {
  it("deliver the script whole, in short pieces, run it as given and remove it afterwards", () => {
    const commands = ssmCommands(text, "--expect-no-leftovers");
    const pieces = commands.filter((command) => command.startsWith("printf '%s' '"));
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(SSM_CHUNK_CHARS + 60);
    const joined = pieces.map((piece) => /^printf '%s' '([A-Za-z0-9+/=]*)' >> /u.exec(piece)![1]!).join("");
    expect(Buffer.from(joined, "base64").toString("utf8")).toBe(text);
    expect(commands[0]).toContain("umask 077");
    const last = commands.at(-1)!;
    expect(last).toContain("bash /var/tmp/.su1-script.sh --expect-no-leftovers");
    expect(last).toMatch(/rm -f \/var\/tmp\/\.su1-script\.b64 \/var\/tmp\/\.su1-script\.sh; exit \$rc$/u);
  });
  it("refuse a script argument that a shell would read as more than a flag", () => {
    for (const bad of ["; reboot", "$(id)", "`id`", "--x | sh", "a'b", "a\nb"]) expect(() => ssmCommands("echo", bad), bad).toThrow(/not allowed/u);
    expect(() => ssmCommands("echo", `--expect-docker-user-sha ${"a".repeat(64)}`)).not.toThrow();
  });
});

describe("the script's text", () => {
  it("is valid bash (checked with bash -n, which runs nothing)", () => {
    expect(() => execFileSync("bash", ["-n", SCRIPT])).not.toThrow();
  });

  it("names its eleven checks exactly as the report expects them, once each", () => {
    const emitted = [...text.matchAll(/\b(?:emit|verdict) (\d+) (?:(?:PASS|FAIL) )?([a-z0-9_]+) /gu)].map((match) => `${match[1]!}:${match[2]!}`);
    const names = new Map<string, number>();
    for (const entry of emitted) names.set(entry, (names.get(entry) ?? 0) + 1);
    for (const { n, name } of SU1_CHECKS) expect(names.has(`${String(n)}:${name}`), `${String(n)} ${name}`).toBe(true);
    // Every emitted number belongs to the table (a typo in a name or number would not).
    for (const entry of names.keys()) expect(SU1_CHECKS.some(({ n, name }) => entry === `${String(n)}:${name}`) || entry.endsWith(":not_run"), entry).toBe(true);
  });

  it("changes nothing on the host: no rule, sysctl, module, mount, service or file write, and no AWS command", () => {
    const code = text.split("\n").filter((row) => !row.trimStart().startsWith("#")).join("\n").replace(/\s#\s[^\n]*/gu, "").replace(/read -r -d '' PROBE_JS <<'PROBE_END'[\s\S]*?\nPROBE_END\n/u, "");
    for (const forbidden of [/\biptables\b[^\n]*\s-[AIDFRXNPZ]\b/u, /\bip6tables\b/u, /(?<!-)\bsysctl\b/u, /\bmodprobe\b/u, /\bmount\b/u, /\bsystemctl\b/u, /\bservice\b/u, /\breboot\b/u, /\bshutdown\b/u, /\bkillall?\b/u, /\bchmod\b/u, /\bchown\b/u, /\btee\b/u, /\bcurl\b/u, /\bwget\b/u, /\baws\b/u, /\bsudo\b/u]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    // No redirection into a file (only to /dev/null or a file descriptor).
    for (const match of code.matchAll(/(?<![<>&0-9])>>?\s*([^\s&|;)]+)/gu)) expect(["/dev/null", "&1", "&2"].includes(match[1]!) || match[1]!.startsWith("&"), match[0]).toBe(true);
    // Docker: only what the throwaway runs need, never a privileged, host-network or socket-mounting container.
    expect(code).not.toMatch(/--privileged|--cap-add|--network host|--net host|--pid host|docker\.sock|--volume|--mount/u);
    for (const row of code.split("\n").filter((entry) => /\brun\b/u.test(entry) && /DOCKER|dk /u.test(entry))) expect(row).not.toMatch(/\s-v\s/u);
    const subcommands = new Set([...code.matchAll(/\b(?:dk|"\$DOCKER") (\w+)(?: (\w+))?/gu)].map((match) => (match[1] === "network" ? `network ${match[2]!}` : match[1]!)));
    for (const used of subcommands) expect(["info", "version", "inspect", "logs", "stop", "exec", "run", "ps", "network create", "network ls", "network inspect", "network rm", "rm"], used).toContain(used);
  });

  it("starts only things labelled for this run, not the worker's own setup-run labels, and removes them on every exit", () => {
    expect(text).toContain('SU1_LABEL="agentx.su1-check=$RUN"');
    expect(text).toMatch(/trap cleanup EXIT/u);
    expect(text).toMatch(/trap 'cleanup; exit 130' INT TERM HUP/u);
    // Containers it starts carry the su1 label; the worker's labels are only ever read (filters in check 8).
    const runs = [...text.matchAll(/dk run [^\n]*|"\$DOCKER" run [^\n]*/gu)].map((match) => match[0]);
    expect(runs.length).toBe(2);
    for (const row of runs) expect(row).toContain('--label "$SU1_LABEL"');
    expect(text).toMatch(/dk network create [^\n]*--label "\$SU1_LABEL"/u);
    expect(text.match(/agentx\.setup-run/gu)!.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/--label "?agentx\.setup-run/u);
  });

  it("refuses to do anything but report on a host that is not a root Linux worker, and the header names the staging guard and the ledger", () => {
    expect(text).toMatch(/\$EUID -ne 0/u);
    expect(text).toMatch(/uname -s\)" != Linux/u);
    expect(text).toContain("staging-aws.sh");
    expect(text).toContain("944937319445");
    expect(text).toContain("us-west-2");
    expect(text).not.toMatch(/us-east-1/u);
    expect(text).toContain("DEFERRED-CHECKS.md");
  });
});

// ---- the embedded probe program, run (plain node, this machine) against a stub resolver

const execFileAsync = promisify(execFile);
const probeSource = (): string => /read -r -d '' PROBE_JS <<'PROBE_END'\n([\s\S]*?)\nPROBE_END\n/u.exec(text)![1]!;

/** A resolver that answers `ok.test` with one A record, anything else NXDOMAIN, over UDP and TCP on one port of 127.0.0.1. */
async function stubResolver(): Promise<{ port: number; close(): Promise<void> }> {
  const answer = (query: Buffer): Buffer => {
    const name = (() => { const parts: string[] = []; let at = 12; while (query[at]! > 0) { parts.push(query.subarray(at + 1, at + 1 + query[at]!).toString()); at += query[at]! + 1; } return parts.join("."); })();
    const reply = Buffer.from(query);
    const ok = name === "ok.test";
    reply.writeUInt16BE(0x8180 | (ok ? 0 : 3), 2);
    reply.writeUInt16BE(ok ? 1 : 0, 6);
    return ok ? Buffer.concat([reply, Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 2, 3, 4])]) : reply;
  };
  const tcp: Server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 2 && buffer.length >= 2 + buffer.readUInt16BE(0)) {
        const reply = answer(buffer.subarray(2, 2 + buffer.readUInt16BE(0)));
        const head = Buffer.alloc(2); head.writeUInt16BE(reply.length);
        socket.end(Buffer.concat([head, reply]));
      }
    });
  });
  await new Promise<void>((resolveListen) => { tcp.listen(0, "127.0.0.1", resolveListen); });
  const port = (tcp.address() as { port: number }).port;
  const udp = createSocket("udp4");
  udp.on("message", (message, remote) => { udp.send(answer(message), remote.port, remote.address); });
  await new Promise<void>((resolveBind) => { udp.bind(port, "127.0.0.1", resolveBind); });
  return { port, close: async () => { udp.close(); await new Promise<void>((resolveClose) => { tcp.close(() => { resolveClose(); }); }); } };
}

describe("the probe program", () => {
  it("asks over UDP and TCP, tells a refused connection from an open one, reads a file, and prints one line per test", async () => {
    const stub = await stubResolver();
    try {
      const tests = [
        { label: "pub_udp", kind: "udpq", host: "127.0.0.1", port: stub.port, name: "ok.test" },
        { label: "pub_tcp", kind: "tcpq", host: "127.0.0.1", port: stub.port, name: "ok.test" },
        { label: "nx_udp", kind: "udpq", host: "127.0.0.1", port: stub.port, name: "su1-abc.invalid" },
        { label: "nx_tcp", kind: "tcpq", host: "127.0.0.1", port: stub.port, name: "su1-abc.invalid" },
        { label: "open_port", kind: "conn", host: "127.0.0.1", port: stub.port },
        { label: "closed_port", kind: "conn", host: "127.0.0.1", port: 1 },
        { label: "silent_udp", kind: "udpq", host: "127.0.0.1", port: 9, name: "ok.test", ms: 300 },
        { label: "hosts", kind: "file", path: "/dev/null" },
      ];
      const { stdout } = await execFileAsync(process.execPath, ["-e", probeSource(), JSON.stringify({ tests })], { timeout: 20_000 });
      const out = stdout.trim();
      const rows = out.split("\n");
      expect(rows).toHaveLength(tests.length);
      expect(rows).toContain("pub_udp answer rcode=0 an=1");
      expect(rows).toContain("pub_tcp answer rcode=0 an=1");
      expect(rows).toContain("nx_udp answer rcode=3 an=0");
      expect(rows).toContain("nx_tcp answer rcode=3 an=0");
      expect(rows).toContain("open_port open");
      expect(rows).toContain("closed_port ECONNREFUSED");
      expect(rows).toContain("silent_udp timeout");
      expect(rows).toContain('hosts file ""');
      // The script's own readers take the same lines: the status word, the rcode and the answer count.
      expect(out.split("\n").find((row) => row.startsWith("nx_udp"))!.split(" ")[1]).toBe("answer");
    } finally { await stub.close(); }
  }, 30_000);
});
