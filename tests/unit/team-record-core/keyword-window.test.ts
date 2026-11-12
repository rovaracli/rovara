// Lane K1 (DECISIONS 145): the keyword side's window is read in PAGES (one DynamoDB Query stops at 1 MB) within a time budget, and scores each row by its best passage.
import { describe, expect, it } from "vitest";
import { queryRecordEventWindow, queryRecordEvents, RECORD_WINDOW_ROWS_MAX } from "../../../packages/broker/src/team-record/store.js";
import { KEYWORD_READ_BUDGET_MS, KEYWORD_SCAN_ROWS, keywordDocumentOf, recordSearch, type RecordQueryDependencies } from "../../../packages/broker/src/team-record/query.js";
import type { ReadAudience, TeamRecordTable } from "../../../packages/broker/src/team-record/types.js";
import { GITHUB_SCOPE, ORG_A, addSource, caller, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { eventFromItem } from "../../../packages/broker/src/team-record/store.js";

const MB = 1_048_576;
const PROJECT_AUDIENCE = { kind: "project" as const };
const person = (extra = {}): ReadAudience => ({ kind: "caller", caller: caller(extra) });

type Page = { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
interface Wrapped { table: TeamRecordTable; pages: Array<{ limit: number | undefined; items: number; bytes: number }>; }

/** The world's table, but every Query of the project's rows stops like DynamoDB's: at `maxItems` items or at 1 MB of items, whichever comes first, with a LastEvaluatedKey. */
function pagedLikeDynamo(w: World, options: { maxItems?: number; maxBytes?: number; took?: (page: number) => void } = {}): Wrapped {
  const pages: Wrapped["pages"] = [];
  const real = w.table.documentClient;
  const send = async (command: { constructor: { name: string }; input?: Record<string, unknown> }): Promise<unknown> => {
    const input = command.input as { Limit?: number; KeyConditionExpression?: string } | undefined;
    if (command.constructor.name !== "QueryCommand" || !String(input?.KeyConditionExpression).startsWith("pk = :pk AND sk BETWEEN")) return real.send(command);
    const asked = input?.Limit;
    if (options.maxItems !== undefined && command.input !== undefined) command.input.Limit = Math.min(asked ?? options.maxItems, options.maxItems);
    const response = await real.send(command) as Page;
    let items = response.Items ?? [];
    let lastKey = response.LastEvaluatedKey;
    if (options.maxBytes !== undefined) {
      let bytes = 0;
      const kept: typeof items = [];
      for (const item of items) {
        bytes += JSON.stringify(item).length;
        if (bytes > options.maxBytes && kept.length > 0) break;
        kept.push(item);
      }
      if (kept.length < items.length) { items = kept; lastKey = { pk: kept[kept.length - 1]!.pk, sk: kept[kept.length - 1]!.sk }; }
    }
    pages.push({ limit: asked, items: items.length, bytes: JSON.stringify(items).length });
    options.took?.(pages.length - 1);
    return { ...response, Items: items, ...(lastKey === undefined ? {} : { LastEvaluatedKey: lastKey }) };
  };
  return { table: { ...w.table, documentClient: { send } }, pages };
}

/** `count` rows of the project, oldest first (row 0 is the oldest), each with `text(i)`. */
async function seed(w: World, count: number, text: (i: number) => string): Promise<void> {
  await addSource(w, { source: "github", scope: GITHUB_SCOPE });
  for (let i = 0; i < count; i += 1) {
    const at = new Date(Date.parse("2026-10-01T00:00:00.000Z") + i * 60_000).toISOString();
    const outcome = await w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: `row-${String(i)}`, version: "1" }, occurredAt: at, audience: PROJECT_AUDIENCE, scope: GITHUB_SCOPE, text: text(i), links: [] }));
    if (outcome.status !== "stored") throw new Error(`seed row ${String(i)}: ${JSON.stringify(outcome)}`);
  }
}
const depsOf = (w: World, table: TeamRecordTable, extra: Partial<RecordQueryDependencies> = {}): RecordQueryDependencies => ({ table, modes: w.deps.modes, now: () => w.clock.ms, ...extra });

