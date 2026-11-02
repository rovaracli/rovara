// The operator's side of the SU-1 Linux checks (scripts/staging-checks/setup-agent-su1.sh): it builds the SSM command parameters that deliver the script to a staging worker, reads the worker's output
// back, and prints one PASS or FAIL per check 1-11. It makes NO AWS call and reads no secret: the operator runs the AWS commands through ~/.local/share/rovara-tools/staging-aws.sh (see the script's header).
//   npx tsx scripts/staging-checks/setup-agent-su1-report.ts --ssm-params [--script-args '--expect-docker-user-sha <sha>']   > params.json
//   npx tsx scripts/staging-checks/setup-agent-su1-report.ts --output <file> [--evidence9 <file>] [--evidence10 <file> --stale-file-created] [--turn-cents <n>]
// Checks 9 and 10 need a real model-driven setup run, which the read-only script does not start; the operator saves the app's answer of that run (`GET /v1/app/projects/<name>/setup-agent`) and this tool judges it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The checks, in order, with the name the script prints for each. */
export const SU1_CHECKS = [
  { n: 1, name: "br_netfilter" },
  { n: 2, name: "docker_user_order" },
  { n: 3, name: "helper_reply_path" },
  { n: 4, name: "sandbox_walls" },
  { n: 5, name: "dns_answers" },
  { n: 6, name: "no_fallback" },
  { n: 7, name: "bridges" },
  { n: 8, name: "leftover_sweep" },
  { n: 9, name: "budget_with_zero_cost_proxy" },
  { n: 10, name: "stale_untracked_project_json" },
  { n: 11, name: "public_ip_egress" },
] as const;

export type Su1Status = "PASS" | "FAIL";
export interface Su1Row { n: number; name: string; status: Su1Status; detail: string }
export interface Su1Parsed {
  /** The checks the output reported, by number. */
  rows: Map<number, Su1Row>;
  /** The run id and host of the START line of the run that was read. */
  run?: string | undefined;
  host?: string | undefined;
  summary?: { pass: number; fail: number; total: number } | undefined;
  /** Lines that looked like a result but could not be used (a wrong name, a number out of range, a duplicate within one run). */
  problems: string[];
}

const RESULT = /^SU1 (\d{1,2}) (PASS|FAIL) ([a-z0-9_]+) \| (.*)$/u;
const START = /^SU1 START run=(\S+) host=(\S+)/u;
const SUMMARY = /^SU1 SUMMARY pass=(\d+) fail=(\d+) total=(\d+)/u;

/**
 * Reads the script's output. If several runs were pasted one after the other, only the last run (from its START line) is read. A result whose name is not the one the check has is a problem and the check
 * is then missing; a check twice in one run is a problem too (the second is ignored). Anything else in the text (the SSM status line, a shell error) is ignored.
 */
export function parseSu1Output(text: string): Su1Parsed {
  const lines = text.split(/\r?\n/u);
  let from = 0;
  for (let index = 0; index < lines.length; index += 1) if (START.test(lines[index]!)) from = index;
  const parsed: Su1Parsed = { rows: new Map(), problems: [] };
  for (const line of lines.slice(from)) {
    const start = START.exec(line);
    if (start !== null) { parsed.run = start[1]; parsed.host = start[2]; continue; }
    const summary = SUMMARY.exec(line);
    if (summary !== null) { parsed.summary = { pass: Number(summary[1]), fail: Number(summary[2]), total: Number(summary[3]) }; continue; }
    const found = RESULT.exec(line);
    if (found === null) continue;
    const n = Number(found[1]), expected = SU1_CHECKS.find((check) => check.n === n);
    if (expected === undefined) { parsed.problems.push(`check ${String(n)} is not one of 1-11`); continue; }
    if (expected.name !== found[3]) { parsed.problems.push(`check ${String(n)} is named ${found[3]!}, expected ${expected.name}`); continue; }
    if (parsed.rows.has(n)) { parsed.problems.push(`check ${String(n)} appears twice in one run`); continue; }
    parsed.rows.set(n, { n, name: expected.name, status: found[2] as Su1Status, detail: found[4]! });
  }
  return parsed;
}

