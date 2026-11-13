// The guard's budget ledger SQL (rovara_guard.py section 4) against a REAL Postgres: the statements the guard sends, run by its own _PostgresLedger through a database stand-in that shells to psql.
// What it pins (DECISIONS 172, 165): a call that went ahead over the cap holds only the room that is left, and when its cost never becomes known (cut stream, settle after the grace, orphan swept
// by the call that finds it or by a replica starting) it is charged its WORST CASE, not that small room; a hold written without a worst case (an older guard replica) is charged what it reserved;
// settling twice charges once. Runs only where Docker answers and postgres:16 is already present (it never pulls), so CI skips it.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROVARA_GUARD_PY } from "../../packages/model-proxy/src/rovara-guard.js";

const usable = spawnSync("docker", ["image", "inspect", "postgres:16"], { stdio: "ignore" }).status === 0 && spawnSync("python3", ["-I", "-c", "pass"]).status === 0;

const DRIVER = String.raw`
import asyncio, csv, io, json, subprocess, sys, types
PG = sys.argv[2]
class HTTPException(Exception): pass
class CustomLogger:
    def __init__(self, *a, **k): pass
def lit(v):
    if v is None: return "NULL"
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, int): return str(v)
    return "'" + str(v).replace("'", "''") + "'"
def psql(sql):
    out = subprocess.run(["docker", "exec", "-i", PG, "psql", "-U", "litellm", "-d", "litellm", "-v", "ON_ERROR_STOP=1", "--csv", "-q"], input=sql, capture_output=True, text=True)
    if out.returncode != 0: raise RuntimeError(out.stderr)
    return list(csv.DictReader(io.StringIO(out.stdout)))
class DB:
    """What LiteLLM's Prisma client offers the guard: the statement with $n parameters, then the values (Postgres infers each parameter's type from its cast)."""
    def run(self, sql, args=()):
        if not args: return psql(sql + ";")
        return psql("PREPARE s AS " + sql + "; EXECUTE s(" + ", ".join(lit(a) for a in args) + ");")
    async def execute_raw(self, sql, *args): await asyncio.to_thread(self.run, sql, args)
    async def query_raw(self, sql, *args): return await asyncio.to_thread(self.run, sql, args)
litellm = types.ModuleType("litellm"); proxy = types.ModuleType("litellm.proxy"); server = types.ModuleType("litellm.proxy.proxy_server"); logger = types.ModuleType("litellm.integrations.custom_logger")
integrations = types.ModuleType("litellm.integrations")
server.prisma_client = types.SimpleNamespace(db=DB()); server.llm_router = None
fastapi = types.ModuleType("fastapi"); fastapi.HTTPException = HTTPException; logger.CustomLogger = CustomLogger
sys.modules.update({"litellm": litellm, "litellm.proxy": proxy, "litellm.proxy.proxy_server": server, "litellm.integrations": integrations, "litellm.integrations.custom_logger": logger, "fastapi": fastapi})
text = open(sys.argv[1]).read()
ns = {"HTTPException": HTTPException, "CustomLogger": CustomLogger, "__name__": "guard_section"}
exec(compile(text[text.index("# ---------------------------------------------------------------- 4. task budget"):], "guard", "exec"), ns)
sql = DB().run
def row(key): return sql("SELECT charged_micros, held_micros, estimated_micros FROM rovara_budget.keys WHERE key_hash = " + lit(key) + ";")[0]
def holds(key): return int(sql("SELECT count(*) AS n FROM rovara_budget.holds WHERE key_hash = " + lit(key) + ";")[0]["n"])
def expire(call_id): sql("UPDATE rovara_budget.holds SET expires_at = now() - interval '1 second' WHERE call_id = " + lit(call_id) + ";")
CAP = 1_000_000
async def main():
    out = {}
    ledger = ns["_PostgresLedger"]()
    ns["_LEDGER"] = ledger
    await ledger._db()
    await ledger._db()
    sql('CREATE TABLE IF NOT EXISTS "LiteLLM_VerificationToken" (token text PRIMARY KEY, metadata jsonb)')
    # 1. an overrun call (an estimated hold that does not fit the room: it goes ahead, holding the room that is left) cut before its cost is known: charged its worst case
    verdict, _ = await ledger.take("k-cut", "c-cut", 5_000_000, 900_000, CAP, True)
    held = row("k-cut")["held_micros"]
    await ledger.settle("c-cut", None, True)
    out["cut"] = {"verdict": verdict, "held": held, "after": row("k-cut")}
    # 2. the same call settled to its real cost: charged that cost, not the worst case
    await ledger.take("k-known", "c-known", 5_000_000, 900_000, CAP, True)
    await ledger.settle("c-known", 30_000, True)
    out["known"] = row("k-known")
    # 3. a call that fits (not overrun) cut before its cost is known: its whole hold, which is its worst case
    await ledger.take("k-fits", "c-fits", 40_000, 0, CAP, False)
    await ledger.settle("c-fits", None, True)
    out["fits"] = row("k-fits")
    # 4. an overrun orphan swept by the next call on its key
    await ledger.take("k-orphan", "c-orphan", 5_000_000, 900_000, CAP, True)
    expire("c-orphan")
    await ledger.take("k-orphan", "c-after", 10_000, 900_000, CAP, False)       # the sweep runs first; this take does not fit (charged 5,000,000) and is refused
    out["orphan"] = {"after": row("k-orphan"), "holds": holds("k-orphan")}
    # 5. an overrun orphan swept at start-up by a replica
    await ledger.take("k-start", "c-start", 5_000_000, 900_000, CAP, True)
    expire("c-start")
    fresh = ns["_PostgresLedger"]()
    await fresh._db()
    out["start"] = {"after": row("k-start"), "holds": holds("k-start")}
    # 6. a hold written by an older guard (no worst case): charged what it reserved, settled and swept
    for key, call_id in (("k-old-settle", "c-old-1"), ("k-old-sweep", "c-old-2")):
        sql("INSERT INTO rovara_budget.keys (key_hash, held_micros) VALUES (" + lit(key) + ", 120000);")
        sql("INSERT INTO rovara_budget.holds (call_id, key_hash, reserved_micros, expires_at) VALUES (" + lit(call_id) + ", " + lit(key) + ", 120000, now() + interval '1 hour');")
    await ledger.settle("c-old-1", None, True)
    expire("c-old-2")
    again = ns["_PostgresLedger"]()
    await again._db()
    out["old"] = {"settled": row("k-old-settle"), "swept": row("k-old-sweep")}
    # 7. settling twice charges once
    await ledger.take("k-twice", "c-twice", 5_000_000, 900_000, CAP, True)
    await ledger.settle("c-twice", None, True)
    await ledger.settle("c-twice", None, True)
    out["twice"] = row("k-twice")
    # 8. DECISIONS 180: the company's month. Estimated calls that overrun their key (each key has spent 900,000 of 1,000,000 and the call's worst case is 5,000,000), from different keys of one
    # company at once, on a month of 1,000,000 with nothing spent: only one may go ahead. month = (company, 'YYYY-MM', the month's cap, LiteLLM's spend for the month).
    async def many(org, month, limit, team_spend, worst, n, tag, spent=900_000, estimated=True, key_spent=None):
        verdicts = await asyncio.gather(*[ledger.take("%s-%d" % (tag, i), "%s-call-%d" % (tag, i), worst, spent, CAP, estimated, (org, month, limit, team_spend)) for i in range(n)])
        return sorted(v for v, _ in verdicts)
    def month_row(org, month):
        rows = sql("SELECT held_micros, charged_micros, over_used FROM rovara_budget.org_months WHERE org = " + lit(org) + " AND month = " + lit(month) + ";")
        return rows[0] if rows else None
    out["slot"] = await many("org-a", "2026-11", 1_000_000, 0, 5_000_000, 4, "ma")
    out["slot_row"] = month_row("org-a", "2026-11")
    out["slot_other_company"] = await many("org-b", "2026-11", 1_000_000, 0, 5_000_000, 3, "mb")
    out["slot_next_month"] = await many("org-a", "2026-12", 1_000_000, 0, 5_000_000, 3, "mc")
    # a call that fits its key still needs the slot when it could pass the month: 980,000 of 1,000,000 are spent and its worst case is 50,000
    out["fits_but_month"] = await many("org-f", "2026-11", 1_000_000, 980_000, 50_000, 3, "mf", spent=0)
    # the month is already at its cap: no estimated call at all; a call of a known price is not refused (this lane), but is counted
    out["blocked"] = await many("org-c", "2026-11", 1_000_000, 1_000_000, 5_000_000, 2, "me")
    out["blocked_known"] = await many("org-c", "2026-11", 1_000_000, 1_000_000, 10_000, 2, "mk", spent=0, estimated=False)
    out["blocked_known_row"] = month_row("org-c", "2026-11")
    # worst cases that fit the month together take no slot: 4 x 5,000,000 of 100,000,000
    out["none"] = await many("org-d", "2026-11", 100_000_000, 0, 5_000_000, 4, "mg")
    out["none_row"] = month_row("org-d", "2026-11")
    # ... but in-flight holds count: a month of 12,000,000 takes two such calls, a third takes the slot and the fourth finds the month used up
    out["inflight"] = await many("org-i", "2026-11", 12_000_000, 0, 5_000_000, 4, "mi")
    # a settle and a sweep move the month's hold into what the month was charged; a failed call (cost 0) gives the slot back, a whole-hold settle and a sweep keep it
    await ledger.take("mj-0", "mj-call-0", 5_000_000, 900_000, CAP, True, ("org-j", "2026-11", 1_000_000, 0))
    second = await ledger.take("mj-1", "mj-call-1", 5_000_000, 900_000, CAP, True, ("org-j", "2026-11", 1_000_000, 0))
    await ledger.settle("mj-call-0", 0, True)
    out["released"] = {"second_while_held": second[0], "row": month_row("org-j", "2026-11"), "third": (await ledger.take("mj-2", "mj-call-2", 5_000_000, 900_000, CAP, True, ("org-j", "2026-11", 1_000_000, 0)))[0]}
    await ledger.take("kp-0", "kp-call-0", 5_000_000, 900_000, CAP, True, ("org-k", "2026-11", 1_000_000, 0))
    await ledger.settle("kp-call-0", None, True)
    out["kept"] = {"row": month_row("org-k", "2026-11"), "next": (await ledger.take("kp-1", "kp-call-1", 5_000_000, 900_000, CAP, True, ("org-k", "2026-11", 1_000_000, 0)))[0]}
    await ledger.take("ml-0", "ml-call-0", 5_000_000, 900_000, CAP, True, ("org-l", "2026-11", 1_000_000, 0))
    expire("ml-call-0")
    swept = ns["_PostgresLedger"](); await swept._db()
    out["swept"] = month_row("org-l", "2026-11")
    await ledger.take("mm-0", "mm-call-0", 70_000, 0, CAP, False, ("org-m", "2026-11", 1_000_000, 0))
    await ledger.take("mm-1", "mm-call-1", 30_000, 0, CAP, False, ("org-m", "2026-11", 1_000_000, 0))
    held_two = month_row("org-m", "2026-11")
    await ledger.settle("mm-call-0", 4_000, False)
    await ledger.settle("mm-call-1", None, False)
    out["month_known"] = {"held": held_two, "settled": month_row("org-m", "2026-11")}
    # a deadlock between a take and a settle is retried once (Postgres: 40P01)
    class Flaky(DB):
        failed = 0
        async def query_raw(self, sql, *args):
            if sql is ns["_SQL_TAKE"] and not Flaky.failed:
                Flaky.failed = 1; raise RuntimeError("ERROR: deadlock detected (SQLSTATE 40P01)")
            return await super().query_raw(sql, *args)
    server.prisma_client = types.SimpleNamespace(db=Flaky())
    retried = ns["_PostgresLedger"](); await retried._db()
    out["retried"] = {"verdict": (await retried.take("mn-0", "mn-call-0", 10_000, 0, CAP, False))[0], "failed": Flaky.failed}
    return out
print("RESULT " + json.dumps(asyncio.run(main())))
`;

