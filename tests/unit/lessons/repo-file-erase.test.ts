// Lessons in the repo, lane R2, review round 4: the ERASURE SWEEP is independent of the publish state. It reads the default branch's file, the lesson store's tombstones, its own pull request rows and the code host, and nothing else.
// The invariant at the bottom enumerates every way the publish state can fail and asserts the sweep still takes a gone block out in the same pass, for that repository and for another one in the same project.
import { afterEach, describe, expect, it } from "vitest";
import type { CodeHost } from "@agentx/contracts";
import { dynamoRepoFileStore } from "../../../packages/broker/src/lessons/dynamo-repo-file.js";
import { applyFileChanges, parseLessonsFile, renderLessonsFile } from "../../../packages/broker/src/lessons/repo-file-format.js";
import { closeProjectRovaraPrs, closeOpenPullRequestFor } from "../../../packages/broker/src/lessons/repo-file-routes.js";
import { lessonsRepoFileJob, type RepoFileRuntime } from "../../../packages/broker/src/lessons/repo-file-job.js";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { MAX_THEIRS, InMemoryRepoFileStore, StateFull, newRepoFileState, type RepoFileState, type RepoFileStore } from "../../../packages/broker/src/lessons/repo-file-state.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { FILE, FakeRepoHost, OTHER_PLACE, PLACE, passSetup, repoLesson } from "./repo-file-helpers.js";

afterEach(() => { setLearnedLessonsGate(undefined); });
const idsIn = (text: string | undefined): string[] => (text === undefined ? [] : parseLessonsFile(text).blocks.map((b) => b.id));
const GONE = "les_gone0001";
const KEEP = "les_keep0001";
const file = (...ids: string[]): string => renderLessonsFile(ids.map((id) => ({ id, heading: "Whole repository", text: `Text of ${id}: use the helper.` })));

/** A removal-only pull request is open when some open PR's file lacks the gone block but keeps the other one. */
const removalOpen = (host: FakeRepoHost): boolean => host.open.some((pr) => { const ids = idsIn(host.file(pr.source, FILE)); return !ids.includes(GONE) && ids.includes(KEEP); });

/** Two repositories of one project, each with the lessons file on main holding a block of a lesson that is now gone, and a watch row (Rovara has written to both). */
async function twoRepos(mode?: (w: ReturnType<typeof passSetup>) => RepoFileStore) {
  const w = passSetup();
  const second = new FakeRepoHost();
  for (const host of [w.host, second]) host.setFile("main", FILE, file(KEEP, GONE));
  const targetB = { ...w.target, name: "web", place: OTHER_PLACE, host: second as unknown as CodeHost };
  await w.seedLessons(repoLesson(KEEP), repoLesson(GONE));
  await w.store.purge(w.key, GONE);
  const rows = new InMemoryRepoFileStore();
  for (const place of [PLACE, OTHER_PLACE]) await rows.putPr(w.key, { place, kind: "watch", number: "0", ids: [], at: 1 });
  const state = mode?.(w) ?? new InMemoryRepoFileStore();
  const runtime: RepoFileRuntime = { deps: { ...w.deps, state, rows }, targets: async () => [w.target, targetB], newHolder: () => "n" };
  return { w, second, runtime, rows };
}

