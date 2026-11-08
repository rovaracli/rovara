// Approve by exception (DECISIONS 24): the pull request description says how many lessons the task used. For a repository KNOWN to be private it lists them, with a link per lesson to mark it not helpful
// (the link opens the task page, a page that asks); for a public repository or one of unknown visibility it carries only the count and one link (H4). Version 1 and version 2 descriptions both have it (M5).
// The list shrinks with the other lists, the markers stay, titles are inert, a restricted lesson is never named.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot } from "../../../packages/contracts/src/task-workflow-node.js";
import { workflowPullRequestBody, workflowPullRequestStatusLines } from "../../../packages/broker/src/aws/developer-tasks.js";
import { rovaraPullRequestBody, ROVARA_STATUS_END, ROVARA_STATUS_START, PULL_REQUEST_BODY_MAX_BYTES } from "../../../packages/broker/src/rovara-code/pull-request-body.js";
import { repositoryVisibilityOf } from "../../../packages/broker/src/aws/broker/lessons-wiring.js";
import { lessonsUsedForTask, lessonsUsedReaderOver, lessonsUsedSection, notHelpfulUrl, setLessonsUsedReader, visibilityOfRepositories } from "../../../packages/broker/src/lessons/used-in-pr.js";
import { InMemoryLessonStore, type LoadManifest } from "../../../packages/broker/src/lessons/store.js";
import { withLessonAudiences, type LessonAudiencePort, type LessonTaskAudience } from "../../../packages/broker/src/lessons/task-audience.js";
import { PROJECT, WS, allowAllAccess, draft, lessonRecord, seed, settings, wideAudience } from "./lesson-helpers.js";

const now = "2026-10-25T12:00:00.000Z";
const code = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
const review = (role: "CRITIC" | "SECURITY") => ({ operationId: randomUUID(), candidateDigest: code.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now });
const workflow = WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now, definitionVersion: "1.1.0" }),
  stage: "PULL_REQUEST", state: "READY", candidate: code,
  checkPolicy: { required: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
  verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
  reviews: [review("CRITIC"), review("SECURITY")],
});
const PAGE = "https://app.example.test/review/8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6/task";
const entry = (id: string, title = `Lesson ${id}`) => ({ title, notHelpfulUrl: notHelpfulUrl(PAGE, id)! });
const section = (entries: Array<{ title: string; notHelpfulUrl: string }>, count = entries.length) => ({ count, taskUrl: PAGE, entries });
const context = { changedFiles: { files: [{ repository: "payments", path: "src/retry.ts", added: 3, removed: 1 }], complete: true } };

