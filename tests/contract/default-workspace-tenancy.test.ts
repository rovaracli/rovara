import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OrgIdSchema, defaultWorkspaceKey, projectMemberKey } from "@rovara-code/contracts";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { call, issuer } from "../support/slack-broker.js";

// A person's default workspace for a project is found by (org, person, project), never by (person, project) alone: a person removed from org A who joins org B,
// where a project has the same name, must not be handed org A's workspace (its id, status or revision), and must be able to get a default workspace of their own.

const ADMIN = { subject: "admin-subject", admin: true };
const PERSON_SUBJECT = "cognito-subject-of-a-person-who-moves-between-orgs";
const ORG_A = OrgIdSchema.parse("org_aaaaaaaaaaaaaaaaaaaa");
const ownerKey = createHash("sha256").update(issuer).update("\0").update(PERSON_SUBJECT).digest("hex");
type Row = Record<string, unknown>;

async function harness() {
  const broker = await createDeveloperTaskBroker();
  const db = broker.db;
  // The person is a developer of org B's (the test org's) project "payments".
  db.set({ ...projectMemberKey(TEST_ORG, ownerKey, "payments"), entityType: "MEMBERSHIP", ownerKey, projectName: "payments", role: "developer", grantId: "g" });
  const prepare = () => call(broker.handler, { method: "POST", path: "/v1/admin/workspaces/prepare", user: ADMIN, body: { requestId: randomUUID(), projectName: "payments", projectRevision: 1, ownerSubject: PERSON_SUBJECT } });
  const defaults = (): Row[] => db.find((row) => row.entityType === "DEFAULT_WORKSPACE");
  return { ...broker, db, prepare, defaults };
}

describe("the default workspace map is scoped by org", () => {
  it("is written under the org's own key", async () => {
    const h = await harness();
    const prepared = await h.prepare();
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(202);
    const [row, ...rest] = h.defaults();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ ...defaultWorkspaceKey(TEST_ORG, ownerKey, "payments"), workspaceId: (prepared.body.workspace as { id: string }).id });
  });

  it("never hands a person another org's workspace for a same-named project, and lets them have their own", async () => {
    const h = await harness();
    // The person's default workspace from org A: a workspace of org A, found by the key the map had before it was scoped by org.
    const first = await h.prepare();
    const firstId = (first.body.workspace as { id: string }).id;
    const own = h.db.get(`WORKSPACE#${firstId}`, "META")!;
    const foreignId = randomUUID();
    h.db.set({ ...own, pk: `WORKSPACE#${foreignId}`, id: foreignId, orgId: ORG_A, status: "READY" });
    for (const row of h.defaults()) h.db.delete(String(row.pk), String(row.sk));
    h.db.set({ pk: `OWNER#${ownerKey}`, sk: "PROJECT#payments", entityType: "DEFAULT_WORKSPACE", workspaceId: foreignId });

    // Preparing the person's workspace in this org neither returns org A's workspace nor stops at its row.
    const prepared = await h.prepare();
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(202);
    expect(JSON.stringify(prepared.body)).not.toContain(foreignId);
    const ownId = (prepared.body.workspace as { id: string }).id;
    expect(ownId).not.toBe(foreignId);
    expect(h.db.get(`WORKSPACE#${ownId}`, "META")).toMatchObject({ orgId: TEST_ORG });
    expect(h.db.get(defaultWorkspaceKey(TEST_ORG, ownerKey, "payments").pk, defaultWorkspaceKey(TEST_ORG, ownerKey, "payments").sk)).toMatchObject({ workspaceId: ownId });
  });

  it("still finds this org's own workspace under the key it had before it was scoped (rows already written), and only that", async () => {
    const h = await harness();
    const first = await h.prepare();
    const firstId = (first.body.workspace as { id: string }).id;
    for (const row of h.defaults()) h.db.delete(String(row.pk), String(row.sk));
    h.db.set({ pk: `OWNER#${ownerKey}`, sk: "PROJECT#payments", entityType: "DEFAULT_WORKSPACE", workspaceId: firstId });
    const again = await h.prepare();
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    expect((again.body.workspace as { id: string }).id).toBe(firstId);
    expect(h.defaults()).toHaveLength(1);
  });
});
