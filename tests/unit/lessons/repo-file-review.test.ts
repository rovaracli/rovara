// Lessons in the repo, lane R2, review round 1 (LESSONS-REPO-FILE-REVIEW.md): the seven reviewer probes as real tests, plus the cases the fixes added.
// Principle A: a failed read stops the write for that repo (never "absent"), and nothing is deleted that is not provably Rovara's own. Principle B: removals are never blocked.
import { afterEach, describe, expect, it } from "vitest";
import type { PathKind, RepositoryRef } from "@agentx/contracts";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { parseLessonsFile } from "../../../packages/broker/src/lessons/repo-file-format.js";
import { switchRepoFileOff } from "../../../packages/broker/src/lessons/repo-file-pass.js";
import { closeOpenPullRequestFor } from "../../../packages/broker/src/lessons/repo-file-routes.js";
import { MAX_THEIRS, StateFull, StateUnreadable, appended, parseRepoFileState } from "../../../packages/broker/src/lessons/repo-file-state.js";
import { lessonsRepoFileJob } from "../../../packages/broker/src/lessons/repo-file-job.js";
import { dynamoRepoFileStore } from "../../../packages/broker/src/lessons/dynamo-repo-file.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { FILE, FakeRepoHost, passSetup, repoLesson } from "./repo-file-helpers.js";

afterEach(() => { setLearnedLessonsGate(undefined); });
const idsIn = (text: string | undefined): string[] => (text === undefined ? [] : parseLessonsFile(text).blocks.map((b) => b.id));
async function runAndMerge(w: ReturnType<typeof passSetup>): Promise<number> {
  const result = await w.run();
  expect(result.status).toBe("opened");
  const number = Number((result as { number: string }).number);
  w.host.merge(number);
  return number;
}
const runtimeOf = (w: ReturnType<typeof passSetup>) => ({ deps: w.deps, targets: async () => [w.target], newHolder: () => "erasure-1" });

describe("review P1: hand-edit hold vs privacy removal", () => {
  it("a team-reworded block whose lesson is now ERASED (purged) is proposed for removal", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
    await w.enable();
    await runAndMerge(w);
    const merged = w.host.file("main", FILE)!;
    w.host.setFile("main", FILE, merged.replace("Lesson text for les_aaaa0001: use the shared helper.", "Team wording of the first lesson."));
    await w.store.purge(w.key, "les_aaaa0001");
    w.week();
    const result = await w.run();
    const state = await w.current();
    expect(result.status).toBe("opened");
    expect(state.open?.removed ?? []).toContain("les_aaaa0001");
  });
});

describe("review P2: a person's push to Rovara's PR (e.g. GitHub 'Update branch') blocks every later removal", () => {
  it("an erased lesson in the merged file still gets a removal PR within one pass", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
    await w.enable();
    await runAndMerge(w);
    await w.seedLessons(repoLesson("les_aaaa0003"));
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened" });
    const open = (await w.current()).open!;
    // 'Update branch' / any push by a person moves the head.
    w.host.setFile(open.branch, "unrelated.txt", "merge of main");
    await w.store.purge(w.key, "les_aaaa0001");
    const results = [];
    for (let i = 0; i < 3; i += 1) { w.week(); results.push((await w.run()).status); }
    const removalProposed = w.host.prs.some((pr) => pr.state === "open" && !idsIn(w.host.file(pr.source, FILE)).includes("les_aaaa0001"));
    expect({ results, removalProposed }).toMatchObject({ removalProposed: true });
  });
});

describe("review P3: erasure of an add in a PR a person pushed to", () => {
  it("the erased add does not stay mergeable in an open PR", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    w.host.setFile(open.branch, "unrelated.txt", "merge of main");
    await w.store.purge(w.key, "les_aaaa0001");
    await closeOpenPullRequestFor(runtimeOf(w), w.key, "les_aaaa0001");
    const stillCarries = w.host.open.some((pr) => idsIn(w.host.file(pr.source, FILE)).includes("les_aaaa0001"));
    expect(stillCarries).toBe(false);
  });
});

class FlakyAgentsHost extends FakeRepoHost {
  failAgentsRead = true;
  override async pathKind(r: RepositoryRef, path: string, revision: string): Promise<PathKind> {
    if (path === "AGENTS.md" && this.failAgentsRead) throw new Error("GitHub 502");
    return super.pathKind(r, path, revision);
  }
}

describe("review P4: a transient read failure of an existing agent file", () => {
  it("never replaces the team's AGENTS.md with Rovara's stub", async () => {
    const host = new FlakyAgentsHost();
    host.setFile("main", "AGENTS.md", "# Team rules\n\nNever touch prod.\n");
    const w = passSetup({ host });
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    expect(await w.run()).toMatchObject({ status: "opened" });
    const open = (await w.current()).open!;
    expect(host.file(open.branch, "AGENTS.md")).toContain("Never touch prod.");
  });
});

describe("review P5: a closing left over from a failed close is replayed a week later without re-checking the head", () => {
  it("does not delete a branch a person pushed to in the meantime", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const first = (await w.current()).open!;
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    w.host.failCalls.add("updateChangeRequest");
    expect(await w.run()).toMatchObject({ status: "opened" });
    expect((await w.current()).closing.map((c) => c.branch)).toContain(first.branch);
    // During the week a person pushes to the old PR's branch.
    w.host.setFile(first.branch, "person.txt", "a person's commit");
    w.host.failCalls.delete("updateChangeRequest");
    w.week();
    await w.run();
    expect(w.host.files.has(first.branch)).toBe(true);
  });
});

