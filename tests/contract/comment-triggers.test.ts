// Plan 3 Task 14b (R1-1, R3-1, R66): the opt-out of the repository-level comment rule. An org owner or admin who read a repository's comment-triggered
// workflows asks for an opt-out; an org admin confirms it on the confirmation page; it is bound to the digest of the files they reviewed and lapses by
// itself when a scan finds another. These tests run the routes through the broker, the confirmation through the handler the page calls, and the run's
// side (`commentTriggerRule`, which Task 20b's `classifyWrite` calls) directly, all on one fake table and an in-memory repository.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { COMMENT_TRIGGER_COVERAGE_NOTE, COMMENT_TRIGGER_STALE_TEXT, agentGuardrailsKey, commentSignal, projectRevisionKey, commentTriggerOptOutKey, commentTriggerLapseNotice, projectMetaKey, type OrgId } from "@rovara-code/contracts";
import { type AuditEventInput, type OrgRole } from "@agentx/cloud-contracts";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { getApprovalSubjectHandler, getApproverRule, type ApprovalDependencies, type ApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import {
  commentTriggerRule,
  lapseStaleOptOuts,
  listCommentTriggerNotices,
  listOptOutViews,
  readOptOut,
  requestOptOut,
} from "../../packages/broker/src/agents/comment-trigger-optouts.js";
import { repoCommandTriggers } from "../../packages/broker/src/agents/comment-trigger-scan.js";
import { memoryRunCache } from "../../packages/broker/src/agents/run-cache.js";
import { approvalDecideKind } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { routeDecidePage } from "../../packages/broker/src/aws/decide-web.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor, type DecideRequestContext } from "../../packages/broker/src/developer/decide-session.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import { DEFAULT_AGENT_GUARDRAILS } from "@rovara-code/contracts";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { blobSha, treeReader, workflow } from "../support/fake-repository.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // org admin
const OWEN = person("7", "Owen"); // org owner
const EVE = person("4", "Eve"); // a plain member
const MAX = person("2", "Max"); // a member who maintains payments
const ORIN = person("9", "Orin"); // admin of the other org
const orgResolver: OrgResolver = async (subject) => (subject.developerId === OMAR.developerId || subject.developerId === ORIN.developerId ? ORG_B : TEST_ORG);

const WORKFLOW = ".github/workflows/triage.yml";
const SCRIPT = "scripts/triage.sh";
const REPOSITORY = "example/demo";
const LAPSE_TEXT = (files: string) => `Rovara is asking again about comment-triggered workflows in ${REPOSITORY}: ${files} changed. Agent comments there wait for a person until an admin reviews them.`;
const baseFiles = (): Record<string, string> => ({ [WORKFLOW]: workflow("issue_comment", `./${SCRIPT}`), [SCRIPT]: "echo triage" });

beforeAll(async () => { await loadSlackBroker(); }, 60_000);

type Reply = { status: number; body: Record<string, unknown> };
const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };

async function world(options: { files?: Record<string, string> } = {}) {
  let files = options.files ?? baseFiles();
  let down = false;
  let pinned: number | undefined;
  const members = new FakeProjectMembers();
  members.grant(TEST_ORG, "payments", MAX.developerId, "maintainer");
  members.grant(TEST_ORG, "payments", EVE.developerId, "contributor");
  for (const [who, role] of [[DANA, "admin"], [OWEN, "owner"]] as const) members.setOrgRole(TEST_ORG, who.developerId, role);
  const audit = capturingAuditDeps();
  const reads: string[] = [];
  /** The pin each reader was made with (the third argument), in order. */
  const pins: Array<number | undefined> = [];
  const agentRepositoryReader = vi.fn(async (url: string, scope: { orgId: OrgId }, options?: { installationId?: number }) => {
    reads.push(`${url} ${scope.orgId}`);
    pins.push(options?.installationId);
    if (down) throw new Error("GitHub is down");
    return treeReader(files);
  });
  const h = await createDeveloperTaskBroker({
    orgResolver, audit,
    brokerExtra: { agents: { projectMembers: members }, githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), agentRepositoryReader } },
  });
  const enroll = async (who: Developer, org: OrgId, role: OrgRole) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId: org, role });
  };
  await enroll(DANA, TEST_ORG, "admin");
  await enroll(OWEN, TEST_ORG, "owner");
  await enroll(EVE, TEST_ORG, "member");
  await enroll(MAX, TEST_ORG, "member");
  await enroll(ORIN, ORG_B, "admin");
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  const deps: ApprovalDependencies = {
    store, projectMembers: members, documentClient: h.db, tableName: "state", now: Date.now, confirmOrigin: "https://cell.example.com",
    signInStore: new DeveloperSignInStore({ documentClient: h.db, tableName: "signin", now: Date.now }),
    audit: audit.audit,
    repositoryReader: async ({ orgId, repositoryUrl, installationId }) => agentRepositoryReader(repositoryUrl, { orgId }, installationId === undefined ? undefined : { installationId }),
    projectRepositories: async (orgId, project) => (orgId === TEST_ORG && project === "payments" ? [{ name: "demo", url: "https://github.com/example/demo.git", ...(pinned === undefined ? {} : { installationId: pinned }) }] : undefined),
  };
  const call = async (who: Developer, method: string, path: string, body?: Record<string, unknown>): Promise<Reply> => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest };
  };
  const PATH = "/v1/app/projects/payments/connectors/github/comment-triggers";
  const review = async (who: Developer = DANA, project = "payments", query = "") => call(who, "GET", `/v1/app/projects/${project}/connectors/github/comment-triggers${query}`);
  const digest = async () => (await review()).body.repositories as Array<{ digest: string; files: string[]; triggers: boolean }>;
  const put = async (who: Developer, expectedDigest: string, extra: Record<string, unknown> = {}): Promise<Reply> => {
    const reply = await h.dev(who, "PUT", PATH, { requestId: randomUUID(), repository: REPOSITORY, expectedDigest, reason: "ok", ...extra });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest };
  };
  const ask = async (who: Developer, extra: Record<string, unknown> = {}, requestId: string = randomUUID()): Promise<Reply> => {
    const current = (await digest())[0]!;
    const reply = await h.dev(who, "PUT", PATH, { requestId, repository: REPOSITORY, expectedDigest: current.digest, reason: "Only our own triage bot reacts", ...extra });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest };
  };
  const approvals = () => h.db.find((item) => item.entityType === "APPROVAL") as unknown as ApprovalRecord[];
  /** What the page does when an org admin approves the only (or the last) waiting opt-out: the registered handler, on the record with the person who decided. */
  const confirm = async (by: Developer = DANA, record: ApprovalRecord = approvals().at(-1)!) => getApprovalSubjectHandler("opt_out")!(deps, { ...record, decidedBy: by.developerId });
  const optOutThrough = async (project = "payments") => {
    const asked = await ask(DANA);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await confirm();
    return project;
  };
  const rule = (project = "payments", taskId = "task-1", cache = memoryRunCache()) => commentTriggerRule({ ...deps, repositoryReader: deps.repositoryReader! }, { orgId: TEST_ORG, project, repository: REPOSITORY, taskId, cache });
  return {
    ...h, pin: (id: number | undefined) => { pinned = id; }, files: () => files, setFiles: (next: Record<string, string>) => { files = next; }, setDown: (value: boolean) => { down = value; },
    members, audit, deps, store, call, review, digest, ask, put, approvals, confirm, optOutThrough, rule, PATH, reads, pins, agentRepositoryReader, enroll,
  };
}

