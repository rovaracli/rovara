// Approve by exception (DECISIONS 24): the pull request description lists the lessons the task used, with a link per lesson to mark it not helpful. The link opens the task page (a page that asks);
// the list shrinks with the other lists, the markers stay, titles are inert, a restricted lesson is never named.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot } from "../../../packages/contracts/src/task-workflow-node.js";
import { workflowPullRequestStatusLines } from "../../../packages/broker/src/aws/developer-tasks.js";
import { rovaraPullRequestBody, ROVARA_STATUS_END, ROVARA_STATUS_START, PULL_REQUEST_BODY_MAX_BYTES } from "../../../packages/broker/src/rovara-code/pull-request-body.js";
import { lessonsUsedForTask, lessonsUsedReaderOver, notHelpfulUrl, setLessonsUsedReader } from "../../../packages/broker/src/lessons/used-in-pr.js";
import { InMemoryLessonStore, type LoadManifest } from "../../../packages/broker/src/lessons/store.js";
import { KEY, PROJECT, WS, allowAllAccess, draft, lessonRecord, seed, settings } from "./lesson-helpers.js";

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
const context = { changedFiles: { files: [{ repository: "payments", path: "src/retry.ts", added: 3, removed: 1 }], complete: true } };

describe("the description's Lessons used section", () => {
  it("lists each lesson with a not-helpful link to the task page, inside the marked block", () => {
    const body = rovaraPullRequestBody({ summary: ["Retry the call."], fallbackTitle: "t", workflow, context: { ...context, lessonsUsed: [entry("les_aaaa1111", "Retries use withRetry"), entry("les_bbbb2222")] }, reviewLines: () => [], pageUrl: PAGE });
    const block = body.slice(body.indexOf(ROVARA_STATUS_START), body.indexOf(ROVARA_STATUS_END));
    expect(block).toContain("## Lessons used");
    expect(block).toContain(`- Retries use withRetry ([not helpful](${PAGE}?notHelpful=les_aaaa1111))`);
    expect(block).toContain(`- Lesson les_bbbb2222 ([not helpful](${PAGE}?notHelpful=les_bbbb2222))`);
    expect(body.indexOf("## Lessons used")).toBeLessThan(body.indexOf("## Risk"));
  });

  it("rewrites with the status block after a fix, and has no section when no lesson was used", () => {
    expect(workflowPullRequestStatusLines(workflow, { ...context, lessonsUsed: [entry("les_aaaa1111")] }).join("\n")).toContain("## Lessons used");
    expect(workflowPullRequestStatusLines(workflow, context).join("\n")).not.toContain("Lessons used");
    expect(workflowPullRequestStatusLines(workflow, { ...context, lessonsUsed: [] }).join("\n")).not.toContain("Lessons used");
  });

  it("titles are inert (no mention, no link, no hidden comment) and a link that is not https is left out", () => {
    const hostile = "Use <!-- x --> [click](https://evil.example) @mallory";
    const lines = workflowPullRequestStatusLines(workflow, { ...context, lessonsUsed: [{ title: hostile, notHelpfulUrl: PAGE + "?notHelpful=les_aaaa1111" }, { title: "plain", notHelpfulUrl: "javascript:alert(1)" }] }).join("\n");
    expect(lines).not.toContain("<!--");
    expect(lines).not.toContain("https://evil.example");
    expect(lines).not.toMatch(/@mallory/u);
    expect(lines).toContain("- plain");
    expect(lines).not.toContain("javascript:");
  });

  it("many lessons shrink to fit: the body stays under the cap with its markers", () => {
    const many = Array.from({ length: 300 }, (_, i) => entry(`les_${String(i).padStart(8, "0")}`, "A".repeat(100)));
    const body = rovaraPullRequestBody({ summary: ["x".repeat(400)], fallbackTitle: "t", workflow, context: { ...context, lessonsUsed: many }, reviewLines: () => [], pageUrl: PAGE });
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
  it("names only lessons that reached the prompt and are open to the project; never a restricted one; none when learning is off", async () => {
    const store = new InMemoryLessonStore();
    const restricted = { ...draft().provenance, audience: { kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:C1", principals: ["U1"], capturedAt: "x", liveCheck: "none" as const } } };
    await seed(store, lessonRecord({ id: "les_open0001", title: "Open lesson" }), lessonRecord({ id: "les_secret01", title: "Secret lesson", provenance: restricted }), lessonRecord({ id: "les_dropped1", title: "Dropped lesson" }));
    await store.putManifest(manifest([["les_open0001", "valid"], ["les_secret01", "valid"], ["les_dropped1", "stale_dropped"], ["les_open0001", "moved"], ["les_gone0001", "valid"]]));
    const read = lessonsUsedReaderOver({ store, settings: settings(), access: allowAllAccess });
    const input = { orgId: WS, project: PROJECT, taskId: "task-1", pageUrl: PAGE };
    expect(await read(input)).toEqual([{ id: "les_open0001", title: "Open lesson", notHelpfulUrl: `${PAGE}?notHelpful=les_open0001` }]);
    expect(await lessonsUsedReaderOver({ store, settings: settings({ mode: "Off" }), access: allowAllAccess })(input)).toEqual([]);
    expect(await read({ ...input, pageUrl: undefined })).toEqual([]);
    // Another project's task has nothing.
    expect(await read({ ...input, project: "other" })).toEqual([]);
    void KEY;
  });

  it("the broker call never throws and is empty without a reader", async () => {
    setLessonsUsedReader(undefined);
    expect(await lessonsUsedForTask({ orgId: WS, project: PROJECT, taskId: "t", pageUrl: PAGE })).toEqual([]);
    setLessonsUsedReader(async () => { throw new Error("down"); });
    expect(await lessonsUsedForTask({ orgId: WS, project: PROJECT, taskId: "t", pageUrl: PAGE })).toEqual([]);
    setLessonsUsedReader(undefined);
  });

  it("the link is the task page with the lesson named, https only", () => {
    expect(notHelpfulUrl(`${PAGE}?x=1#top`, "les_a1")).toBe(`${PAGE}?notHelpful=les_a1`);
    expect(notHelpfulUrl("http://app.example.test/review/x/task", "les_a1")).toBeUndefined();
    expect(notHelpfulUrl("not a url", "les_a1")).toBeUndefined();
  });
});
