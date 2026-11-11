// Enterprise foundations, task I2: the Auditor reads the audit log and exports it, and can write nothing anywhere. The guarantee does not rest on every one
// of the hundreds of role checks remembering the new role: the route dispatcher refuses everything an Auditor asks for except a short allow-list. These cases
// fail when the rule they name is removed.
import { describe, expect, it } from "vitest";
import { editionPolicy } from "@agentx/contracts";
import {
  AUDITOR_ALLOWED_ROUTES,
  AUDITOR_REFUSED,
  canReadAuditLog,
  requireAuditorEdition,
  requireAuditorRoute,
} from "../../packages/broker/src/org/auditor.js";

const auditor = { orgRole: "auditor" as const };
const refused = (method: string, path: string, who: { orgRole: string } = auditor) => {
  try { requireAuditorRoute(who, method, path); return undefined; } catch (error) { return (error as { code?: string; message: string }); }
};

/** Writes an owner or admin can make through /v1/app and /v1/dev: a representative set from every area (people, projects, work, agents, settings, money, connections). */
const WRITE_ROUTES: ReadonlyArray<[string, string]> = [
  ["PUT", "/v1/app/org/members/" + "a".repeat(64) + "/role"], ["DELETE", "/v1/app/org/members/" + "a".repeat(64)], ["POST", "/v1/app/org/invites"], ["POST", "/v1/app/org/invites/reviewed"],
  ["PUT", "/v1/app/org/budget"], ["PUT", "/v1/app/org"], ["POST", "/v1/app/org/leave"], ["PUT", "/v1/app/me/name"], ["DELETE", "/v1/app/me/identities/github"], ["POST", "/v1/app/me/identities/github"],
  ["POST", "/v1/app/projects"], ["PUT", "/v1/app/projects/payments/settings"], ["PUT", "/v1/app/projects/payments/members/" + "b".repeat(64)], ["DELETE", "/v1/app/projects/payments/members/" + "b".repeat(64)],
  ["POST", "/v1/app/projects/payments/archive"], ["POST", "/v1/app/projects/payments/reviewed-archive"], ["POST", "/v1/app/projects/payments/allowed-websites"], ["PUT", "/v1/app/projects/payments/slack-channel"],
  ["POST", "/v1/app/projects/payments/working-branches"], ["PUT", "/v1/app/projects/payments/code-settings"], ["PUT", "/v1/app/projects/payments/how-we-work"], ["POST", "/v1/app/projects/payments/code-intent"],
  ["POST", "/v1/dev/tasks"], ["POST", "/v1/dev/tasks/t1/continue"], ["POST", "/v1/dev/tasks/t1/cancel"], ["POST", "/v1/app/tasks/t1/decide"], ["POST", "/v1/app/tasks/t1/merge"],
  ["POST", "/v1/app/agents"], ["PUT", "/v1/app/agents/a1"], ["DELETE", "/v1/app/agents/a1"], ["POST", "/v1/app/chains"], ["POST", "/v1/app/chain-runs"], ["POST", "/v1/app/sessions"],
  ["POST", "/v1/app/devices"], ["PUT", "/v1/app/connections/github"], ["PUT", "/v1/app/org/model-selection-policy"], ["PUT", "/v1/app/org/budget/spend"], ["POST", "/v1/app/spend-requests"],
  ["POST", "/v1/app/triggers"], ["POST", "/v1/app/realtime/token"], ["POST", "/v1/app/github/connect"],
  // The audit area itself: only the export start is a POST an Auditor may make.
  ["PUT", "/v1/app/org/audit/exports"], ["DELETE", "/v1/app/org/audit/exports/e1"], ["POST", "/v1/app/org/audit/records"], ["POST", "/v1/app/org/audit/status"], ["POST", "/v1/app/org/audit/exports/e1"],
  ["POST", "/v1/app/org/audit/admin/records"],
  // Learning v2 L3b: reading lessons is open to the Auditor; deciding, rolling back and marking are not.
  ["POST", "/v1/app/projects/payments/lessons/les_abc12345/approve"], ["POST", "/v1/app/projects/payments/lessons/les_abc12345/reject"], ["POST", "/v1/app/projects/payments/lessons/les_abc12345/merge"], ["POST", "/v1/app/projects/payments/lessons/les_abc12345/retire"],
  ["POST", "/v1/app/projects/payments/lessons/rollback"], ["POST", "/v1/app/projects/payments/lessons"], ["PUT", "/v1/app/projects/payments/lessons"], ["DELETE", "/v1/app/projects/payments/lessons/sources"],
  ["POST", "/v1/app/tasks/11111111-1111-4111-8111-111111111111/lessons/les_abc12345/feedback"],
  // Lessons in the repo (R2): switching a repository's lessons file on or off, resuming it, answering the pointer.
  ["POST", "/v1/app/projects/payments/lessons/repo"],
  // The preset: the project's set, approve and cancel, and the company's set, approve and cancel (lessons leftovers sweep, LT-2).
  ["POST", "/v1/app/projects/payments/lessons/preset"], ["POST", "/v1/app/projects/payments/lessons/preset/approve"], ["POST", "/v1/app/projects/payments/lessons/preset/cancel"],
  ["POST", "/v1/app/org/lessons/preset"], ["POST", "/v1/app/org/lessons/preset/approve"], ["POST", "/v1/app/org/lessons/preset/cancel"],
];
const READ_ROUTES_NOT_ALLOWED: ReadonlyArray<[string, string]> = [
  ["GET", "/v1/app/nav"], ["GET", "/v1/app/projects"], ["GET", "/v1/dev/projects"], ["GET", "/v1/app/org/members"], ["GET", "/v1/app/org"], ["GET", "/v1/app/org/budget"], ["GET", "/v1/app/org/invites"],
  ["GET", "/v1/dev/tasks/t1"], ["GET", "/v1/app/agents"], ["GET", "/v1/app/sessions"], ["GET", "/v1/app/models"], ["GET", "/v1/app/org/spend"], ["GET", "/v1/app/projects/payments/members"],
  ["GET", "/v1/app/org/audit/unknown"], ["GET", "/v1/app/org/audit"], ["GET", "/v1/app/org/audit/"], ["GET", "/v1/app/org/audit/exports/e1/extra"], ["GET", "/v1/app/org/audit/admin/records"],
  // L3b: the lessons reads that stay with people who decide, and everything else that only looks like the open two.
  ["GET", "/v1/app/projects/payments/lessons/digest"], ["GET", "/v1/app/projects/payments/lessons/les_abc12345/history"], ["GET", "/v1/app/projects/payments/lessons/"], ["GET", "/v1/app/projects/payments/lessons/sources/x"],
  // The company's preset and its waiting proposal are for the people who could decide it, never for the Auditor.
  ["GET", "/v1/app/org/lessons/preset"], ["GET", "/v1/app/org/lessons/preset/approve"],
  // The company's pending approvals, a project's spend and its merge rules (the finished list's scopes ride on /v1/app/sessions, above): reads for the people who work with them, not the Auditor.
  ["GET", "/v1/app/org/approvals/pending-summary"], ["GET", "/v1/app/projects/payments/spend"], ["GET", "/v1/app/projects/payments/code-settings"],
  ["GET", "/v1/app/projects/pay/ments/lessons"], ["GET", "/v1/app/projects/payments/Lessons"], ["GET", "/v1/app/tasks/11111111-1111-4111-8111-111111111111/lessons"], ["GET", "/v1/app/tasks/11111111-1111-4111-8111-111111111111/loaded-knowledge"],
];