/** A comment as `classifyWrite` will judge it: the repository rule and the text checks together. */
const consequential = async (w: Awaited<ReturnType<typeof world>>, body: string, project = "payments") => {
  const repository = await w.rule(project);
  const text = commentSignal({ body }, { allowMentions: false, labelPaths: [] });
  return { repositoryRule: repository.consequential, text: text.consequential, either: repository.consequential || text.consequential };
};

describe("GET /v1/app/projects/{p}/connectors/github/comment-triggers", () => {
  it("shows an org admin the current scan of each of the project's GitHub repositories", async () => {
    const w = await world();
    const shown = await w.review();
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    expect(shown.body).toEqual({
      coverage: COMMENT_TRIGGER_COVERAGE_NOTE,
      project: "payments",
      repositories: [{ repository: REPOSITORY, triggers: true, failedClosed: false, digest: expect.stringMatching(/^[a-f0-9]{64}$/) as string, files: [SCRIPT, WORKFLOW].sort() }],
    });
    expect(w.reads).toEqual([`https://github.com/${REPOSITORY}.git ${TEST_ORG}`]);
    expect(typeof shown.body.coverage).toBe("string");
    expect((await w.review(OWEN)).status).toBe(200);
  });

  it("reads the repository named by ?repository=, in any case, and refuses one that is not the project's without repeating it", async () => {
    const w = await world();
    expect((await w.review(DANA, "payments", "?repository=Example/Demo")).body).toMatchObject({ repositories: [{ repository: REPOSITORY }] });
    for (const wrong of ["other/thing", "nonsense", "a/b/c", "../x"]) {
      const reply = await w.review(DANA, "payments", `?repository=${encodeURIComponent(wrong)}`);
      expect(reply.status, wrong).toBe(400);
      expect(errorOf(reply)).toEqual({ code: "CONFIG_INVALID", message: "repository: that is not one of this project's repositories" });
    }
  });

  it("scans afresh on every request, so an admin never reviews an old answer", async () => {
    const w = await world();
    const before = (await w.digest())[0]!.digest;
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo changed" });
    expect((await w.digest())[0]!.digest).not.toBe(before);
  });

  it("carries a short fixed hint when the scan failed closed for a reason it knows (round 3)", async () => {
    const w = await world({ files: { [WORKFLOW]: workflow("issue_comment", "cd secret-dir && ./x.sh") } });
    const reply = await w.review();
    expect(reply.body.repositories).toEqual([{ repository: REPOSITORY, triggers: true, failedClosed: true, digest: "0".repeat(64), files: [], hint: "use working-directory instead of cd" }]);
    expect(JSON.stringify(reply.body)).not.toContain("secret-dir");
    const open = await world();
    expect(((await open.review()).body.repositories as Array<Record<string, unknown>>)[0]).not.toHaveProperty("hint");
  });

  it("shows a scan that could not be read as failed closed, with nothing to review", async () => {
    const w = await world();
    w.setDown(true);
    const reply = await w.review();
    expect(reply.body.repositories).toEqual([{ repository: REPOSITORY, triggers: true, failedClosed: true, digest: "0".repeat(64), files: [] }]);
  });

  it("shows the project's opt-out when it matches the files, and none after they change", async () => {
    const w = await world();
    await w.optOutThrough();
    const shown = (await w.review()).body.repositories as Array<{ optOut?: Record<string, unknown> }>;
    expect(shown[0]!.optOut).toMatchObject({ project: "payments", repository: REPOSITORY, reviewedBy: DANA.developerId, reason: "Only our own triage bot reacts" });
  });

  it("is for an org owner or admin: a maintainer of the project who is not one, a member and a stranger get 403, and a project of another org is not found", async () => {
    const w = await world();
    for (const who of [MAX, EVE]) {
      const reply = await w.review(who);
      expect(reply.status).toBe(403);
      expect(errorOf(reply)).toEqual({ code: "FORBIDDEN", message: "Only an org owner or admin can review or change a project's opt-out of the comment-triggered workflow rule." });
    }
    expect(w.reads).toEqual([]);
    const other = await w.review(ORIN);
    expect(other.status).toBe(404);
    expect(errorOf(other).code).toBe("PROJECT_NOT_FOUND");
    expect((await w.review(DANA, "nobody")).status).toBe(404);
  });
});

