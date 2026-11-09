// Lessons in the repo, lane R2, review round 4: the ERASURE SWEEP is independent of the publish state. It reads the default branch's file, the lesson store's tombstones, its own pull request rows and the code host, and nothing else.
// The invariant at the bottom enumerates every way the publish state can fail and asserts the sweep still takes a gone block out in the same pass, for that repository and for another one in the same project.
import { afterEach, describe, expect, it } from "vitest";
import type { CodeHost } from "@agentx/contracts";
import { dynamoRepoFileStore } from "../../../packages/broker/src/lessons/dynamo-repo-file.js";
import { applyFileChanges, parseLessonsFile, renderLessonsFile } from "../../../packages/broker/src/lessons/repo-file-format.js";
import { closeProjectRovaraPrs, closeOpenPullRequestFor, repoFileAction, repoFileStatus, repositoriesChanged } from "../../../packages/broker/src/lessons/repo-file-routes.js";
import { lessonsRepoFileJob, type RepoFileRuntime } from "../../../packages/broker/src/lessons/repo-file-job.js";
import { watchRowOf } from "../../../packages/broker/src/lessons/repo-file-host.js";
import { UNREACHABLE_RETRY_MS } from "../../../packages/broker/src/lessons/repo-file-sweep.js";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { MAX_THEIRS, InMemoryRepoFileStore, StateFull, newRepoFileState, type RepoFileState, type RepoFileStore } from "../../../packages/broker/src/lessons/repo-file-state.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { DAY, FILE, FakeRepoHost, OTHER_PLACE, PLACE, passSetup, repoLesson } from "./repo-file-helpers.js";

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
  second.repoId = "2002";
  for (const host of [w.host, second]) host.setFile("main", FILE, file(KEEP, GONE));
  const targetB = { ...w.target, name: "web", place: OTHER_PLACE, host: second as unknown as CodeHost };
  await w.seedLessons(repoLesson(KEEP), repoLesson(GONE));
  await w.store.purge(w.key, GONE);
  const rows = new InMemoryRepoFileStore();
  for (const each of [w.target, targetB]) await rows.putPr(w.key, watchRowOf(each, 1));
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
    listPrs: async () => { throw new Error("state down"); }, putPr: async () => { throw new Error("state down"); }, delPr: async () => { throw new Error("state down"); }, claimPr: async () => { throw new Error("state down"); },
  });
  const full = (): RepoFileStore => {
    const inner = new InMemoryRepoFileStore();
    const fullState = (place: string): RepoFileState => ({ ...newRepoFileState(place, "x"), enabled: true, theirs: Array.from({ length: MAX_THEIRS }, (_, i) => ({ branch: `rovara/lessons-${i.toString(16).padStart(12, "0")}`, number: String(i + 1), url: "", ids: [] })) });
    return { ...inner, list: async () => [fullState(PLACE), fullState(OTHER_PLACE)], get: async (_k, place) => fullState(place), put: async () => { throw new StateFull(); }, claimPr: inner.claimPr.bind(inner), listPrs: inner.listPrs.bind(inner), putPr: inner.putPr.bind(inner), delPr: inner.delPr.bind(inner) };
  };
  const unparseable = (): RepoFileStore => {
    const table = new FakeDynamoDb({ indexKeys: {} });
    const store = dynamoRepoFileStore({ documentClient: table, tableName: "t" });
    void store.put({ workspaceId: "org_aaaaaaaaaaaaaaaaaaaa", project: "proj-1" }, newRepoFileState(PLACE, "api"), 0).then(() => { for (const item of table.items?.values() ?? []) (item as { state: unknown }).state = { nonsense: true }; });
    return { ...store, list: async () => { throw new Error("state unparseable"); }, get: async () => { throw new Error("state unparseable"); } };
  };
  const leased = (): RepoFileStore => {
    const inner = new InMemoryRepoFileStore();
    return { ...inner, claimPr: inner.claimPr.bind(inner), list: async () => [{ ...newRepoFileState(PLACE, "api"), enabled: true, lease: { holder: "someone", until: 9e15 } }], get: async () => ({ ...newRepoFileState(PLACE, "api"), enabled: true, lease: { holder: "someone", until: 9e15 } }), put: async () => undefined, listPrs: inner.listPrs.bind(inner), putPr: inner.putPr.bind(inner), delPr: inner.delPr.bind(inner) };
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

// ---- round 5: write ahead ----

const KILL_L1 = "les_aaaa0001";
const KILL_L2 = "les_aaaa0002";

/**
 * Kills "the Lambda" between every pair of steps of opening a pull request: after the Nth write event (a row write or delete, a state write, the commit, the pull request) every later one throws. Returns the wired setup and a way
 * to bring it back to life.
 */
function dying(deadAfter: number) {
  const w = passSetup();
  let events = 0;
  const alive = { on: true };
  const guard = (): void => { if (alive.on) return; events += 1; if (events > deadAfter) throw new Error("the Lambda died"); };
  const rows = new InMemoryRepoFileStore();
  const rawPut = rows.putPr.bind(rows), rawDel = rows.delPr.bind(rows);
  rows.putPr = async (k, r) => { guard(); return rawPut(k, r); };
  rows.delPr = async (k, p, n) => { guard(); return rawDel(k, p, n); };
  const rawStatePut = w.state.put.bind(w.state);
  w.state.put = async (k, st, e) => { guard(); return rawStatePut(k, st, e); };
  const rawCommit = w.host.commitFiles.bind(w.host), rawReconcile = w.host.reconcileChangeRequest.bind(w.host);
  w.host.commitFiles = async (input) => { guard(); const out = await rawCommit(input); guard(); return out; };
  w.host.reconcileChangeRequest = async (input) => { guard(); const out = await rawReconcile(input); guard(); return out; };
  w.deps.rows = rows;
  return { w, rows, arm: () => { alive.on = false; }, revive: () => { alive.on = true; }, events: () => events };
}

describe("N9: the Lambda dies between any two steps of opening a pull request; the next sweep still takes the erased text out", () => {
  const runtimeFor = (w: ReturnType<typeof passSetup>): RepoFileRuntime => ({ deps: w.deps, targets: async () => [w.target], newHolder: () => "n" });
  it.each(Array.from({ length: 14 }, (_, i) => [i]))("dies after event %i: a person pushes to whatever branch exists, the lesson is erased, and no open PR carries it", async (deadAfter) => {
    const { w, arm, revive } = dying(deadAfter);
    await w.seedLessons(repoLesson(KILL_L1));
    await w.enable();
    arm();
    await w.run();
    revive();
    for (const pr of w.host.prs) w.host.setFile(pr.source, "person.txt", "a person's commit");
    for (const branch of w.host.branchNames) w.host.setFile(branch, "person.txt", "a person's commit");
    await w.store.purge(w.key, KILL_L1);
    const runtime = runtimeFor(w);
    await closeOpenPullRequestFor(runtime, w.key, KILL_L1);
    w.clock.advance(DAY);
    await lessonsRepoFileJob(runtime, w.key.workspaceId, [w.key.project], 3_600_000, 0);
    expect(w.host.open.filter((pr) => idsIn(w.host.file(pr.source, FILE)).includes(KILL_L1))).toEqual([]);
  });

  it.each(Array.from({ length: 14 }, (_, i) => [i]))("dies after event %i and the publish state is lost with it: the rows alone are enough to find the pull request or branch and take the erased text out", async (deadAfter) => {
    const { w, arm, revive } = dying(deadAfter);
    await w.seedLessons(repoLesson(KILL_L1));
    await w.enable();
    arm();
    await w.run();
    revive();
    await w.store.purge(w.key, KILL_L1);
    const runtime: RepoFileRuntime = { ...runtimeFor(w), deps: { ...w.deps, state: new InMemoryRepoFileStore() } };
    await closeOpenPullRequestFor(runtime, w.key, KILL_L1);
    w.clock.advance(3_600_000);
    await lessonsRepoFileJob(runtime, w.key.workspaceId, [w.key.project], 3_600_000, 0);
    const carrying = w.host.open.filter((pr) => idsIn(w.host.file(pr.source, FILE)).includes(KILL_L1));
    expect(carrying).toEqual([]);
    // No person pushed to them, so they are Rovara's alone: a branch that still carries the text (the Lambda died between the commit and the row that records the head, so the head cannot be proven) keeps its row, and a pull request
    // a person opens from it afterwards is closed by the next sweep.
    const left = w.host.branchNames.filter((b) => b !== "main" && idsIn(w.host.file(b, FILE)).includes(KILL_L1));
    const rowBranches = (await w.deps.rows!.listPrs(w.key)).rows.map((row) => row.branch);
    for (const branch of left) {
      expect(rowBranches).toContain(branch);
      await w.host.reconcileChangeRequest({ repository: w.target.repository, sourceBranch: branch, targetBranch: "main", title: "t", body: "b" });
    }
    await closeOpenPullRequestFor(runtime, w.key, KILL_L1);
    expect(w.host.open.filter((pr) => idsIn(w.host.file(pr.source, FILE)).includes(KILL_L1))).toEqual([]);
  });

  it.each(Array.from({ length: 14 }, (_, i) => [i]))("dies after event %i: the team merges what exists, the repository is switched off, the lesson is erased: the block is proposed for removal", async (deadAfter) => {
    const { w, arm, revive } = dying(deadAfter);
    await w.seedLessons(repoLesson(KILL_L1), repoLesson(KILL_L2));
    await w.enable();
    arm();
    await w.run();
    revive();
    const pr = w.host.prs[0];
    if (pr === undefined) return; // nothing was written to the host: nothing to take out
    w.host.merge(pr.number);
    const state = await w.current();
    await w.state.put(w.key, { ...state, enabled: false }, state.revision);
    await w.store.purge(w.key, KILL_L1);
    const runtime = runtimeFor(w);
    await closeOpenPullRequestFor(runtime, w.key, KILL_L1);
    w.clock.advance(DAY);
    await lessonsRepoFileJob(runtime, w.key.workspaceId, [w.key.project], 3_600_000, 0);
    const mainHas = idsIn(w.host.file("main", FILE)).includes(KILL_L1);
    const removal = w.host.open.some((p) => { const ids = idsIn(w.host.file(p.source, FILE)); return !ids.includes(KILL_L1) && ids.includes(KILL_L2); });
    expect({ mainHas, removal }).toSatisfy((r: { mainHas: boolean; removal: boolean }) => !r.mainHas || r.removal);
  });

  it("a row write that fails means no host write at all", async () => {
    const w = passSetup();
    const rows = new InMemoryRepoFileStore();
    rows.failPrWrites = true;
    w.deps.rows = rows;
    await w.seedLessons(repoLesson(KILL_L1));
    await w.enable();
    expect(await w.run()).toEqual({ status: "problem", problem: "state_unreadable" });
    expect(w.host.writes).toEqual([]);
    expect(w.host.prs).toEqual([]);
    expect(w.host.branchNames).toEqual([]);
  });

  it("the erasure sweep makes no removal PR twice when the numbered row could not be written (the branch-keyed row covers it)", async () => {
    const { w, second, runtime, rows } = await twoRepos();
    const rawPut = rows.putPr.bind(rows);
    let numbered = 0;
    rows.putPr = async (k, r) => { if (r.kind === "removal" && !r.number.startsWith("~")) { numbered += 1; throw new Error("blip"); } return rawPut(k, r); };
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    expect(numbered).toBeGreaterThan(0);
    expect(w.host.prs.filter((pr) => pr.state === "open")).toHaveLength(1);
    expect(second.prs.filter((pr) => pr.state === "open")).toHaveLength(1);
    // Once the branch's pull request is found by branch, the row gets its number.
    rows.putPr = rawPut;
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    const removalRows = (await rows.listPrs(w.key)).rows.filter((row) => row.kind === "removal" && row.place === PLACE);
    expect(removalRows.every((row) => !row.number.startsWith("~"))).toBe(true);
  });

  it("switching the feature on writes a watch row for EVERY repository of the project first; if that fails nothing changes", async () => {
    const { w, runtime, rows } = await twoRepos();
    for (const row of (await rows.listPrs(w.key)).rows) await rows.delPr(w.key, row.place, row.number);
    rows.failPrWrites = true;
    expect(await repoFileAction(runtime, w.key, { action: "on", repo: "api" })).toEqual({ ok: false, code: "unreadable" });
    expect(await w.state.get(w.key, PLACE)).toBeUndefined();
    rows.failPrWrites = false;
    expect(await repoFileAction(runtime, w.key, { action: "on", repo: "api" })).toMatchObject({ ok: true });
    expect((await rows.listPrs(w.key)).rows.map((row) => row.place).sort()).toEqual([OTHER_PLACE, PLACE].sort());
  });
});

describe("round 5 lows", () => {
  it("U2: a removal PR made stale by the publish PR's merge is closed", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("U2a0000001"), repoLesson("U2b0000002"));
    await w.enable();
    const r = await w.run();
    w.host.merge(Number((r as { number: string }).number));
    await w.store.purge(w.key, "U2a0000001");
    await w.sweep();
    const removal = w.host.open.at(-1)!;
    w.week();
    const p = await w.run();
    expect(p.status).toBe("opened");
    w.host.merge(Number((p as { number: string }).number));
    expect(idsIn(w.host.file("main", FILE))).not.toContain("U2a0000001");
    await w.sweep();
    expect(w.host.prs.find((x) => x.number === removal.number)!.state).not.toBe("open");
  });

  it("a removal PR that no longer matches main's file (the team edited it meanwhile) is closed and made again", async () => {
    const { w, runtime } = await twoRepos();
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    const first = w.host.open.at(-1)!;
    w.host.setFile("main", FILE, `${w.host.file("main", FILE)!}\n- A line the team added.\n`);
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    expect(w.host.prs.find((p) => p.number === first.number)!.state).toBe("closed");
    const second = w.host.open.at(-1)!;
    expect(second.number).not.toBe(first.number);
    expect(w.host.file(second.source, FILE)).toContain("A line the team added.");
  });

  it("U3: a PR closed by the sweep and reopened after 91 days is closed again (a row that carried a gone lesson is kept for good)", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("U3a0000001"));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    await w.store.purge(w.key, "U3a0000001");
    await w.sweep();
    const pr = w.host.prs.find((p) => p.source === open.branch)!;
    w.clock.advance(400 * DAY);
    await w.sweep();
    pr.state = "open";
    await w.sweep();
    expect(pr.state).toBe("closed");
  });

  it("a removal PR is shown on the repository's status row", async () => {
    const { w, runtime } = await twoRepos();
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    await runtime.deps.state.put(w.key, { ...newRepoFileState(PLACE, "api"), enabled: true }, 0);
    const status = await repoFileStatus(runtime, w.key);
    expect(status.repos[0]).toMatchObject({ erasurePrs: 1 });
    expect(status.repos[0]!.notices.join(" ")).toContain("remove");
  });

  it("an add whose lesson is mid-purge (tombstone written, head not yet removed) is not proposed", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("mid0000001"), repoLesson("mid0000002"));
    await w.enable();
    await w.store.markGone(w.key, "mid0000001", "purged");
    expect(await w.run()).toMatchObject({ status: "opened", adds: 1 });
    expect(Object.keys((await w.current()).open!.added)).toEqual(["mid0000002"]);
  });

  it("the erasure sweep has a slice of the nightly budget of its own and runs first", async () => {
    const { lessonsNightlyJob } = await import("../../../packages/broker/src/lessons/jobs.js");
    const { w, second, runtime } = await twoRepos();
    const order: string[] = [];
    const rawList = runtime.deps.state.list.bind(runtime.deps.state);
    runtime.deps.state.list = async (k) => { order.push("publish"); return rawList(k); };
    const rawCommitFiles = w.host.commitFiles.bind(w.host);
    w.host.commitFiles = async (input) => { order.push("sweep-write"); return rawCommitFiles(input); };
    const deps = { table: {} as never, settings: runtime.deps.settings, now: () => Date.now(), newRequestId: () => "x", log: () => undefined, resume: async () => ({ finished: 0, failed: 0 }), repoFile: runtime } as never;
    await lessonsNightlyJob(deps, w.key.workspaceId, [w.key.project], 3_600_000);
    expect(order[0]).toBe("sweep-write");
    expect(removalOpen(w.host) && removalOpen(second)).toBe(true);
  });
});