// ---- checks 9 and 10: judged from the answer of a live setup run

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
const finishedStates: readonly unknown[] = ["ready", "failed"];

/**
 * Check 9: a proxy-routed model that reports a cost of 0 still stops at the budget. The answer of the run must say it ended `budget_used` with a counted spend above 0 (the run counts it itself from the turns'
 * tokens), and the spend may be over the budget by at most one turn (`turnCents`, the dearest one turn can cost at the run's model; the default is the catalog's worst case for the default model).
 */
export function judgeBudgetRun(answer: unknown, turnCents = 50): { status: Su1Status; detail: string } {
  const view = asRecord(answer), summary = asRecord(view?.["summary"]), limits = asRecord(view?.["limits"]);
  if (view === undefined || summary === undefined || limits === undefined) return { status: "FAIL", detail: "the evidence is not a finished setup run's answer (no summary or limits)" };
  if (!finishedStates.includes(view["status"])) return { status: "FAIL", detail: `the run is ${String(view["status"])}, not finished` };
  const stop = summary["stop"] ?? view["stop"], spend = summary["spendCents"], budget = limits["budgetCents"];
  if (stop !== "budget_used") return { status: "FAIL", detail: `the run ended ${String(stop)}, not budget_used` };
  if (typeof spend !== "number" || !Number.isFinite(spend) || spend <= 0) return { status: "FAIL", detail: `the counted spend is ${String(spend)}: a cost the proxy reported as 0 must still be counted` };
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) return { status: "FAIL", detail: "the run's budget is not a positive number" };
  if (spend > budget + turnCents) return { status: "FAIL", detail: `spend ${String(spend)} cents is over the ${String(budget)} cent budget by more than one turn (${String(turnCents)} cents)` };
  return { status: "PASS", detail: `ended budget_used at ${String(spend)} cents of ${String(budget)}, over by ${String(Math.max(0, spend - budget))} (one turn is at most ${String(turnCents)})` };
}

/**
 * Check 10: an untracked `kalmius/project.json` the run wrote never reaches the proposal. The operator says it was written (`staleFileCreated`; the answer cannot show it); the answer must hold a proposal and the
 * proposal must not name the file anywhere (a citation, a source, an item, a note).
 */
export function judgeStaleFile(answer: unknown, staleFileCreated: boolean): { status: Su1Status; detail: string } {
  if (!staleFileCreated) return { status: "FAIL", detail: "the evidence does not say a stale kalmius/project.json was written in the run (--stale-file-created)" };
  const view = asRecord(answer);
  if (view === undefined || !finishedStates.includes(view["status"])) return { status: "FAIL", detail: "the evidence is not a finished setup run's answer" };
  const proposal = asRecord(view["proposal"]);
  if (proposal === undefined) return { status: "FAIL", detail: "the run made no proposal, so nothing shows the file stayed out of it" };
  if (/kalmius\/project\.json/iu.test(JSON.stringify(proposal))) return { status: "FAIL", detail: "the proposal names kalmius/project.json" };
  return { status: "PASS", detail: "the run wrote an untracked kalmius/project.json and its proposal does not name it" };
}

export interface Su1Evidence { evidence9?: unknown; evidence10?: unknown; staleFileCreated?: boolean; turnCents?: number }

/** The final eleven rows: the script's rows, with 9 and 10 judged from the evidence when it is given; a missing row is a FAIL. */
export function finalRows(parsed: Su1Parsed, evidence: Su1Evidence = {}): Su1Row[] {
  return SU1_CHECKS.map(({ n, name }): Su1Row => {
    if (n === 9 && evidence.evidence9 !== undefined) return { n, name, ...judgeBudgetRun(evidence.evidence9, evidence.turnCents) };
    if (n === 10 && evidence.evidence10 !== undefined) return { n, name, ...judgeStaleFile(evidence.evidence10, evidence.staleFileCreated === true) };
    return parsed.rows.get(n) ?? { n, name, status: "FAIL", detail: "no result in the output (the output may be cut off: SSM returns at most 24,000 characters)" };
  });
}

