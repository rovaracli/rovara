// Lessons in the repo, lane R3 (decisions 50, 50a, 50b; design rev 2 section 6): read-back, file -> Rovara, one way, by id. The team's edits of the merged `.rovara/lessons.md` are taken into Rovara by the weekly pass:
// changed text = a correction, a removed id = retired by the team, a bullet with no id = a new person-approved lesson. Nothing is ever retired or changed on a read that failed, and an erased id is never brought back.
// The mutation checks (retire on a parse failure, resurrect a gone id, let formatter churn make edits) are recorded in the lane report.
import { afterEach, describe, expect, it } from "vitest";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { parseLessonsFile } from "../../../packages/broker/src/lessons/repo-file-format.js";
import { readBackFile, scopeOfHeading } from "../../../packages/broker/src/lessons/repo-file-readback.js";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { noticesOf } from "../../../packages/broker/src/lessons/repo-file-pr.js";
import { settings } from "./lesson-helpers.js";
import { FILE, passSetup, repoLesson } from "./repo-file-helpers.js";

afterEach(() => { setLearnedLessonsGate(undefined); });
type W = ReturnType<typeof passSetup>;
const FIRST = "Lesson text for les_aaaa0001: use the shared helper.";
const idsIn = (text: string | undefined): string[] => (text === undefined ? [] : parseLessonsFile(text).blocks.map((b) => b.id));
const lesson = async (w: W, id: string) => (await w.store.listAllHeads(w.key)).find((l) => l.id === id);

/** A repository with two merged lessons (ids les_aaaa0001 and les_aaaa0002) and Rovara's record of them. */
async function merged(over: Parameters<typeof passSetup>[0] = {}): Promise<W> {
  const w = passSetup(over);
  await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
  await w.enable();
  const result = await w.run();
  expect(result.status).toBe("opened");
  w.host.merge(Number((result as { number: string }).number));
  return w;
}
const changeFile = (w: W, edit: (text: string) => string): void => { w.host.setFile("main", FILE, edit(w.host.file("main", FILE)!)); };
const pass = async (w: W) => { w.week(); return w.run(); };
const actions = (w: W): string[] => w.audit.actions();

