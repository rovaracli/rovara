// Team record source-row lane, T4 part A: the code host end to end with a real source row. The row is added through the runtime's own source route (T2); GitHub deliveries (already verified: the signature is
// checked before the tap, `aws/github-webhooks.ts`) then go through `runtime.taps.github`. Proved: the rows land under the project and place the source row names, a private repository's rows carry
// the place's audience with a live check, retention comes from the row, a repository that is deleted or transferred is tombstoned and the row's health becomes `failing` WITHOUT a new revision, and
// with no row nothing is recorded.
import { randomUUID } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { developerOrgKey, githubInstallationKey, githubRepoProjectKey, recordSourceKey } from "@agentx/cloud-contracts";
import { githubMemberKey, projectRevisionKey, type OrgId } from "@rovara-code/contracts";
import { createTeamRecordRuntime, type TeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { needsLinkedAuthor } from "../../../packages/broker/src/team-record/unlinked.js";
import { markSourceFailing, sourceConfigFromItem } from "../../../packages/broker/src/team-record/store.js";
import { SdkUnavailableError } from "../../../packages/broker/src/team-record/aws-adapters.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A, ORG_B, T0 } from "../../support/team-record-core.js";

const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;
const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const noSdk = async (): Promise<never> => { throw new SdkUnavailableError(); };
const OWNER = "a".repeat(64);
const SCOPE = "github:repo/101";
const REPO_ID = 101;
const hex = (n: number): string => n.toString(16).padStart(40, "0");

function setup(options: { repositoryIsPrivate?: boolean } = {}) {
  const db = new FakeDynamoDb({ indexKeys });
  // A linked member: GitHub account 123 is the company member dev-1.
  for (const orgId of [ORG_A, ORG_B]) db.set({ ...githubMemberKey(orgId, "123"), entityType: "GITHUB_MEMBER", developerId: "dev-1", orgId });
  db.set({ ...developerOrgKey("dev-1"), entityType: "DEVELOPER_ORG", orgId: ORG_A, role: "member" });
  // The installation, its repository and the project holding it (org A's project "web").
  db.set({ ...githubInstallationKey(55), entityType: "GITHUB_INSTALLATION", orgId: ORG_A, status: "active" });
  db.set({ ...githubRepoProjectKey(REPO_ID, ORG_A, "web"), entityType: "GITHUB_REPO_PROJECT", orgId: ORG_A, project: "web", installationId: 55, githubRepositoryId: REPO_ID });
  db.set({
    ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION",
    definition: { name: "web", revision: 1, repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app", installationId: 55, githubRepositoryId: REPO_ID }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." },
  });
  const runtime = createTeamRecordRuntime({ env: { ...ON, TEAM_RECORD_VECTORS_ROLE_ARN: undefined }, documentClient: db, stateTableName: "State", now: () => T0, sdk: noSdk });
  if (runtime === undefined) throw new Error("the runtime was not built");
  return { db, runtime, isPrivate: options.repositoryIsPrivate !== false };
}
type World = ReturnType<typeof setup>;

const sourcesPath = "/v1/app/projects/web/record/sources";
async function postSource(runtime: TeamRecordRuntime, body: Record<string, unknown>, orgId: OrgId = ORG_A) {
  return runtime.routes({
    method: "POST", path: sourcesPath, query: {}, caller: { orgId, developerId: OWNER, projectRole: "maintainer" },
    write: { orgRole: "owner", browserSession: true, body: () => body },
  }) as Promise<{ status: number; body: Record<string, unknown> }>;
}
const addGithubRow = (runtime: TeamRecordRuntime, over: Record<string, unknown> = {}, orgId?: OrgId) =>
  postSource(runtime, { action: "add", requestId: randomUUID(), source: "github", scope: SCOPE, retention: "C", audienceDefault: "maintainers", enabled: true, ...over }, orgId);

const rowsOf = (w: World) => w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT");
const sourceRow = (w: World, orgId: OrgId = ORG_A) => sourceConfigFromItem(w.db.get(recordSourceKey(orgId, "web", "github", SCOPE).pk, recordSourceKey(orgId, "web", "github", SCOPE).sk));

const alice = { id: 123, login: "maya", type: "User" };
const repository = (isPrivate: boolean) => ({ id: REPO_ID, full_name: "acme/api", private: isPrivate, default_branch: "main" });
const envelope = (w: World, action: string) => ({ action, installation: { id: 55 }, repository: repository(w.isPrivate) });
const pullRequest = (number: number, over: Record<string, unknown> = {}) => ({
  number, html_url: `https://github.com/acme/api/pull/${String(number)}`, title: "Fix cart total", body: "Rounds correctly now", user: alice, head: { sha: hex(number), ref: "fix" }, base: { ref: "main" },
  merged: false, updated_at: "2026-10-30T10:00:00Z", ...over,
});
const delivery = (eventName: string, payload: Record<string, unknown>, deliveryId = randomUUID()) => ({ eventName, deliveryId, payload });

describe("A. no source row: nothing is recorded", () => {
  it("every kind of delivery is dropped before anything is stored", async () => {
    const w = setup();
    const opened = await w.runtime.taps.github(delivery("pull_request", { ...envelope(w, "opened"), pull_request: pullRequest(5) }));
    expect(opened).toMatchObject({ written: 0 });
    await w.runtime.taps.github(delivery("check_suite", { ...envelope(w, "completed"), check_suite: { id: 9, conclusion: "failure", head_sha: hex(5), pull_requests: [{ number: 5 }], updated_at: "2026-10-30T10:00:00Z" } }));
    expect(rowsOf(w)).toEqual([]);
  });

  it("a disabled row records nothing either", async () => {
    const w = setup();
    expect(await addGithubRow(w.runtime, { enabled: false })).toMatchObject({ status: 200 });
    await w.runtime.taps.github(delivery("pull_request", { ...envelope(w, "opened"), pull_request: pullRequest(5) }));
    expect(rowsOf(w)).toEqual([]);
  });
});

describe("A. with a source row added through the route", () => {
  it("every delivery kind lands under the row's project and place, with a private repository's audience (live check on read) and the row's retention", async () => {
    const w = setup({ repositoryIsPrivate: true });
    expect(await addGithubRow(w.runtime)).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    const tap = w.runtime.taps.github;
    await tap(delivery("pull_request", { ...envelope(w, "opened"), pull_request: pullRequest(5) }));
    await tap(delivery("pull_request", { ...envelope(w, "closed"), pull_request: pullRequest(5, { merged: true, merge_commit_sha: hex(99), updated_at: "2026-10-30T11:00:00Z" }), sender: alice }));
    await tap(delivery("pull_request_review", { ...envelope(w, "submitted"), pull_request: { number: 5 }, review: { id: 31, html_url: "https://github.com/acme/api/pull/5#r31", state: "changes_requested", body: "Please add a test", user: alice, submitted_at: "2026-10-30T10:30:00Z" } }));
    await tap(delivery("pull_request_review_comment", { ...envelope(w, "created"), pull_request: { number: 5 }, comment: { id: 41, html_url: "https://github.com/acme/api/pull/5#c41", body: "nit: rename this", user: alice, path: "src/a.ts", updated_at: "2026-10-30T10:40:00Z" } }));
    const ci = await tap(delivery("check_suite", { ...envelope(w, "completed"), check_suite: { id: 9, conclusion: "failure", head_sha: hex(5), pull_requests: [{ number: 5 }], updated_at: "2026-10-30T10:50:00Z" } }));
    expect(ci).toMatchObject({ written: 1, refused: 0 });
    const stored = rowsOf(w);
    expect([...new Set(stored.map((row) => row.kind))].sort()).toEqual(["github.ci", "github.pr", "github.review", "github.review_comment"]);
    for (const row of stored) {
      expect(row).toMatchObject({ workspaceId: ORG_A, project: "web", scope: SCOPE, retention: "C", source: "github" });
      expect(row.audience).toMatchObject({ kind: "restricted", acl: { scope: SCOPE, liveCheck: "on_read" } });
    }
    expect(stored.find((row) => row.kind === "github.ci")).toMatchObject({ structured: { conclusion: "failure" } });
    expect(stored.find((row) => row.kind === "github.review")?.text).toContain("Please add a test");
  });

  it("a public repository's rows are the project's", async () => {
    const w = setup({ repositoryIsPrivate: false });
    await addGithubRow(w.runtime);
    await w.runtime.taps.github(delivery("pull_request", { ...envelope(w, "opened"), pull_request: pullRequest(5) }));
    expect(rowsOf(w)).toMatchObject([{ kind: "github.pr", retention: "C", audience: { kind: "project" } }]);
  });

  it("retention A keeps nothing of an outside source: no row, and no word of the pull request anywhere in the table", async () => {
    const w = setup({ repositoryIsPrivate: false });
    expect(await addGithubRow(w.runtime, { retention: "A" })).toMatchObject({ status: 200 });
    const result = await w.runtime.taps.github(delivery("pull_request", { ...envelope(w, "opened"), pull_request: pullRequest(5) }));
    expect(result).toMatchObject({ written: 0 });
    expect(rowsOf(w)).toEqual([]);
    expect(JSON.stringify(w.db.find(() => true))).not.toContain("Rounds correctly");
  });

  it("a push that reverts a commit no Rovara task made records nothing and fails nothing", async () => {
    const w = setup();
    await addGithubRow(w.runtime);
    const before = rowsOf(w).length;
    const result = await w.runtime.taps.github(delivery("push", {
      ...envelope(w, "push"), ref: "refs/heads/main", before: hex(1), after: hex(2), sender: alice,
      commits: [{ id: hex(2), message: `Revert "Fix cart total"\n\nThis reverts commit ${hex(7)}.` }],
    }));
    expect(result).toMatchObject({ written: 0, failed: 0 });
    expect(rowsOf(w)).toHaveLength(before);
  });

  it("another org's admin cannot add the place (the repository is not theirs) and a delivery never lands in another org", async () => {
    const w = setup();
    await addGithubRow(w.runtime);
    const other = await addGithubRow(w.runtime, {}, ORG_B);
    expect(other.status).not.toBe(200);
    await w.runtime.taps.github(delivery("pull_request", { ...envelope(w, "opened"), pull_request: pullRequest(5) }));
    expect(rowsOf(w).every((row) => row.workspaceId === ORG_A)).toBe(true);
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE" && item.workspaceId === ORG_B)).toEqual([]);
  });
});

describe("A. a repository deleted or transferred", () => {
  it.each(["deleted", "transferred"])("%s: the place is tombstoned, the rows are hidden, the row's health is failing, and its revision is untouched", async (action) => {
    const w = setup();
    await addGithubRow(w.runtime);
    await w.runtime.taps.github(delivery("pull_request", { ...envelope(w, "opened"), pull_request: pullRequest(5) }));
    expect(rowsOf(w)).toHaveLength(1);
    const before = sourceRow(w)!;
    expect(before).toMatchObject({ health: "unknown", revision: 1 });
    await w.runtime.taps.github(delivery("repository", envelope(w, action)));
    const after = sourceRow(w)!;
    expect(after).toMatchObject({ health: "failing", revision: 1, enabled: true, updatedAt: before.updatedAt, retention: "C" });
    // Nothing more is recorded for the closed place, and the old row no longer reads.
    await w.runtime.taps.github(delivery("pull_request", { ...envelope(w, "opened"), pull_request: pullRequest(6) }));
    const visible = await w.runtime.routes({ method: "GET", path: "/v1/app/projects/web/record/search", query: { query: "cart" }, caller: { orgId: ORG_A, developerId: OWNER, projectRole: "maintainer" } });
    expect(JSON.stringify(visible?.body)).not.toContain("Fix cart total");
    expect(rowsOf(w).filter((row) => row.kind === "github.pr" && !row.tombstone)).toHaveLength(0);
  });

  it("the admin's revision fence and the health write do not fight: the editor who loaded revision 1 can still change the row, and the change keeps health", async () => {
    const w = setup();
    await addGithubRow(w.runtime);
    await w.runtime.taps.github(delivery("repository", envelope(w, "deleted")));
    expect(sourceRow(w)).toMatchObject({ health: "failing", revision: 1 });
    const changed = await postSource(w.runtime, { action: "change", requestId: randomUUID(), source: "github", scope: SCOPE, expectedRevision: 1, audienceDefault: "project" });
    expect(changed).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(sourceRow(w)).toMatchObject({ health: "failing", revision: 2, audienceDefault: "project" });
  });

  it("a repository deleted with no source row is still tombstoned and writes no row", async () => {
    const w = setup();
    await w.runtime.taps.github(delivery("repository", envelope(w, "deleted")));
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE")).toEqual([]);
  });
});

describe("A. who must be linked", () => {
  it("only a code host's CI verdict (kind github.ci: no author, no words) needs no linked person; any other actor-less system draft, any text, or a person's row still does", () => {
    expect(needsLinkedAuthor({ source: "github", kind: "github.ci", trust: "system" })).toBe(false);
    expect(needsLinkedAuthor({ source: "github", kind: "github.ci", trust: "system", text: "some words" })).toBe(true);
    expect(needsLinkedAuthor({ source: "github", kind: "github.revert", trust: "system" })).toBe(true);
    expect(needsLinkedAuthor({ source: "linear", kind: "ticket.updated", trust: "system" })).toBe(true);
    expect(needsLinkedAuthor({ source: "github", trust: "system" })).toBe(true);
    expect(needsLinkedAuthor({ source: "github", kind: "github.ci", trust: "outsider" })).toBe(true);
    expect(needsLinkedAuthor({ source: "linear" })).toBe(true);
  });
});

describe("A. markSourceFailing", () => {
  const table = (w: World) => ({ documentClient: w.db, tableName: "TeamRecord" });

  it("marks only a row that exists, once, and answers what it did", async () => {
    const w = setup();
    expect(await markSourceFailing(table(w), ORG_A, "github", SCOPE)).toBe("no_row");
    await addGithubRow(w.runtime);
    expect(await markSourceFailing(table(w), ORG_A, "github", SCOPE)).toBe("marked");
    expect(await markSourceFailing(table(w), ORG_A, "github", SCOPE)).toBe("already");
    expect(await markSourceFailing(table(w), ORG_B, "github", SCOPE)).toBe("no_row");
  });

  it("a row changed between the read and the write is read again: the write lands on the new revision and never overwrites the editor's change", async () => {
    const w = setup();
    await addGithubRow(w.runtime);
    let raced = false;
    const racing = {
      send: async (command: unknown) => {
        if (!raced && command instanceof UpdateCommand && JSON.stringify(command.input.ExpressionAttributeValues).includes("failing")) {
          raced = true;
          // An admin's change commits first (the route's own update: only the five mutable fields, revision + 1).
          await postSource(w.runtime, { action: "change", requestId: randomUUID(), source: "github", scope: SCOPE, expectedRevision: 1, audienceDefault: "project" });
        }
        return w.db.send(command as never);
      },
    };
    expect(await markSourceFailing({ documentClient: racing, tableName: "TeamRecord" }, ORG_A, "github", SCOPE)).toBe("marked");
    expect(raced).toBe(true);
    expect(sourceRow(w)).toMatchObject({ health: "failing", revision: 2, audienceDefault: "project" });
  });

  it("a row that keeps changing is given up on (the caller logs it) and nothing is overwritten", async () => {
    const w = setup();
    await addGithubRow(w.runtime);
    let revision = 1;
    const busy = {
      send: async (command: unknown) => {
        if (command instanceof UpdateCommand && JSON.stringify(command.input.ExpressionAttributeValues).includes("failing")) {
          revision += 1;
          await postSource(w.runtime, { action: "change", requestId: randomUUID(), source: "github", scope: SCOPE, expectedRevision: revision - 1, audienceDefault: revision % 2 === 0 ? "project" : "maintainers" });
        }
        return w.db.send(command as never);
      },
    };
    expect(await markSourceFailing({ documentClient: busy, tableName: "TeamRecord" }, ORG_A, "github", SCOPE)).toBe("busy");
    expect(sourceRow(w)).toMatchObject({ health: "unknown" });
  });
});