describe("the Auditor's route allow-list", () => {
  it("lets the Auditor read the audit log, its status, start an export and read an export, and read its own identity", () => {
    for (const [method, path] of [
      ["GET", "/v1/app/org/audit/records"], ["GET", "/v1/dev/org/audit/records"], ["GET", "/v1/app/org/audit/status"], ["POST", "/v1/app/org/audit/exports"],
      ["POST", "/v1/dev/org/audit/exports"], ["GET", "/v1/app/org/audit/exports/exp_abc-123"], ["GET", "/v1/app/me"], ["GET", "/v1/app/install"],
      ["GET", "/v1/app/projects/payments/lessons"], ["GET", "/v1/app/projects/payments/lessons/sources"],
    ] as const) expect(refused(method, path), `${method} ${path}`).toBeUndefined();
    expect(AUDITOR_ALLOWED_ROUTES.length).toBe(8);
  });

  it("refuses every write route of a representative set with a fixed FORBIDDEN sentence", () => {
    for (const [method, path] of WRITE_ROUTES) {
      const error = refused(method, path);
      expect(error?.code, `${method} ${path}`).toBe("FORBIDDEN");
      expect(error?.message, `${method} ${path}`).toContain(AUDITOR_REFUSED);
    }
  });

  it("refuses the reads that are not on the list, and unknown audit paths", () => {
    for (const [method, path] of READ_ROUTES_NOT_ALLOWED) expect(refused(method, path)?.code, `${method} ${path}`).toBe("FORBIDDEN");
  });

  it("refuses by method: any method but GET (and the one export POST), in any case or spelling", () => {
    for (const method of ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "get", "Get", "post", "", "GET ", "CONNECT"]) {
      expect(refused(method, "/v1/app/org/audit/records")?.code, `[${method}]`).toBe("FORBIDDEN");
    }
    expect(refused("POST", "/v1/app/org/audit/records")?.code).toBe("FORBIDDEN");
    expect(refused("GET", "/v1/app/org/audit/exports")?.code).toBe("FORBIDDEN");
  });

  it("matches the whole path: no prefix, suffix, trailing slash, case change, dot segment or encoded separator gets through", () => {
    for (const path of [
      "/v1/app/org/audit/records/", "/V1/app/org/audit/records", "/v1/app/org/audit/Records", "/v1/app/org/audit/records/../../members", "/v1/app/org/audit/records%2f..%2fmembers",
      "/v1/app/org/audit/exports/a/b", "/v1/app/org/audit/exports/%2e%2e", "/v1/app/org/audit/exports/..", "/v1/app/org/audit/exports/a%2fb", "/x/v1/app/org/audit/records", "/v1/app/org/audit/records?x=1",
      "/v1/app/me/name", "/v1/app/me/", "/v1/app/org/audit/exports/a\n", "/v1/app/org/audit/records\n/v1/app/org", "", "/", "v1/app/org/audit/records",
    ]) expect(refused("GET", path)?.code, JSON.stringify(path)).toBe("FORBIDDEN");
  });

  it("is a no-op for every other role, and fails closed for a role it does not know", () => {
    for (const orgRole of ["owner", "admin", "member"]) expect(refused("DELETE", "/v1/app/org/members/x", { orgRole })).toBeUndefined();
    // An unreadable role is not a no-op: only the three roles that exist are let through untouched.
    for (const orgRole of ["", "AUDITOR", "Auditor", "viewer", "future-role", "owner "]) expect(refused("DELETE", "/v1/app/org/members/x", { orgRole })?.code, orgRole).toBe("FORBIDDEN");
  });
});

describe("who may read the audit log", () => {
  it("is owners, admins and the Auditor, and no one else", () => {
    for (const role of ["owner", "admin", "auditor"]) expect(canReadAuditLog(role)).toBe(true);
    for (const role of ["member", "", "Owner", "viewer", undefined, null, 1]) expect(canReadAuditLog(role as never)).toBe(false);
  });
});

describe("the Auditor is Enterprise only", () => {
  it("is allowed when the edition has the feature, and refused on Public or when the edition is not known", () => {
    expect(() => requireAuditorEdition(editionPolicy("enterprise"))).not.toThrow();
    expect(() => requireAuditorEdition(editionPolicy("public"))).toThrow("FORBIDDEN");
    expect(() => requireAuditorEdition(undefined)).toThrow("FORBIDDEN");
  });
});