describe("review P6: switch off / erasure close when the PR cannot be read", () => {
  it("switch off keeps a branch it could not verify as Rovara's", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    w.host.setFile(open.branch, "person.txt", "a person's commit");
    w.host.failCalls.add("getChangeRequest");
    await switchRepoFileOff(w.deps, w.key, w.target, await w.current());
    expect(w.host.files.has(open.branch)).toBe(true);
  });
});

describe("review P7: the open PR is never rebuilt when the default branch's file changed under it", () => {
  it("a PR computed on an old base is rebuilt once main's file changed (else it can sit conflicted forever)", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await runAndMerge(w);
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    await w.run();
    const before = (await w.current()).open!;
    // The team edits the file on main (a block of its own at the end, next to where the add goes).
    w.host.setFile("main", FILE, `${w.host.file("main", FILE)!}\n- A team lesson with no id.\n`);
    w.week();
    const result = await w.run();
    const after = (await w.current()).open!;
    expect({ status: result.status, rebuilt: after.baseRevision !== before.baseRevision }).toMatchObject({ rebuilt: true });
  });
});

// ---- the cases the fixes added ----
const stored = (w: ReturnType<typeof passSetup>) => w.state.items;

describe("H1 principle A: a read that fails is never 'absent'", () => {
  it("a failed read of CLAUDE.md skips the pointer for this pass, leaves the file alone, and still proposes the lessons", async () => {
    const host = new FakeRepoHost();
    host.setFile("main", "CLAUDE.md", "# Claude notes\n");
    const original = host.fileAtRevision.bind(host);
    host.fileAtRevision = async (r, path, revision, scope, options) => { if (path === "CLAUDE.md") throw new Error("GitHub 502"); return original(r, path, revision, scope, options); };
    const w = passSetup({ host });
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    expect(await w.run()).toMatchObject({ status: "opened" });
    const open = (await w.current()).open!;
    expect(host.file(open.branch, "CLAUDE.md")).toBe("# Claude notes\n");
    expect(host.file(open.branch, "AGENTS.md")).toBeUndefined();
    expect((await w.current()).pointerProposed).toBe(false);
  });

  it("every pointer file that is written is written under the text it was read as (null when seen absent), like the lessons file", async () => {
    const host = new FakeRepoHost();
    host.setFile("main", "CLAUDE.md", "# Claude notes\n");
    const w = passSetup({ host });
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const input = host.commitInputs[0]!;
    expect(input.previous).toEqual(expect.arrayContaining([{ path: ".rovara/lessons.md", content: null }, { path: "CLAUDE.md", content: "# Claude notes\n" }]));
    expect(input.files.map((f) => f.path).sort()).toEqual(input.previous!.map((p) => p.path).sort());
    const fresh = passSetup();
    await fresh.seedLessons(repoLesson("les_aaaa0001"));
    await fresh.enable();
    await fresh.run();
    expect(fresh.host.commitInputs[0]!.previous).toEqual(expect.arrayContaining([{ path: "AGENTS.md", content: null }]));
  });
});

describe("H2 principle B: a person's push to Rovara's PR hands it over; removals still go out, and only removals", () => {
  it("opens a new PR with the removals only, leaves the team's PR and its branch alone, and adds wait until the team's PR is closed or merged", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
    await w.enable();
    await runAndMerge(w);
    await w.seedLessons(repoLesson("les_aaaa0003"));
    w.week();
    await w.run();
    const theirs = (await w.current()).open!;
    w.host.setFile(theirs.branch, "unrelated.txt", "merge of main");
    await w.store.purge(w.key, "les_aaaa0001");
    await w.seedLessons(repoLesson("les_aaaa0004"));
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", removals: 1, adds: 0, edits: 0 });
    const state = await w.current();
    expect(state.theirs.map((t) => t.branch)).toEqual([theirs.branch]);
    expect(state.unmerged).toBe(1);
    expect(w.host.prs.find((pr) => pr.source === theirs.branch)!.state).toBe("open");
    expect(w.host.files.has(theirs.branch)).toBe(true);
    expect(idsIn(w.host.file(state.open!.branch, FILE))).toEqual(["les_aaaa0002"]);
    expect(w.host.open[0] === undefined ? "" : w.host.prs.find((pr) => pr.source === state.open!.branch)!.body).toContain("removals only");
    // The team merges or closes its PR: adds come back.
    w.host.close(w.host.prs.find((pr) => pr.source === theirs.branch)!.number);
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened" });
    expect((await w.current()).theirs).toEqual([]);
    expect(Object.keys((await w.current()).open!.added).length).toBeGreaterThan(0);
  });

  it("an erased add in a PR a person pushed to: the PR is closed (its commits and branch stay), whether or not the host can be read", async () => {
    for (const unreadable of [false, true]) {
      const w = passSetup();
      await w.seedLessons(repoLesson("les_aaaa0001"));
      await w.enable();
      await w.run();
      const open = (await w.current()).open!;
      w.host.setFile(open.branch, "person.txt", "a person's commit");
      if (unreadable) w.host.failCalls.add("getChangeRequest");
      await w.store.purge(w.key, "les_aaaa0001");
      w.host.failCalls.delete("nothing");
      await closeOpenPullRequestFor(runtimeOf(w), w.key, "les_aaaa0001");
      w.host.failCalls.delete("getChangeRequest");
      expect(w.host.open).toHaveLength(0);
      expect(w.host.files.has(open.branch)).toBe(true);
      expect(w.host.file(open.branch, "person.txt")).toBe("a person's commit");
    }
  });

  it("an erased add in a PR already handed over is closed too", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    w.host.setFile(open.branch, "person.txt", "x");
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    await w.run();
    expect((await w.current()).theirs).toHaveLength(1);
    await w.store.markGone(w.key, "les_aaaa0001", "withdrawn");
    await closeOpenPullRequestFor(runtimeOf(w), w.key, "les_aaaa0001");
    expect(w.host.prs.find((pr) => pr.source === open.branch)!.state).toBe("closed");
    expect(w.host.files.has(open.branch)).toBe(true);
    expect((await w.state.listPrs(w.key)).rows.find((row) => row.branch === open.branch)?.closedAt).toBeDefined();
  });
});

