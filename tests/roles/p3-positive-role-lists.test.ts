// P3-OPEN-ROLES-CLOUD-ADOPTION (convergence A6): Cloud's negative Auditor checks became positive lists before Cloud reads open role names from Code's shared answers. For the four roles Cloud has (owner, admin, member,
// Auditor) every answer is what it was; a role name Cloud does not know now gets nothing, where a negative check would have treated it as a member.
import { describe, expect, it } from "vitest";
import type { OrgRole } from "@agentx/cloud-contracts";
import { effectiveProjectRole } from "../../packages/broker/src/developer/project-roles.js";
import { createScriptToken } from "../../packages/broker/src/script-tokens/store.js";

const ID = "a".repeat(64);
const GRANT = { role: "developer", projectRole: "maintainer" };
const roleCall = async (role: string): Promise<string> => {
  try {
    await createScriptToken({} as never, { orgId: "org", developerId: ID, orgRole: role as OrgRole } as never, {}, async () => undefined);
    return "made";
  } catch (error) { return (error as { code?: string }).code === "FORBIDDEN" ? "refused" : "past the role check"; }
};

describe("positive role lists (P3 adoption)", () => {
  it("gives a project role exactly as before for owner, admin, member and Auditor, and none to a role Cloud does not know", () => {
    expect(effectiveProjectRole({ orgRole: "owner", developerId: ID }, undefined, false)).toBe("maintainer");
    expect(effectiveProjectRole({ orgRole: "admin", developerId: ID }, undefined, false)).toBe("maintainer");
    expect(effectiveProjectRole({ orgRole: "member", developerId: ID }, GRANT, false)).toBe("maintainer");
    expect(effectiveProjectRole({ orgRole: "member", developerId: ID }, undefined, true)).toBe("contributor");
    expect(effectiveProjectRole({ orgRole: "member", developerId: ID }, undefined, false)).toBeUndefined();
    expect(effectiveProjectRole({ orgRole: "auditor", developerId: ID }, GRANT, true)).toBeUndefined();
    for (const unknown of ["superuser", "constructor", "__proto__", ""]) expect(effectiveProjectRole({ orgRole: unknown as OrgRole, developerId: ID }, GRANT, true), unknown).toBeUndefined();
  });

  it("lets only a writer make a script token: the Auditor and an unknown role are refused at the role check", async () => {
    expect(await roleCall("auditor")).toBe("refused");
    expect(await roleCall("superuser")).toBe("refused");
    for (const writer of ["owner", "admin", "member"]) expect(await roleCall(writer), writer).toBe("past the role check");
  });
});
