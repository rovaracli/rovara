import { describe, expect, it } from "vitest";
import { orgMemberKey } from "../../packages/cloud-contracts/src/org-node.js";
import { projectMemberKey, projectRevisionKey } from "@rovara-code/contracts";
import { taskPersonInviteStateConditions, type TaskPersonProjectAuthorityWitness } from "../../packages/broker/src/aws/task-person-invite-authority-fence.js";
import { TEST_ORG } from "../support/orgs.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const actorId = "a".repeat(64);
const targetId = "b".repeat(64);
const projectRevision = { ...projectRevisionKey(TEST_ORG, "project-alpha", 7), revision: 7, developerTasksPresent: false };
const grantWitness = (developerId: string): TaskPersonProjectAuthorityWitness => ({
  taskId, developerId, project: "project-alpha", access: "granted", projectRevision,
  membership: { ...projectMemberKey(TEST_ORG, developerId, "project-alpha"), projectName: "project-alpha", role: "developer" },
});
const orgWitness = (developerId: string, key = orgMemberKey(TEST_ORG, developerId)): TaskPersonProjectAuthorityWitness => ({
  taskId, developerId, project: "project-alpha", access: "granted", projectRevision, orgMember: { ...key, role: "owner" },
});

describe("invite authority conditions for an org owner or admin with no grant (final review I1)", () => {
  it("fences the org member row for a person granted by their org role", () => {
    const conditions = taskPersonInviteStateConditions({ taskId, project: "project-alpha", teamId: "T0TEAM", actor: grantWitness(actorId), target: orgWitness(targetId) });
    expect(conditions).toContainEqual({ kind: "org-role", ...orgMemberKey(TEST_ORG, targetId), developerId: targetId });
  });

  it("refuses an org member row keyed to another developer", () => {
    expect(taskPersonInviteStateConditions({ taskId, project: "project-alpha", teamId: "T0TEAM", actor: grantWitness(actorId),
      target: orgWitness(targetId, orgMemberKey(TEST_ORG, actorId)) })).toBeUndefined();
  });

  it("refuses a witness that carries both a grant and an org member row", () => {
    expect(taskPersonInviteStateConditions({ taskId, project: "project-alpha", teamId: "T0TEAM", actor: grantWitness(actorId),
      target: { ...orgWitness(targetId), membership: grantWitness(targetId).membership! } })).toBeUndefined();
  });
});