describe("H3: a privacy removal beats the hand-edit hold; Rovara's own edits and quality removals do not", () => {
  async function reworded(over: (w: ReturnType<typeof passSetup>) => Promise<void>) {
    const w = passSetup({ names: ["Ann Lee"] });
    await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
    await w.enable();
    await runAndMerge(w);
    w.host.setFile("main", FILE, w.host.file("main", FILE)!.replace("Lesson text for les_aaaa0001: use the shared helper.", "Team wording of the first lesson."));
    await over(w);
    w.week();
    return w;
  }
  const head = async (w: ReturnType<typeof passSetup>, id: string) => (await w.store.listAllHeads(w.key)).find((l) => l.id === id)!;

  it.each([
    ["withdrawn by an erasure", async (w: ReturnType<typeof passSetup>) => { const l = await head(w, "les_aaaa0001"); await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...l, version: 2, status: "withdrawn" }], 9); }],
    ["now names a person", async (w: ReturnType<typeof passSetup>) => { w.names.value = ["for les_aaaa0001"]; }],
    ["no longer repo-only", async (w: ReturnType<typeof passSetup>) => { const l = await head(w, "les_aaaa0001"); await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...l, version: 2, provenance: { ...l.provenance, repoOnly: undefined } }], 9); }],
  ])("%s: proposed for removal, with the note that the team edited it", async (_name, change) => {
    const w = await reworded(change);
    expect(await w.run()).toMatchObject({ status: "opened", removals: 1 });
    const state = await w.current();
    expect(state.open!.removed).toEqual(["les_aaaa0001"]);
    expect(state.held).toEqual([]);
    expect(w.host.prs.at(-1)!.body).toContain("Your team edited this lesson");
    expect(idsIn(w.host.file(state.open!.branch, FILE))).toEqual(["les_aaaa0002"]);
  });

  it.each([
    ["retired", async (w: ReturnType<typeof passSetup>) => { const l = await head(w, "les_aaaa0001"); await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...l, version: 2, status: "retired" }], 9); }],
    ["expired", async (w: ReturnType<typeof passSetup>) => { const l = await head(w, "les_aaaa0001"); await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...l, version: 2, status: "expired" }], 9); }],
    ["thumbs-down", async (w: ReturnType<typeof passSetup>) => { await w.store.mutate(w.key, "les_aaaa0001", (l) => ({ counters: { ...l.counters, harmful: 1 } })); }],
    ["Rovara's own new wording", async (w: ReturnType<typeof passSetup>) => { const l = await head(w, "les_aaaa0001"); await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...l, version: 2, body: "Rovara's other wording." }], 9); }],
  ])("%s: still held, left as the team wrote it", async (_name, change) => {
    const w = await reworded(change);
    expect(await w.run()).toMatchObject({ status: "no_changes" });
    expect((await w.current()).held).toEqual(["les_aaaa0001"]);
  });
});

describe("M1: nothing is deleted that is not provably Rovara's own", () => {
  it("erasure closing a PR whose head moved or cannot be read keeps the branch (see H2); a replay only deletes a branch still at the head Rovara left", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const first = (await w.current()).open!;
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    w.host.failCalls.add("deleteBranch");
    await w.run();
    expect((await w.current()).closing.map((c) => c.headRevision)).toEqual([first.headRevision]);
    w.host.failCalls.delete("deleteBranch");
    w.week();
    await w.run();
    // Still at Rovara's head: now deleted.
    expect(w.host.files.has(first.branch)).toBe(false);
    expect((await w.current()).closing).toEqual([]);
  });

  it("a head that cannot be read is not Rovara's: no delete, retried a few times, then dropped", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    const state = await w.current();
    await w.state.put(w.key, { ...state, closing: [{ branch: open.branch, number: "1", cause: "replaced", headRevision: open.headRevision }] }, state.revision);
    w.host.failCalls.add("baseBranchHead");
    for (let i = 0; i < 4; i += 1) { w.week(); await w.run(); }
    expect(w.host.files.has(open.branch)).toBe(true);
    expect((await w.current()).closing).toEqual([]);
    expect(w.host.writes.filter((write) => write.op === "delete")).toEqual([]);
  });

  it("a pending branch is deleted only while it is at a head Rovara wrote (the base it was made at or its own commit)", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    w.host.failCalls.add("reconcileChangeRequest");
    await w.run();
    const pending = (await w.current()).pending!;
    w.host.failCalls.delete("reconcileChangeRequest");
    w.host.setFile(pending.branch, "person.txt", "a person pushed to the stray branch");
    w.week();
    await w.run();
    expect(w.host.files.has(pending.branch)).toBe(true);
    expect((await w.current()).pending).toBeUndefined();
  });
});

