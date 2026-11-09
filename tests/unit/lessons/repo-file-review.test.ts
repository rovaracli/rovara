// Lessons in the repo, lane R2, review round 1 (LESSONS-REPO-FILE-REVIEW.md): the seven reviewer probes as real tests, plus the cases the fixes added.
// Principle A: a failed read stops the write for that repo (never "absent"), and nothing is deleted that is not provably Rovara's own. Principle B: removals are never blocked.
import { afterEach, describe, expect, it } from "vitest";
import type { PathKind, RepositoryRef } from "@agentx/contracts";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { parseLessonsFile } from "../../../packages/broker/src/lessons/repo-file-format.js";
import { switchRepoFileOff } from "../../../packages/broker/src/lessons/repo-file-pass.js";
import { closeOpenPullRequestFor } from "../../../packages/broker/src/lessons/repo-file-routes.js";
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
    await closeOpenPullRequestFor(runtimeOf(w), w.key, "les_aaaa0001");
    expect(w.host.prs.find((pr) => pr.source === open.branch)!.state).toBe("closed");
    expect(w.host.files.has(open.branch)).toBe(true);
    expect((await w.current()).theirs).toEqual([]);
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