describe("the sweep opens a removal-only PR for a gone block, on its own branch, and only that", () => {
  it("removes exactly the gone blocks, from the head the file was read at, on a new random branch without force, and keeps its own row; a second sweep opens nothing more", async () => {
    const { w, runtime, rows } = await twoRepos();
    const head = w.host.heads.get("main")!;
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    const pr = w.host.open.at(-1)!;
    expect(idsIn(w.host.file(pr.source, FILE))).toEqual([KEEP]);
    expect(w.host.file(pr.source, FILE)).toBe(applyFileChanges(file(KEEP, GONE), { remove: [GONE], replace: [], add: [] }));
    expect(w.host.writes.find((write) => write.op === "commit")).toMatchObject({ force: false, parent: head, branch: pr.source });
    expect(pr.source).toMatch(/^rovara\/lessons-[0-9a-f]{12}$/u);
    expect((await rows.listPrs(w.key)).rows.filter((row) => row.kind === "removal" && row.place === PLACE)).toEqual([expect.objectContaining({ number: String(pr.number), ids: [GONE] })]);
    expect(w.audit.actions()).toContain("lesson.repo_file_pr_opened");
    const before = w.host.prs.length;
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    expect(w.host.prs).toHaveLength(before);
  });

  it("never adopts a branch that exists and never touches a person's PR; a ledger that is down writes nothing", async () => {
    const { w, runtime } = await twoRepos();
    w.host.setFile("rovara/lessons-000000000001", "notes.txt", "the team's");
    w.host.prs.push({ number: 99, source: "feature/x", target: "main", baseRevision: w.host.heads.get("main")!, title: "x", body: "", state: "open" });
    w.failAudit.on = true;
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    expect(w.host.writes).toEqual([]);
    w.failAudit.on = false;
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    expect(w.host.file("rovara/lessons-000000000001", "notes.txt")).toBe("the team's");
    expect(w.host.prs.find((pr) => pr.number === 99)!.state).toBe("open");
    expect(w.host.writes.map((write) => write.branch)).not.toContain("rovara/lessons-000000000001");
  });

  it("does nothing, and makes no host call, for a repository Rovara has never written to", async () => {
    const { w, runtime, rows } = await twoRepos();
    for (const row of (await rows.listPrs(w.key)).rows) await rows.delPr(w.key, row.place, row.number);
    w.host.calls.length = 0;
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    expect(w.host.calls).toEqual([]);
  });
});

describe("a reopened PR is found again; archive closes Rovara's PRs", () => {
  it("a PR the sweep closed, reopened by a person, is closed again (its row is kept)", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    await w.store.purge(w.key, "les_aaaa0001");
    await w.sweep();
    const pr = w.host.prs.find((p) => p.source === open.branch)!;
    expect(pr.state).toBe("closed");
    pr.state = "open";
    await w.sweep();
    expect(pr.state).toBe("closed");
  });

  it("archiving a project closes every open Rovara PR of its repositories, from the rows", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    const runtime: RepoFileRuntime = { deps: w.deps, targets: async () => [w.target], newHolder: () => "a" };
    expect(await closeProjectRovaraPrs(runtime, w.key)).toBe(1);
    expect(w.host.prs.find((p) => p.source === open.branch)!.state).toBe("closed");
  });
});

describe("bookkeeping overflow never blocks a removal (N7)", () => {
  it("theirs at the cap, all closed by the team, then a hand-over and an erasure of a merged lesson: the removal still goes out and no pass dies", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
    await w.enable();
    const r = await w.run();
    w.host.merge(Number((r as { number: string }).number));
    await w.seedLessons(repoLesson("les_aaaa0003"));
    w.week();
    await w.run();
    const open = (await w.current()).open!;
    const s = await w.current();
    const closed = Array.from({ length: MAX_THEIRS }, (_, i) => {
      const branch = `rovara/lessons-${(0xabc000 + i).toString(16).padStart(12, "0")}`;
      w.host.setFile(branch, "x.txt", "person");
      const number = w.host.prs.length + 1;
      w.host.prs.push({ number, source: branch, target: "main", baseRevision: w.host.heads.get("main")!, title: "t", body: "", state: "closed" });
      return { branch, number: String(number), url: "", ids: [] as string[] };
    });
    await w.state.put(w.key, { ...s, theirs: closed }, s.revision);
    w.host.setFile(open.branch, "person.txt", "a person's commit");
    await w.store.purge(w.key, "les_aaaa0001");
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", removals: 1 });
    expect((await w.current()).problem).toBeUndefined();
  });

  it("20 team PRs still open and one more handed over: no track is lost silently, the row says so, additions wait and the removal goes out", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
    await w.enable();
    const r = await w.run();
    w.host.merge(Number((r as { number: string }).number));
    await w.seedLessons(repoLesson("les_aaaa0003"));
    w.week();
    await w.run();
    const open = (await w.current()).open!;
    const s = await w.current();
    const opened = Array.from({ length: MAX_THEIRS }, (_, i) => {
      const branch = `rovara/lessons-${(0xabc000 + i).toString(16).padStart(12, "0")}`;
      w.host.setFile(branch, "x.txt", "person");
      const number = w.host.prs.length + 1;
      w.host.prs.push({ number, source: branch, target: "main", baseRevision: w.host.heads.get("main")!, title: "t", body: "", state: "open" });
      return { branch, number: String(number), url: "", ids: [] as string[] };
    });
    await w.state.put(w.key, { ...s, theirs: opened }, s.revision);
    w.host.setFile(open.branch, "person.txt", "a person's commit");
    await w.store.purge(w.key, "les_aaaa0001");
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", removals: 1, adds: 0 });
    expect((await w.current()).problem).toBe("state_unreadable");
  });
});