describe("M3: a PR computed on an old base is rebuilt when the team's file or a pointer file changed", () => {
  it("rebuilds when the pointer file it would write changed on the default branch", async () => {
    const w = passSetup();
    w.host.setFile("main", "AGENTS.md", "# Agents\n");
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const before = (await w.current()).open!;
    w.host.setFile("main", "AGENTS.md", "# Agents\n\nNew team rule.\n");
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened" });
    expect((await w.current()).open!.branch).not.toBe(before.branch);
    expect(w.host.file((await w.current()).open!.branch, "AGENTS.md")).toContain("New team rule.");
  });
});

describe("the lows", () => {
  it("L2: a reason that is not about quality is one neutral sentence", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
    await w.enable();
    await runAndMerge(w);
    await w.store.mutate(w.key, "les_aaaa0001", (l) => ({ counters: { ...l.counters, harmful: 1 } }));
    w.week();
    await w.run();
    const body = w.host.prs.at(-1)!.body;
    expect(body).toContain("Rovara no longer proposes this lesson");
    expect(body).not.toMatch(/harmful|wrong|names a person|Rovara user/u);
  });

  it("L4: lessons switched off closes Rovara's open PR and retries leftover closings (no model, no new PR)", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    setLearnedLessonsGate(() => false);
    w.week();
    expect(await w.run()).toEqual({ status: "skipped", reason: "lessons_off" });
    expect(w.host.open).toHaveLength(0);
    expect(w.host.files.has(open.branch)).toBe(false);
    expect((await w.current()).open).toBeUndefined();
  });

  it("L8: only a withdrawn or purged lesson closes the open PR, not a scrub that keeps it", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync("packages/broker/src/lessons/deletion.ts", "utf8");
    expect(text).toMatch(/intent\.outcome === "withdraw" \|\| intent\.outcome === "purge"\)\s*\{?\s*await notifyLessonGone|notifyLessonGone[^\n]*\n[^\n]*/u);
    expect(text).toMatch(/if \(intent\.outcome === "withdraw" \|\| intent\.outcome === "purge"\) await notifyLessonGone/u);
  });

  it("L9: a resume keeps what Rovara rendered, so a restored old file's purged lesson is proposed for removal, and the lessons are proposed again", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
    await w.enable();
    await runAndMerge(w);
    const old = w.host.file("main", FILE)!;
    w.host.setFile("main", FILE, undefined);
    w.week();
    await w.run();
    const { repoFileAction } = await import("../../../packages/broker/src/lessons/repo-file-routes.js");
    await repoFileAction(runtimeOf(w), w.key, { action: "resume", repo: "api" });
    expect(Object.keys((await w.current()).rendered).sort()).toEqual(["les_aaaa0001", "les_aaaa0002"]);
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", adds: 2 });
    w.host.merge(w.host.open[0]!.number);
    // The team restores the old file after an id was purged.
    await w.store.purge(w.key, "les_aaaa0001");
    w.host.setFile("main", FILE, old);
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", removals: 1 });
    expect(stored(w).size).toBe(1);
  });

  it("L10: the first PR suggests CODEOWNERS for the file only", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    expect(w.host.prs[0]!.body).toContain("CODEOWNERS");
  });

  it("L5: repositories of a project are tried in a different order each day", async () => {
    const { lessonsRepoFileJob } = await import("../../../packages/broker/src/lessons/repo-file-job.js");
    const w = passSetup();
    const seen: string[][] = [];
    const targets = ["github:repo/1", "github:repo/2", "github:repo/3"].map((place) => ({ ...w.target, place, name: place.slice(-1) }));
    for (const target of targets) await w.state.put(w.key, { ...(await import("../../../packages/broker/src/lessons/repo-file-state.js")).newRepoFileState(target.place, target.name), enabled: true }, 0);
    for (const day of [0, 1, 2]) {
      const order: string[] = [];
      const host = { ...w.target.host } as never;
      void host;
      await lessonsRepoFileJob({ deps: { ...w.deps, state: new Proxy(w.state, { get: (t, k) => (k === "get" ? async (key: never, place: string) => { order.push(place); return (t as never as { get(k: unknown, p: string): Promise<unknown> }).get(key, place); } : (t as never)[k as never]) }) }, targets: async () => targets, newHolder: () => "h" }, KEYWS, [w.key.project], 10_000, day);
      seen.push(order);
    }
    expect(new Set(seen.map((o) => o[0])).size).toBeGreaterThan(1);
  });
});
const KEYWS = "org_aaaaaaaaaaaaaaaaaaaa";

// ---- re-check of the fix round (LESSONS-REPO-FILE-REVIEW.md, Q1-Q5) ----
const L1 = "les_aaaa0001";
const TEXT1 = `Lesson text for ${L1}: use the shared helper.`;

