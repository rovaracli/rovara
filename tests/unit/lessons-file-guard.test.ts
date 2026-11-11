// Lessons in the repo, lane R2 (owner decision 50.4): a task's pull request may not touch `.rovara/lessons.md`. The path rule (shared by the worker's push check and the broker's merge check) and the broker's check through the
// code host's changed files: a rename counts under both names, a list cut short or unreadable fails closed.
import { describe, expect, it } from "vitest";
import type { ChangeRequestFilesPage } from "@rovara-code/contracts";
import { leavesLessonsFileAlone, touchesCompanyRulesFile, touchesLessonsFile } from "../../packages/broker/src/rovara-code/lessons-file-guard.js";
import { COMPANY_RULES_FILE_REFUSAL, LESSONS_FILE_REFUSAL, assertLessonsFileUntouched, assertPushCarriesNoLessonsFile as pushGuard, isCompanyRulesFilePath, isLessonsFilePath } from "../../packages/worker/src/lessons-file-guard.js";

const REF = { repository: { url: "https://github.com/acme/api" }, id: "7", url: "" };
const SCOPE = { system: "install" } as never;
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

// ---- review M2: EVERY worker push goes through one guarded function (real git) ----
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll } from "vitest";
import { LESSONS_FILE_MERGE_REFUSAL, assertPushCarriesNoLessonsFile } from "../../packages/worker/src/lessons-file-guard.js";
import { deleteBranchOn } from "../../packages/broker/src/github-commit-files.js";

const run = promisify(execFile);
const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "rovara-guard-"));
  dirs.push(dir);
  const git = async (args: string[]): Promise<string> => (await run("git", args, { cwd: dir, env: GIT_ENV })).stdout;
  await git(["init", "-q", "--initial-branch=main"]);
  await mkdir(join(dir, ".rovara"), { recursive: true });
  await writeFile(join(dir, ".rovara/lessons.md"), "base\n");
  await writeFile(join(dir, "a.txt"), "a\n");
  await git(["add", "-A"]); await git(["commit", "-q", "-m", "base"]);
  return { dir, git, write: (path: string, text: string) => writeFile(join(dir, path), text), commit: async (message: string) => { await git(["add", "-A"]); await git(["commit", "-q", "-m", message]); return (await git(["rev-parse", "HEAD"])).trim(); } };
}