// ---- round 6 (N10): the sweep visits the WATCH ROWS, not the project's current repository list ----

const X = "les_rc6x0001";
const Y = "les_rc6y0001";
const carrying = (host: FakeRepoHost, id: string) => host.open.filter((pr) => idsIn(host.file(pr.source, FILE)).includes(id));

/** One repository, a runtime whose project list can change under it, and a `reach` that rebuilds a repository from its watch row (the installation can be made to refuse). */
function wired() {
  const w = passSetup();
  const rows = new InMemoryRepoFileStore();
  w.deps.rows = rows;
  const project = { list: [w.target] };
  const reached: Array<{ place: string; url: string; name: string }> = [];
  const runtime: RepoFileRuntime = {
    deps: w.deps, targets: async () => project.list, newHolder: () => "n",
    reach: async (_ws, _project, former) => { reached.push(former); return former.place === w.target.place ? w.target : undefined; },
  };
  return { w, rows, runtime, project, reached };
}
const nightly = (runtime: RepoFileRuntime, w: ReturnType<typeof passSetup>) => lessonsRepoFileJob(runtime, w.key.workspaceId, [w.key.project], 3_600_000, 0);

describe("N10: a repository that left the project, moved host or got a new id is still swept through its watch row", () => {
  it("a watch row remembers who the repository is: its address, the project's name for it, and the host kind in its place", async () => {
    const { w, rows } = wired();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    const watch = (await rows.listPrs(w.key)).rows.find((row) => row.kind === "watch");
    expect(watch).toMatchObject({ place: PLACE, repoUrl: w.target.repository.url, repoName: w.target.name });
    expect(PLACE.startsWith("github:")).toBe(true);
  });

  it("V1: removed from the project while a Rovara PR adding X is open; X erased: the PR is closed (hook and nightly)", async () => {
    const { w, runtime, project, reached } = wired();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    project.list = [];
    await w.store.purge(w.key, X);
    await closeOpenPullRequestFor(runtime, w.key, X);
    expect(carrying(w.host, X)).toEqual([]);
    expect(reached.length).toBeGreaterThan(0);
  });

  it("V1b: the same with the hook lost: the nightly sweep closes it", async () => {
    const { w, runtime, project } = wired();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    project.list = [];
    await w.store.purge(w.key, X);
    w.clock.advance(DAY);
    await nightly(runtime, w);
    expect(carrying(w.host, X)).toEqual([]);
  });

  it("V2: removed from the project after X merged on main; X erased: a removal PR is opened", async () => {
    const { w, runtime, project } = wired();
    await w.seedLessons(repoLesson(X), repoLesson(Y));
    await w.enable();
    const r = await w.run();
    w.host.merge(Number((r as { number: string }).number));
    project.list = [];
    await w.store.purge(w.key, X);
    await closeOpenPullRequestFor(runtime, w.key, X);
    expect(w.host.open.some((p) => { const ids = idsIn(w.host.file(p.source, FILE)); return !ids.includes(X) && ids.includes(Y); })).toBe(true);
  });

  it("the list of the project can not be read at all: the watch rows still carry the sweep", async () => {
    const { w, runtime } = wired();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    runtime.targets = async () => { throw new Error("project unreadable"); };
    await w.store.purge(w.key, X);
    await closeOpenPullRequestFor(runtime, w.key, X);
    expect(carrying(w.host, X)).toEqual([]);
  });

  it("taking a repository out of the project closes its open Rovara PRs right away, with nothing erased", async () => {
    const { w, runtime, project } = wired();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    expect(w.host.open).toHaveLength(1);
    project.list = [];
    await repositoriesChanged(runtime, w.key);
    expect(w.host.open).toHaveLength(0);
  });

  it("a repository that is still in the project keeps its open PR when nothing is erased", async () => {
    const { w, runtime } = wired();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    await repositoriesChanged(runtime, w.key);
    await nightly(runtime, w);
    expect(w.host.open).toHaveLength(1);
  });

  it("archive closes the open PRs of a repository that already left", async () => {
    const { w, runtime, project } = wired();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    project.list = [];
    expect(await closeProjectRovaraPrs(runtime, w.key)).toBe(1);
    expect(w.host.open).toHaveLength(0);
  });

  it("a pull request with that number that Rovara did not make from the row's branch is never touched (the address is another repository now)", async () => {
    const { w, runtime, project } = wired();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    const pr = w.host.prs.find((p) => p.source === open.branch)!;
    pr.source = "feature/theirs";
    project.list = [];
    await w.store.purge(w.key, X);
    await closeOpenPullRequestFor(runtime, w.key, X);
    expect(pr.state).toBe("open");
    expect(w.host.writes.filter((write) => write.op === "update")).toEqual([]);
  });

  it("a repository Rovara cannot reach is recorded ONCE with how many deleted lessons wait, shown on the status, tried weekly by the nightly job (the hook tries every time), and never stops another repository", async () => {
    const { w, second, runtime, rows } = await twoRepos();
    w.host.failCalls.add("repositoryIdentity");
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    const watch = () => rows.listPrs(w.key).then((l) => l.rows.find((row) => row.kind === "watch" && row.place === PLACE)!);
    const first = await watch();
    expect(first.unreachableAt).toBeDefined();
    expect(removalOpen(second)).toBe(true); // the other repository was swept regardless
    // Recorded once: another failure writes nothing new on the row's "since".
    const since = first.unreachableAt;
    w.clock.advance(60_000);
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    expect((await watch()).unreachableAt).toBe(since);
    // Nightly: skipped inside the week, tried after it.
    w.host.calls.length = 0;
    w.clock.advance(DAY);
    await nightly(runtime, w);
    expect(w.host.calls).toEqual([]);
    w.clock.advance(UNREACHABLE_RETRY_MS);
    await nightly(runtime, w);
    expect(w.host.calls).toContain("repositoryIdentity");
    const state = await w.deps.state.put(w.key, { ...newRepoFileState(PLACE, "api"), enabled: true }, 0);
    expect(state).toBeDefined();
    const status = await repoFileStatus(runtime, w.key);
    expect(status.unreachable).toEqual([{ repo: "api", lessons: 0 }]);
    // It comes back: the record is cleared.
    w.host.failCalls.delete("repositoryIdentity");
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    expect((await watch()).unreachableAt).toBeUndefined();
    expect((await repoFileStatus(runtime, w.key)).unreachable).toBeUndefined();
  });

  it("the unreachable record says how many deleted lessons the repository's rows still stand for", async () => {
    const { w, runtime, rows } = wired();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    await w.store.purge(w.key, X);
    w.host.failCalls.add("repositoryIdentity");
    await closeOpenPullRequestFor(runtime, w.key, X);
    const watch = (await rows.listPrs(w.key)).rows.find((row) => row.kind === "watch")!;
    expect(watch.unreachableLessons).toBe(1);
    await w.deps.state.put(w.key, { ...newRepoFileState(PLACE, "api"), enabled: true }, 0);
    expect((await repoFileStatus(runtime, w.key)).unreachable).toEqual([{ repo: w.target.name, lessons: 1 }]);
  });

  it("a former repository this install cannot rebuild is recorded as unreachable too, and nothing throws", async () => {
    const { w, runtime, project, rows } = wired();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    project.list = [];
    delete runtime.reach;
    await w.store.purge(w.key, X);
    await expect(closeOpenPullRequestFor(runtime, w.key, X)).resolves.toBeUndefined();
    expect((await rows.listPrs(w.key)).rows.find((row) => row.kind === "watch")!.unreachableAt).toBeDefined();
  });
});