describe("a changed block under a known id is the team's correction", () => {
  it("takes the team's wording as the lesson's text, as a person edit by 'repository edit', audited; repo-only stays, the hold is released and nothing is proposed back", async () => {
    const w = await merged();
    const before = (await lesson(w, "les_aaaa0001"))!;
    changeFile(w, (t) => t.replace(FIRST, "The team's own wording: call the shared helper."));
    expect(await pass(w)).toEqual({ status: "no_changes" });
    const after = (await lesson(w, "les_aaaa0001"))!;
    expect(after.body).toBe("The team's own wording: call the shared helper.");
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.status).toBe("active");
    expect(after.provenance.repoOnly).toEqual(before.provenance.repoOnly);
    expect(after.trial).toBeUndefined();
    expect(after.approvals).toHaveLength(1);
    expect(after.approvals[0]).toMatchObject({ mode: "one", by: "system:repository-edit" });
    const state = await w.current();
    expect(state.held).toEqual([]);
    expect(state.readBack).toMatchObject({ edited: 1, retired: 0, imported: 0 });
    const event = w.audit.events.find((e) => e.action === "lesson.updated")!;
    expect(event).toMatchObject({ lessonId: "les_aaaa0001", actor: "repository edit", facts: { cause: "repository_edit" } });
    // Rovara never overwrites it, even though its own store disagreed a moment ago: no edit, no PR.
    expect(w.host.open).toHaveLength(0);
    // The other lesson is untouched.
    expect((await lesson(w, "les_aaaa0002"))!.version).toBe(1);
  });

  it("a SUBSTANTIAL rewrite clears the thumbs-down and the pending removal from before it; help counts are kept (decision 76.2)", async () => {
    const w = await merged();
    await w.store.mutate(w.key, "les_aaaa0001", (l) => ({ counters: { ...l.counters, helpful: 3, harmful: 1 }, retireProposedAt: 5 }));
    changeFile(w, (t) => t.replace(FIRST, "Prefer the retry wrapper in the http client and give up after three tries."));
    expect(await pass(w)).toEqual({ status: "no_changes" });
    const after = (await lesson(w, "les_aaaa0001"))!;
    expect(after.counters).toMatchObject({ helpful: 3, harmful: 0 });
    expect(after.retireProposedAt).toBeUndefined();
  });

  it("a SMALL edit (one word) keeps the thumbs-down and the pending removal: a tiny change does not reset a lesson's record", async () => {
    const w = await merged();
    await w.store.mutate(w.key, "les_aaaa0001", (l) => ({ counters: { ...l.counters, helpful: 3, harmful: 4 }, retireProposedAt: 5 }));
    changeFile(w, (t) => t.replace(FIRST, `${FIRST.replace(/\.$/u, "")} now.`));
    await pass(w);
    const after = (await lesson(w, "les_aaaa0001"))!;
    expect(after.body).toContain("now.");
    expect(after.counters).toMatchObject({ helpful: 3, harmful: 4 });
    expect(after.retireProposedAt).toBe(5);
  });

  it("the approval a read-back gives is honest: its approver is the repository edit, not a person", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(FIRST, "Reworded by someone who can write to the repository."));
    await pass(w);
    expect((await lesson(w, "les_aaaa0001"))!.approvals).toMatchObject([{ by: "system:repository-edit", mode: "one" }]);
  });

  it("a team rewording that names a person, or asks for more access, is not taken in: recorded once with a fixed reason, the block stays held", async () => {
    const w = await merged({ names: ["Ann Lee"] });
    changeFile(w, (t) => t.replace(FIRST, "Ask Ann Lee before you touch the helper."));
    await pass(w);
    expect((await lesson(w, "les_aaaa0001"))!.body).toBe(FIRST);
    const state = await w.current();
    expect(Object.values(state.refused ?? {})).toEqual(["names_a_person"]);
    expect(state.held).toEqual(["les_aaaa0001"]);
    expect(actions(w).filter((a) => a === "lesson.updated")).toHaveLength(0);
    const refusals = () => actions(w).filter((a) => a === "lesson.refused").length;
    expect(refusals()).toBe(1);
    await pass(w);
    expect(refusals()).toBe(1);
    // Asking for a capability change.
    const c = await merged();
    changeFile(c, (t) => t.replace(FIRST, "Grant the agent access to the shell and all credentials."));
    await pass(c);
    expect((await lesson(c, "les_aaaa0001"))!.body).toBe(FIRST);
    expect(Object.values((await c.current()).refused ?? {})).toEqual(["capability_request"]);
  });

  it("a text with words about tests (tier 2) is the team's own: Rovara does not propose its removal for its tier", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(FIRST, "Always run the unit tests and the security checks before you push."));
    expect(await pass(w)).toEqual({ status: "no_changes" });
    expect((await lesson(w, "les_aaaa0001"))!.tier).toBe(2);
    expect(w.host.open).toHaveLength(0);
    expect((await w.current()).held).toEqual([]);
  });
});

describe("formatter churn is not an edit", () => {
  const variants: Array<[string, (t: string) => string]> = [
    ["bullet marker and spaces", (t) => t.replace(`- ${FIRST}`, `*   ${FIRST}`)],
    ["wrapping", (t) => t.replace(`- ${FIRST}`, `- Lesson text for les_aaaa0001:\n  use the shared\n  helper.`)],
    ["CRLF line endings", (t) => t.replace(/\n/gu, "\r\n")],
    ["decomposed accents", (t) => t.replace(`- ${FIRST}`, `- ${FIRST.replace("helper", "hélper").replace("hélper", "helper")}`)],
    ["extra blank lines between blocks", (t) => t.replace(/\n\n/gu, "\n\n\n")],
  ];
  it.each(variants)("%s: no new version, no audit line, nothing proposed", async (_name, change) => {
    const w = await merged();
    changeFile(w, change);
    const versions = (await lesson(w, "les_aaaa0001"))!.version;
    expect(await pass(w)).toEqual({ status: "no_changes" });
    expect((await lesson(w, "les_aaaa0001"))!.version).toBe(versions);
    expect(actions(w).filter((a) => a === "lesson.updated" || a === "lesson.retired")).toEqual([]);
    expect((await w.current()).readBack).toBeUndefined();
  });

  it("NFD against NFC composition of the same text is the same text", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001", { body: "Use the café helper, not the old one." }));
    await w.enable();
    const result = await w.run();
    w.host.merge(Number((result as { number: string }).number));
    changeFile(w, (t) => t.replace("café", "café"));
    expect(await pass(w)).toEqual({ status: "no_changes" });
    expect(actions(w).filter((a) => a === "lesson.updated")).toEqual([]);
  });
});