describe("the guard on a push that adds a commit to an existing pull request", () => {
  it("refuses a commit that edits or deletes the file, and passes one that does not (positive control)", async () => {
    const r = await repo();
    await r.write("a.txt", "b\n");
    await expect(assertPushCarriesNoLessonsFile(r.git, await r.commit("clean"))).resolves.toBeUndefined();
    await r.write(".rovara/lessons.md", "sneaky\n");
    await expect(assertPushCarriesNoLessonsFile(r.git, await r.commit("edit"))).rejects.toThrow(LESSONS_FILE_REFUSAL);
    await rm(join(r.dir, ".rovara/lessons.md"));
    await expect(assertPushCarriesNoLessonsFile(r.git, await r.commit("delete"))).rejects.toThrow(LESSONS_FILE_REFUSAL);
  });

  it("a merge of the base that changed the file is not flagged; a person's earlier change on the branch is not flagged; a conflict resolution that differs from both parents is", async () => {
    const r = await repo();
    await r.git(["checkout", "-q", "-b", "pr"]);
    await r.write(".rovara/lessons.md", "a person's change on the pull request\n");
    await r.write("a.txt", "pr\n");
    await r.commit("person");
    await r.git(["checkout", "-q", "main"]);
    await r.write("b.txt", "main\n");
    await r.commit("main moves");
    // The base moves the lessons file; the pull request branch also holds the person's version of it.
    await r.git(["checkout", "-q", "pr"]);
    await r.git(["merge", "-q", "--no-edit", "main"]);
    await expect(assertPushCarriesNoLessonsFile(r.git, "HEAD")).resolves.toBeUndefined();
    // A merge commit whose tree takes the lessons file from neither parent.
    await r.write(".rovara/lessons.md", "third version\n");
    await r.git(["add", "-A"]); await r.git(["commit", "-q", "--amend", "--no-edit"]);
    await expect(assertPushCarriesNoLessonsFile(r.git, "HEAD")).rejects.toThrow(LESSONS_FILE_MERGE_REFUSAL);
    expect((await readFile(join(r.dir, ".rovara/lessons.md"), "utf8"))).toBe("third version\n");
  });

  it("every push of maintain-pull-request.ts goes through the one guarded function", async () => {
    const text = await readFile("packages/worker/src/maintain-pull-request.ts", "utf8");
    expect((text.match(/credentialedGit\([^\n]*\["push"/gu) ?? []).length).toBe(1);
    expect(text).toMatch(/async function push\([^\n]*\n[^\n]*\n[^\n]*\n\s*await assertPushCarriesNoLessonsFile\(/u);
    expect((text.match(/"push"/gu) ?? []).length).toBe(1);
  });
});

describe("review L3: deleting a branch", () => {
  const context = (status: number, message?: string) => ({ fetch: (async () => new Response(message === undefined ? null : JSON.stringify({ message }), { status })) as typeof fetch, owner: "acme", name: "api", token: "t" });
  it("only GitHub's own 'Reference does not exist' means gone; a 404, another 422 or a 403 is a failure the caller tries again", async () => {
    expect(await deleteBranchOn(context(204), "rovara/lessons-0123456789ab")).toBe("deleted");
    expect(await deleteBranchOn(context(422, "Reference does not exist"), "rovara/lessons-0123456789ab")).toBe("gone");
    for (const [status, message] of [[404, "Not Found"], [422, "Something else"], [403, "Resource not accessible"]] as const) await expect(deleteBranchOn(context(status, message), "rovara/lessons-0123456789ab")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(deleteBranchOn(context(204), "main")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

// ---- G-04: the company rules file is guarded the same way
describe("the company rules file", () => {
  it.each([
    [".rovara/company-rules.md", true], [".Rovara/Company-Rules.MD", true], ["./.rovara/company-rules.md", true], [".rovara\\company-rules.md", true], [".rovara/company-rules.md/x", true],
    [".rovara/company-rules.md.bak", false], ["company-rules.md", false], ["docs/.rovara/company-rules.md", false], [".rovara/project.yaml", false], [".rovara/lessons.md", false],
  ])("%s -> %s", (path, expected) => { expect(isCompanyRulesFilePath(path)).toBe(expected); expect(touchesCompanyRulesFile(path)).toBe(expected); });

  it("the connected path counts too, in the broker's check", () => {
    expect(touchesCompanyRulesFile("docs/our-rules.md", "docs/our-rules.md")).toBe(true);
    expect(touchesCompanyRulesFile("Docs/Our-Rules.md", "docs/our-rules.md")).toBe(true);
    expect(touchesCompanyRulesFile("docs/other.md", "docs/our-rules.md")).toBe(false);
  });

  it("the broker's check refuses a pull request that changes it (an add, a rename either way) with its own reason, and a clean one passes", async () => {
    const REF2 = { repository: { url: "https://github.com/acme/api" }, id: "7", url: "" };
    const files = (list: Array<{ path: string; previousPath?: string }>) => ({ changedFiles: async () => ({ files: list.map((item) => ({ ...item, status: "modified", additions: 1, deletions: 0 })) }) });
    for (const list of [[{ path: ".rovara/company-rules.md" }], [{ path: "x.md", previousPath: ".rovara/company-rules.md" }]]) {
      expect(await leavesLessonsFileAlone(files(list), REF2, SCOPE)).toEqual({ ok: false, reason: "touches_company_rules" });
    }
    expect(await leavesLessonsFileAlone(files([{ path: "docs/our-rules.md" }]), REF2, SCOPE, { companyRulesPath: "docs/our-rules.md" })).toEqual({ ok: false, reason: "touches_company_rules" });
    expect(await leavesLessonsFileAlone(files([{ path: "docs/our-rules.md" }]), REF2, SCOPE)).toEqual({ ok: true });
    // The lessons file still has its own reason, and is checked first.
    expect(await leavesLessonsFileAlone(files([{ path: ".rovara/lessons.md" }, { path: ".rovara/company-rules.md" }]), REF2, SCOPE)).toEqual({ ok: false, reason: "touches" });
  });

  it("the worker refuses to push a change to it, with the fixed sentence, on a first push and on a push onto an existing pull request", async () => {
    const out = (paths: string[]) => async () => `${paths.join("\0")}\0`;
    await expect(assertLessonsFileUntouched(out(["src/a.ts", ".rovara/company-rules.md"]), "c".repeat(40), "b".repeat(40))).rejects.toThrow(COMPANY_RULES_FILE_REFUSAL);
    await expect(assertLessonsFileUntouched(out(["src/a.ts"]), "c".repeat(40), "b".repeat(40))).resolves.toBeUndefined();
    // On a pull request: a commit that differs from its one parent in the file is refused with the company sentence; the lessons sentence is kept for the lessons file.
    const git = (diff: string) => async (args: string[]) => (args[0] === "rev-list" ? `${"c".repeat(40)} ${"b".repeat(40)}` : diff);
    await expect(pushGuard(git(".rovara/company-rules.md\0"), "HEAD")).rejects.toThrow(COMPANY_RULES_FILE_REFUSAL);
    await expect(pushGuard(git(".rovara/lessons.md\0"), "HEAD")).rejects.toThrow(LESSONS_FILE_REFUSAL);
    await expect(pushGuard(git("src/a.ts\0"), "HEAD")).resolves.toBeUndefined();
  });
});
