// Collaborator role (W11) test bench: the whole broker with the `payments` project, and one person of each project role, plus a company admin, a task owned by a contributor, and a browser
// session per person (the collaborator writes are browser-only). Another company's member and project of the same name prove company scoping.
import { randomUUID } from "node:crypto";
import { orgProjectCatalogKey, projectMemberKey, projectRevisionKey, type OrgId } from "@rovara-code/contracts";
import { type OrgRole, type ProjectRole } from "@agentx/cloud-contracts";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { storedRoleOf } from "../../packages/broker/src/org/project-members.js";
import { capturingAuditDeps } from "./audit-capture.js";
import { DEV_ISSUER, createDeveloperTaskBroker, seedMembership, type Developer } from "./developer-task-broker.js";
import { TEST_ORG } from "./orgs.js";

export const OTHER_ORG: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const person = (letter: string, name: string): Developer => ({ developerId: letter.repeat(64), name, provider: "oidc", sessionId: `s-${name.split(" ")[0]!.toLowerCase()}` });
export const PRIYA = person("1", "Priya Raman");   // maintainer
export const SAM = person("2", "Sam Okoye");       // viewer
export const LENA = person("3", "Lena Fischer");   // company admin (maintains every project)
export const KIT = person("4", "Kit Alvarez");     // contributor, owns the task
export const CARA = person("5", "Cara Lund");      // collaborator
export const NEO = person("6", "Neo Tanaka");      // contributor, not the task's owner
export const OTTO = person("7", "Otto Brand");     // another company's maintainer of its own `payments`
export const TASK_ID = "11111111-1111-4111-8111-111111111111";
export const PROJECT = "payments";

export type Reply = { status: number; body: Record<string, unknown> };
export const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string } | undefined;

const BINDING = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" } as const;

export async function collaboratorBench() {
  const audit = capturingAuditDeps();
  const h = await createDeveloperTaskBroker({ audit });
  const admit = async (who: Developer, orgRole: OrgRole, orgId: OrgId = TEST_ORG) => {
    await h.orgOf(who);
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, email: `${who.name.split(" ")[0]!.toLowerCase()}@example.com`, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(h.db, who.developerId, { orgId, role: orgRole });
  };
  const grant = (who: Developer, role: ProjectRole, orgId: OrgId = TEST_ORG) => h.db.set({
    ...projectMemberKey(orgId, who.developerId, PROJECT), entityType: "MEMBERSHIP", ownerKey: who.developerId, grantId: randomUUID(), projectName: PROJECT,
    role: storedRoleOf(role), projectRole: role, grantedBy: { developerId: PRIYA.developerId }, grantedAt: "2026-11-01T00:00:00.000Z",
  });
  for (const who of [PRIYA, SAM, KIT, CARA, NEO]) await admit(who, "member");
  await admit(LENA, "admin");
  grant(PRIYA, "maintainer"); grant(SAM, "viewer"); grant(KIT, "contributor"); grant(CARA, "collaborator"); grant(NEO, "contributor");
  // Another company with its own `payments` and its own maintainer: none of it may ever be reached from TEST_ORG, nor TEST_ORG's from it.
  await admit(OTTO, "member", OTHER_ORG);
  h.db.set({ ...projectRevisionKey(OTHER_ORG, PROJECT, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: { name: PROJECT, revision: 1, repositories: [{ name: "web", url: "https://github.com/other/payments.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." } });
  h.db.set({ ...orgProjectCatalogKey(OTHER_ORG, PROJECT), entityType: "PROJECT_CATALOG", name: PROJECT, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  grant(OTTO, "maintainer", OTHER_ORG);
  // The task a product decision is raised on: KIT's, in TEST_ORG's `payments`.
  h.db.set({ ...taskKey(TASK_ID), taskId: TASK_ID, orgId: TEST_ORG, project: PROJECT, developerId: KIT.developerId, developerName: KIT.name, provider: "oidc", ownerKey: KIT.developerId, workspaceId: "ws-1", createdAt: "2026-11-10T00:00:00.000Z" });

  const sessions = new Map<string, string>();
  const browserSessionOf = (who: Developer): string => {
    let id = sessions.get(who.developerId);
    if (id === undefined) {
      id = randomUUID();
      h.db.set({ ...(h.db.get(`SESSION#${who.sessionId}`, "META") as Record<string, unknown>), pk: `SESSION#${id}`, sessionId: id, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600, authTime: new Date().toISOString() });
      sessions.set(who.developerId, id);
    }
    return id;
  };
  /** A request the way the web app sends it: the session cookie, the origin and the CSRF header (a live browser session). */
  const web = async (who: Developer, method: string, path: string, body?: unknown): Promise<Reply> => {
    const id = browserSessionOf(who);
    const response = await h.handler({
      rawPath: path.replace("/v1/app/", "/v1/web/"), rawQueryString: "", routeKey: "ANY /v1/web/{proxy+}",
      headers: { cookie: `__Host-agentx_review_session=${id}`, "sec-fetch-site": "same-origin", origin: new URL(DEV_ISSUER).origin, [APP_CSRF_HEADER]: appCsrfTokenFor(id) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: "r", http: { method } },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  return { ...h, audit, admit, grant, web, deps: { documentClient: h.db, tableName: "state", now: () => Date.now(), audit: audit.audit } };
}
export type CollaboratorBench = Awaited<ReturnType<typeof collaboratorBench>>;