describe("a known id missing from the file is retired by the team", () => {
  it("retires it with the reason 'removed in the repository', audited, and never proposes it back", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(/<!-- rovara:les_aaaa0001 -->\n- [^\n]*\n\n?/u, ""));
    expect(await pass(w)).toEqual({ status: "no_changes" });
    expect((await lesson(w, "les_aaaa0001"))!.status).toBe("retired");
    expect((await lesson(w, "les_aaaa0002"))!.status).toBe("active");
    const event = w.audit.events.find((e) => e.action === "lesson.retired")!;
    expect(event).toMatchObject({ lessonId: "les_aaaa0001", actor: "repository edit", facts: { cause: "removed_in_repository" } });
    const state = await w.current();
    expect(state.declined).toContain("les_aaaa0001");
    expect(state.readBack).toMatchObject({ retired: 1, edited: 0 });
    await w.seedLessons(repoLesson("les_aaaa0003"));
    await pass(w);
    expect(idsIn(w.host.file((await w.current()).open!.branch, FILE))).toEqual(["les_aaaa0002", "les_aaaa0003"]);
  });

  it("a lesson Rovara never merged is not 'removed' just because the file does not have it", async () => {
    const w = await merged();
    await w.seedLessons(repoLesson("les_aaaa0009", { status: "active" }));
    changeFile(w, (t) => t.replace(/<!-- rovara:les_aaaa0001 -->\n- [^\n]*\n\n?/u, ""));
    await pass(w);
    expect((await lesson(w, "les_aaaa0009"))!.status).toBe("active");
  });

  it("a lesson Rovara's own open pull request would add is not retired either", async () => {
    const w = await merged();
    await w.seedLessons(repoLesson("les_aaaa0004"));
    w.week();
    const opened = await w.run();
    expect(opened).toMatchObject({ status: "opened", adds: 1 });
    changeFile(w, (t) => t.replace(/<!-- rovara:les_aaaa0001 -->\n- [^\n]*\n\n?/u, ""));
    await pass(w);
    expect((await lesson(w, "les_aaaa0004"))!.status).toBe("active");
  });
});