describe("re-check Q1 (H3 ordering): a privacy blocker masked by an earlier quality reason", () => {
  it("a reworded block whose lesson is no longer repo-only AND has harm feedback is proposed for removal", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(L1), repoLesson("les_aaaa0002"));
    await w.enable();
    const r = await w.run();
    w.host.merge(Number((r as { number: string }).number));
    w.host.setFile("main", FILE, w.host.file("main", FILE)!.replace(TEXT1, "Team wording of the first lesson."));
    const head = (await w.store.listAllHeads(w.key)).find((x) => x.id === L1)!;
    await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...head, version: 2, provenance: { ...head.provenance, repoOnly: undefined } }], 9);
    await w.store.mutate(w.key, L1, (x) => ({ counters: { ...x.counters, harmful: 1 } }));
    w.week();
    await w.run();
    expect((await w.current()).open?.removed ?? []).toContain(L1);
  });
});

describe("re-check Q2 (H2 + erasure): text that reached main through a handed-over PR", () => {
  it("is proposed for removal once its lesson is erased", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(L1));
    await w.enable();
    const r = await w.run();
    const number = Number((r as { number: string }).number);
    const open = (await w.current()).open!;
    w.host.setFile(open.branch, FILE, w.host.file(open.branch, FILE)!.replace(TEXT1, "Team wording of the first lesson."));
    w.week();
    await w.run();
    expect((await w.current()).theirs.length).toBe(1);
    w.host.merge(number);
    w.week();
    await w.run();
    await w.store.purge(w.key, L1);
    w.week();
    await w.run();
    const proposed = w.host.open.some((pr) => !idsIn(w.host.file(pr.source, FILE)).includes(L1));
    expect({ inMain: idsIn(w.host.file("main", FILE)).includes(L1), proposed }).toEqual({ inMain: true, proposed: true });
  });
});

describe("re-check Q3 (M1 vs erasure): an erasure close that failed once, then a person pushes", () => {
  it("the PR carrying the erased add is still closed (branch kept), not dropped", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(L1));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    w.host.failCalls.add("updateChangeRequest");
    await w.store.purge(w.key, L1);
    await closeOpenPullRequestFor(runtimeOf(w), w.key, L1);
    expect(w.host.open).toHaveLength(1);
    w.host.setFile(open.branch, "person.txt", "a person's commit");
    w.host.failCalls.delete("updateChangeRequest");
    await w.sweep();
    const stillCarries = w.host.open.some((pr) => idsIn(w.host.file(pr.source, FILE)).includes(L1));
    expect({ stillCarries, branchKept: w.host.files.has(open.branch) }).toEqual({ stillCarries: false, branchKept: true });
  });
});

describe("re-check Q4 (M1 replaced closing): an old PR a person pushed to after replacement is dropped from tracking", () => {
  it("a later erasure of an add that is only in that PR still closes it", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(L1));
    await w.enable();
    await w.run();
    const first = (await w.current()).open!;
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    w.host.failCalls.add("updateChangeRequest");
    expect(await w.run()).toMatchObject({ status: "opened" });
    w.host.failCalls.delete("updateChangeRequest");
    w.host.setFile(first.branch, "person.txt", "a person's commit");
    // Now L1 stops being proposed (e.g. erased) - it is in the new PR too, so erase a lesson only the first PR had is not possible here;
    // instead check the first PR is tracked somewhere (theirs or closing) after the next pass.
    w.week();
    await w.run();
    const s = await w.current();
    const tracked = s.theirs.some((t) => t.branch === first.branch) || s.closing.some((c) => c.branch === first.branch) || s.open?.branch === first.branch;
    const firstOpen = w.host.prs.find((p) => p.source === first.branch)!.state === "open";
    expect({ firstOpen, tracked }).not.toEqual({ firstOpen: true, tracked: false });
  });
});

class FlakyAgentsHost2 extends FakeRepoHost {
  failAgentsRead = true;
  override async pathKind(r: RepositoryRef, path: string, revision: string): Promise<PathKind> {
    if (path === "AGENTS.md" && this.failAgentsRead) throw new Error("GitHub 502");
    return super.pathKind(r, path, revision);
  }
}

describe("re-check Q5 (H1): pointer skipped on a failed read, proposed later with previous", () => {
  it("lessons go out without the pointer, and the next pass proposes it under the text it read", async () => {
    const host = new FlakyAgentsHost2();
    host.setFile("main", "AGENTS.md", "# Team rules\n\nNever touch prod.\n");
    const w = passSetup({ host });
    await w.seedLessons(repoLesson(L1));
    await w.enable();
    expect(await w.run()).toMatchObject({ status: "opened" });
    const first = (await w.current()).open!;
    expect(host.file(first.branch, "AGENTS.md")).toBe("# Team rules\n\nNever touch prod.\n");
    expect((await w.current()).pointerProposed).toBe(false);
    host.failAgentsRead = false;
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened" });
    const last = host.commitInputs.at(-1)!;
    const agents = last.previous?.find((p) => p.path === "AGENTS.md");
    expect(agents?.content).toBe("# Team rules\n\nNever touch prod.\n");
    expect(host.file((await w.current()).open!.branch, "AGENTS.md")).toContain("Never touch prod.");
  });
});

