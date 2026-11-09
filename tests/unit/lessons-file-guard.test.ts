// Lessons in the repo, lane R2 (owner decision 50.4): a task's pull request may not touch `.rovara/lessons.md`. The path rule (shared by the worker's push check and the broker's merge check) and the broker's check through the
// code host's changed files: a rename counts under both names, a list cut short or unreadable fails closed.
import { describe, expect, it } from "vitest";
import type { ChangeRequestFilesPage } from "@agentx/contracts";
import { leavesLessonsFileAlone, touchesLessonsFile } from "../../packages/broker/src/rovara-code/lessons-file-guard.js";
import { LESSONS_FILE_REFUSAL, assertLessonsFileUntouched, isLessonsFilePath } from "../../packages/worker/src/lessons-file-guard.js";

const REF = { repository: { url: "https://github.com/acme/api" }, id: "7", url: "" };
const SCOPE = { system: "private-install" } as never;
const file = (path: string, previousPath?: string) => ({ path, status: "modified", additions: 1, deletions: 0, ...(previousPath === undefined ? {} : { previousPath }) });
const host = (pages: ChangeRequestFilesPage[] | Error) => ({ changedFiles: async (_ref: unknown, page: number) => { if (pages instanceof Error) throw pages; return pages[page - 1] ?? { files: [] }; } });

describe("which paths count", () => {
  it.each([
    [".rovara/lessons.md", true], [".Rovara/Lessons.MD", true], ["./.rovara/lessons.md", true], [".rovara\\lessons.md", true], [".rovara/lessons.md/", true], [".rovara", true], [".rovara/lessons.md/x", true],
    [".rovara/project.yaml", false], [".rovara/rules/a.md", false], ["docs/.rovara/lessons.md", false], [".rovara/lessons.md.bak", false], ["lessons.md", false], ["", false],
  ])("%s -> %s", (path, expected) => {
    expect(touchesLessonsFile(path)).toBe(expected);
    expect(isLessonsFilePath(path)).toBe(expected);
  });
  it("compares as NFC", () => { expect(touchesLessonsFile(".rovara/lessons.md".normalize("NFD"))).toBe(true); });
});

describe("the broker's check through the code host", () => {
  it("passes a change that leaves the file alone (positive control: the list was read)", async () => {
    let asked = 0;
    const counting = { changedFiles: async () => { asked += 1; return { files: [file("src/a.ts"), file(".rovara/project.yaml")] }; } };
    expect(await leavesLessonsFileAlone(counting, REF, SCOPE)).toEqual({ ok: true });
    expect(asked).toBe(1);
  });
  it("refuses an add, an edit or a delete of the file, and a rename in either direction", async () => {
    for (const files of [[file(".rovara/lessons.md")], [file("src/a.ts"), file("notes/new.md", ".rovara/lessons.md")], [file(".rovara/lessons.md", "old/name.md")]]) {
      expect(await leavesLessonsFileAlone(host([{ files }]), REF, SCOPE)).toEqual({ ok: false, reason: "touches" });
    }
  });
  it("fails closed on a list cut short, and on a host that cannot answer", async () => {
    const endless = Array.from({ length: 12 }, (_, i) => ({ files: [file(`src/f${String(i)}.ts`)], nextPage: i + 2 }));
    expect(await leavesLessonsFileAlone(host(endless), REF, SCOPE)).toEqual({ ok: false, reason: "incomplete" });
    expect(await leavesLessonsFileAlone(host(new Error("down")), REF, SCOPE)).toEqual({ ok: false, reason: "unreadable" });
    // A path on a later page still counts.
    expect(await leavesLessonsFileAlone(host([{ files: [file("a")], nextPage: 2 }, { files: [file(".rovara/lessons.md")] }]), REF, SCOPE)).toEqual({ ok: false, reason: "touches" });
  });
});

describe("the worker's check on a diff", () => {
  const gitReturning = (out: string) => async () => out;
  it("passes a clean diff, refuses a touched one with the fixed sentence, and fails closed when the diff cannot be read", async () => {
    await expect(assertLessonsFileUntouched(gitReturning("src/a.ts\0.rovara/project.yaml\0"), "c".repeat(40), "b".repeat(40))).resolves.toBeUndefined();
    await expect(assertLessonsFileUntouched(gitReturning("src/a.ts\0.rovara/lessons.md\0"), "c".repeat(40), "b".repeat(40))).rejects.toThrow(LESSONS_FILE_REFUSAL);
    await expect(assertLessonsFileUntouched(async () => { throw new Error("git failed"); }, "c".repeat(40), "b".repeat(40))).rejects.toThrow(/could not read the list of files/);
  });
  it("without a base uses the commit's first parent, or the empty tree for a root commit", async () => {
    const seen: string[][] = [];
    await assertLessonsFileUntouched(async (args) => { seen.push(args); return args[0] === "rev-parse" ? "a".repeat(40) : ""; }, "c".repeat(40));
    expect(seen[1]!.slice(-2)).toEqual(["a".repeat(40), "c".repeat(40)]);
    seen.length = 0;
    await assertLessonsFileUntouched(async (args) => { seen.push(args); if (args[0] === "rev-parse") throw new Error("no parent"); return ""; }, "c".repeat(40));
    expect(seen[1]!.slice(-2)).toEqual(["4b825dc642cb6eb9a060e54bf8d69288fbee4904", "c".repeat(40)]);
  });
});