export const allPass = (rows: readonly Su1Row[]): boolean => rows.length === SU1_CHECKS.length && rows.every((row) => row.status === "PASS");

export function formatReport(rows: readonly Su1Row[], parsed?: Su1Parsed): string {
  const out = rows.map((row) => `${row.status} ${String(row.n).padStart(2, " ")} ${row.name}: ${row.detail}`);
  const passed = rows.filter((row) => row.status === "PASS").length;
  out.push(`${String(passed)} of ${String(rows.length)} checks passed${parsed?.host === undefined ? "" : ` (host ${parsed.host}, run ${parsed.run ?? "?"})`}.`);
  for (const problem of parsed?.problems ?? []) out.push(`NOTE ${problem}`);
  return out.join("\n");
}

// ---- delivering the script through SSM

/** Characters a script argument may hold: the two flags and a digest, nothing a shell would read as more. */
const SAFE_ARGS = /^[A-Za-z0-9 _.=:/-]*$/u;
/** One SSM command string stays short: the script goes in base64 pieces of this size. */
export const SSM_CHUNK_CHARS = 3_000;
const REMOTE_B64 = "/var/tmp/.su1-script.b64";
const REMOTE_SCRIPT = "/var/tmp/.su1-script.sh";

/** The `commands` of an AWS-RunShellScript call that writes the script to the worker, runs it as root with `args`, and removes it. Pure: nothing is sent. */
export function ssmCommands(script: string, args = ""): string[] {
  if (!SAFE_ARGS.test(args)) throw new Error("the script arguments hold a character that is not allowed");
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const chunks: string[] = [];
  for (let at = 0; at < encoded.length; at += SSM_CHUNK_CHARS) chunks.push(encoded.slice(at, at + SSM_CHUNK_CHARS));
  return [
    `umask 077; rm -f ${REMOTE_B64} ${REMOTE_SCRIPT}; : > ${REMOTE_B64}`,
    ...chunks.map((chunk) => `printf '%s' '${chunk}' >> ${REMOTE_B64}`),
    `base64 -d ${REMOTE_B64} > ${REMOTE_SCRIPT} && rm -f ${REMOTE_B64} && bash ${REMOTE_SCRIPT}${args === "" ? "" : ` ${args}`}; rc=$?; rm -f ${REMOTE_B64} ${REMOTE_SCRIPT}; exit $rc`,
  ];
}

// ---- the command line

function flagValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
}

export function main(argv: readonly string[]): number {
  const here = fileURLToPath(new URL(".", import.meta.url));
  if (argv.includes("--ssm-params")) {
    const script = readFileSync(resolve(here, "setup-agent-su1.sh"), "utf8");
    process.stdout.write(JSON.stringify({ commands: ssmCommands(script, flagValue(argv, "--script-args") ?? "") }) + "\n");
    return 0;
  }
  const output = flagValue(argv, "--output");
  if (output === undefined) { process.stderr.write("usage: --ssm-params [--script-args '<flags>']  |  --output <file> [--evidence9 <file>] [--evidence10 <file> --stale-file-created] [--turn-cents <n>]\n"); return 2; }
  const read = (name: string): unknown => { const path = flagValue(argv, name); return path === undefined ? undefined : JSON.parse(readFileSync(path, "utf8")) as unknown; };
  const turn = flagValue(argv, "--turn-cents");
  const parsed = parseSu1Output(readFileSync(output, "utf8"));
  const rows = finalRows(parsed, { evidence9: read("--evidence9"), evidence10: read("--evidence10"), staleFileCreated: argv.includes("--stale-file-created"), ...(turn === undefined ? {} : { turnCents: Number(turn) }) });
  process.stdout.write(formatReport(rows, parsed) + "\n");
  return allPass(rows) ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