describe("PUT /v1/app/projects/{p}/connectors/github/comment-triggers", () => {
  it("records a pending opt-out for an org admin and applies nothing", async () => {
    const w = await world();
    const current = (await w.digest())[0]!;
    const asked = await w.ask(DANA);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const [record] = w.approvals();
    expect(asked.body).toEqual({
      status: "NEEDS_CONFIRMATION", confirmUrl: `https://abc123.execute-api.us-east-1.amazonaws.com/v1/app/approve/${record!.approvalId}`,
      changes: [
        `Lets agents comment, review and label in ${REPOSITORY} on payments without waiting for a person, although workflows there act on comments or labels`,
        `Covers 2 files, digest ${current.digest.slice(0, 12)}`,
      ],
    });
    expect(record).toMatchObject({
      kind: "change", status: "PENDING", requestedBy: DANA.developerId, subject: { kind: "opt_out", project: "payments", repository: REPOSITORY, expectedDigest: current.digest, files: current.files, reason: "Only our own triage bot reacts" },
      approvers: { kind: "rule", rule: "org_admin" },
    });
    const spec = record!.approvers as unknown as { candidates: string[] };
    expect([...spec.candidates].sort()).toEqual([DANA.developerId, OWEN.developerId].sort());
    // Nothing was applied: no opt-out, no event, no audit item, and a plain comment still waits for a person.
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeUndefined();
    expect(w.db.find((item) => item.entityType === "COMMENT_TRIGGER_EVENT")).toEqual([]);
    expect(w.audit.recorded()).toEqual([]);
    expect((await consequential(w, "Looks right to me.")).repositoryRule).toBe(true);
  });

  it("is for an org owner or admin: a maintainer who is not one, and a member, get 403 and nothing is recorded", async () => {
    const w = await world();
    const current = (await w.digest())[0]!;
    for (const who of [MAX, EVE]) {
      const reply = await w.put(who, current.digest);
      expect(reply.status, who.name).toBe(403);
      expect(errorOf(reply).code).toBe("FORBIDDEN");
    }
    expect(w.approvals()).toEqual([]);
    expect((await w.ask(OWEN)).status).toBe(202);
  });

  it("answers a repeat of a waiting request with the same link and one record, and refuses the id for another request", async () => {
    const w = await world();
    const requestId = randomUUID();
    const first = await w.ask(DANA, {}, requestId);
    const again = await w.ask(DANA, {}, requestId);
    expect(again).toEqual(first);
    expect(w.approvals()).toHaveLength(1);
    const other = await w.ask(DANA, { reason: "A different reason" }, requestId);
    expect(other.status).toBe(400);
    expect(errorOf(other)).toEqual({ code: "CONFIG_INVALID", message: "requestId: this request ID was already used for a different request" });
    expect(w.approvals()).toHaveLength(1);
    // Another request id for the same thing waits as its own record.
    expect((await w.ask(DANA)).status).toBe(202);
    expect(w.approvals()).toHaveLength(2);
  });

  it("does not turn a request that was decided since into a waiting one", async () => {
    const w = await world();
    const requestId = randomUUID();
    await w.ask(DANA, {}, requestId);
    const [record] = w.approvals();
    w.db.set({ ...(w.db.get(`ORG#${TEST_ORG}#APPROVAL#${record!.approvalId}`, "META") as Record<string, unknown>), status: "DECLINED" });
    const again = await w.ask(DANA, {}, requestId);
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe("APPROVAL_CLOSED");
  });

  it("refuses a digest that is not the current one with the exact text, and records nothing", async () => {
    const w = await world();
    const reply = await w.ask(DANA, { expectedDigest: "a".repeat(64) });
    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toEqual({ code: "CONFIG_INVALID", message: "the workflows changed since you looked; review them again" });
    expect(COMMENT_TRIGGER_STALE_TEXT).toBe("the workflows changed since you looked; review them again");
    expect(w.approvals()).toEqual([]);
  });

  it("refuses to ask about a scan that failed closed: there is nothing a person could review", async () => {
    const w = await world();
    const current = (await w.digest())[0]!;
    w.setDown(true);
    const reply = await w.put(DANA, current.digest);
    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toEqual({ code: "CONFIG_INVALID", message: "Rovara can't read this repository's workflows completely, so they can't be reviewed. Try again shortly." });
    // The all-zero digest of a failed scan is not accepted either.
    const zero = await w.put(DANA, "0".repeat(64));
    expect(errorOf(zero).code).toBe("CONFIG_INVALID");
    expect(w.approvals()).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["no request id", { requestId: undefined }],
    ["a request id that is not a uuid", { requestId: "abc" }],
    ["no repository", { repository: undefined }],
    ["a repository that is not owner/name", { repository: "demo" }],
    ["no digest", { expectedDigest: undefined }],
    ["a digest that is not a SHA-256", { expectedDigest: "abc" }],
    ["no reason", { reason: undefined }],
    ["an empty reason", { reason: "   " }],
    ["a reason of 301 characters", { reason: "x".repeat(301) }],
    ["a reason with a control character", { reason: "line one\nline two" }],
    ["a reason with a zero-width character", { reason: "looks\u200Bfine" }],
    ["a field it does not know", { surprise: true }],
  ])("refuses a body with %s", async (_name, change) => {
    const w = await world();
    const current = (await w.digest())[0]!;
    const body = { requestId: randomUUID(), repository: REPOSITORY, expectedDigest: current.digest, reason: "ok", ...change };
    const reply = await w.dev(DANA, "PUT", w.PATH, Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)));
    expect(reply.status, JSON.stringify(reply.body)).toBe(400);
    expect(w.approvals()).toEqual([]);
  });

  it("does not repeat a field the caller made up", async () => {
    const w = await world();
    const current = (await w.digest())[0]!;
    const reply = await w.put(DANA, current.digest, { "secret-field-name": true });
    expect(reply.status).toBe(400);
    expect(JSON.stringify(reply.body)).not.toContain("secret-field-name");
    expect(errorOf(reply).message).toBe("body: has a field this request does not take");
  });

  it("takes a reason of exactly 300 characters, trimmed", async () => {
    const w = await world();
    expect((await w.ask(DANA, { reason: `  ${"x".repeat(300)}  ` })).status).toBe(202);
    expect(w.approvals()[0]!.subject).toMatchObject({ reason: "x".repeat(300) });
  });

  it("refuses a repository that is not the project's, without repeating it, and a project of another org", async () => {
    const w = await world();
    const current = (await w.digest())[0]!;
    const wrong = await w.put(DANA, current.digest, { repository: "evil/secret-name" });
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(wrong.body)).not.toContain("secret-name");
    expect(errorOf(wrong).message).toBe("repository: that is not one of this project's repositories");
    const foreign = await w.dev(ORIN, "PUT", w.PATH, { requestId: randomUUID(), repository: REPOSITORY, expectedDigest: current.digest, reason: "x" });
    expect(foreign.status).toBe(404);
    expect(w.approvals()).toEqual([]);
  });

  it("refuses an archived project", async () => {
    const w = await world();
    const current = (await w.digest())[0]!;
    w.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", status: "archived", createdBy: "x", createdAt: "2026-10-01T00:00:00.000Z" });
    const reply = await w.put(DANA, current.digest);
    expect(errorOf(reply).code).toBe("PROJECT_ARCHIVED");
    expect(w.approvals()).toEqual([]);
  });

  it("takes only the repository's own name in any case, and stores it lower case", async () => {
    const w = await world();
    const current = (await w.digest())[0]!;
    const reply = await w.put(DANA, current.digest, { repository: "EXAMPLE/Demo" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(w.approvals()[0]!.subject).toMatchObject({ repository: REPOSITORY });
  });
});

describe("an agent operation capability can't reach the routes (R3-4)", () => {
  const forged = (actions: string[]) => {
    const body = Buffer.from(JSON.stringify({ workspaceId: randomUUID(), operationId: randomUUID(), fence: 1, actions, expiresAt: Math.floor(Date.now() / 1000) + 3_600 })).toString("base64url");
    return `${body}.${createHmac("sha256", "c".repeat(64)).update(body).digest("base64url")}`;
  };

  it("answers 401 to a capability for agent-tools, for any other action, and for a real one, on both methods, in either header", async () => {
    const w = await world();
    const current = (await w.digest())[0]!;
    const capabilities = [
      forged(["agent-tools"]),
      forged(["agent-tools", "agent-skills", "model-access", "events", "result", "artifacts"]),
      issueCapability({ callbackSigningKey: "c".repeat(64) }, randomUUID(), randomUUID(), 1, { agentSkills: true, modelAccess: true, pullRequest: true }),
    ];
    const call = (method: string, headers: Record<string, string>, body?: unknown) => w.handler({
      version: "2.0", rawPath: "/v1/app/projects/payments/connectors/github/comment-triggers", rawQueryString: "", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: randomUUID(), http: { method } },
    });
    const put = { requestId: randomUUID(), repository: REPOSITORY, expectedDigest: current.digest, reason: "x" };
    for (const capability of capabilities) {
      for (const headers of [{ "x-agentx-callback-capability": capability }, { authorization: `Bearer ${capability}` }, { "x-agentx-callback-capability": capability, authorization: capability }]) {
        expect((await call("GET", headers)).statusCode).toBe(401);
        expect((await call("PUT", headers, put)).statusCode).toBe(401);
      }
    }
    expect((await call("PUT", {}, put)).statusCode).toBe(401);
    expect(w.approvals()).toEqual([]);
    expect(w.reads).toEqual([`https://github.com/${REPOSITORY}.git ${TEST_ORG}`]);
  });

  it("is reached by no MCP tool: nothing in the MCP package names the route", () => {
    const directory = join(process.cwd(), "packages/mcp/src");
    const text = readdirSync(directory).filter((name) => name.endsWith(".ts")).map((name) => readFileSync(join(directory, name), "utf8")).join("\n");
    expect(text).not.toMatch(/comment-triggers|comment_triggers|opt[-_]out/iu);
  });
});