describe("round 6 lows", () => {
  it("a pull request the host no longer has (404) marks its row closed instead of failing every night", async () => {
    const { w, runtime, rows } = wired();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    const raw = w.host.getChangeRequest.bind(w.host);
    w.host.getChangeRequest = async (ref) => { if (ref.id === open.number) throw new Error("GitHub pull request lookup failed with HTTP 404"); return raw(ref); };
    await w.store.purge(w.key, X);
    w.clock.advance(DAY);
    const counts = await nightly(runtime, w);
    expect(counts.repoFileErasureFailures).toBe(0);
    expect((await rows.listPrs(w.key)).rows.find((row) => row.kind === "adds" && row.number === open.number)!.closedAt).toBeDefined();
    const again = await nightly(runtime, w);
    expect(again.repoFileErasureFailures).toBe(0);
  });

  it("two sweeps that start together open ONE removal PR (one holds the lease, the other reads the rows again under it)", async () => {
    const { w, runtime } = await twoRepos();
    await Promise.all([closeOpenPullRequestFor(runtime, w.key, GONE), closeOpenPullRequestFor(runtime, w.key, GONE), nightly(runtime, w)]);
    expect(w.host.open.filter((pr) => !idsIn(w.host.file(pr.source, FILE)).includes(GONE))).toHaveLength(1);
  });

  it("a lease the Lambda died holding is taken over after 15 minutes, not before", async () => {
    const { w, runtime, rows } = await twoRepos();
    await rows.claimPr(w.key, { place: PLACE, kind: "lease", number: "lease-removal", ids: [], at: w.clock.now() });
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    expect(removalOpen(w.host)).toBe(false);
    w.clock.advance(16 * 60_000);
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    expect(removalOpen(w.host)).toBe(true);
    expect((await rows.listPrs(w.key)).rows.some((row) => row.kind === "lease")).toBe(false);
  });

  it("a host that cannot find a pull request by branch cannot be switched on, and a stray branch it holds is shown on the status", async () => {
    const { w, runtime, rows } = wired();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    const rawReconcile = w.host.reconcileChangeRequest.bind(w.host);
    w.host.reconcileChangeRequest = async () => { throw new Error("blip"); };
    await w.run();
    w.host.reconcileChangeRequest = rawReconcile;
    expect(w.host.branchNames.length).toBe(1);
    (w.host as unknown as Record<string, unknown>).changeRequestForBranch = undefined;
    await w.store.purge(w.key, X);
    await closeOpenPullRequestFor(runtime, w.key, X);
    expect((await rows.listPrs(w.key)).rows.find((row) => row.kind === "watch")!.strayBranches).toBe(1);
    await w.deps.state.put(w.key, { ...newRepoFileState(PLACE, "api"), enabled: true }, 0);
    const status = await repoFileStatus(runtime, w.key);
    expect(status.strayBranches).toEqual([{ repo: w.target.name, branches: 1 }]);
    expect(status.canEnable).toBe(false);
  });

  it("a switched-off repository with a removal PR waiting still shows it on the status", async () => {
    const { w, runtime } = await twoRepos();
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    const status = await repoFileStatus(runtime, w.key);
    const row = status.repos.find((r) => r.repo === w.target.name);
    expect(row).toMatchObject({ enabled: false, erasurePrs: 1 });
    expect(status.available).toContain(w.target.name);
  });
});