describe("the description's Lessons used section", () => {
  it("lists each lesson with a not-helpful link to the task page, inside the marked block", () => {
    const body = rovaraPullRequestBody({ summary: ["Retry the call."], fallbackTitle: "t", workflow, context: { ...context, lessonsUsed: section([entry("les_aaaa1111", "Retries use withRetry"), entry("les_bbbb2222")]) }, reviewLines: () => [], pageUrl: PAGE });
    const block = body.slice(body.indexOf(ROVARA_STATUS_START), body.indexOf(ROVARA_STATUS_END));
    expect(block).toContain("## Lessons used");
    expect(block).toContain(`- Retries use withRetry ([not helpful](${PAGE}?notHelpful=les_aaaa1111))`);
    expect(block).toContain(`- Lesson les_bbbb2222 ([not helpful](${PAGE}?notHelpful=les_bbbb2222))`);
    expect(body.indexOf("## Lessons used")).toBeLessThan(body.indexOf("## Risk"));
  });

  it("H4: with no titles (a public repository, or visibility unknown) the section is the count and ONE link to the task page", () => {
    const lines = workflowPullRequestStatusLines(workflow, { ...context, lessonsUsed: { count: 3, taskUrl: PAGE, entries: [] } }).join("\n");
    expect(lines).toContain("## Lessons used");
    expect(lines).toContain("Rovara used 3 lessons from this project's record.");
    expect(lines).toContain(`[task page](${PAGE})`);
    expect(lines).not.toContain("notHelpful");
    expect(lines.split(PAGE).length - 1).toBe(1);
    expect(workflowPullRequestStatusLines(workflow, { ...context, lessonsUsed: { count: 1, taskUrl: "http://insecure.test/x", entries: [] } }).join("\n")).not.toContain("http://insecure.test");
  });

  it("M5: a version 1 description has the section too (same rule)", () => {
    const v1 = WorkflowSnapshotSchema.parse({ ...workflow, definitionVersion: "1.0.0" });
    expect(v1.definitionVersion).not.toBe("1.1.0");
    const withTitles = workflowPullRequestStatusLines(v1, { lessonsUsed: section([entry("les_aaaa1111", "Retries use withRetry")]) }).join("\n");
    expect(withTitles).toContain("## Lessons used");
    expect(withTitles).toContain(`- Retries use withRetry ([not helpful](${PAGE}?notHelpful=les_aaaa1111))`);
    const countOnly = workflowPullRequestStatusLines(v1, { lessonsUsed: { count: 2, taskUrl: PAGE, entries: [] } }).join("\n");
    expect(countOnly).toContain("Rovara used 2 lessons");
    expect(countOnly).not.toContain("notHelpful");
    expect(workflowPullRequestStatusLines(v1, {}).join("\n")).not.toContain("Lessons used");
  });

  // R1 (re-check round 1): the FULL description a task opens with, built by workflowPullRequestBody, for both versions. A public or unknown repository gets the count and one link; a private one gets titles.
  describe("R1: the whole opening description, both versions", () => {
    const openingTask = { title: "Add a retry flag" } as never;
    const v1 = WorkflowSnapshotSchema.parse({ ...workflow, definitionVersion: "1.0.0" });
    const bodyOf = (wf: typeof workflow, lessonsUsed: ReturnType<typeof section> | undefined) =>
      workflowPullRequestBody(openingTask, wf, "Retry the call.", PAGE, { ...context, ...(lessonsUsed === undefined ? {} : { lessonsUsed }) });
    const statusBlock = (body: string, start: string, end: string) => body.slice(body.indexOf(start), body.indexOf(end));
    it("version 1: a private repository lists titles with not-helpful links, a public one only the count and one link, none when no lesson was used", () => {
      expect(v1.definitionVersion).toBe("1.0.0");
      const listed = bodyOf(v1, section([entry("les_aaaa1111", "Retries use withRetry")]));
      expect(listed).toContain("## Lessons used");
      expect(listed).toContain(`- Retries use withRetry ([not helpful](${PAGE}?notHelpful=les_aaaa1111))`);
      // It sits inside the marked block, so a pushed fix rewrites it with the rest.
      expect(statusBlock(listed, "<!-- agentx:checks-and-reviews -->", "<!-- /agentx:checks-and-reviews -->")).toContain("## Lessons used");
      const countOnly = bodyOf(v1, { count: 4, taskUrl: PAGE, entries: [] });
      expect(countOnly).toContain("Rovara used 4 lessons from this project's record.");
      expect(countOnly).toContain(`[task page](${PAGE})`);
      expect(countOnly).not.toContain("notHelpful");
      expect(bodyOf(v1, undefined)).not.toContain("Lessons used");
      expect(bodyOf(v1, section([], 0))).not.toContain("Lessons used");
    });
    it("version 2: the same, from the same call", () => {
      expect(workflow.definitionVersion).toBe("1.1.0");
      const listed = bodyOf(workflow, section([entry("les_bbbb2222", "Config defaults come first")]));
      expect(listed).toContain("## Lessons used");
      expect(listed).toContain(`- Config defaults come first ([not helpful](${PAGE}?notHelpful=les_bbbb2222))`);
      expect(listed.slice(listed.indexOf(ROVARA_STATUS_START), listed.indexOf(ROVARA_STATUS_END))).toContain("## Lessons used");
      const countOnly = bodyOf(workflow, { count: 2, taskUrl: PAGE, entries: [] });
      expect(countOnly).toContain("Rovara used 2 lessons");
      expect(countOnly).not.toContain("notHelpful");
      expect(bodyOf(workflow, undefined)).not.toContain("Lessons used");
    });
  });

  it("rewrites with the status block after a fix, and has no section when no lesson was used", () => {
    expect(workflowPullRequestStatusLines(workflow, { ...context, lessonsUsed: section([entry("les_aaaa1111")]) }).join("\n")).toContain("## Lessons used");
    expect(workflowPullRequestStatusLines(workflow, context).join("\n")).not.toContain("Lessons used");
    expect(workflowPullRequestStatusLines(workflow, { ...context, lessonsUsed: section([], 0) }).join("\n")).not.toContain("Lessons used");
  });

  it("titles are inert (no mention, no link, no hidden comment) and a link that is not https is left out", () => {
    const hostile = "Use <!-- x --> [click](https://evil.example) @mallory";
    const lines = workflowPullRequestStatusLines(workflow, { ...context, lessonsUsed: section([{ title: hostile, notHelpfulUrl: PAGE + "?notHelpful=les_aaaa1111" }, { title: "plain", notHelpfulUrl: "javascript:alert(1)" }]) }).join("\n");
    expect(lines).not.toContain("<!--");
    expect(lines).not.toContain("https://evil.example");
    expect(lines).not.toMatch(/@mallory/u);
    expect(lines).toContain("- plain");
    expect(lines).not.toContain("javascript:");
  });

  it("many lessons shrink to fit: the body stays under the cap with its markers", () => {
    const many = Array.from({ length: 300 }, (_, i) => entry(`les_${String(i).padStart(8, "0")}`, "A".repeat(100)));
    const body = rovaraPullRequestBody({ summary: ["x".repeat(400)], fallbackTitle: "t", workflow, context: { ...context, lessonsUsed: section(many) }, reviewLines: () => [], pageUrl: PAGE });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_BYTES);
    expect(body).toContain(ROVARA_STATUS_START);
    expect(body).toContain(ROVARA_STATUS_END);
    expect(body).toContain("## Risk");
  });
});

