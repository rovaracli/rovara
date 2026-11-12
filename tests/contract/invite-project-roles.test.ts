// The project roles an invite may carry are spelled out in Cloud's invite-creation.ts (so the browser's start-up bundle does not load Code's app-projects module); they must stay
// exactly Code's project roles, in order, and accept and refuse the same values.
import { expect, it } from "vitest";
import { ProjectRoleSchema } from "@rovara-code/contracts";
import { InviteProjectRoleSchema, InviteProjectSchema } from "@agentx/cloud-contracts";

it("an invite's project roles are exactly Code's project roles", () => {
  expect(InviteProjectRoleSchema.options).toEqual(ProjectRoleSchema.options);
  for (const role of ["maintainer", "contributor", "viewer", "owner", "admin", "developer", "", "Maintainer"]) {
    expect(InviteProjectRoleSchema.safeParse(role).success, role).toBe(ProjectRoleSchema.safeParse(role).success);
    expect(InviteProjectSchema.safeParse({ name: "payments", role }).success, role).toBe(ProjectRoleSchema.safeParse(role).success);
  }
});