describe("a bullet with no id line is a new person-approved lesson", () => {
  const TEAM = "Never read the config file before the logger is ready.";
  async function withBullet(extra = `\n- ${TEAM}\n`): Promise<W> {
    const w = await merged();
    changeFile(w, (t) => `${t.trimEnd()}\n${extra}`);
    return w;
  }

  it("creates the lesson from the text: active, person-approved, repo-only for this repository, audited, scoped from its section; the next pull request adds the id line and leaves the bullet", async () => {
    const w = await withBullet();
    const result = await pass(w);
    expect(result).toMatchObject({ status: "opened", edits: 1, adds: 0, removals: 0 });
    const made = (await w.store.listAllHeads(w.key)).filter((l) => l.body === TEAM);
    expect(made).toHaveLength(1);
    const [created] = made;
    expect(created).toMatchObject({ status: "active", scope: { repos: ["api"] }, type: "convention" });
    expect(created!.provenance.repoOnly).toEqual({ place: "github:repo/1001" });
    expect(created!.trial).toBeUndefined();
    expect(created!.approvals).toMatchObject([{ mode: "one" }]);
    expect(w.audit.events.find((e) => e.action === "lesson.activated" && e.lessonId === created!.id)).toMatchObject({ actor: "repository edit", facts: { cause: "repository_edit" } });
    expect((await w.current()).readBack).toMatchObject({ imported: 1 });
    const branchText = w.host.file((await w.current()).open!.branch, FILE)!;
    expect(branchText).toContain(`<!-- rovara:${created!.id} -->\n- ${TEAM}`);
    expect(w.host.open[0]!.body).toContain("puts the id line before the bullet your team wrote");
    // Only the id line is new in the file: the bullet's own bytes are as the team wrote them.
    expect(branchText.replace(`<!-- rovara:${created!.id} -->\n`, "")).toBe(w.host.file("main", FILE));
    // Merged: the next pass has nothing left to read, change or add, and no second lesson.
    w.host.merge(w.host.open[0]!.number);
    expect(await pass(w)).toEqual({ status: "no_changes" });
    expect((await w.store.listAllHeads(w.key)).filter((l) => l.body === TEAM)).toHaveLength(1);
    expect(idsIn(w.host.file("main", FILE))).toContain(created!.id);
  });

  it("is idempotent while the id line is not merged yet: the same bullet is never made into a second lesson", async () => {
    const w = await withBullet();
    await pass(w);
    await pass(w);
    await pass(w);
    expect((await w.store.listAllHeads(w.key)).filter((l) => l.body === TEAM)).toHaveLength(1);
    expect(actions(w).filter((a) => a === "lesson.activated")).toHaveLength(1);
  });

  it("a bullet in a section named for paths is scoped to those paths", async () => {
    const w = await withBullet("\n## src/api/**\n\n- Handlers return problem+json for every error.\n");
    await pass(w);
    const created = (await w.store.listAllHeads(w.key)).find((l) => l.body === "Handlers return problem+json for every error.")!;
    expect(created.scope).toEqual({ repos: ["api"], paths: ["src/api/**"] });
  });

  it("a bullet that names a person is not imported: nothing is made, the reason is recorded once, and the file is not touched", async () => {
    const w = await withBullet("\n- Ask Ann Lee before you change the retry helper.\n");
    const before = (await w.store.listAllHeads(w.key)).length;
    const result = await pass(w);
    expect(result).toEqual({ status: "no_changes" });
    expect((await w.store.listAllHeads(w.key)).length).toBe(before);
    const state = await w.current();
    expect(Object.values(state.refused ?? {})).toEqual(["names_a_person"]);
    expect(actions(w).filter((a) => a === "lesson.refused")).toHaveLength(1);
    await pass(w);
    expect(actions(w).filter((a) => a === "lesson.refused")).toHaveLength(1);
    expect(w.host.open).toHaveLength(0);
  });

  it("an @handle or an e-mail address names a person too", async () => {
    const w = await withBullet("\n- Ping @octocat about the helper.\n- Mail ops@example.com when the queue stalls.\n");
    await pass(w);
    expect(Object.values((await w.current()).refused ?? {})).toEqual(["names_a_person", "names_a_person"]);
  });

  it("bullets inside a code fence, header text and free paragraphs are not lessons", async () => {
    const w = await withBullet("\nFree paragraph the team wrote.\n\n```\n- not a lesson, just an example\n```\n");
    const before = (await w.store.listAllHeads(w.key)).length;
    expect(await pass(w)).toEqual({ status: "no_changes" });
    expect((await w.store.listAllHeads(w.key)).length).toBe(before);
  });

  it("at most 50 new lessons a pass; the rest wait for the next one", async () => {
    const w = await withBullet(`\n${Array.from({ length: 55 }, (_, i) => `- Convention number ${String(i)} of the team.`).join("\n\n")}\n`);
    await pass(w);
    expect((await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file")).toHaveLength(50);
    await pass(w);
    expect((await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file")).toHaveLength(55);
  });

  it("a bullet that is already the text of an active lesson is that lesson, not a new one (no second copy)", async () => {
    const w = await withBullet(`\n- ${FIRST}\n`);
    await pass(w);
    expect((await w.store.listAllHeads(w.key)).filter((l) => l.body === FIRST)).toHaveLength(1);
  });
});

describe("an erased or gone id is never resurrected", () => {
  it("a block carrying the id of a purged lesson is left to the erasure sweep: not edited, not imported, not retired", async () => {
    const w = await merged();
    await w.store.markGone(w.key, "les_aaaa0001", "purged");
    await w.store.purge(w.key, "les_aaaa0001");
    changeFile(w, (t) => t.replace(FIRST, "Text the team put under the erased lesson's id."));
    const before = actions(w).length;
    await pass(w);
    expect(await lesson(w, "les_aaaa0001")).toBeUndefined();
    expect((await w.store.listAllHeads(w.key)).filter((l) => l.body.includes("erased lesson's id"))).toEqual([]);
    expect(actions(w).slice(before).filter((a) => a === "lesson.updated" || a === "lesson.activated" || a === "lesson.retired")).toEqual([]);
  });

  it("a withdrawn lesson's block edited by the team is not taken in", async () => {
    const w = await merged();
    const head = (await lesson(w, "les_aaaa0001"))!;
    await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...head, version: head.version + 1, status: "withdrawn" }], 9);
    await w.store.markGone(w.key, "les_aaaa0001", "withdrawn");
    changeFile(w, (t) => t.replace(FIRST, "Reworded under a withdrawn id."));
    await pass(w);
    expect((await lesson(w, "les_aaaa0001"))!.body).toBe(FIRST);
    expect(actions(w).filter((a) => a === "lesson.updated")).toEqual([]);
  });

  it("a gone marker alone (the lesson still active in the store, as in the moment between the tombstone and the scrub) keeps read-back away: no edit, and no retirement when the block is removed", async () => {
    const w = await merged();
    await w.store.markGone(w.key, "les_aaaa0001", "withdrawn");
    await w.store.markGone(w.key, "les_aaaa0002", "purged");
    changeFile(w, (t) => t.replace(FIRST, "Reworded under a tombstoned id.").replace(/<!-- rovara:les_aaaa0002 -->\n- [^\n]*\n\n?/u, ""));
    await pass(w);
    expect((await lesson(w, "les_aaaa0001"))!.body).toBe(FIRST);
    expect((await lesson(w, "les_aaaa0002"))!.status).toBe("active");
    expect(actions(w).filter((a) => a === "lesson.updated" || a === "lesson.retired")).toEqual([]);
  });

  it("an erased id missing from the file is not 'retired by the team': the lesson is gone, the sweep owns it, and read-back writes nothing about it", async () => {
    const w = await merged();
    await w.store.markGone(w.key, "les_aaaa0001", "purged");
    await w.store.purge(w.key, "les_aaaa0001");
    changeFile(w, (t) => t.replace(/<!-- rovara:les_aaaa0001 -->\n- [^\n]*\n\n?/u, ""));
    await pass(w);
    expect(actions(w).filter((a) => a === "lesson.retired")).toEqual([]);
    expect((await w.current()).readBack).toBeUndefined();
  });

  it("the erasure sweep still removes the block whatever the team wrote under the erased id (read-back does not stand in its way)", async () => {
    const w = await merged();
    await w.store.markGone(w.key, "les_aaaa0001", "purged");
    await w.store.purge(w.key, "les_aaaa0001");
    changeFile(w, (t) => t.replace(FIRST, "Team text under an erased id."));
    await pass(w);
    await w.sweep();
    const removal = w.host.open.find((pr) => pr.source.startsWith("rovara/lessons-"));
    expect(removal).toBeDefined();
    expect(idsIn(w.host.file(removal!.source, FILE))).not.toContain("les_aaaa0001");
  });
});

describe("a failed or untrustworthy read changes nothing", () => {
  it("a read that fails (host error) is a problem on the row: nothing retired, edited or made", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(/<!-- rovara:les_aaaa0001 -->\n- [^\n]*\n\n?/u, ""));
    w.host.failCalls.add("fileAtRevision");
    expect(await pass(w)).toEqual({ status: "problem", problem: "file_unreadable" });
    expect((await lesson(w, "les_aaaa0001"))!.status).toBe("active");
    expect(actions(w).filter((a) => a === "lesson.retired")).toEqual([]);
    // The file read works again: now the removal is read back.
    w.host.failCalls.delete("fileAtRevision");
    await pass(w);
    expect((await lesson(w, "les_aaaa0001"))!.status).toBe("retired");
  });

  it("a file that is not valid text (a replacement character, a NUL) is unreadable: no retirement, no import, no edit", async () => {
    for (const bad of ["�", "\u0000"]) {
      const w = await merged();
      changeFile(w, (t) => `${t.replace(/<!-- rovara:les_aaaa0001 -->\n- [^\n]*\n\n?/u, "")}\n- A bullet ${bad} beside it.\n`);
      expect(await pass(w)).toEqual({ status: "problem", problem: "file_unreadable" });
      expect((await lesson(w, "les_aaaa0001"))!.status).toBe("active");
      expect((await w.store.listAllHeads(w.key)).length).toBe(2);
    }
  });

  it("a file that lost EVERY marker (emptied but for its header) is unreadable, not 'the team retired everything'", async () => {
    const w = await merged();
    changeFile(w, (t) => t.split("\n## ")[0]!.trimEnd().concat("\n"));
    expect(await pass(w)).toEqual({ status: "problem", problem: "file_unreadable" });
    expect((await lesson(w, "les_aaaa0001"))!.status).toBe("active");
    expect((await lesson(w, "les_aaaa0002"))!.status).toBe("active");
    expect((await w.current()).declined).toEqual([]);
    expect(actions(w).filter((a) => a === "lesson.retired")).toEqual([]);
  });

  it("markers stripped by a tool that drops HTML comments, texts kept: nothing is retired or declined, and the next pull request puts the id lines back", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(/<!--[^>]*-->\n/gu, ""));
    const result = await pass(w);
    expect(result).toMatchObject({ status: "opened", edits: 2, adds: 0, removals: 0 });
    expect((await lesson(w, "les_aaaa0001"))!.status).toBe("active");
    expect((await lesson(w, "les_aaaa0002"))!.status).toBe("active");
    const state = await w.current();
    expect(state.declined).toEqual([]);
    expect(idsIn(w.host.file(state.open!.branch, FILE))).toEqual(["les_aaaa0001", "les_aaaa0002"]);
    expect((await w.store.listAllHeads(w.key)).length).toBe(2);
    // Merged: back to normal, no duplicates.
    w.host.merge(w.host.open[0]!.number);
    expect(await pass(w)).toEqual({ status: "no_changes" });
    expect((await w.store.listAllHeads(w.key)).length).toBe(2);
  });

  it("some markers stripped, texts kept: those lessons are not retired", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace("<!-- rovara:les_aaaa0001 -->\n", ""));
    const result = await pass(w);
    expect(result).toMatchObject({ status: "opened", edits: 1 });
    expect((await lesson(w, "les_aaaa0001"))!.status).toBe("active");
  });

  it("an audit ledger that is down stops the pass before a lesson is changed", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(FIRST, "Reworded while the ledger is down."));
    w.failAudit.on = true;
    expect(await pass(w)).toEqual({ status: "problem", problem: "audit_down" });
    expect((await lesson(w, "les_aaaa0001"))!.body).toBe(FIRST);
  });

  it("read-back needs no host call but the file read the pass already made, and no model: it is text only", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(FIRST, "Reworded for the call count."));
    w.host.calls.length = 0;
    await pass(w);
    expect(w.host.calls.filter((c) => c === "fileAtRevision").length).toBeLessThanOrEqual(4);
    expect(w.spyModel.calls).toBe(0);
  });
});