describe("one unreadable state item does not hide the others (N8)", () => {
  it("the Dynamo list skips an item that does not parse; get still throws for it; a bad PR row does not hide the good ones", async () => {
    const table = new FakeDynamoDb({ indexKeys: {} });
    const seen: string[] = [];
    const store = dynamoRepoFileStore({ documentClient: table, tableName: "t" }, { onUnreadable: (what) => seen.push(what) });
    const w = passSetup();
    await store.put(w.key, { ...newRepoFileState(PLACE, "api"), enabled: true }, 0);
    await store.put(w.key, { ...newRepoFileState(OTHER_PLACE, "web"), enabled: true }, 0);
    await store.putPr(w.key, { place: PLACE, kind: "watch", number: "0", ids: [], at: 1 });
    await store.putPr(w.key, { place: OTHER_PLACE, kind: "watch", number: "0", ids: [], at: 1 });
    for (const item of table.items?.values() ?? []) {
      const record = item as { state?: { place?: string }; row?: { place?: string } };
      if (record.state?.place === OTHER_PLACE) record.state = { place: OTHER_PLACE, future: true } as never;
      if (record.row?.place === OTHER_PLACE) record.row = { place: OTHER_PLACE, future: true } as never;
    }
    expect((await store.list(w.key)).map((state) => state.place)).toEqual([PLACE]);
    const rows = await store.listPrs(w.key);
    expect(rows.rows.map((row) => row.place)).toEqual([PLACE]);
    expect(rows.unreadable).toBe(1);
    expect(seen.sort()).toEqual(["row", "state"]);
    await expect(store.get(w.key, OTHER_PLACE)).rejects.toThrow();
  });
});

describe("goneOf, the tombstone lookup: a case for both stores, in chunks, with an unknown id", () => {
  it("answers withdrawn and purged, nothing for an unknown id, for more than 100 ids", async () => {
    const w = passSetup();
    const ids = Array.from({ length: 250 }, (_, i) => `les_t${String(i).padStart(7, "0")}`);
    await w.store.markGone(w.key, ids[3]!, "withdrawn");
    await w.store.markGone(w.key, ids[199]!, "purged");
    await w.store.markGone(w.key, ids[249]!, "purged");
    const found = await w.store.goneOf(w.key, [...ids, "les_unknown1"]);
    expect([...found.entries()].sort()).toEqual([[ids[3], "withdrawn"], [ids[199], "purged"], [ids[249], "purged"]]);
    expect((await w.store.goneOf({ ...w.key, project: "other" }, ids)).size).toBe(0);
  });
});

/**
 * THE INVARIANT. Every way the publish state can fail, and each time the erasure sweep, run exactly as the nightly job runs it, takes the gone block out of the repository that has the failing state AND out of another repository of
 * the same project, in the same pass. The failing store is handed to the publish pass only; the sweep gets its own rows.
 */