describe("confirming an opt-out (the handler the confirmation page calls)", () => {
  it("is registered, and its rule is the live org_admin rule", async () => {
    const w = await world();
    expect(getApprovalSubjectHandler("opt_out")).toBeTypeOf("function");
    await w.ask(DANA);
    const record = w.approvals()[0]!;
    const rule = getApproverRule("org_admin")!;
    expect(await rule(w.deps, record, { orgId: TEST_ORG, developerId: DANA.developerId, orgRole: "member" })).toBe(true);
    expect(await rule(w.deps, record, { orgId: TEST_ORG, developerId: OWEN.developerId, orgRole: "member" })).toBe(true);
    // Maintainer of the project and member of the org: not an admin, whatever the session claims.
    expect(await rule(w.deps, record, { orgId: TEST_ORG, developerId: MAX.developerId, orgRole: "admin" })).toBe(false);
    expect(await rule(w.deps, record, { orgId: TEST_ORG, developerId: EVE.developerId, orgRole: "owner" })).toBe(false);
    // An admin of another org can't.
    expect(await rule(w.deps, record, { orgId: ORG_B, developerId: ORIN.developerId, orgRole: "admin" })).toBe(false);
    // Demoted since the request was made: read now.
    seedMembership(w.db, DANA.developerId, { orgId: TEST_ORG, role: "member" });
    expect(await rule(w.deps, record, { orgId: TEST_ORG, developerId: DANA.developerId, orgRole: "admin" })).toBe(false);
  });

  it("stores exactly what was reviewed, and records the event and the audit item in the same transaction", async () => {
    const w = await world();
    const seen: Array<Array<{ Put?: { Item: Record<string, unknown> }; Delete?: unknown }>> = [];
    const original = w.db.send.bind(w.db) as (command: unknown) => Promise<unknown>;
    (w.db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") seen.push((command as { input: { TransactItems: never } }).input.TransactItems);
      return original(command);
    };
    const current = (await w.digest())[0]!;
    await w.ask(DANA);
    await w.confirm(OWEN);
    const stored = (await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments"))!;
    expect(stored).toMatchObject({
      orgId: TEST_ORG, project: "payments", repository: REPOSITORY, digest: current.digest, files: current.files, reviewedBy: OWEN.developerId,
      reason: "Only our own triage bot reacts", approvalId: w.approvals()[0]!.approvalId,
      fileShas: { [WORKFLOW]: blobSha(baseFiles()[WORKFLOW]!), [SCRIPT]: blobSha("echo triage") },
    });
    expect(Date.parse(stored.reviewedAt)).toBeGreaterThan(Date.now() - 60_000);
    // One transaction wrote the opt-out, its event and its audit item.
    const transaction = seen.find((items) => items.some((item) => item.Put?.Item.entityType === "COMMENT_TRIGGER_OPT_OUT"))!;
    expect(transaction.map((item) => String(item.Put?.Item.entityType ?? item.Put?.Item.pk).replace(/AUDIT_PENDING#\d+/u, "AUDIT_PENDING"))).toEqual(["COMMENT_TRIGGER_OPT_OUT", "COMMENT_TRIGGER_EVENT", "AUDIT_PENDING"]);
    const [event] = w.audit.recordedBy("comment_trigger_opt_out.applied");
    expect(event).toMatchObject({
      orgId: TEST_ORG, action: "comment_trigger_opt_out.applied", actor: { kind: "member", id: OWEN.developerId }, target: { kind: "repository", name: REPOSITORY }, facts: { scope: "repository" },
      details: [{ subject: "org", fields: { project: "payments" } }],
    });
    expect(w.db.find((item) => item.entityType === "COMMENT_TRIGGER_EVENT")).toMatchObject([{ kind: "applied", project: "payments", repository: REPOSITORY, digest: current.digest, by: OWEN.developerId }]);
  });

  it("makes a plain comment safe, and a slash command still needs a person (the opt-out removes only the repository rule)", async () => {
    const w = await world();
    expect(await consequential(w, "Looks right to me. The failing test is in auth.spec.ts.")).toEqual({ repositoryRule: true, text: false, either: true });
    await w.optOutThrough();
    expect(await consequential(w, "Looks right to me. The failing test is in auth.spec.ts.")).toEqual({ repositoryRule: false, text: false, either: false });
    expect(await consequential(w, "/deploy production")).toMatchObject({ repositoryRule: false, text: true, either: true });
    expect(await consequential(w, "bors r+")).toMatchObject({ repositoryRule: false, text: true, either: true });
    // The org's own command words still apply.
    expect(commentSignal({ body: "scripts/deploy.sh" }, { allowMentions: false, labelPaths: [], extraCommandWords: ["deploy"] }).consequential).toBe(true);
  });

  it("is refused when the workflows changed between the request and the confirmation, and stores nothing", async () => {
    const w = await world();
    await w.ask(DANA);
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo changed after the admin looked" });
    const error = await w.confirm().then(() => undefined, (thrown: Error) => thrown);
    expect(error?.message).toBe(`CONFIG_INVALID: ${COMMENT_TRIGGER_STALE_TEXT}`);
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeUndefined();
    expect(w.audit.recorded()).toEqual([]);
  });

  it("is refused for a scan that failed closed", async () => {
    const w = await world();
    await w.ask(DANA);
    w.setDown(true);
    const error = await w.confirm().then(() => undefined, (thrown: Error) => thrown);
    expect(error?.message).toBe("CONFIG_INVALID: Rovara can't read this repository's workflows completely, so they can't be reviewed. Try again shortly.");
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeUndefined();
  });

  it("is refused for a record nobody decided, and for a repository the project no longer has", async () => {
    const w = await world();
    await w.ask(DANA);
    const record = w.approvals()[0]!;
    const handler = getApprovalSubjectHandler("opt_out")!;
    expect((await handler(w.deps, record).then(() => undefined, (thrown: Error) => thrown))?.message).toMatch(/^CONFIG_INVALID: this change has not been decided by anyone/);
    const moved = { ...w.deps, projectRepositories: async () => [{ name: "other", url: "https://github.com/example/other.git" }] };
    expect((await handler(moved, { ...record, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown))?.message).toBe("CONFIG_INVALID: this repository is no longer one of the project's, so the opt-out can't be applied");
    const gone = { ...w.deps, projectRepositories: async () => undefined };
    expect((await handler(gone, { ...record, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown))?.message).toMatch(/no longer one of the project's/);
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeUndefined();
  });

  it("changes nothing the second time the same confirmation arrives", async () => {
    const w = await world();
    await w.ask(DANA);
    await w.confirm();
    const before = structuredClone([...w.db.items]);
    await w.confirm();
    expect([...w.db.items]).toEqual(before);
    expect(w.audit.recordedBy("comment_trigger_opt_out.applied")).toHaveLength(1);
  });

  it("belongs to one project: another project's runs in the same repository are not opted out", async () => {
    const w = await world();
    await w.optOutThrough();
    expect((await w.rule("payments")).consequential).toBe(false);
    expect((await w.rule("other-project")).consequential).toBe(true);
  });
});

describe("the opt-out lapses when the digest changes (the run's scan)", () => {
  it.each<[string, (files: Record<string, string>) => Record<string, string>, string[]]>([
    ["a script the workflow calls changes", (files) => ({ ...files, [SCRIPT]: "echo changed" }), [SCRIPT]],
    ["the triggering workflow itself changes", (files) => ({ ...files, [WORKFLOW]: workflow("issue_comment", `./${SCRIPT} --verbose`) }), [WORKFLOW]],
    ["a workflow that triggers is added", (files) => ({ ...files, ".github/workflows/new.yml": workflow("issues") }), [".github/workflows/new.yml"]],
    ["a bot config appears", (files) => ({ ...files, "bors.toml": "status = []" }), ["bors.toml"]],
    ["a local action the workflow uses is added", (files) => ({ ...files, [WORKFLOW]: `${files[WORKFLOW]!}      - uses: ./.github/actions/x\n`, ".github/actions/x/action.yml": "runs:\n  using: composite\n  steps: []\n" }),
      [".github/actions/x/action.yml", WORKFLOW]],
  ])("when %s: deletes the opt-out, records the event and the audit item, and the plain comment waits again", async (_name, change, changed) => {
    const w = await world();
    await w.optOutThrough();
    const old = (await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments"))!;
    expect((await w.rule()).consequential).toBe(false);
    w.setFiles(change(baseFiles()));
    const after = await w.rule();
    expect(after).toMatchObject({ consequential: true, optedOut: false });
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeUndefined();
    expect(w.db.get(commentTriggerOptOutKey(TEST_ORG, REPOSITORY, "payments").pk, commentTriggerOptOutKey(TEST_ORG, REPOSITORY, "payments").sk)).toBeUndefined();
    const [event] = w.db.find((item) => item.entityType === "COMMENT_TRIGGER_EVENT" && item.kind === "lapsed");
    expect(event).toMatchObject({
      orgId: TEST_ORG, project: "payments", repository: REPOSITORY, oldDigest: old.digest, newDigest: after.scan.digest, changedFiles: [...changed].sort(), by: "system", taskId: "task-1",
      notice: LAPSE_TEXT([...changed].sort().join(", ")),
    });
    const [audited] = w.audit.recordedBy("comment_trigger_opt_out.lapsed");
    expect(audited).toMatchObject({ orgId: TEST_ORG, actor: { kind: "system", id: "rovara" }, target: { kind: "repository", name: REPOSITORY }, facts: { scope: "repository" } });
    expect(await consequential(w, "Looks right to me.")).toMatchObject({ repositoryRule: true });
  });

  it("deletes the opt-out and the event are one transaction with the audit item", async () => {
    const w = await world();
    await w.optOutThrough();
    const seen: Array<Array<Record<string, { Item?: Record<string, unknown> }>>> = [];
    const original = w.db.send.bind(w.db) as (command: unknown) => Promise<unknown>;
    (w.db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") seen.push((command as { input: { TransactItems: never } }).input.TransactItems);
      return original(command);
    };
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo changed" });
    await w.rule();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.map((item) => Object.keys(item)[0])).toEqual(["Delete", "Put", "Put"]);
    expect(String(seen[0]![2]!.Put!.Item!.pk)).toMatch(/^AUDIT_PENDING#/u);
  });

  it("lapses nothing while the files are the same, in this run or the next", async () => {
    const w = await world();
    await w.optOutThrough();
    for (const task of ["task-1", "task-2", "task-3"]) expect((await w.rule("payments", task)).optedOut).toBe(true);
    expect(w.db.find((item) => item.entityType === "COMMENT_TRIGGER_EVENT" && item.kind === "lapsed")).toEqual([]);
    expect(w.audit.recordedBy("comment_trigger_opt_out.lapsed")).toEqual([]);
  });

  it("compares the opt-out with the scan of every run: it is never cached across runs", async () => {
    const w = await world();
    await w.optOutThrough();
    expect((await w.rule("payments", "task-1")).optedOut).toBe(true);
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo changed" });
    // The same run's cached scan still says the files are as they were, so its opt-out holds for the rest of that run only.
    const cache = memoryRunCache();
    await w.rule("payments", "task-2", cache);
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeUndefined();
    expect((await w.rule("payments", "task-3")).optedOut).toBe(false);
  });

  it("scans the repository once per run however many writes the run makes", async () => {
    const w = await world();
    const cache = memoryRunCache();
    for (let call = 0; call < 4; call += 1) await w.rule("payments", "task-1", cache);
    expect(w.agentRepositoryReader).toHaveBeenCalledTimes(1);
    await w.rule("payments", "task-2");
    expect(w.agentRepositoryReader).toHaveBeenCalledTimes(2);
  });

  it("names a removed workflow as changed, and a repository that no longer triggers is not consequential", async () => {
    const w = await world();
    await w.optOutThrough();
    w.setFiles({ "README.md": "nothing here" });
    const after = await w.rule();
    expect(after).toMatchObject({ consequential: false, optedOut: false });
    expect(after.scan.triggers).toBe(false);
    const [event] = w.db.find((item) => item.entityType === "COMMENT_TRIGGER_EVENT" && item.kind === "lapsed");
    expect(event!.changedFiles).toEqual([SCRIPT, WORKFLOW].sort());
  });

  it("does not lapse on a scan that failed closed, treats the write as consequential meanwhile, and honours the opt-out again when the files are read", async () => {
    const w = await world();
    await w.optOutThrough();
    w.setDown(true);
    const during = await w.rule("payments", "task-2");
    expect(during).toMatchObject({ consequential: true, optedOut: false });
    expect(during.scan.failedClosed).toBe(true);
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeDefined();
    w.setDown(false);
    expect((await w.rule("payments", "task-3")).optedOut).toBe(true);
    expect(w.audit.recordedBy("comment_trigger_opt_out.lapsed")).toEqual([]);
  });

  it("lapses each project's opt-out of the repository, once each, with its own event and audit item", async () => {
    const w = await world();
    await w.optOutThrough();
    // A second project with an opt-out for the same repository (made directly: only payments exists in the harness).
    const first = (await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments"))!;
    const { pk: _pk, sk: _sk, ...rest } = first as unknown as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- the key is rebuilt
    w.db.set({ ...commentTriggerOptOutKey(TEST_ORG, REPOSITORY, "web"), entityType: "COMMENT_TRIGGER_OPT_OUT", ...rest, project: "web", approvalId: "apr_bbbbbbbbbbbbbbbbbbbb" });
    expect((await listOptOutViews(w.deps, TEST_ORG)).map((entry) => entry.project)).toEqual(["payments", "web"]);
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo changed" });
    await w.rule();
    expect(await listOptOutViews(w.deps, TEST_ORG)).toEqual([]);
    expect(w.db.find((item) => item.entityType === "COMMENT_TRIGGER_EVENT" && item.kind === "lapsed").map((item) => item.project).sort()).toEqual(["payments", "web"]);
    const lapsed = w.audit.recordedBy("comment_trigger_opt_out.lapsed");
    expect(lapsed).toHaveLength(2);
    expect(new Set(lapsed.map((event: AuditEventInput) => event.eventId)).size).toBe(2);
  });

  it("lapses once when two runs find the change at the same time", async () => {
    const w = await world();
    await w.optOutThrough();
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo changed" });
    await Promise.all([w.rule("payments", "task-a"), w.rule("payments", "task-b"), w.rule("payments", "task-c")]);
    expect(w.db.find((item) => item.entityType === "COMMENT_TRIGGER_EVENT" && item.kind === "lapsed")).toHaveLength(1);
    expect(w.audit.recordedBy("comment_trigger_opt_out.lapsed")).toHaveLength(1);
  });

  it("lapses an opt-out made again for the same digests as a new occurrence, not a repeat the ledger would drop", async () => {
    const w = await world();
    await w.optOutThrough();
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo changed" });
    await w.rule();
    w.setFiles(baseFiles());
    await w.ask(DANA, { reason: "Reviewed again" });
    await w.confirm();
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo changed" });
    await w.rule("payments", "task-9");
    expect(w.db.find((item) => item.entityType === "COMMENT_TRIGGER_EVENT" && item.kind === "lapsed")).toHaveLength(2);
    const lapsed = w.audit.recordedBy("comment_trigger_opt_out.lapsed");
    expect(new Set(lapsed.map((event: AuditEventInput) => event.eventId)).size).toBe(2);
  });

  it("lapses nothing on a scan that failed closed, whoever asks", async () => {
    const w = await world();
    await w.optOutThrough();
    const closed = await repoCommandTriggers({ repositoryReader: async () => { throw new Error("down"); } }, { orgId: TEST_ORG, repository: REPOSITORY });
    expect(closed.failedClosed).toBe(true);
    expect(await lapseStaleOptOuts(w.deps, { orgId: TEST_ORG, repository: REPOSITORY, scan: closed })).toBe(0);
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeDefined();
  });

  it("lapses nothing for a different repository or another org's opt-outs", async () => {
    const w = await world();
    await w.optOutThrough();
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo changed" });
    const scan = await repoCommandTriggers({ repositoryReader: w.deps.repositoryReader! }, { orgId: TEST_ORG, repository: REPOSITORY });
    expect(await lapseStaleOptOuts(w.deps, { orgId: TEST_ORG, repository: "example/other", scan })).toBe(0);
    expect(await lapseStaleOptOuts(w.deps, { orgId: ORG_B, repository: REPOSITORY, scan })).toBe(0);
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeDefined();
    expect(await lapseStaleOptOuts(w.deps, { orgId: TEST_ORG, repository: REPOSITORY, scan })).toBe(1);
  });

  it("reads a stored opt-out that is not valid, or that names another org, as no opt-out", async () => {
    const w = await world();
    await w.optOutThrough();
    const key = commentTriggerOptOutKey(TEST_ORG, REPOSITORY, "payments");
    const item = w.db.get(key.pk, key.sk) as Record<string, unknown>;
    w.db.set({ ...item, digest: "short" });
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeUndefined();
    w.db.set({ ...item, orgId: ORG_B });
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeUndefined();
    expect(await listOptOutViews(w.deps, TEST_ORG)).toEqual([]);
    expect((await w.rule()).consequential).toBe(true);
  });
});

describe("who is told when an opt-out lapses", () => {
  it("shows the exact notice to the org's owners and admins and to the project's maintainers, and to no one else", async () => {
    const w = await world();
    await w.optOutThrough();
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo changed" });
    await w.rule();
    const notice = { at: expect.any(String) as string, project: "payments", repository: REPOSITORY, notice: LAPSE_TEXT(SCRIPT) };
    const seenBy = (who: Developer, orgRole: OrgRole, orgId: OrgId = TEST_ORG) => listCommentTriggerNotices(w.deps, { orgId, developerId: who.developerId, orgRole });
    expect(await seenBy(DANA, "admin")).toEqual([notice]);
    expect(await seenBy(OWEN, "owner")).toEqual([notice]);
    expect(await seenBy(MAX, "member")).toEqual([notice]);
    // A contributor, a person with no role on the project and another org's admin see nothing.
    expect(await seenBy(EVE, "member")).toEqual([]);
    expect(await seenBy({ ...EVE, developerId: "8".repeat(64) }, "member")).toEqual([]);
    expect(await seenBy(ORIN, "admin", ORG_B)).toEqual([]);
  });

  it("reads the person's role now, so a person who stopped maintaining the project stops hearing", async () => {
    const w = await world();
    await w.optOutThrough();
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo changed" });
    await w.rule();
    expect(await listCommentTriggerNotices(w.deps, { orgId: TEST_ORG, developerId: MAX.developerId, orgRole: "member" })).toHaveLength(1);
    w.members.grant(TEST_ORG, "payments", MAX.developerId, "contributor");
    expect(await listCommentTriggerNotices(w.deps, { orgId: TEST_ORG, developerId: MAX.developerId, orgRole: "member" })).toEqual([]);
  });

  it("forgets a notice after thirty days, and lists the newest first", async () => {
    const w = await world();
    await w.optOutThrough();
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo changed" });
    await w.rule();
    const later = { ...w.deps, now: () => Date.now() + 31 * 86_400_000 };
    expect(await listCommentTriggerNotices(later, { orgId: TEST_ORG, developerId: DANA.developerId, orgRole: "admin" })).toEqual([]);
  });

  it("words the notice for the files that changed, shortened and without control characters", () => {
    expect(commentTriggerLapseNotice("a/b", ["x.yml"])).toBe("Rovara is asking again about comment-triggered workflows in a/b: x.yml changed. Agent comments there wait for a person until an admin reviews them.");
    expect(commentTriggerLapseNotice("a/b", [])).toContain("the workflow files changed");
    expect(commentTriggerLapseNotice("a/b", Array.from({ length: 12 }, (_, index) => `f${String(index)}.sh`))).toContain("f0.sh, f1.sh, f2.sh, f3.sh, f4.sh, f5.sh, f6.sh, f7.sh, f8.sh, f9.sh and 2 more changed");
    const nasty = commentTriggerLapseNotice("a/b", ["evil\n\u202Efile\u200B.sh", "y".repeat(500)]);
    expect(nasty).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(nasty).not.toContain("y".repeat(121));
  });
});

describe("GET /v1/app/org/agent-guardrails lists the opt-outs", () => {
  it("lists each active opt-out with its project, repository, digest, files, reviewer, time and reason, to any member", async () => {
    const w = await world();
    const path = "/v1/app/org/agent-guardrails";
    expect((await w.call(EVE, "GET", path)).body).toEqual({ guardrails: DEFAULT_AGENT_GUARDRAILS, revision: 0, commentTriggerOptOuts: [] });
    await w.optOutThrough();
    const current = (await w.digest())[0]!;
    const shown = await w.call(EVE, "GET", path);
    expect(shown.status).toBe(200);
    expect(shown.body.commentTriggerOptOuts).toEqual([{
      project: "payments", repository: REPOSITORY, digest: current.digest, files: current.files, reviewedBy: DANA.developerId, reviewedAt: expect.any(String) as string, reason: "Only our own triage bot reacts",
    }]);
    // The stored internals (the blob shas and the approval) are not shown.
    expect(JSON.stringify(shown.body)).not.toContain("fileShas");
    expect(JSON.stringify(shown.body)).not.toContain("approvalId");
    expect((await w.call(ORIN, "GET", path)).body).toMatchObject({ commentTriggerOptOuts: [] });
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo changed" });
    await w.rule();
    expect((await w.call(EVE, "GET", path)).body.commentTriggerOptOuts).toEqual([]);
  });

  it("leaves the guardrails document alone: saving it does not touch the opt-outs", async () => {
    const w = await world();
    await w.optOutThrough();
    const saved = await w.call(DANA, "PUT", "/v1/app/org/agent-guardrails", { expectedRevision: 0, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxAutonomy: "suggest" } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).not.toHaveProperty("commentTriggerOptOuts");
    expect(w.db.get(agentGuardrailsKey(TEST_ORG).pk, "META")).toBeDefined();
    expect(await listOptOutViews(w.deps, TEST_ORG)).toHaveLength(1);
  });
});

// ---- Fix round 1

describe("a project with several repositories (review M7)", () => {
  /** Adds a second revision of `payments` with a second repository, as the broker reads the project. */
  function withTwoRepositories(w: Awaited<ReturnType<typeof world>>) {
    const first = w.db.get(projectRevisionKey(TEST_ORG, "payments", 1).pk, projectRevisionKey(TEST_ORG, "payments", 1).sk) as { definition: { repositories: unknown[] } } & Record<string, unknown>;
    const second = { ...first, ...projectRevisionKey(TEST_ORG, "payments", 2), definition: { ...first.definition, revision: 2, repositories: [...first.definition.repositories, { name: "api", url: "https://github.com/example/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" }] } };
    w.db.set(second);
  }

  it("asks for the repository to be named instead of scanning every one in one request", async () => {
    const w = await world();
    withTwoRepositories(w);
    const reply = await w.review();
    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toEqual({ code: "CONFIG_INVALID", message: "repository: this project has several repositories; name one with ?repository= (example/api, example/demo)" });
    expect(w.reads).toEqual([]);
  });

  it("scans the one that is named, and a project with one repository still needs no name", async () => {
    const w = await world();
    withTwoRepositories(w);
    const named = await w.review(DANA, "payments", "?repository=example/api");
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    expect(named.body.repositories).toMatchObject([{ repository: "example/api" }]);
    expect(w.reads).toEqual([`https://github.com/example/api.git ${TEST_ORG}`]);
    expect((await (await world()).review()).status).toBe(200);
  });
});

describe("the project's pinned installation (review M5)", () => {
  it("holds the request, the confirmation and the run's gate to it", async () => {
    const w = await world();
    w.pin(55);
    const current = (await w.digest())[0]!;
    const caller = { orgId: TEST_ORG, developerId: DANA.developerId, orgRole: "admin" as const };
    w.pins.length = 0;
    await requestOptOut(w.deps, caller, { requestId: randomUUID(), project: "payments", repository: REPOSITORY, expectedDigest: current.digest, reason: "ok" });
    await w.confirm();
    await commentTriggerRule({ ...w.deps, repositoryReader: w.deps.repositoryReader! }, { orgId: TEST_ORG, project: "payments", repository: REPOSITORY, installationId: 55, cache: memoryRunCache() });
    expect(w.pins).toEqual([55, 55, 55]);
    w.pin(undefined);
    w.pins.length = 0;
    await w.rule();
    expect(w.pins).toEqual([undefined]);
  });

  it("is read from the project's current revision by the routes", async () => {
    const w = await world();
    const key = projectRevisionKey(TEST_ORG, "payments", 1);
    const revision = w.db.get(key.pk, key.sk) as { definition: { repositories: Array<Record<string, unknown>> } } & Record<string, unknown>;
    w.db.set({ ...revision, definition: { ...revision.definition, repositories: revision.definition.repositories.map((repository) => ({ ...repository, installationId: 7 })) } });
    expect((await w.review()).status).toBe(200);
    expect(w.pins).toEqual([7]);
  });
});

describe("the reason is stored as it was validated (review M6)", () => {
  it("trims it at the function boundary, whoever calls", async () => {
    const w = await world();
    const current = (await w.digest())[0]!;
    const caller = { orgId: TEST_ORG, developerId: DANA.developerId, orgRole: "admin" as const };
    await requestOptOut(w.deps, caller, { requestId: randomUUID(), project: "payments", repository: REPOSITORY, expectedDigest: current.digest, reason: "   padded reason   " });
    expect(w.approvals()[0]!.subject).toMatchObject({ reason: "padded reason" });
  });
});

describe("a lapse that loses to a newer opt-out (review mutant M8)", () => {
  it("still treats a remaining opt-out of another digest as not opted out", async () => {
    const w = await world();
    await w.optOutThrough();
    const key = commentTriggerOptOutKey(TEST_ORG, REPOSITORY, "payments");
    const stored = w.db.get(key.pk, key.sk) as Record<string, unknown>;
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo changed" });
    // Another admin's opt-out for some other digest lands just as the lapse commits: the lapse is cancelled and that opt-out stays.
    const original = w.db.send.bind(w.db) as (command: unknown) => Promise<unknown>;
    let cancelled = 0;
    (w.db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
      const items = (command as { input?: { TransactItems?: Array<{ Delete?: { Key: { pk: string; sk: string } } }> } }).input?.TransactItems;
      if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand" && items?.[0]?.Delete?.Key.sk === key.sk) {
        cancelled += 1;
        w.db.set({ ...stored, digest: "e".repeat(64), approvalId: "apr_cccccccccccccccccccc" });
        throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
      }
      return original(command);
    };
    const after = await w.rule();
    expect(cancelled).toBe(1);
    expect((await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments"))?.digest).toBe("e".repeat(64));
    expect(after).toMatchObject({ consequential: true, optedOut: false });
  });
});

describe("requestOptOut at the function boundary", () => {
  it("checks the repository, the digest and the scan itself, whoever calls it", async () => {
    const w = await world();
    const current = (await w.digest())[0]!;
    const caller = { orgId: TEST_ORG, developerId: DANA.developerId, orgRole: "admin" as const };
    const base = { requestId: randomUUID(), project: "payments", repository: REPOSITORY, expectedDigest: current.digest, reason: "ok" };
    await expect(requestOptOut(w.deps, caller, { ...base, repository: "someone/else" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(requestOptOut(w.deps, caller, { ...base, reason: "two\nlines" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(requestOptOut(w.deps, caller, { ...base, reason: "" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(requestOptOut(w.deps, caller, { ...base, project: "not a project!" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(requestOptOut(w.deps, caller, { ...base, requestId: "nope" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(requestOptOut(w.deps, caller, { ...base, expectedDigest: "b".repeat(64) })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(requestOptOut(w.deps, { ...caller, orgId: ORG_B }, base)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const { projectRepositories: _projects, ...withoutProjects } = w.deps; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
    const { repositoryReader: _reader, ...withoutReader } = w.deps; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
    await expect(requestOptOut(withoutProjects, caller, base)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(requestOptOut(withoutReader, caller, base)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(w.approvals()).toEqual([]);
    expect((await requestOptOut(w.deps, caller, base)).confirmUrl).toMatch(/\/v1\/app\/approve\/apr_/u);
  });
});


describe("deciding an opt-out on the confirmation page (Task 21a-wiring, review M8)", () => {
  const CELL = "https://cell.example.com";
  /** The page for `who`, with a session that signed in 30 seconds ago, through the real `apr` kind. */
  function pageFor(w: Awaited<ReturnType<typeof world>>) {
    const store = new DecideStore({ documentClient: w.db, tableName: "signin", now: Date.now });
    const context: DecideRequestContext = { store, now: Date.now, cellOrigin: CELL, kinds: { apr: approvalDecideKind(w.deps) } };
    return async (who: Developer, approvalId: string, decision?: "approve" | "decline") => {
      const cookie = `cookie-${who.name}-${randomUUID()}`.padEnd(40, "x");
      const signedInAt = Math.floor(Date.now() / 1000) - 30;
      await store.putSession(cookie, {
        orgId: TEST_ORG, developerId: who.developerId, approvalId, signedInAt, method: "email_code",
        csrfHash: createHash("sha256").update(csrfTokenFor(cookie)).digest("hex"), expiresAt: signedInAt + 600,
      });
      const url = new URL(`${CELL}/v1/app/approve/${approvalId}`);
      return routeDecidePage(context, decision === undefined
        ? { method: "GET", path: url.pathname, requestId: "r", headers: { cookie: `${DECIDE_COOKIE}=${cookie}` } }
        : {
          method: "POST", path: url.pathname, requestId: "r", body: new URLSearchParams({ csrf: csrfTokenFor(cookie), decision }).toString(),
          headers: { origin: CELL, "content-type": "application/x-www-form-urlencoded", cookie: `${DECIDE_COOKIE}=${cookie}` },
        }, url);
    };
  }

  it("shows the reviewed files and digest to an org admin, applies exactly the stored opt-out when they approve, and records them as the reviewer", async () => {
    const w = await world();
    const current = (await w.digest())[0]!;
    expect((await w.ask(DANA)).status).toBe(202);
    const record = w.approvals()[0]!;
    const page = pageFor(w);
    const shown = await page(DANA, record.approvalId);
    expect(shown.statusCode).toBe(200);
    for (const expected of [REPOSITORY, "payments", current.digest, ...current.files, "Only our own triage bot reacts", "Approve", "Decline"]) expect(shown.body, expected).toContain(expected);
    // Nothing is applied by looking.
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeUndefined();
    const done = await page(DANA, record.approvalId, "approve");
    expect(done.statusCode, done.body).toBe(200);
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toMatchObject({ digest: current.digest, files: current.files, reviewedBy: DANA.developerId, approvalId: record.approvalId });
    expect(w.approvals()[0]).toMatchObject({ status: "APPROVED_DONE", decidedBy: DANA.developerId });
    expect(w.audit.recordedBy("comment_trigger_opt_out.applied")).toHaveLength(1);
    expect((await consequential(w, "Looks right to me.")).repositoryRule).toBe(false);
  });

  it("gives a maintainer who is not an org admin, and a member, 403 on the page and applies nothing", async () => {
    const w = await world();
    expect((await w.ask(DANA)).status).toBe(202);
    const record = w.approvals()[0]!;
    const page = pageFor(w);
    for (const who of [MAX, EVE]) {
      const shown = await page(who, record.approvalId);
      expect(shown.statusCode, who.name).toBe(403);
      expect(shown.body).toContain("Only an organization owner or admin can decide this.");
      expect((await page(who, record.approvalId, "approve")).statusCode, who.name).toBe(403);
    }
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeUndefined();
    expect(w.approvals()[0]).toMatchObject({ status: "PENDING" });
  });

  it("ends APPROVED_FAILED with the stale words when the workflows changed after the request, and stores nothing", async () => {
    const w = await world();
    expect((await w.ask(DANA)).status).toBe(202);
    const record = w.approvals()[0]!;
    w.setFiles({ ...baseFiles(), [SCRIPT]: "echo something else" });
    const done = await pageFor(w)(DANA, record.approvalId, "approve");
    expect(done.body).toContain("did not go through");
    expect(done.body).toContain(COMMENT_TRIGGER_STALE_TEXT.replace(/'/g, "&#39;"));
    expect(w.approvals()[0]).toMatchObject({ status: "APPROVED_FAILED" });
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeUndefined();
  });

  it("applies nothing when an org admin declines", async () => {
    const w = await world();
    expect((await w.ask(DANA)).status).toBe(202);
    const record = w.approvals()[0]!;
    expect((await pageFor(w)(OWEN, record.approvalId, "decline")).statusCode).toBe(200);
    expect(w.approvals()[0]).toMatchObject({ status: "DECLINED", decidedBy: OWEN.developerId });
    expect(await readOptOut(w.deps, TEST_ORG, REPOSITORY, "payments")).toBeUndefined();
    expect(w.audit.recorded()).toEqual([expect.objectContaining({ action: "approval.decided" })]);
  });
});