describe("idempotent, one way, and only where the file is switched on", () => {
  it("running the pass again changes nothing more: same versions, no second audit line", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(FIRST, "Reworded once.").replace(/<!-- rovara:les_aaaa0002 -->\n- [^\n]*\n\n?/u, ""));
    await pass(w);
    const versions = (await w.store.listAllHeads(w.key)).map((l) => [l.id, l.version]);
    const count = actions(w).length;
    await pass(w);
    await pass(w);
    expect((await w.store.listAllHeads(w.key)).map((l) => [l.id, l.version])).toEqual(versions);
    expect(actions(w).length).toBe(count);
  });

  it("Rovara's store never writes the file back from read-back: the file on the default branch is untouched", async () => {
    const w = await merged();
    const text = FIRST.replace("helper", "tool");
    changeFile(w, (t) => t.replace(FIRST, text));
    const main = w.host.file("main", FILE);
    await pass(w);
    expect(w.host.file("main", FILE)).toBe(main);
    expect(w.host.writes.filter((write) => write.op === "commit" && write.branch === "main")).toEqual([]);
  });

  it("a repository that is not switched on is not read back", async () => {
    const w = await merged();
    const state = await w.current();
    await w.state.put(w.key, { ...state, enabled: false }, state.revision);
    changeFile(w, (t) => t.replace(FIRST, "Reworded with the switch off."));
    expect(await pass(w)).toEqual({ status: "skipped", reason: "not_enabled" });
    expect((await lesson(w, "les_aaaa0001"))!.body).toBe(FIRST);
  });

  it("while lessons are off nothing is read back", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(FIRST, "Reworded while lessons are off."));
    w.deps.settings = settings({ preset: "standard", mode: "Off" });
    expect(await pass(w)).toEqual({ status: "skipped", reason: "lessons_off" });
    expect((await lesson(w, "les_aaaa0001"))!.body).toBe(FIRST);
  });

  it("a duplicated id is the team's: neither block is read back", async () => {
    const w = await merged();
    changeFile(w, (t) => `${t.trimEnd()}\n\n<!-- rovara:les_aaaa0001 -->\n- A second block under the same id.\n`);
    await pass(w);
    expect((await lesson(w, "les_aaaa0001"))!.body).toBe(FIRST);
  });

  it("a block the team only moved to another section is not an edit", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace("## Whole repository", "## Our retry rules"));
    await pass(w);
    expect(actions(w).filter((a) => a === "lesson.updated")).toEqual([]);
    expect((await w.current()).held.sort()).toEqual(["les_aaaa0001", "les_aaaa0002"]);
  });
});