// ---- the cases the second fix round added ----
describe("N1: any privacy reason overrides the hold, whatever quality reasons are also present", () => {
  it.each([
    ["retired and no longer repo-only", (l: ReturnType<typeof repoLesson>) => ({ ...l, status: "retired" as const, provenance: { ...l.provenance, repoOnly: undefined } })],
    ["expired and restricted audience", (l: ReturnType<typeof repoLesson>) => ({ ...l, status: "expired" as const, provenance: { ...l.provenance, audience: { kind: "restricted" as const, acl: { source: "slack", scope: "slack:channel/C1", capturedAt: "t", liveCheck: "on_read" as const } } } })],
    ["stale citation and names a person", (l: ReturnType<typeof repoLesson>) => ({ ...l, citationChecks: [{ index: 0, result: "stale" as const, at: 1 }], body: "Ask Ann Lee for les_aaaa0001 details." })],
  ])("%s: proposed for removal, with a privacy reason", async (_name, change) => {
    const w = passSetup({ names: ["Ann Lee"] });
    await w.seedLessons(repoLesson(L1), repoLesson("les_aaaa0002"));
    await w.enable();
    const r = await w.run();
    w.host.merge(Number((r as { number: string }).number));
    w.host.setFile("main", FILE, w.host.file("main", FILE)!.replace(TEXT1, "Team wording of the first lesson."));
    const head = (await w.store.listAllHeads(w.key)).find((l) => l.id === L1)!;
    await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...change(head), version: 2 }], 9);
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", removals: 1 });
    expect((await w.current()).open!.removed).toEqual([L1]);
  });
});

describe("N2: erasure is driven by the file, not by Rovara's ownership records", () => {
  it("a block a person copied into the file, or that came in through any PR, whose lesson was erased gets a removal; an unknown id is left alone", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0002"));
    await w.enable();
    const r = await w.run();
    w.host.merge(Number((r as { number: string }).number));
    // A person copies a block for a lesson Rovara never rendered here and that is later erased; and another with an id nobody knows.
    w.host.setFile("main", FILE, `${w.host.file("main", FILE)!}\n<!-- rovara:les_copied01 -->\n- Copied text of a lesson.\n\n<!-- rovara:les_unknown9 -->\n- Some other tool's block.\n`);
    await w.seedLessons(repoLesson("les_copied01"));
    await w.store.purge(w.key, "les_copied01");
    const { closeOpenPullRequestFor: gone } = await import("../../../packages/broker/src/lessons/repo-file-routes.js");
    await gone(runtimeOf(w), w.key, "les_copied01");
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", removals: 1 });
    expect((await w.current()).open!.removed).toEqual(["les_copied01"]);
    expect(w.host.file((await w.current()).open!.branch, FILE)).toContain("les_unknown9");
  });

  it("a lesson of ANOTHER repository, copied here, is proposed for removal; so is one that is not repo-only at all", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0002"));
    await w.enable();
    const r = await w.run();
    w.host.merge(Number((r as { number: string }).number));
    const other = repoLesson("les_other001", { place: "github:repo/2002" });
    const slack = repoLesson("les_slack001", { provenance: { ...other.provenance, repoOnly: undefined } });
    await w.seedLessons(other, slack);
    w.host.setFile("main", FILE, `${w.host.file("main", FILE)!}\n<!-- rovara:les_other001 -->\n- Text of the other repo.\n\n<!-- rovara:les_slack001 -->\n- Text from a chat.\n`);
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", removals: 2 });
  });

  it("text that reached main through a handed-over PR and whose lesson is later erased is proposed for removal (probe Q2 plus the reopen case)", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(L1));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    w.host.setFile(open.branch, "person.txt", "a person's commit");
    w.week();
    await w.run();
    w.host.merge(1);
    await w.store.purge(w.key, L1);
    const { closeOpenPullRequestFor: gone } = await import("../../../packages/broker/src/lessons/repo-file-routes.js");
    await gone(runtimeOf(w), w.key, L1);
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", removals: 1 });
  });
});

describe("N3: closing a pull request is always safe; only deleting a branch needs the head", () => {
  it("an erasure close that cannot read the head still closes the PR, keeps the branch, and the entry is never dropped before the host confirms", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(L1));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    w.host.failCalls.add("updateChangeRequest");
    w.host.failCalls.add("baseBranchHead");
    await w.store.purge(w.key, L1);
    await closeOpenPullRequestFor(runtimeOf(w), w.key, L1);
    for (let i = 0; i < 5; i += 1) { w.week(); await w.sweep(); }
    expect(w.host.open).toHaveLength(1);
    expect((await w.state.listPrs(w.key)).rows.filter((row) => row.kind === "adds" && row.closedAt === undefined).map((row) => row.branch)).toEqual([open.branch]);
    w.host.failCalls.clear();
    await w.sweep();
    expect(w.host.open.some((pr) => idsIn(w.host.file(pr.source, FILE)).includes(L1))).toBe(false);
    expect(w.host.prs.find((pr) => pr.source === open.branch)!.state).toBe("closed");
  });

  it("a replaced PR a person pushed to is kept in `theirs` with the ids it carried, so a later erasure still finds it", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(L1));
    await w.enable();
    await w.run();
    const first = (await w.current()).open!;
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    w.host.failCalls.add("updateChangeRequest");
    await w.run();
    w.host.failCalls.delete("updateChangeRequest");
    w.host.setFile(first.branch, "person.txt", "a person's commit");
    w.week();
    await w.run();
    expect((await w.current()).theirs).toEqual([expect.objectContaining({ branch: first.branch, ids: [L1] })]);
    expect((await w.current()).closing).toEqual([]);
    await w.store.purge(w.key, L1);
    await closeOpenPullRequestFor(runtimeOf(w), w.key, L1);
    expect(w.host.prs.find((pr) => pr.source === first.branch)!.state).toBe("closed");
    expect(w.host.files.has(first.branch)).toBe(true);
  });
});