describe("the window read pages past DynamoDB's 1 MB page (K1)", () => {
  it("reads every row up to the limit although a page holds only part of them, newest first", async () => {
    const w = world();
    await seed(w, 60, (i) => `row ${String(i)} about nothing`);
    const wrapped = pagedLikeDynamo(w, { maxItems: 7 });
    const window = await queryRecordEventWindow(wrapped.table, ORG_A, "web", { limit: 50, nowSeconds: Math.floor(w.clock.ms / 1000) });
    expect(window.events).toHaveLength(50);
    expect(window).toMatchObject({ rowsRead: 50, stopped: "limit", pages: 8 });
    expect(window.events[0]!.text).toBe("row 59 about nothing");
    expect(window.events[49]!.text).toBe("row 10 about nothing");
    // the first page asks for the whole window; each next page for what is left
    expect(wrapped.pages.map((page) => page.limit)).toEqual([50, 43, 36, 29, 22, 15, 8, 1]);
    // the plain read gets the same rows
    expect((await queryRecordEvents(wrapped.table, ORG_A, "web", { limit: 50 })).map((event) => event.id)).toEqual(window.events.map((event) => event.id));
  });

  it("reads past 1 MB: rows of 7 KB, a page cut at 1 MB, the whole 400-row window", async () => {
    const w = world();
    const filler = "the team talked about the billing retry and the queue consumer. ".repeat(110);   // about 7,000 characters
    await seed(w, 300, (i) => `${filler} marker-${String(i)}`);
    const wrapped = pagedLikeDynamo(w, { maxBytes: MB });
    const window = await queryRecordEventWindow(wrapped.table, ORG_A, "web", { limit: KEYWORD_SCAN_ROWS });
    // the cut is real: no page holds more than 1 MB, and one page is nowhere near 300 rows
    expect(wrapped.pages.length).toBeGreaterThan(1);
    expect(Math.max(...wrapped.pages.map((page) => page.items))).toBeLessThan(300);
    expect(Math.max(...wrapped.pages.map((page) => page.bytes))).toBeLessThanOrEqual(MB + 20_000);
    // and every row is read anyway: 300 rows exist, the window asks for 400, no older row is left
    expect(window).toMatchObject({ rowsRead: 300, stopped: "end" });
    expect(window.events.some((event) => event.text!.endsWith(" marker-0"))).toBe(true);
  });

  it("through the search: a word only the OLDEST of 300 long rows holds is found by keyword alone, past the first 1 MB page", async () => {
    const w = world();
    const filler = "the team talked about the billing retry and the queue consumer. ".repeat(110);
    await seed(w, 300, (i) => (i === 0 ? `${filler} the quokka rollout postmortem` : `${filler} marker-${String(i)}`));
    const wrapped = pagedLikeDynamo(w, { maxBytes: MB });
    const result = await recordSearch(depsOf(w, wrapped.table), person(), "web", { query: "quokka" });
    expect(wrapped.pages.length).toBeGreaterThan(1);
    expect(result.hits).toHaveLength(1);
    const oldest = rows(w, "TEAM_RECORD_EVENT").find((row) => (row.sourceRef as { id: string }).id === "row-0")!;
    expect(result.hits[0]!.id).toBe(oldest.id);
    // control: with the old single query (one page only) the oldest row is outside the window
    const single = pagedLikeDynamo(w, { maxBytes: MB });
    const oneQuery = { ...single.table, documentClient: { send: (command: { constructor: { name: string } }) => single.table.documentClient.send(command).then((response) => { delete (response as Page).LastEvaluatedKey; return response; }) } };
    expect((await recordSearch(depsOf(w, oneQuery), person(), "web", { query: "quokka" })).hits).toEqual([]);
  });

  it("never reads more than RECORD_WINDOW_ROWS_MAX rows, whatever limit is asked", async () => {
    const w = world();
    await seed(w, 12, (i) => `row ${String(i)}`);
    expect(RECORD_WINDOW_ROWS_MAX).toBe(500);
    const wrapped = pagedLikeDynamo(w, { maxItems: 5 });
    expect(await queryRecordEventWindow(wrapped.table, ORG_A, "web", { limit: 9_999 })).toMatchObject({ rowsRead: 12, stopped: "end" });
    expect(wrapped.pages[0]!.limit).toBe(500);
  });
});