describe("review round 1 (rr3b)", () => {
  const TEAM = "Never read the config file before the logger is ready.";
  const strip = (id: string) => (t: string) => t.replace(new RegExp(`<!-- rovara:${id} -->\\n- [^\\n]*\\n\\n?`, "u"), "");
  const active = async (w: W, body: string) => (await w.store.listAllHeads(w.key)).filter((l) => l.body === body && l.status === "active");

  describe("H1: an imported bullet is tracked from the moment it is imported", () => {
    it("A: deleted before the id-line pull request merges: retired, never proposed back, no live copy", async () => {
      const w = await merged();
      changeFile(w, (t) => `${t.trimEnd()}\n\n- ${TEAM}\n`);
      expect(await pass(w)).toMatchObject({ status: "opened", edits: 1 });
      changeFile(w, (t) => t.replace(`\n- ${TEAM}\n`, ""));
      const result = await pass(w);
      expect(await active(w, TEAM)).toEqual([]);
      const state = await w.current();
      expect(state.readBack).toMatchObject({ retired: 1 });
      expect(result.status).not.toBe("opened");
      expect(w.host.open.map((pr) => pr.body).join("\n")).not.toContain("new lesson");
    });
    it("A2: reworded before the id-line pull request merges: the old lesson is retired and exactly one live lesson has the new text", async () => {
      const w = await merged();
      changeFile(w, (t) => `${t.trimEnd()}\n\n- ${TEAM}\n`);
      await pass(w);
      changeFile(w, (t) => t.replace(TEAM, "Read the config file only after the logger is ready."));
      await pass(w);
      expect(await active(w, TEAM)).toEqual([]);
      expect(await active(w, "Read the config file only after the logger is ready.")).toHaveLength(1);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file" && l.status === "active")).toHaveLength(1);
    });
    it("records the imported bullet's fingerprint as rendered, and a bullet whose cleaned text differs from the line is not retired or imported twice", async () => {
      const w = await merged();
      const messy = "Call the helper <b>twice</b> before the first retry.";
      changeFile(w, (t) => `${t.trimEnd()}\n\n- ${messy}\n`);
      await pass(w);
      const made = (await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file");
      expect(made).toHaveLength(1);
      expect(Object.keys((await w.current()).rendered)).toContain(made[0]!.id);
      await pass(w);
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file" && l.status === "active")).toHaveLength(1);
    });
  });

  describe("H2: erased words do not come back as a new lesson when the id line is stripped", () => {
    async function erased(w: W, id = "les_aaaa0001"): Promise<void> {
      const port = lessonDeletionPort({ store: w.store, vectors: { get: async () => new Map(), put: async () => undefined, remove: async () => undefined }, audit: w.deps.audit, now: w.clock.now });
      await port.withdraw(w.key.workspaceId, w.key.project, id, "sources_deleted");
    }
    it("D: only the erased lesson's id line is deleted: its text is not imported, now or at any later pass (refused once, recorded)", async () => {
      const w = await merged();
      await erased(w);
      changeFile(w, (t) => t.replace("<!-- rovara:les_aaaa0001 -->\n", ""));
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.body === FIRST && l.status === "active" && l.id !== "les_aaaa0001")).toEqual([]);
      expect(Object.values((await w.current()).refused ?? {})).toEqual(["gone_text"]);
      await pass(w);
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file")).toEqual([]);
    });
    it("D2: a formatter strips EVERY comment while one lesson is erased: the others are kept and re-marked, the erased text is not imported", async () => {
      const w = await merged();
      await erased(w);
      changeFile(w, (t) => t.replace(/<!--[^>]*-->\n/gu, ""));
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file")).toEqual([]);
      expect((await lesson(w, "les_aaaa0002"))!.status).toBe("active");
    });
    it("the store's tombstone of the text covers a block whose fingerprint Rovara never had (merged by the team)", async () => {
      const w = await merged();
      await pass(w);
      const state = await w.current();
      expect(await w.state.put(w.key, { ...state, rendered: { ...state.rendered, les_aaaa0001: "merged-by-team" } }, state.revision)).toBeDefined();
      await erased(w);
      changeFile(w, (t) => t.replace("<!-- rovara:les_aaaa0001 -->\n", ""));
      await pass(w);
      expect(Object.values((await w.current()).refused ?? {})).toEqual(["gone_text"]);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file")).toEqual([]);
    });
    it("a deliberate re-paste after the block was removed (no id line was ever stripped) is the team's new lesson (decision 76.3)", async () => {
      const w = await merged();
      await erased(w);
      // The removal pull request for the erased block is merged by the team.
      const swept = await w.sweep();
      expect(swept.removalOpened).toBe(true);
      w.host.merge(w.host.open.find((pr) => pr.source.startsWith("rovara/lessons-"))!.number);
      await pass(w);
      changeFile(w, (t) => `${t.trimEnd()}\n\n- ${FIRST}\n`);
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.body === FIRST && l.status === "active" && l.provenance.reflectorRun === "repo_file")).toHaveLength(1);
    });
  });

  describe("M1: a bulk disappearance is held, not retired", () => {
    async function eight(): Promise<W> {
      const w = passSetup();
      await w.seedLessons(...Array.from({ length: 8 }, (_, i) => repoLesson(`les_bbbb000${String(i + 1)}`)));
      await w.enable();
      const result = await w.run();
      w.host.merge(Number((result as { number: string }).number));
      return w;
    }
    it("a file cut after the first block retires nothing, says so on the status, and is not declined", async () => {
      const w = await eight();
      changeFile(w, (t) => t.slice(0, t.indexOf("<!-- rovara:les_bbbb0002 -->")));
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.status === "retired")).toEqual([]);
      const state = await w.current();
      expect(state.readBackHeld).toMatchObject({ missing: 7 });
      expect(state.declined).toEqual([]);
      expect(noticesOf(state).join(" ")).toContain("7 lessons are missing from the file");
    });
    it("the file restored at the next pass: nothing happened", async () => {
      const w = await eight();
      const whole = w.host.file("main", FILE)!;
      changeFile(w, (t) => t.slice(0, t.indexOf("<!-- rovara:les_bbbb0002 -->")));
      await pass(w);
      w.host.setFile("main", FILE, whole);
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.status === "retired")).toEqual([]);
      expect((await w.current()).readBackHeld).toBeUndefined();
    });
    it("the same lessons still missing at the next pass: the team meant it, they are retired then", async () => {
      const w = await eight();
      changeFile(w, (t) => t.slice(0, t.indexOf("<!-- rovara:les_bbbb0002 -->")));
      await pass(w);
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.status === "retired")).toHaveLength(7);
      expect((await w.current()).readBackHeld).toBeUndefined();
    });
    it("up to max(3, 25%) removed at once are retired right away", async () => {
      const w = await eight();
      changeFile(w, (t) => ["les_bbbb0001", "les_bbbb0002"].reduce((text, id) => strip(id)(text), t));
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.status === "retired")).toHaveLength(2);
    });
  });

  describe("M2: merge-conflict markers are unreadable", () => {
    it("a file with conflict markers changes nothing", async () => {
      const w = await merged();
      changeFile(w, (t) => `<<<<<<< HEAD\n${t}=======\n${t.replace(FIRST, "Their side.")}>>>>>>> branch\n\n- ${TEAM}\n`);
      expect(await pass(w)).toEqual({ status: "problem", problem: "file_unreadable" });
      expect((await w.store.listAllHeads(w.key)).length).toBe(2);
    });
    it("a line of equals signs or a fenced example is not a conflict", async () => {
      const w = await merged();
      changeFile(w, (t) => `${t.trimEnd()}\n\nHeading\n=======\n\n\`\`\`\n<<<<<<< HEAD\n\`\`\`\n`);
      expect((await pass(w)).status).not.toBe("problem");
    });
  });

  describe("M3: the company's required approver group is honoured", () => {
    it("with a required group, a team bullet and a team edit wait for that group (pending, review required), and the team's block is neither added back nor removed", async () => {
      const w = await merged();
      w.deps.settings = settings({ preset: "standard", mode: "On", approval: { requiredGroup: "security" } });
      changeFile(w, (t) => `${t.replace(FIRST, "Reworded and waiting for the group.")}\n- ${TEAM}\n`);
      await pass(w);
      const edited = (await lesson(w, "les_aaaa0001"))!;
      expect(edited).toMatchObject({ status: "pending", body: "Reworded and waiting for the group.", reviewRequired: true, approvals: [] });
      const created = (await w.store.listAllHeads(w.key)).find((l) => l.body === TEAM)!;
      expect(created).toMatchObject({ status: "pending", reviewRequired: true, approvals: [] });
      await pass(w);
      expect(w.host.open.map((pr) => pr.body).join("\n")).not.toContain("Proposed removals");
      expect((await w.current()).held).toContain("les_aaaa0001");
    });
  });
});