describe("the sweep does not depend on the publish state, whatever its failure", () => {
  const throwing = (): RepoFileStore => ({
    list: async () => { throw new Error("state down"); }, get: async () => { throw new Error("state down"); }, put: async () => { throw new StateFull(); },
    listPrs: async () => { throw new Error("state down"); }, putPr: async () => { throw new Error("state down"); }, delPr: async () => { throw new Error("state down"); },
  });
  const full = (): RepoFileStore => {
    const inner = new InMemoryRepoFileStore();
    const fullState = (place: string): RepoFileState => ({ ...newRepoFileState(place, "x"), enabled: true, theirs: Array.from({ length: MAX_THEIRS }, (_, i) => ({ branch: `rovara/lessons-${i.toString(16).padStart(12, "0")}`, number: String(i + 1), url: "", ids: [] })) });
    return { ...inner, list: async () => [fullState(PLACE), fullState(OTHER_PLACE)], get: async (_k, place) => fullState(place), put: async () => { throw new StateFull(); }, listPrs: inner.listPrs.bind(inner), putPr: inner.putPr.bind(inner), delPr: inner.delPr.bind(inner) };
  };
  const unparseable = (): RepoFileStore => {
    const table = new FakeDynamoDb({ indexKeys: {} });
    const store = dynamoRepoFileStore({ documentClient: table, tableName: "t" });
    void store.put({ workspaceId: "org_aaaaaaaaaaaaaaaaaaaa", project: "proj-1" }, newRepoFileState(PLACE, "api"), 0).then(() => { for (const item of table.items?.values() ?? []) (item as { state: unknown }).state = { nonsense: true }; });
    return { ...store, list: async () => { throw new Error("state unparseable"); }, get: async () => { throw new Error("state unparseable"); } };
  };
  const leased = (): RepoFileStore => {
    const inner = new InMemoryRepoFileStore();
    return { ...inner, list: async () => [{ ...newRepoFileState(PLACE, "api"), enabled: true, lease: { holder: "someone", until: 9e15 } }], get: async () => ({ ...newRepoFileState(PLACE, "api"), enabled: true, lease: { holder: "someone", until: 9e15 } }), put: async () => undefined, listPrs: inner.listPrs.bind(inner), putPr: inner.putPr.bind(inner), delPr: inner.delPr.bind(inner) };
  };
  const modes: Array<[string, () => RepoFileStore]> = [
    ["missing (no state at all)", () => new InMemoryRepoFileStore()],
    ["every call throws, put raises StateFull", throwing],
    ["theirs full (and every put refused)", full],
    ["unparseable item (list and get throw)", unparseable],
    ["lease held by another pass (puts lose)", leased],
  ];

  it.each(modes)("%s: the nightly job's sweep and the erasure hook still remove the gone block in both repositories", async (_name, make) => {
    for (const via of ["job", "hook"] as const) {
      const { w, second, runtime } = await twoRepos(make);
      if (via === "job") await lessonsRepoFileJob(runtime, w.key.workspaceId, [w.key.project], 3_600_000, 0);
      else await closeOpenPullRequestFor(runtime, w.key, GONE);
      expect({ via, repoA: removalOpen(w.host), repoB: removalOpen(second) }).toEqual({ via, repoA: true, repoB: true });
    }
  });

  it("one repository's host failing does not stop the other", async () => {
    const { w, second, runtime } = await twoRepos();
    w.host.failCalls.add("baseBranchHead");
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    expect({ a: removalOpen(w.host), b: removalOpen(second) }).toEqual({ a: false, b: true });
  });

  it("the sweep's dependencies hold no publish state at all", async () => {
    const { sweepDepsOf } = await import("../../../packages/broker/src/lessons/repo-file-erase.js");
    const { w } = await twoRepos();
    const deps = sweepDepsOf({ ...w.deps, state: new InMemoryRepoFileStore() });
    expect(Object.keys(deps).sort()).toEqual(["audit", "log", "now", "randomHex", "rows", "store"]);
    expect("state" in deps).toBe(false);
    expect("settings" in deps).toBe(false);
  });
});