describe("the window read keeps to its time budget (K1)", () => {
  it("starts no page once the budget has passed, and answers with the newest rows read so far", async () => {
    const w = world();
    await seed(w, 60, (i) => `row ${String(i)}`);
    const clock = { ms: 1_000_000 };
    const wrapped = pagedLikeDynamo(w, { maxItems: 10, took: () => { clock.ms += 1_000; } });   // every page takes one second
    const window = await queryRecordEventWindow(wrapped.table, ORG_A, "web", { limit: 60, deadlineAt: clock.ms + 2_500, clock: () => clock.ms });
    // pages start at t = 0 s, 1 s, 2 s (all before 2.5 s); the next would start at 3 s
    expect(window).toMatchObject({ pages: 3, rowsRead: 30, stopped: "deadline" });
    expect(window.events[0]!.text).toBe("row 59");
    expect(window.events[29]!.text).toBe("row 30");
    expect(wrapped.pages).toHaveLength(3);
  });

  it("always reads the first page, even when the budget is already spent", async () => {
    const w = world();
    await seed(w, 20, (i) => `row ${String(i)}`);
    const wrapped = pagedLikeDynamo(w, { maxItems: 10 });
    const window = await queryRecordEventWindow(wrapped.table, ORG_A, "web", { limit: 20, deadlineAt: 0, clock: () => 5 });
    expect(window).toMatchObject({ pages: 1, rowsRead: 10, stopped: "deadline" });
  });

  it("gives up on a page that is still running at the deadline (a slow table does not hold the search)", async () => {
    const w = world();
    await seed(w, 20, (i) => `row ${String(i)}`);
    let calls = 0;
    const real = w.table.documentClient;
    const slow: TeamRecordTable = { ...w.table, documentClient: { send: (command: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      if (command.constructor.name === "QueryCommand" && String((command.input as { KeyConditionExpression?: string }).KeyConditionExpression).startsWith("pk = :pk AND sk BETWEEN")) {
        calls += 1;
        if (calls === 1) { (command.input as { Limit: number }).Limit = 10; return real.send(command); }
        return new Promise(() => undefined);   // the second page never comes back
      }
      return real.send(command);
    } } };
    const started = Date.now();
    const window = await queryRecordEventWindow(slow, ORG_A, "web", { limit: 20, deadlineAt: started + 150 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(window).toMatchObject({ pages: 1, rowsRead: 10, stopped: "deadline" });
  });

  it("the search spends at most KEYWORD_READ_BUDGET_MS on the window, logs the cut, and still answers from the rows it has", async () => {
    expect(KEYWORD_READ_BUDGET_MS).toBe(3_000);
    const w = world();
    await seed(w, 60, (i) => (i === 59 ? "the newest row says quokka" : i === 0 ? "the oldest row says quokka" : `row ${String(i)}`));
    const wrapped = pagedLikeDynamo(w, { maxItems: 10, took: () => { w.clock.ms += 1_200; } });   // 1.2 s a page: three pages fit in 3 s (t = 0, 1.2, 2.4), the fourth would start at 3.6
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const result = await recordSearch(depsOf(w, wrapped.table, { log: (event, fields) => { logs.push({ event, fields: { ...fields } }); } }), person(), "web", { query: "quokka" });
    expect(wrapped.pages).toHaveLength(3);
    expect(logs.find((entry) => entry.event === "record.keyword_window_cut")?.fields).toMatchObject({ rows: 30, pages: 3 });
    // the newest row (inside the rows read) is found; the oldest (not read in time) is not
    expect(result.hits.map((hit) => hit.snippet)).toEqual(["the newest row says quokka"]);
  });
});

describe("what the keyword side scores of a row (K1)", () => {
  it("is the text while it has not expired, and the structured fields always; expired text is never scored", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE, retention: "C" });
    await w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: "exp", version: "1" }, audience: PROJECT_AUDIENCE, scope: GITHUB_SCOPE, retention: "C", text: "the quokka rollout postmortem", structured: { title: "Narwhal review" }, links: [] }));
    const item = rows(w, "TEAM_RECORD_EVENT")[0]!;
    const now = Math.floor(w.clock.ms / 1000);
    const live = eventFromItem(item, now)!;
    expect(live.textExpiresAt).toBeGreaterThan(now);
    expect(keywordDocumentOf(live, now)).toContain("quokka");
    expect(keywordDocumentOf(live, now)).toContain("Narwhal");
    // the same row after its text expired: a reader that did NOT strip it (the row as stored) still does not score it
    const expired = { ...live, textExpiresAt: now - 1 };
    expect(keywordDocumentOf(expired, now)).not.toContain("quokka");
    expect(keywordDocumentOf(expired, now)).toContain("Narwhal");
    expect(keywordDocumentOf({ ...live, text: undefined }, now)).not.toContain("quokka");
  });

  it("through the search: a word only the expired text held finds nothing, a word of the structured fields still finds the row", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE, retention: "C" });
    await w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: "exp", version: "1" }, audience: PROJECT_AUDIENCE, scope: GITHUB_SCOPE, retention: "C", text: "the quokka rollout postmortem", structured: { title: "Narwhal review" }, links: [] }));
    const search = (query: string) => recordSearch(depsOf(w, w.table), person(), "web", { query });
    expect((await search("quokka")).hits).toHaveLength(1);
    expect((await search("narwhal")).hits).toHaveLength(1);
    w.clock.ms += 31 * 86_400_000;   // past the 30 days raw text lives under C, and the nightly job has not run
    expect((await search("quokka")).hits).toEqual([]);
    expect((await search("narwhal")).hits).toHaveLength(1);
  });
});