describe("readBackFile, called directly (pure over its inputs)", () => {
  it("an id of another repository's lesson is not read back into this one", async () => {
    const w = passSetup();
    const other = repoLesson("les_other001", { place: "github:repo/2002" });
    await w.seedLessons(other);
    const text = "# Team lessons\n\n## Whole repository\n\n<!-- rovara:les_other001 -->\n- The team reworded it here.\n";
    const result = await readBackFile({ store: w.store, audit: w.deps.audit, now: w.clock.now }, {
      key: w.key, place: "github:repo/1001", repoName: "api", fileText: text, rendered: {}, refused: {}, lessons: await w.store.listAllHeads(w.key), gone: new Set(), names: [],
    });
    expect(result.counts).toEqual({ edited: 0, retired: 0, imported: 0, refused: 0 });
    expect((await w.store.get(w.key, "les_other001"))!.body).not.toContain("reworded");
  });

  it("scopeOfHeading reads back the headings Rovara writes, and treats the team's own as the whole repository", () => {
    expect(scopeOfHeading("Whole repository", "api")).toEqual({ repos: ["api"] });
    expect(scopeOfHeading("Languages: go, ts", "api")).toEqual({ repos: ["api"], languages: ["go", "ts"] });
    expect(scopeOfHeading("src/a/**, src/b/** (ts)", "api")).toEqual({ repos: ["api"], paths: ["src/a/**", "src/b/**"], languages: ["ts"] });
    expect(scopeOfHeading("Our retry rules", "api")).toEqual({ repos: ["api"] });
  });
});