type Row = { charged_micros: string; held_micros: string; estimated_micros: string };
type MonthRow = { held_micros: string; charged_micros: string; over_used: string };
type Out = { cut: { verdict: string; held: string; after: Row }; known: Row; fits: Row; orphan: { after: Row; holds: number }; start: { after: Row; holds: number }; old: { settled: Row; swept: Row }; twice: Row;
  slot: string[]; slot_row: MonthRow; slot_other_company: string[]; slot_next_month: string[]; fits_but_month: string[]; blocked: string[]; blocked_known: string[]; blocked_known_row: MonthRow; none: string[]; none_row: MonthRow;
  inflight: string[]; released: { second_while_held: string; row: MonthRow; third: string }; kept: { row: MonthRow; next: string }; swept: MonthRow; month_known: { held: MonthRow; settled: MonthRow }; retried: { verdict: string; failed: number } };

describe.skipIf(!usable)("the budget ledger's SQL against a real Postgres (docker)", () => {
  it("charges the worst case of an overrun call whose cost is never known, by settle, by the sweep of its key and by the start-up sweep; an older hold keeps its reserved charge", () => {
    const run = `rovara-ledger-${randomBytes(4).toString("hex")}`;
    const directory = mkdtempSync(join(tmpdir(), "rovara-ledger-"));
    writeFileSync(join(directory, "rovara_guard.py"), ROVARA_GUARD_PY);
    writeFileSync(join(directory, "driver.py"), DRIVER);
    try {
      execFileSync("docker", ["run", "-d", "--name", run, "-e", "POSTGRES_USER=litellm", "-e", `POSTGRES_PASSWORD=${randomBytes(12).toString("hex")}`, "-e", "POSTGRES_DB=litellm", "postgres:16"], { stdio: "ignore" });
      for (let tries = 0; ; tries += 1) {
        if (spawnSync("docker", ["exec", run, "psql", "-U", "litellm", "-d", "litellm", "-c", "select 1"], { stdio: "ignore" }).status === 0 && spawnSync("docker", ["exec", run, "pg_isready", "-U", "litellm"], { stdio: "ignore" }).status === 0) break;
        if (tries > 60) throw new Error("postgres did not start");
        spawnSync("sleep", ["1"]);
      }
      spawnSync("sleep", ["2"]);                          // the image restarts the server once after its first start
      const result = spawnSync("python3", ["-I", join(directory, "driver.py"), join(directory, "rovara_guard.py"), run], { encoding: "utf8", timeout: 120_000 });
      expect(result.status, result.stderr.slice(-3000)).toBe(0);
      const out = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith("RESULT "))!.slice(7)) as Out;
      const n = (value: string) => Number(value);
      // 1. the call went ahead over the cap holding only the $0.10 of room that was left, then was cut: charged its $5 worst case.
      expect(out.cut.verdict).toBe("ok");
      expect(n(out.cut.held)).toBe(100_000);
      expect(out.cut.after).toMatchObject({ charged_micros: "5000000", held_micros: "0", estimated_micros: "5000000" });
      // 2. a known cost is charged as it is; 3. a call that fit is charged its hold.
      expect(out.known).toMatchObject({ charged_micros: "30000", held_micros: "0" });
      expect(out.fits).toMatchObject({ charged_micros: "40000", held_micros: "0" });
      // 4 and 5. the sweeps charge the worst case too, and clear the hold.
      expect(out.orphan.after).toMatchObject({ charged_micros: "5000000", held_micros: "0" });
      expect(out.orphan.holds).toBe(0);
      expect(out.start.after).toMatchObject({ charged_micros: "5000000", held_micros: "0" });
      expect(out.start.holds).toBe(0);
      // 6. no worst case recorded (an older guard): what the hold reserved. 7. twice is once.
      expect(out.old.settled).toMatchObject({ charged_micros: "120000", held_micros: "0" });
      expect(out.old.swept).toMatchObject({ charged_micros: "120000", held_micros: "0" });
      expect(out.twice).toMatchObject({ charged_micros: "5000000", held_micros: "0" });
      // 8. DECISIONS 180: the company's month is a ledger. Of four estimated calls on four keys of one company, each able to pass the month's cap, one goes ahead and three find the month used
      // up (the one that went ahead holds its worst case); another company, and the next month, each have their own one.
      const month = (held: string, charged: string, over: string) => ({ held_micros: held, charged_micros: charged, over_used: over });
      expect(out.slot).toEqual(["month", "month", "month", "ok"]);
      expect(out.slot_row).toEqual(month("5000000", "0", "t"));
      expect(out.slot_other_company).toEqual(["month", "month", "ok"]);
      expect(out.slot_next_month).toEqual(["month", "month", "ok"]);
      expect(out.fits_but_month).toEqual(["month", "month", "ok"]);                  // a call that fits its key still needs the slot when it could pass the month
      expect(out.blocked).toEqual(["month", "month"]);
      expect(out.blocked_known).toEqual(["ok", "ok"]);                              // not refused for the month in this lane, but counted
      expect(out.blocked_known_row).toEqual(month("20000", "0", "f"));
      expect(out.none).toEqual(["ok", "ok", "ok", "ok"]);                           // worst cases that fit the month together take no slot
      expect(out.none_row).toEqual(month("20000000", "0", "f"));
      expect(out.inflight).toEqual(["month", "ok", "ok", "ok"]);                    // in-flight holds count against the month
      expect(out.released).toEqual({ second_while_held: "month", row: month("0", "0", "f"), third: "ok" });   // a failed call (cost 0) gives the slot back
      expect(out.kept).toEqual({ row: month("0", "5000000", "t"), next: "month" });  // a whole-hold settle keeps it, and charges the month its worst case
      expect(out.swept).toEqual(month("0", "5000000", "t"));
      expect(out.month_known).toEqual({ held: month("100000", "0", "f"), settled: month("0", "34000", "f") });
      expect(out.retried).toEqual({ verdict: "ok", failed: 1 });
    } finally {
      spawnSync("docker", ["rm", "-f", "-v", run], { stdio: "ignore" });
    }
  });
});
