// P3-OPEN-ROLES-CLOUD-ADOPTION (convergence A6): Cloud's negative Auditor checks became positive lists before Cloud reads open role names from Code's shared answers. For the four roles Cloud has (owner, admin, member,
// Auditor) every answer is what it was; a role name Cloud does not know now gets nothing, where a negative check would have treated it as a member.
import { describe, expect, it } from "vitest";
import type { OrgRole } from "@agentx/cloud-contracts";
import { effectiveProjectRole } from "../../packages/broker/src/developer/project-roles.js";
import { createScriptToken } from "../../packages/broker/src/script-tokens/store.js";
import { mergedRole } from "../../packages/broker/src/org/merge-members.js";

const ID = "a".repeat(64);
const GRANT = { role: "developer", projectRole: "maintainer" };
const roleCall = async (role: string): Promise<string> => {
  try {
    await createScriptToken({} as never, { orgId: "org", developerId: ID, orgRole: role as OrgRole } as never, {}, async () => undefined);
    return "made";
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return e.code === "FORBIDDEN" ? `refused: ${String(e.message)}` : "past the role check";
  }
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
    expect(await roleCall("auditor")).toContain("An Auditor can't make script tokens.");
    // An unknown role is not told it is an Auditor.
    expect(await roleCall("superuser")).toContain("Your company role can't make script tokens.");
    expect(await roleCall("superuser")).not.toContain("Auditor");
    for (const writer of ["owner", "admin", "member"]) expect(await roleCall(writer), writer).toBe("past the role check");
  });

  it("keeps the higher-ranked role on a merge exactly as before, and never lets a role name the table does not list win", () => {
    expect(mergedRole(true, "owner", "member")).toBe("owner");
    expect(mergedRole(true, "member", "admin")).toBe("admin");
    expect(mergedRole(true, "admin", "auditor")).toBe("admin");
    expect(mergedRole(true, "auditor", "member")).toBe("member");
    expect(mergedRole(false, "owner", "member")).toBe("member");
    for (const unknown of ["superuser", "constructor", "__proto__", "toString"]) {
      expect(mergedRole(true, unknown, "auditor"), unknown).toBe("auditor");
      expect(mergedRole(true, unknown, "member"), unknown).toBe("member");
      expect(mergedRole(true, "member", unknown), unknown).toBe("member");
    }
  });
});
