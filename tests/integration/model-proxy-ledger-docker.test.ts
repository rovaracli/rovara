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
    # 8. DECISIONS 180: the company's month. Estimated calls that do not fit their key's room (each key has spent 900,000 of 1,000,000 and the call's worst case is 5,000,000), from different keys
    # of one company at once: only one may pass the month's cap.
    async def many(org, month, gate, worst, n, tag):
        verdicts = await asyncio.gather(*[ledger.take("%s-%d" % (tag, i), "%s-call-%d" % (tag, i), worst, 900_000, CAP, True, (gate, org, month)) for i in range(n)])
        return sorted(v for v, _ in verdicts)
    out["slot"] = await many("org-a", "2026-11", "slot", 5_000_000, 6, "ma")
    out["slot_other_company"] = await many("org-b", "2026-11", "slot", 5_000_000, 3, "mb")
    out["slot_next_month"] = await many("org-a", "2026-12", "slot", 5_000_000, 3, "mc")
    out["slot_fits"] = await many("org-a", "2026-11", "slot", 10_000, 2, "md")                  # fits its key's room: needs no slot, even with the slot taken
    out["blocked"] = await many("org-c", "2026-11", "blocked", 5_000_000, 2, "me")
    out["blocked_fits"] = await many("org-c", "2026-11", "blocked", 10_000, 2, "mf")
    out["none"] = await many("org-d", "2026-11", "none", 5_000_000, 4, "mg")
    out["month_rows"] = sorted((r["org"], r["month"], r["over_used"]) for r in sql("SELECT org, month, over_used FROM rovara_budget.org_months;"))
    return out
print("RESULT " + json.dumps(asyncio.run(main())))
`;

type Row = { charged_micros: string; held_micros: string; estimated_micros: string };
type Out = { cut: { verdict: string; held: string; after: Row }; known: Row; fits: Row; orphan: { after: Row; holds: number }; start: { after: Row; holds: number }; old: { settled: Row; swept: Row }; twice: Row; slot: string[]; slot_other_company: string[]; slot_next_month: string[]; slot_fits: string[]; blocked: string[]; blocked_fits: string[]; none: string[]; month_rows: string[][] };

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
      // 8. DECISIONS 180: of six estimated calls on six keys of one company that could each pass the month's cap, one goes ahead and five are told the month is used up; another company, and the
      // next month, each have their own one; a call that fits its key needs none; a month already at its cap lets no overrun through; a call that cannot pass the month takes no slot.
      expect(out.slot).toEqual(["month", "month", "month", "month", "month", "ok"]);
      expect(out.slot_other_company).toEqual(["month", "month", "ok"]);
      expect(out.slot_next_month).toEqual(["month", "month", "ok"]);
      expect(out.slot_fits).toEqual(["ok", "ok"]);
      expect(out.blocked).toEqual(["month", "month"]);
      expect(out.blocked_fits).toEqual(["ok", "ok"]);
      expect(out.none).toEqual(["ok", "ok", "ok", "ok"]);
      expect(out.month_rows).toEqual([["org-a", "2026-11", "t"], ["org-a", "2026-12", "t"], ["org-b", "2026-11", "t"]]);
    } finally {
      spawnSync("docker", ["rm", "-f", "-v", run], { stdio: "ignore" });
    }
  });
});
