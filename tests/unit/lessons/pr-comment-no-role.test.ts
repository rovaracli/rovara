// Review L1 (lessons visibility follow-up): since owner decision 34 a span restricted only to a project repository no longer disqualifies a correction by its audience, so who wrote it is what keeps an outsider out.
// A commenter in a PRIVATE project repository who (a) has a Rovara account but no role in the project, or (b) only carries GitHub's `author_association: MEMBER`, must never count as a member's correction.
// Proved on the production path: a GitHub delivery through the real record runtime's tap (the real actor resolver and project-role read), the captured-rows reader the lesson subject source uses, then `memberCorrectionOf`.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { developerOrgKey, githubInstallationKey, githubRepoProjectKey, orgMemberKey } from "@agentx/cloud-contracts";
import { githubMemberKey, projectMemberKey, projectRevisionKey } from "@rovara-code/contracts";
import { createTeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { SdkUnavailableError } from "../../../packages/broker/src/team-record/aws-adapters.js";
import { tableCapturedRows } from "../../../packages/broker/src/lessons/captured-rows.js";
import { memberCorrectionOf } from "../../../packages/broker/src/lessons/reflect.js";
import type { MarkedSpan } from "../../../packages/broker/src/lessons/reflect-input.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A, T0 } from "../../support/team-record-core.js";

const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;
const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const noSdk = async (): Promise<never> => { throw new SdkUnavailableError(); };
const OWNER = "a".repeat(64);
const REPO_ID = 101;
const SCOPE = `github:repo/${String(REPO_ID)}`;

function setup() {
  const db = new FakeDynamoDb({ indexKeys });
  const company = (developerId: string, githubId: string, role: "member") => {
    db.set({ ...githubMemberKey(ORG_A, githubId), entityType: "GITHUB_MEMBER", developerId, orgId: ORG_A });
    db.set({ ...developerOrgKey(developerId), entityType: "DEVELOPER_ORG", orgId: ORG_A, role });
    db.set({ ...orgMemberKey(ORG_A, developerId), entityType: "ORG_MEMBER", orgId: ORG_A, developerId, role });
  };
  // 111: a project contributor (the positive control). 222: a Rovara account in the company with NO grant on the project.
  company("dev-member", "111", "member");
  db.set({ ...projectMemberKey(ORG_A, "dev-member", "web"), entityType: "MEMBERSHIP", ownerKey: "dev-member", projectName: "web", grantId: randomUUID(), role: "developer", projectRole: "contributor" });
  company("dev-norole", "222", "member");
  db.set({ ...githubInstallationKey(55), entityType: "GITHUB_INSTALLATION", orgId: ORG_A, status: "active" });
  db.set({ ...githubRepoProjectKey(REPO_ID, ORG_A, "web"), entityType: "GITHUB_REPO_PROJECT", orgId: ORG_A, project: "web", installationId: 55, githubRepositoryId: REPO_ID });
  db.set({
    ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION",
    definition: { name: "web", revision: 1, repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app", installationId: 55, githubRepositoryId: REPO_ID }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." },
  });
  const runtime = createTeamRecordRuntime({ env: { ...ON, TEAM_RECORD_VECTORS_ROLE_ARN: undefined }, documentClient: db, stateTableName: "State", now: () => T0, sdk: noSdk });
  if (runtime === undefined) throw new Error("the runtime was not built");
  return { db, runtime };
}
type World = ReturnType<typeof setup>;

async function addPrivateRepositoryRow(w: World): Promise<void> {
  const reply = await w.runtime.routes({
    method: "POST", path: "/v1/app/projects/web/record/sources", query: {}, caller: { orgId: ORG_A, developerId: OWNER, projectRole: "maintainer" },
    write: { orgRole: "owner", browserSession: true, body: () => ({ action: "add", requestId: randomUUID(), source: "github", scope: SCOPE, retention: "C", audienceDefault: "maintainers", enabled: true }) },
  }) as { status: number };
  expect(reply.status).toBe(200);
}

/** A review comment on pull request 5 of the private project repository, by GitHub account `accountId`, with the association GitHub reports. */
async function comment(w: World, accountId: number, commentId: number, association: string) {
  const user = { id: accountId, login: `user${String(accountId)}`, type: "User" };
  return w.runtime.taps.github({
    eventName: "pull_request_review_comment", deliveryId: randomUUID(),
    payload: {
      action: "created", installation: { id: 55 }, repository: { id: REPO_ID, full_name: "acme/api", private: true, default_branch: "main" }, pull_request: { number: 5 },
      comment: { id: commentId, html_url: `https://github.com/acme/api/pull/5#c${String(commentId)}`, body: "Always wrap fetches in withRetry", user, author_association: association, path: "src/a.ts", updated_at: "2026-10-30T10:40:00Z" },
    },
  });
}
const wordsOf = (w: World, commentId: number) => tableCapturedRows({ documentClient: w.db, tableName: "TeamRecord" }).pullRequestWords({ workspaceId: ORG_A, project: "web", host: "github", repository: "acme/api", number: 5, surface: "review_comment", commentId: String(commentId) });

/** The span the lesson subject source makes from a comment's words: restricted only to the repository (a private project repository), trust from the author's standing. */
const spanOf = (trust: MarkedSpan["trust"], kind: MarkedSpan["kind"], authorId = "dev-x"): MarkedSpan => ({
  id: "S1", kind, trust, authorId, text: "Always wrap fetches in withRetry",
  audience: { kind: "restricted", acl: { source: "github", scope: SCOPE, capturedAt: "2026-10-30T10:40:00.000Z", liveCheck: "on_read" } }, scopes: [SCOPE],
});

describe("L1: a PR comment in a private project repository by someone with no project role is never a member's correction", () => {
  it("positive control: a contributor's comment is stored as a member's words (so the other cases prove something)", async () => {
    const w = setup();
    await addPrivateRepositoryRow(w);
    expect(await comment(w, 111, 41, "MEMBER")).toMatchObject({ written: 1 });
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT" && item.kind === "github.review_comment")[0]).toMatchObject({ trust: "member", actor: { developerId: "dev-member", trust: "member" } });
    const found = await wordsOf(w, 41);
    expect(found).toMatchObject({ authorDeveloperId: "dev-member", audience: { kind: "restricted" } });
    // And with the repository-only restriction no longer disqualifying (decision 34), a human_edit / review_finding span of such a member IS a correction.
    expect(memberCorrectionOf([spanOf("member", "review_finding"), spanOf("member", "human_edit")], "member")).toBe(true);
  });

  it("(a) a Rovara account in the company with no project role: the stored row is an outsider's, and no member words come out of it", async () => {
    const w = setup();
    await addPrivateRepositoryRow(w);
    await comment(w, 222, 42, "MEMBER");
    const rows = w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT" && item.kind === "github.review_comment");
    // Whether the row is kept or not, it is never a member's: no row names the account as a member.
    expect(rows.every((row) => row.trust !== "member" && (row.actor as { trust?: string } | undefined)?.trust !== "member")).toBe(true);
    expect(await wordsOf(w, 42)).toBeUndefined();
    for (const kind of ["pr_comment", "review_finding", "human_edit"] as const) expect(memberCorrectionOf([spanOf("outsider", kind, "dev-norole")], "outsider")).toBe(false);
    // Even if such a span were handed over with every other check passing, a lesson whose input held an outsider never counts.
    expect(memberCorrectionOf([spanOf("member", "review_finding", "dev-norole")], "outsider")).toBe(false);
  });

  it("(b) GitHub's author_association MEMBER with no linked account: nothing is stored as a member's, and author_association alone never makes one", async () => {
    const w = setup();
    await addPrivateRepositoryRow(w);
    await comment(w, 333, 43, "MEMBER");
    await comment(w, 333, 44, "OWNER");
    const rows = w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT" && item.kind === "github.review_comment");
    expect(rows.every((row) => row.trust !== "member" && (row.actor as { trust?: string } | undefined)?.trust !== "member")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("dev-member");
    expect(await wordsOf(w, 43)).toBeUndefined();
    expect(await wordsOf(w, 44)).toBeUndefined();
    expect(memberCorrectionOf([spanOf("outsider", "human_edit", "dev-x")], "outsider")).toBe(false);
  });
});