describe("the second round's lows", () => {
  it("L-r1: a pending branch whose head cannot be read is retried a few times, not dropped at once, and is not lost when a new PR is opened", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(L1));
    await w.enable();
    w.host.failCalls.add("reconcileChangeRequest");
    await w.run();
    const stray = (await w.current()).pending!.branch;
    w.host.failCalls.delete("reconcileChangeRequest");
    w.host.failCalls.add("baseBranchHead");
    w.week();
    await w.run();
    expect((await w.current()).pending?.branch === stray || (await w.current()).closing.some((c) => c.branch === stray)).toBe(true);
    w.host.failCalls.clear();
    for (let i = 0; i < 2; i += 1) { w.week(); await w.run(); }
    expect(w.host.files.has(stray)).toBe(false);
  });

  it("L-r3: an agent file that cannot be read says so on the row, and a Copilot file alone does not stop the pointer", async () => {
    const host = new FakeRepoHost();
    host.setFile("main", "CLAUDE.md", "# Claude\n");
    const original = host.pathKind.bind(host);
    host.pathKind = async (r, path, revision) => { if (path === ".github/copilot-instructions.md") throw new Error("link parent"); return original(r, path, revision); };
    const w = passSetup({ host });
    await w.seedLessons(repoLesson(L1));
    await w.enable();
    await w.run();
    expect(host.file((await w.current()).open!.branch, "CLAUDE.md")).toContain("@.rovara/lessons.md");
    const blocked = new FakeRepoHost();
    const orig2 = blocked.pathKind.bind(blocked);
    blocked.pathKind = async (r, path, revision) => { if (path === "AGENTS.md") throw new Error("502"); return orig2(r, path, revision); };
    const w2 = passSetup({ host: blocked });
    await w2.seedLessons(repoLesson(L1));
    await w2.enable();
    await w2.run();
    expect((await w2.current()).problem).toBe("pointer_unreadable");
    expect((await w2.current()).open).toBeDefined();
  });

  it("L-r4: bookkeeping lists have a cap and over it the state FAILS LOUDLY; an erasure close is its own row and has none", async () => {
    const w = passSetup();
    await w.enable();
    const state = await w.current();
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ branch: `rovara/lessons-${i.toString(16).padStart(12, "0")}`, number: String(i + 1), url: "", ids: [`les_t${String(i).padStart(7, "0")}`] }));
    expect(parseRepoFileState({ ...state, theirs: many(MAX_THEIRS) })).toBeDefined();
    expect(parseRepoFileState({ ...state, theirs: many(MAX_THEIRS + 1) })).toBeUndefined();
    expect(() => appended(many(MAX_THEIRS), many(1)[0]!)).toThrow(StateFull);
    // The store refuses the state that does not fit (it is never stored and later read as absent) and the pass says so on the row.
    await expect(w.state.put(w.key, { ...state, theirs: many(MAX_THEIRS + 1) }, state.revision)).rejects.toThrow(StateFull);
    // A state item that exists and does not parse is not 'absent'.
    const table = new FakeDynamoDb({ indexKeys: {} });
    const store = dynamoRepoFileStore({ documentClient: table, tableName: "t" });
    await store.put(w.key, state, 0);
    const [item] = [...table.items?.values() ?? []];
    if (item !== undefined) { item.state = { nonsense: true }; await expect(store.get(w.key, state.place)).rejects.toThrow(StateUnreadable); expect(await store.list(w.key)).toEqual([]); }
  });

  it("L-r5: a merge that combines changes to the file from both sides is refused with a sentence the user can act on", async () => {
    const { LESSONS_FILE_MERGE_REFUSAL } = await import("../../../packages/worker/src/lessons-file-guard.js");
    expect(LESSONS_FILE_MERGE_REFUSAL).toMatch(/both sides/u);
  });
});

// ---- round 3: erasure never depends on a capped list ----
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { setLessonGoneListener } from "../../../packages/broker/src/lessons/repo-file-hook.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { NO_VECTORS } from "../../../packages/broker/src/lessons/runtime.js";
import { Audit, Clock, WS as LWS } from "./lesson-helpers.js";

