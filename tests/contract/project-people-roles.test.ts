// The People tab's role schemas are spelled out in app-project-people.ts (so the browser's bundle never loads Code's app-projects module); they must stay exactly Cloud's four project roles
// (project-roles.ts), Code's three as the floor, and Code's member sources, in order.
import { expect, it } from "vitest";
import { ProjectMemberSourceSchema, ProjectRoleSchema as CodeProjectRoleSchema } from "@rovara-code/contracts";
import { ProjectPeopleFloorRoleSchema, ProjectPeopleMemberSchema, ProjectPeopleRoleSchema, ProjectRoleSchema, projectRoleFloor } from "@agentx/cloud-contracts";

it("the People tab's roles are Cloud's four, its floor Code's three, its sources Code's", () => {
  expect(ProjectPeopleRoleSchema.options).toEqual(ProjectRoleSchema.options);
  expect(ProjectPeopleFloorRoleSchema.options).toEqual(CodeProjectRoleSchema.options);
  expect(ProjectPeopleMemberSchema.shape.source.options).toEqual(ProjectMemberSourceSchema.options);
  for (const role of ProjectPeopleRoleSchema.options) expect(ProjectPeopleFloorRoleSchema.safeParse(projectRoleFloor(role)).success, role).toBe(true);
});