describe("the reader behind it", () => {
  const manifest = (ids: Array<[string, LoadManifest["lessons"][number]["citation"]]>): LoadManifest => ({
    taskId: "task-1", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1,
    lessons: ids.map(([id, citation]) => ({ id, version: 1, score: 0.5, why: "scope" as const, citation })), bytes: 10,
  });
  const input = { orgId: WS, project: PROJECT, taskId: "task-1", pageUrl: PAGE };
  const names = { memberName: async (_org: unknown, id: string) => ({ ann: "Ann Archer" })[id as "ann"], isErased: async () => false } as never;
  async function seeded(extra: Parameters<typeof lessonRecord>[0][] = []) {
    const store = new InMemoryLessonStore();
    const restricted = { ...draft().provenance, audience: { kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:C1", principals: ["U1"], capturedAt: "x", liveCheck: "none" as const } } };
    await seed(store, lessonRecord({ id: "les_open0001", title: "Open lesson", tier: 1 }), lessonRecord({ id: "les_secret01", title: "Secret lesson", provenance: restricted }), lessonRecord({ id: "les_dropped1", title: "Dropped lesson" }), ...extra.map((e) => lessonRecord(e)));
    await store.putManifest(manifest([["les_open0001", "valid"], ["les_secret01", "valid"], ["les_dropped1", "stale_dropped"], ["les_open0001", "moved"], ["les_gone0001", "valid"]]));
    return store;
  }
  it("a PRIVATE repository: names only lessons that reached the prompt and are open to the project; never a restricted one; none when learning is off", async () => {
    const store = await seeded();
    const read = lessonsUsedReaderOver({ store, settings: settings(), access: allowAllAccess, names, visibility: async () => "private" });
    expect(await read(input)).toEqual({ count: 1, taskUrl: PAGE, items: [{ id: "les_open0001", title: "Open lesson", notHelpfulUrl: `${PAGE}?notHelpful=les_open0001` }] });
    expect(await lessonsUsedReaderOver({ store, settings: settings({ mode: "Off" }), access: allowAllAccess, names, visibility: async () => "private" })(input)).toBeUndefined();
    expect(await read({ ...input, pageUrl: undefined })).toBeUndefined();
    expect(await read({ ...input, project: "other" })).toBeUndefined();
    expect(lessonsUsedSection(await read(input))).toEqual({ count: 1, taskUrl: PAGE, entries: [{ title: "Open lesson", notHelpfulUrl: `${PAGE}?notHelpful=les_open0001` }] });
  });

  it("H4: a PUBLIC repository, an unknown one, a visibility that cannot be read, or no reader at all: the count and the link, never a title", async () => {
    const store = await seeded();
    for (const visibility of [async () => "public" as const, async () => "unknown" as const, async (): Promise<"private"> => { throw new Error("down"); }, undefined]) {
      const read = lessonsUsedReaderOver({ store, settings: settings(), access: allowAllAccess, names, ...(visibility === undefined ? {} : { visibility }) });
      const out = await read(input);
      expect(out).toEqual({ count: 1, taskUrl: PAGE, items: [] });
      expect(JSON.stringify(out)).not.toContain("Open lesson");
    }
  });

  it("a private repository still lists no tier-2 or review-check lesson, and no title or body that names a person (or whose authors cannot be named)", async () => {
    const store = await seeded([
      { id: "les_tier2001", title: "Tier two lesson", tier: 2 }, { id: "les_check001", title: "Review check lesson", type: "review_check", tier: 1 },
      { id: "les_named001", title: "Ask @ann first", tier: 1 }, { id: "les_body0001", title: "Plain title", body: "Ann Archer prefers withRetry here.", tier: 1, provenance: { ...draft().provenance, authors: ["ann"] } },
    ]);
    await store.putManifest({ ...manifest([["les_tier2001", "valid"], ["les_check001", "valid"], ["les_named001", "valid"], ["les_body0001", "valid"]]), round: 2 });
    const listed = (await lessonsUsedReaderOver({ store, settings: settings(), access: allowAllAccess, names, visibility: async () => "private" })(input))!;
    expect(listed.items.map((i) => i.id)).toEqual(["les_open0001"]);
    expect(listed.count).toBe(5);
    // Without a names reader nothing can be shown as harmless.
    const blind = (await lessonsUsedReaderOver({ store, settings: settings(), access: allowAllAccess, visibility: async () => "private" })(input))!;
    expect(blind.items).toEqual([]);
  });

  it("LV-1 / decisions 31 and 32: a lesson from a task that hides someone the pull request's task shows it to is neither counted nor named; one the task may still be given is counted, and NAMED only if every source task is open to the whole project", async () => {
    const store = await seeded([{ id: "les_narrow001", title: "Narrowed lesson", tier: 1, provenance: { ...draft().provenance, supportTasks: ["t-narrow"] } }, { id: "les_wide00001", title: "Wide lesson", tier: 1, provenance: { ...draft().provenance, supportTasks: ["t-wide"] } }]);
    await store.putManifest({ ...manifest([["les_narrow001", "valid"], ["les_wide00001", "valid"]]), round: 2 });
    const reads: string[][] = [];
    const table: Record<string, LessonTaskAudience> = { "task-1": wideAudience(), "t-narrow": wideAudience({ denied: new Set(["bob"]) }), "t-wide": wideAudience() };
    const gone = new Set<string>();
    // Every other task (the open lesson's) is open to the whole project.
    const audiences: LessonAudiencePort = { read: async (_o, ids) => { reads.push([...ids]); return new Map(ids.map((id) => [id, gone.has(id) ? undefined : table[id] ?? wideAudience()])); } };
    const access = { ...allowAllAccess, taskVisibility: withLessonAudiences({ read: async () => new Map() }, audiences) };
    const read = () => lessonsUsedReaderOver({ store, settings: settings(), access, names, visibility: async () => "private" })(input);
    // bob can open the pull request's task but not t-narrow: the lesson may not be given to this task, so it is not counted, and not named.
    const out = (await read())!;
    expect(out.items.map((i) => i.id).sort()).toEqual(["les_open0001", "les_wide00001"]);
    expect(out.count).toBe(2);
    expect(JSON.stringify(out)).not.toContain("Narrowed lesson");
    // Positive control: the narrowed task WAS asked about, so the exclusion came from its live audience; the count reader and the naming reader share their reads, so every source task is read ONCE for the whole description (G2).
    expect(reads.flat()).toEqual(expect.arrayContaining(["t-narrow", "t-wide"]));
    for (const id of ["task-1", "t-narrow", "t-wide"]) expect(reads.flat().filter((read) => read === id), id).toHaveLength(1);
    // The task itself also hides bob: the lesson may be given to it, so it IS counted, but it is still not NAMED (a source task with a People denial is not open to the whole project): count and link only.
    table["task-1"] = wideAudience({ denied: new Set(["bob"]) });
    const counted = (await read())!;
    expect(counted.count).toBe(3);
    // (The open lesson was learned from this very task, which now has a People denial, so it is counted and not named either.)
    expect(counted.items.map((i) => i.id)).toEqual(["les_wide00001"]);
    expect(JSON.stringify(counted)).not.toContain("Narrowed lesson");
    // Once no source task denies anyone, all three are named.
    table["task-1"] = wideAudience();
    table["t-narrow"] = wideAudience();
    expect((await read())!.items.map((i) => i.id).sort()).toEqual(["les_narrow001", "les_open0001", "les_wide00001"]);
    // Decision 32 is checked LIVE: nothing is named when the audiences cannot be read (the lessons are not even counted).
    gone.add("t-wide");
    expect((await read())!.items.map((i) => i.id)).not.toContain("les_wide00001");
    // And a pull request's task whose own audience cannot be read counts nothing at all.
    gone.add("task-1");
    expect(await read()).toBeUndefined();
  });

  it("the broker call never throws and is empty without a reader", async () => {
    setLessonsUsedReader(undefined);
    expect(await lessonsUsedForTask({ orgId: WS, project: PROJECT, taskId: "t", pageUrl: PAGE })).toBeUndefined();
    setLessonsUsedReader(async () => { throw new Error("down"); });
    expect(await lessonsUsedForTask({ orgId: WS, project: PROJECT, taskId: "t", pageUrl: PAGE })).toBeUndefined();
    setLessonsUsedReader(undefined);
  });

  it("the link is the task page with the lesson named, https only", () => {
    expect(notHelpfulUrl(`${PAGE}?x=1#top`, "les_a1")).toBe(`${PAGE}?notHelpful=les_a1`);
    expect(notHelpfulUrl("http://app.example.test/review/x/task", "les_a1")).toBeUndefined();
    expect(notHelpfulUrl("not a url", "les_a1")).toBeUndefined();
  });
});

describe("which repositories count as private", () => {
  it("private only when the host said so for every repository; one public one makes it public; anything it could not say is unknown", () => {
    expect(visibilityOfRepositories([{ private: true }, { private: true }])).toBe("private");
    expect(visibilityOfRepositories([{ private: true }, { private: false }])).toBe("public");
    expect(visibilityOfRepositories([{ private: true }, {}])).toBe("unknown");
    expect(visibilityOfRepositories([{ private: true }, undefined])).toBe("unknown");
    expect(visibilityOfRepositories([])).toBe("unknown");
  });
  it("a project the broker cannot read, or a host that fails, is unknown (never private)", async () => {
    expect(await repositoryVisibilityOf({} as never, WS, PROJECT)).toBe("unknown");
    expect(await repositoryVisibilityOf({} as never, "not-an-org", PROJECT)).toBe("unknown");
  });
});