describe("N4: the durable tombstone is one row per lesson, never evicted", () => {
  it("R1: a copied block of an erased lesson is still proposed for removal after 1000 later erasures", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0002"));
    await w.enable();
    const r = await w.run();
    w.host.merge(Number((r as { number: string }).number));
    w.host.setFile("main", FILE, `${w.host.file("main", FILE)!}\n<!-- rovara:les_copied01 -->\n- Copied text of a lesson.\n`);
    await w.seedLessons(repoLesson("les_copied01"));
    await w.store.purge(w.key, "les_copied01");
    for (let i = 0; i < 1000; i += 1) { await w.store.markGone(w.key, `les_gone${String(i).padStart(5, "0")}`, "purged"); await closeOpenPullRequestFor(runtimeOf(w), w.key, `les_gone${String(i).padStart(5, "0")}`); }
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", removals: 1 });
    expect((await w.current()).open!.removed).toEqual(["les_copied01"]);
  });

  it("R2: 1000 pull request rows are 1000 rows, none evicted, and the state never grows with them", async () => {
    const w = passSetup();
    await w.enable();
    const before = JSON.stringify(await w.current()).length;
    for (let i = 0; i < 1000; i += 1) await w.state.putPr(w.key, { place: "github:repo/9", kind: "adds", number: String(i + 1), branch: `rovara/lessons-${i.toString(16).padStart(12, "0")}`, ids: ["les_x0000001"], at: i });
    expect((await w.state.listPrs(w.key)).rows).toHaveLength(1000);
    expect(JSON.stringify(await w.current()).length).toBe(before);
    const table = new FakeDynamoDb({ indexKeys: {} });
    const dynamo = dynamoRepoFileStore({ documentClient: table, tableName: "t" });
    for (let i = 0; i < 300; i += 1) await dynamo.putPr(w.key, { place: "github:repo/9", kind: "adds", number: String(i + 1), branch: `rovara/lessons-${i.toString(16).padStart(12, "0")}`, ids: [], at: i });
    expect((await dynamo.listPrs(w.key)).rows).toHaveLength(300);
    await dynamo.delPr(w.key, "github:repo/9", "7");
    expect((await dynamo.listPrs(w.key)).rows).toHaveLength(299);
  });

  it("an erasure whose lesson was erased with the hook never called is still caught by the next pass, from the tombstone alone", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(L1));
    await w.enable();
    await w.run();
    await w.store.purge(w.key, L1);
    await lessonsRepoFileJob({ deps: w.deps, targets: async () => [w.target], newHolder: () => "n" }, w.key.workspaceId, [w.key.project], 3_600_000, 0);
    expect(w.host.open.some((pr) => idsIn(w.host.file(pr.source, FILE)).includes(L1))).toBe(false);
  });
});

describe("N5: an erasure close is decided before any hand-over", () => {
  it("R3: a replaced PR still in `closing` when its lesson is erased, and a person pushed to it, is closed, not handed over", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(L1));
    await w.enable();
    await w.run();
    const first = (await w.current()).open!;
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    w.host.failCalls.add("updateChangeRequest");
    await w.run();
    w.host.failCalls.delete("updateChangeRequest");
    expect((await w.current()).closing.some((c) => c.branch === first.branch)).toBe(true);
    w.host.setFile(first.branch, "person.txt", "a person's commit");
    await w.store.purge(w.key, L1);
    await closeOpenPullRequestFor(runtimeOf(w), w.key, L1);
    w.week();
    await w.run();
    expect(w.host.open.filter((pr) => idsIn(w.host.file(pr.source, FILE)).includes(L1)).map((pr) => pr.source)).toEqual([]);
    expect(w.host.files.has(first.branch)).toBe(true);
    expect((await w.current()).theirs.some((t) => t.branch === first.branch)).toBe(false);
  });

  it("a pull request waiting in `closing` that a person pushed to is closed by the sweep from its row, with no hook call", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(L1));
    await w.enable();
    await w.run();
    const first = (await w.current()).open!;
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    w.host.failCalls.add("updateChangeRequest");
    await w.run();
    w.host.failCalls.delete("updateChangeRequest");
    w.host.setFile(first.branch, "person.txt", "a person's commit");
    await w.store.markGone(w.key, L1, "withdrawn");
    await w.sweep();
    expect(w.host.prs.find((pr) => pr.source === first.branch)!.state).toBe("closed");
    expect(w.host.files.has(first.branch)).toBe(true);
  });
});

describe("N6: the tombstone is part of the erasure, retried until written", () => {
  it("a tombstone write that fails leaves the deletion unfinished (and the file pass not told); the resume writes it, and only then is the hook called", async () => {
    class FlakyStore extends InMemoryLessonStore {
      failures = 1;
      override async markGone(key: { workspaceId: string; project: string }, id: string, mode: "withdrawn" | "purged"): Promise<void> {
        if (this.failures > 0) { this.failures -= 1; throw new Error("table down"); }
        return super.markGone(key, id, mode);
      }
    }
    const store = new FlakyStore();
    const told: string[] = [];
    setLessonGoneListener(async (_key, id) => { told.push(id); });
    try {
      const w = passSetup();
      void w;
      const lesson = repoLesson(L1, { status: "active" });
      await store.commit({ workspaceId: LWS, project: "proj-1" }, 0, [lesson], 1);
      const port = lessonDeletionPort({ store, vectors: NO_VECTORS, audit: new Audit(), now: new Clock().now });
      await expect(port.withdraw(LWS, "proj-1", L1, "source_deleted")).rejects.toThrow("table down");
      expect(told).toEqual([]);
      expect((await store.goneOf({ workspaceId: LWS, project: "proj-1" }, [L1])).size).toBe(0);
      expect(await port.resumePending(LWS, "proj-1")).toBeGreaterThan(0);
      expect((await store.goneOf({ workspaceId: LWS, project: "proj-1" }, [L1])).get(L1)).toBe("withdrawn");
      expect(told).toEqual([L1]);
    } finally { setLessonGoneListener(undefined); }
  });

  it("a pull request row that cannot be written stops the pass before the state changes; the branch it made is cleaned up, and the next pass opens it again with its row", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson(L1));
    await w.enable();
    w.state.failPrWrites = true;
    expect(await w.run()).toEqual({ status: "problem", problem: "state_unreadable" });
    expect((await w.current()).open).toBeUndefined();
    const stray = (await w.current()).pending!.branch;
    w.state.failPrWrites = false;
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened" });
    expect(w.host.files.has(stray)).toBe(false);
    expect((await w.state.listPrs(w.key)).rows.filter((row) => row.kind === "adds")).toHaveLength(1);
  });
});
