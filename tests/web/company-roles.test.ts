// Which role buttons a viewer gets (company-roles.ts; guided onboarding design section 4, DEC 254l item 2). Code checks every change itself; this
// pins that the screen never offers what Code would refuse.
import { describe, expect, it } from "vitest";
import { roleChangesFor, WHO_CAN_DO_WHAT } from "../../packages/ui/src/screens/admin/company-roles.js";

describe("roleChangesFor", () => {
  it("an owner may make anyone else an owner, an admin or a member, never their current role", () => {
    expect(roleChangesFor("owner", "member", false)).toEqual(["owner", "admin"]);
    expect(roleChangesFor("owner", "admin", false)).toEqual(["owner", "member"]);
    expect(roleChangesFor("owner", "owner", false)).toEqual(["admin", "member"]);
  });
  it("an admin may make members admins and admins members; owners and owner changes are not theirs", () => {
    expect(roleChangesFor("admin", "member", false)).toEqual(["admin"]);
    expect(roleChangesFor("admin", "admin", false)).toEqual(["member"]);
    expect(roleChangesFor("admin", "owner", false)).toEqual([]);
  });
  it("only an owner may step down from their own owner role; members and admins cannot change their own role", () => {
    expect(roleChangesFor("owner", "owner", true)).toEqual(["admin", "member"]);
    for (const target of ["admin", "member"]) expect(roleChangesFor("owner", target, true)).toEqual([]);
    for (const viewer of ["admin", "member", "auditor", "unknown", undefined]) for (const target of ["owner", "admin", "member"]) expect(roleChangesFor(viewer, target, true)).toEqual([]);
  });
  it("a member or unknown viewer changes nothing, and auditors or unknown targets aren't offered", () => {
    for (const viewer of ["member", "auditor", "unknown", undefined]) for (const target of ["owner", "admin", "member"]) expect(roleChangesFor(viewer, target, false)).toEqual([]);
    for (const target of ["auditor", "unknown"]) expect(roleChangesFor("owner", target, false)).toEqual([]);
  });
  it("the table names all three roles, owners first", () => {
    expect(WHO_CAN_DO_WHAT.map(row => row.role)).toEqual(["owner", "admin", "member"]);
  });
});