// ---- round 7 (N11): the repository behind an address is the one the place pins; read and confirm before any destructive call ----
/** A different repository that now answers at the same address (the old one was deleted or renamed and a new one took its name; the installation still covers it). */
class Recreated extends FakeRepoHost {
  override async repositoryIdentity() { this.calls.push("repositoryIdentity"); return { id: "9999", fullName: "acme/api", defaultBranch: "main" }; }
}
const noUpdates = (host: FakeRepoHost) => host.writes.filter((write) => write.op === "update" || write.op === "delete");
const person = (host: FakeRepoHost, branch = "feature/theirs") => host.reconcileChangeRequest({ repository: { url: "x" }, sourceBranch: branch, targetBranch: "main", title: "theirs", body: "" });

describe("N11 (a): every host action first checks the id the host reports against the id in the place", () => {
  async function removed() {
    const ctx = wired();
    await ctx.w.seedLessons(repoLesson(X), repoLesson(Y));
    await ctx.w.enable();
    const r = await ctx.w.run();
    ctx.w.host.merge(Number((r as { number: string }).number));
    ctx.project.list = [];
    const stranger = new Recreated();
    stranger.setFile("main", FILE, ctx.w.host.file("main", FILE));
    const reachHost = { host: stranger };
    ctx.runtime.reach = async (_ws, _p, former) => ({ ...ctx.w.target, place: former.place, repository: { url: former.url }, host: reachHost.host as unknown as CodeHost });
    return { ...ctx, stranger, reachHost };
  }

  it("R1: a removed repo whose address now holds another repository with the same file: nothing is written there, and it is recorded as not reachable", async () => {
    const { w, runtime, stranger, rows } = await removed();
    await w.store.purge(w.key, X);
    await closeOpenPullRequestFor(runtime, w.key, X);
    expect(stranger.writes).toEqual([]);
    expect(stranger.prs).toEqual([]);
    expect(stranger.calls).toEqual(["repositoryIdentity"]);
    expect((await rows.listPrs(w.key)).rows.find((row) => row.kind === "watch")!.unreachableAt).toBeDefined();
  });

  it("a CURRENT target whose address was re-pointed to another repository is not written to either (the check is on the place, not on reach)", async () => {
    const { w, runtime, project } = wired();
    await w.seedLessons(repoLesson(X), repoLesson(Y));
    await w.enable();
    const r = await w.run();
    w.host.merge(Number((r as { number: string }).number));
    const stranger = new Recreated();
    stranger.setFile("main", FILE, w.host.file("main", FILE));
    project.list = [{ ...w.target, host: stranger as unknown as CodeHost }];
    await w.store.purge(w.key, X);
    await closeOpenPullRequestFor(runtime, w.key, X);
    expect(stranger.writes).toEqual([]);
  });

  it("the weekly pass writes nothing into a repository whose id is not the one the place pins, and says it could not read it", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    w.host.repoId = "9999";
    expect(await w.run()).toEqual({ status: "problem", problem: "repository_unreadable" });
    expect(w.host.writes).toEqual([]);
    expect(w.host.branchNames).toEqual([]);
  });

  it("the pass's close-and-delete of what it left (a closing entry, a pending branch) is held back in a repository that is not the pinned one", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    const state = await w.current();
    await w.state.put(w.key, { ...state, enabled: false, open: undefined, closing: [{ branch: open.branch, number: open.number, headRevision: open.headRevision, cause: "switched_off" as const }] }, state.revision);
    w.host.repoId = "9999";
    const { finishClosings } = await import("../../../packages/broker/src/lessons/repo-file-pass.js");
    await finishClosings({ ...w.deps, holder: "h" }, w.key, w.target, (await w.current()));
    expect(noUpdates(w.host)).toEqual([]);
    expect(w.host.open).toHaveLength(1);
    w.host.repoId = "1001";
    await finishClosings({ ...w.deps, holder: "h" }, w.key, w.target, (await w.current()));
    expect(w.host.open).toHaveLength(0);
  });

  it("a Rovara branch with no pull request is not deleted in a repository that is not the pinned one", async () => {
    const { w, runtime, rows } = wired();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    w.host.failCalls.add("reconcileChangeRequest");
    await w.run();
    w.host.failCalls.delete("reconcileChangeRequest");
    expect(w.host.branchNames).toHaveLength(1);
    w.host.repoId = "9999";
    w.clock.advance(DAY);
    await closeOpenPullRequestFor(runtime, w.key, X);
    expect(w.host.branchNames).toHaveLength(1);
    expect(noUpdates(w.host)).toEqual([]);
    expect((await rows.listPrs(w.key)).rows.some((row) => row.number.startsWith("~"))).toBe(true);
    w.host.repoId = "1001";
    await closeOpenPullRequestFor(runtime, w.key, X);
    expect(w.host.branchNames).toHaveLength(0);
  });
});

