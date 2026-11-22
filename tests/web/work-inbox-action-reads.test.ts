import { expect, it } from "vitest";
import { DecisionCardsViewReaderSchema, InboxPageReaderSchema } from "@agentx/contracts/web";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { readDecisions } from "../../packages/ui/src/api/decisions-read.js";
import { readTaskList } from "../../packages/ui/src/api/work-read.js";
import { InboxReader } from "../../packages/ui/src/api/learned.js";
import { queueActionReads } from "../../packages/ui/src/screens/work/queue-action-reads.js";
import { fakeHost } from "./support/fake-host.js";
import { CARDS, decisionsView, ID, task } from "./support/work-fixture.js";
const body = { requestId: "one", shownDigest: "b".repeat(64) };
it.each(["allowed", "missing", "status", "digest", "action", "method"])("decision source pins %s", state => {
 const query = createQueryClient(), host = fakeHost().host;
 const cards = readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView([CARDS[0]!])));
 if (state === "status") cards[0]!.card.status = "approved";
 if (state === "action") cards[0]!.card.actions = [];
 query.setQueryData(["decisions"], state === "missing" ? [] : cards);
 const input = { method: state === "method" ? "DELETE" as const : "POST" as const, path: "/v1/app/decisions/approve_plan/" + ID.plan + "/approve", body: { ...body, ...(state === "digest" ? { shownDigest: "a".repeat(64) } : {}) } };
 expect(queueActionReads(host, query, input)[0]!.permitted()).toBe(state === "allowed");
 query.clear();
});
it.each(["allowed", "missing", "unread", "state", "revision", "round"])("answer source pins %s", state => {
 const query = createQueryClient(), tasks = readTaskList({ tasks: [task(ID.plan, "Question", { round: { round: 2, questions: [{ id: "q1", text: "What?", answered: false }] }, workflow: { stage: "UNDERSTAND", state: "WAITING", revision: 2 } })] });
 if (state === "unread") tasks[0]!.detailUnread = true;
 if (state === "state") tasks[0]!.workflow!.state = "COMPLETE";
 query.setQueryData(["work", "tasks"], state === "missing" ? [] : tasks);
 expect(queueActionReads(fakeHost().host, query, { method: "POST", path: "/v1/app/tasks/" + ID.plan + "/answers", body: { round: state === "round" ? 3 : 2, revision: state === "revision" ? 3 : 2 } })[0]!.permitted()).toBe(state === "allowed");query.clear();
});
it.each(["keep", "drop"])("lesson %s requires the exact id/version and the served permission", choice => {
 for (const state of ["allowed", "missing", "version", "permission", "empty"]) {
  const query = createQueryClient(), lesson = { id: "les_pend0001", version: 1, title: "A lesson", type: "convention", status: "pending", canApprove: state !== "permission", canReject: state !== "permission", counters: { loaded: 0, helpful: 0, harmful: 0 }, createdAt: 1794744000000, updatedAt: 1794744000000, expiresAt: 1797336000000 };
  query.setQueryData(["learned", "inbox"], InboxReader.parse({ state: "on", batches: [{ project: "web", lessons: [lesson] }], unavailable: [] }));
  const input = { method: "POST" as const, path: "/v1/app/projects/web/lessons/decisions", body: { decisions: state === "empty" ? [] : [{ lessonId: state === "missing" ? "les_other001" : lesson.id, version: state === "version" ? 2 : 1, decision: choice }] } };
  const source = queueActionReads(fakeHost().host, query, input)[0]!;expect(source.permitted(), state).toBe(state === "allowed");
  if (state === "allowed") { expect(source.answer?.({ status: 200, body: { results: [] } })).toBe(false);expect(source.answer?.({ status: 200, body: { results: [{ lessonId: lesson.id, ok: true, status: "active" }] } })).toBe(true); }
  query.clear();
 }
});
it.each(["allowed", "hidden", "permission", "missing"])("lesson feedback requires %s", state => {
 const query = createQueryClient();query.setQueryData(["learned", "project", "web", "task", ID.plan], [{ lessonId: state === "missing" ? "les_other001" : "les_logs0001", visible: state !== "hidden", canMark: state !== "permission" }]);
 expect(queueActionReads(fakeHost().host, query, { method: "POST", path: "/v1/app/projects/web/tasks/" + ID.plan + "/lessons/les_logs0001/not-helpful", body: {} })[0]!.permitted()).toBe(state === "allowed");query.clear();
});
it.each(["allowed", "read", "missing", "empty"])("inbox mark ids pin %s", state => {
 const query = createQueryClient(), page = InboxPageReaderSchema.parse({ items: [{ id: "ses_aaaaaaaaaaaaaaaaaaaa.needs_you.1763208000000", kind: "needs_you", title: "Update", status: "Waiting.", at: "2026-11-15T11:00:00.000Z", read: state === "read", open: "/s/ses_aaaaaaaaaaaaaaaaaaaa" }], unread: 1 });
 query.setQueryData(["inbox", "list"], { pages: [page], pageParams: [undefined] });
 expect(queueActionReads(fakeHost().host, query, { method: "POST", path: "/v1/app/inbox/read", body: { ids: state === "empty" ? [] : [state === "missing" ? "missing" : page.items[0]!.id] } })[0]!.permitted()).toBe(state === "allowed");query.clear();
});
it("an unallocated write has no authority source", () => { const query = createQueryClient();expect(queueActionReads(fakeHost().host, query, { method: "POST", path: "/unallocated", body: {} })).toEqual([]);query.clear(); });
it("decision receipts must match the displayed card, and evidence uses its existing reader", () => {
 const query = createQueryClient(), host = fakeHost().host;
 query.setQueryData(["decisions"], readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView([CARDS[0]!]))));
 const source = queueActionReads(host, query, { method: "POST", path: "/v1/app/decisions/approve_plan/" + ID.plan + "/approve", body })[0]!;
 expect(source.answer?.({ status: 200, body: { cardId: CARDS[0]!.id, outcome: "approved", remainingTabs: [] } })).toBe(true);
 expect(source.answer?.({ status: 200, body: { cardId: CARDS[1]!.id, outcome: "approved", remainingTabs: [] } })).toBe(false);
 expect(source.answer?.({ status: 200, body: {} })).toBe(false);
 const evidence = queueActionReads(host, query, { method: "POST", path: "/v1/app/decisions/approve_plan/" + ID.plan + "/evidence-opened", body })[0]!;
 expect(evidence.permitted()).toBe(true);expect(evidence.answer?.({ status: 200, body: { cardId: CARDS[0]!.id, opened: true, recorded: true } })).toBe(true);
 expect(evidence.answer?.({ status: 200, body: { cardId: CARDS[0]!.id, opened: false, recorded: true } })).toBe(false);query.clear();
});
it("criterion answers require the independent current plan as well as the task read", () => {
 const query = createQueryClient();query.setQueryData(["work", "tasks"], readTaskList({ tasks: [task(ID.plan, "Spec", { sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" })] }));
 const reads = queueActionReads(fakeHost().host, query, { method: "POST", path: "/v1/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa/answers", body: {} });
 expect(reads).toHaveLength(2);expect(reads[1]!.key).toEqual(["work", "plan", ID.plan]);query.clear();
});
it("each write binds only its own subject's served facts", () => {
 const query = createQueryClient(), host = fakeHost().host;
 const decisions = readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView([CARDS[0]!, CARDS[1]!])));query.setQueryData(["decisions"], decisions);
 const decision = queueActionReads(host, query, { method: "POST", path: "/v1/app/decisions/approve_plan/" + ID.plan + "/approve", body })[0]!;
 expect(decision.basis?.(decisions)).toEqual([decisions[0]]);
 const tasks = readTaskList({ tasks: [task(ID.plan, "Subject"), task(ID.running, "Other")] });query.setQueryData(["work", "tasks"], tasks);
 const answers = queueActionReads(host, query, { method: "POST", path: "/v1/app/tasks/" + ID.plan + "/answers", body: {} })[0]!;
 expect(answers.basis?.(tasks)).toMatchObject([{ taskId: ID.plan }]);expect(answers.basis?.(tasks)).toHaveLength(1);
 const lessons = [{ lessonId: "les_logs0001", visible: true, canMark: true }, { lessonId: "les_other001", visible: true, canMark: true }];query.setQueryData(["learned", "project", "web", "task", ID.plan], lessons);
 const mark = queueActionReads(host, query, { method: "POST", path: "/v1/app/projects/web/tasks/" + ID.plan + "/lessons/les_logs0001/not-helpful", body: {} })[0]!;
 expect(mark.basis?.(lessons)).toEqual([lessons[0]]);
 const batch = { project: "web", lessons: [] }, otherBatch = { project: "other", lessons: [] }, inbox = { state: "on", batches: [batch, otherBatch], unavailable: [] };query.setQueryData(["learned", "inbox"], inbox);
 const batchSource = queueActionReads(host, query, { method: "POST", path: "/v1/app/projects/web/lessons/decisions", body: { decisions: [] } })[0]!;expect(batchSource.basis?.(inbox)).toEqual([batch]);
 const updates = { pages: [{ items: [{ id: "first", read: false }, { id: "other", read: false }] }], pageParams: [undefined] };query.setQueryData(["inbox", "list"], updates);
 const updateSource = queueActionReads(host, query, { method: "POST", path: "/v1/app/inbox/read", body: { ids: ["first"] } })[0]!;expect(updateSource.basis?.(updates)).toEqual([{ id: "first", read: false }]);query.clear();
});
it.each(["unchanged", "removed", "decided", "digest"])("decision lock observes only its own later %s basis", state => {
 const query = createQueryClient(), cards = readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView([CARDS[0]!, CARDS[1]!])));
 query.setQueryData(["decisions"], cards);
 const source = queueActionReads(fakeHost().host, query, { method: "POST", path: "/v1/app/decisions/approve_plan/" + ID.plan + "/approve", body })[0]!;
 const next = structuredClone(cards);next[1]!.card.status = "approved";
 if (state === "removed") next.shift();if (state === "decided") next[0]!.card.status = "approved";if (state === "digest") next[0]!.digest = "a".repeat(64);
 expect(source.observed?.(next)).toBe(state !== "unchanged");query.clear();
});
it.each(["valid", "wrong card", "decided", "malformed"])("202 pending reader pins %s", state => {
 const query = createQueryClient();query.setQueryData(["decisions"], readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView([CARDS[0]!]))));
 const source = queueActionReads(fakeHost().host, query, { method: "POST", path: "/v1/app/decisions/approve_plan/" + ID.plan + "/approve", body })[0]!;
 expect(source.pending?.({ status: 202, body: state === "malformed" ? {} : { cardId: state === "wrong card" ? CARDS[1]!.id : CARDS[0]!.id, outcome: state === "decided" ? "approved" : "needs_confirmation", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" } })).toBe(state === "valid");query.clear();
});
it.each(["unchanged", "state", "revision", "round", "missing", "unread", "no workflow", "other task"])("answer lock observes %s", state => {
 const query = createQueryClient(), tasks = readTaskList({ tasks: [task(ID.plan, "Question", { workflow: { stage: "UNDERSTAND", state: "WAITING", revision: 2, round: 2 } })] });
 query.setQueryData(["work", "tasks"], tasks);
 const source = queueActionReads(fakeHost().host, query, { method: "POST", path: "/v1/app/tasks/" + ID.plan + "/answers", body: { revision: 2, round: 2 } })[0]!;
 const next = structuredClone(tasks);
 if (state === "state") next[0]!.workflow!.state = "COMPLETE";
 if (state === "revision") next[0]!.workflow!.revision = 3;
 if (state === "round") next[0]!.workflow!.round = 3;
 if (state === "missing") next.shift();if (state === "unread") { next[0]!.detailUnread = true;next[0]!.workflow!.revision = 3; }
 if (state === "no workflow") delete (next[0] as { workflow?: unknown }).workflow;
 if (state === "other task") next[0]!.taskId = ID.running;
 expect(source.observed?.(next)).toBe(["state", "revision", "round"].includes(state));query.clear();
});
it.each(["pending", "decided", "version", "removed", "off", "unavailable", "partial", "other project", "other lesson", "empty", "missing decisions"])("lesson batch lock observes %s", state => {
 const query = createQueryClient(), lesson = { id: "les_pend0001", version: 1, status: "pending" }, inbox = { state: "on", batches: [{ project: "web", lessons: [lesson], partial: false }], unavailable: [] as string[] };
 query.setQueryData(["learned", "inbox"], inbox);
 const source = queueActionReads(fakeHost().host, query, { method: "POST", path: "/v1/app/projects/web/lessons/decisions", body: state === "missing decisions" ? {} : { decisions: state === "empty" ? [] : [{ lessonId: lesson.id, version: 1, decision: "keep" }] } })[0]!;
 const next = structuredClone(inbox);
 if (state === "decided") next.batches[0]!.lessons[0]!.status = "active";
 if (state === "version") next.batches[0]!.lessons[0]!.version = 2;
 if (state === "removed") next.batches = [];
 if (state === "off") { next.state = "off";next.batches = []; }
 if (state === "unavailable") { next.unavailable = ["web"];next.batches = []; }
 if (state === "partial") { next.batches[0]!.partial = true;next.batches[0]!.lessons = []; }
 if (state === "other project") next.batches.push({ project: "other", lessons: [{ ...lesson, status: "active" }], partial: false });
 if (state === "other lesson") next.batches[0]!.lessons.push({ ...lesson, id: "les_other001", status: "active" });
 expect(source.observed?.(next)).toBe(["decided", "version", "removed"].includes(state));query.clear();
});
it.each(["marked", "unmarked", "hidden", "missing", "unspecified"])("feedback lock observes %s", state => {
 const query = createQueryClient();query.setQueryData(["learned", "project", "web", "task", ID.plan], []);
 const source = queueActionReads(fakeHost().host, query, { method: "POST", path: "/v1/app/projects/web/tasks/" + ID.plan + "/lessons/les_logs0001/not-helpful", body: {} })[0]!;
 const next = [{ lessonId: state === "missing" ? "other" : "les_logs0001", visible: state !== "hidden", ...(state === "unspecified" ? {} : { canMark: state === "unmarked" }) }];
 expect(source.observed?.(next)).toBe(state === "marked");query.clear();
});
it.each(["read", "unread", "missing", "empty", "undefined"])("Inbox lock needs every exact id observed %s", state => {
 const query = createQueryClient();query.setQueryData(["inbox", "list"], { pages: [], pageParams: [undefined] });
 const source = queueActionReads(fakeHost().host, query, { method: "POST", path: "/v1/app/inbox/read", body: state === "undefined" ? {} : { ids: state === "empty" ? [] : ["one", "two"] } })[0]!;
 expect(source.observed?.({ pages: [{ items: [{ id: "one", read: true }, { id: state === "missing" ? "other" : "two", read: state !== "unread" }] }] })).toBe(state === "read");query.clear();
});

it.each(["NEEDS_CONFIRMATION", "NEEDS_OWNER_APPROVAL"])("the existing design-spend %s answer passes to its live reader", status => {
 const query = createQueryClient(), path = "/v1/app/tasks/" + ID.plan + "/design-review/spend/raise-cap";
 const card = { ...CARDS[0]!, id: "approve_spend:" + ID.plan, kind: "approve_spend", actions: [{ kind: "choose" as const, label: "Raise cap", method: "POST" as const, href: path }] };
 query.setQueryData(["decisions"], readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView([card]))));
 const source = queueActionReads(fakeHost().host, query, { method: "POST", path, body })[0]!;
 expect(source.pending?.({ status: 202, body: { status, changes: ["Raise cap"], confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" } })).toBe(true);
 expect(source.pending?.({ status: 202, body: { status } })).toBe(false);query.clear();
});
it.each(["missing", "already read"])("Inbox preflight refuses a mixed selection containing an %s id", state => {
 const query = createQueryClient();query.setQueryData(["inbox", "list"], { pages: [{ items: [{ id: "one", read: false }, { id: "two", read: true }] }], pageParams: [undefined] });
 const source = queueActionReads(fakeHost().host, query, { method: "POST", path: "/v1/app/inbox/read", body: { ids: ["one", state === "missing" ? "missing" : "two"] } })[0]!;
 expect(source.permitted()).toBe(false);query.clear();
});
it.each([false, true])("saved %s decision identity comes from the wire when the cache has no card", spend => {
 const query = createQueryClient(), path = spend ? "/v1/app/tasks/" + ID.plan + "/design-review/spend/raise-cap" : "/v1/app/decisions/approve_plan/" + ID.plan + "/approve";
 const card = spend ? { ...CARDS[0]!, id: "approve_spend:" + ID.plan, kind: "approve_spend", actions: [{ kind: "choose" as const, label: "Raise cap", method: "POST" as const, href: path }] } : CARDS[0]!;
 const cards = readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView([card])));query.setQueryData(["decisions"], []);
 const source = queueActionReads(fakeHost().host, query, { method: "POST", path, body })[0]!;
 expect(source.observed?.(cards)).toBe(false);
 const confirmUrl = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
 expect(source.pending?.({ status: 202, body: { cardId: card.id, outcome: "needs_confirmation", confirmUrl } })).toBe(true);
 expect(source.pending?.({ status: 202, body: { cardId: "merge:" + ID.merge, outcome: "needs_confirmation", confirmUrl } })).toBe(false);
 expect(source.pending?.({ status: 202, body: { status: "NEEDS_CONFIRMATION", changes: ["Confirm"], confirmUrl } })).toBe(spend);query.clear();
});