describe("N11 (b): a pull request is closed only after it is read and confirmed to be Rovara's", () => {
  /** An open Rovara PR that adds X, X erased, the project's list empty (so the sweep treats the repository as a former one, which closes every open row). */
  async function erased() {
    const ctx = wired();
    await ctx.w.seedLessons(repoLesson(X));
    await ctx.w.enable();
    await ctx.w.run();
    const open = (await ctx.w.current()).open!;
    await ctx.w.store.purge(ctx.w.key, X);
    return { ...ctx, open, pr: ctx.w.host.prs.find((p) => p.source === open.branch)! };
  }

  it("R2: the pull request read fails (not a 404): it is not closed, a PR of a person's in a recreated repository stays open, and the next sweep that can read it closes it", async () => {
    const { w, runtime, open, pr } = await erased();
    w.host.failCalls.add("getChangeRequest");
    await closeOpenPullRequestFor(runtime, w.key, X);
    expect(pr.state).toBe("open");
    expect(noUpdates(w.host)).toEqual([]);
    w.host.failCalls.delete("getChangeRequest");
    await closeOpenPullRequestFor(runtime, w.key, X);
    expect(w.host.prs.find((p) => p.source === open.branch)!.state).toBe("closed");
  });

  it("R2: in a recreated repository, PR #1 there is a person's and the read fails once: it is not closed", async () => {
    const { w, runtime, project } = wired();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    project.list = [];
    const mine = new FakeRepoHost();
    await person(mine);
    mine.failCalls.add("getChangeRequest");
    runtime.reach = async (_ws, _p, former) => ({ ...w.target, place: former.place, repository: { url: former.url }, host: mine as unknown as CodeHost });
    await w.store.purge(w.key, X);
    await closeOpenPullRequestFor(runtime, w.key, X);
    expect(mine.prs[0]!.state).toBe("open");
    expect(noUpdates(mine)).toEqual([]);
  });

  it("R3: taking a repository out of the project (every open row is closed) does not close a pull request it cannot read", async () => {
    const { w, runtime, project, pr } = await erased();
    project.list = [];
    w.host.failCalls.add("getChangeRequest");
    await repositoriesChanged(runtime, w.key);
    expect(pr.state).toBe("open");
    w.host.failCalls.delete("getChangeRequest");
    await repositoriesChanged(runtime, w.key);
    expect(pr.state).toBe("closed");
  });

  it.each([
    ["made by an account that is not Rovara's", (pr: { byPerson?: boolean }) => { pr.byPerson = true; }],
    ["made from another branch", (pr: { source: string }) => { pr.source = "feature/theirs"; }],
  ])("a pull request %s is never closed or deleted, and its row is remembered as closed", async (_what, change) => {
    const { w, runtime, pr, rows, open } = await erased();
    change(pr);
    await closeOpenPullRequestFor(runtime, w.key, X);
    expect(pr.state).toBe("open");
    expect(noUpdates(w.host)).toEqual([]);
    expect((await rows.listPrs(w.key)).rows.find((row) => row.number === open.number)!.closedAt).toBeDefined();
  });

  it("a pull request against another repository (its base id is not the pinned one) is never closed", async () => {
    const { w, runtime, pr } = await erased();
    const raw = w.host.getChangeRequest.bind(w.host);
    w.host.getChangeRequest = async (ref) => ({ ...(await raw(ref)), baseRepositoryId: "7777" });
    await closeOpenPullRequestFor(runtime, w.key, X);
    expect(pr.state).toBe("open");
    expect(noUpdates(w.host)).toEqual([]);
  });

  it("a host that does not say who made the pull request, or what it is against, is not taken as a yes: nothing is closed, and it is tried again", async () => {
    for (const missing of ["authoredByRovara", "baseRepositoryId"] as const) {
      const { w, runtime, pr } = await erased();
      const raw = w.host.getChangeRequest.bind(w.host);
      w.host.getChangeRequest = async (ref) => { const { [missing]: _drop, ...rest } = await raw(ref); void _drop; return rest as never; };
      const before = await lessonsRepoFileJob(runtime, w.key.workspaceId, [w.key.project], 3_600_000, 0);
      expect(pr.state).toBe("open");
      expect(before.repoFileErasureFailures).toBeGreaterThan(0);
      w.host.getChangeRequest = raw;
      await closeOpenPullRequestFor(runtime, w.key, X);
      expect(pr.state).toBe("closed");
    }
  });

  it("a stale removal pull request that cannot be read is not closed (and no second one is made beside it)", async () => {
    const { w, runtime } = await twoRepos();
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    const first = w.host.open.at(-1)!;
    w.host.setFile("main", FILE, `${w.host.file("main", FILE)!}\n- A line the team added.\n`);
    w.host.failCalls.add("getChangeRequest");
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    expect(w.host.prs.find((p) => p.number === first.number)!.state).toBe("open");
    expect(noUpdates(w.host)).toEqual([]);
    w.host.failCalls.delete("getChangeRequest");
    await closeOpenPullRequestFor(runtime, w.key, GONE);
    expect(w.host.prs.find((p) => p.number === first.number)!.state).toBe("closed");
  });

  it("the pass's close (switching a repository off) reads and confirms first: an unreadable pull request is left open and finished later; one that is not Rovara's is dropped untouched", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    const runtime: RepoFileRuntime = { deps: w.deps, targets: async () => [w.target], newHolder: () => "n" };
    w.host.failCalls.add("getChangeRequest");
    expect(await repoFileAction(runtime, w.key, { action: "off", repo: "api" })).toMatchObject({ ok: true });
    expect(w.host.open).toHaveLength(1);
    expect(noUpdates(w.host)).toEqual([]);
    w.host.failCalls.delete("getChangeRequest");
    w.clock.advance(DAY);
    await lessonsRepoFileJob(runtime, w.key.workspaceId, [w.key.project], 3_600_000, 0);
    expect(w.host.open).toHaveLength(0);
    expect(w.host.files.has(open.branch)).toBe(false);
  });

  it("the pass's close does not touch a pull request that is not Rovara's", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(X));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    w.host.prs.find((p) => p.source === open.branch)!.byPerson = true;
    const runtime: RepoFileRuntime = { deps: w.deps, targets: async () => [w.target], newHolder: () => "n" };
    await repoFileAction(runtime, w.key, { action: "off", repo: "api" });
    expect(w.host.open).toHaveLength(1);
    expect(noUpdates(w.host)).toEqual([]);
    expect((await w.current()).closing).toEqual([]);
  });
});
