// Enterprise foundations, task I2: a role check that could let the Auditor through is found by a scan, and has to be read by a person before it is accepted.
// The scan is in scan-role-sites.ts; what it finds, and why each is safe, is in role-sites-reviewed.ts.
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { roleSites, roleSitesIn } from "./scan-role-sites.js";
import { REVIEWED_ROLE_SITES as FIRST_ROUND, REVIEWED_ROLE_SITES_ROUND_1 } from "./role-sites-reviewed.js";

const REVIEWED_ROLE_SITES = [...FIRST_ROUND, ...REVIEWED_ROLE_SITES_ROUND_1];

const REPO = resolve(import.meta.dirname, "..", "..");
const describeSite = (site: { file: string; line: number; text: string }) => `${site.file}:${String(site.line)}  ${site.text.slice(0, 160)}`;

describe("role checks that the Auditor could slip through", () => {
  const sites = roleSites(REPO);

  it("every comparison with `member`, every lone `admin` comparison and every default to `member` has been read for the Auditor", () => {
    const unreviewed = sites.filter((site) => !REVIEWED_ROLE_SITES.some((entry) => entry.file === site.file && site.text.includes(entry.needle)));
    expect(unreviewed.map(describeSite), "A role check that is not a positive owner/admin list was added. Read it: what happens to an Auditor here? Then add it to tests/roles/role-sites-reviewed.ts with the reason.").toEqual([]);
  });

  it("the reviewed list holds no stale entry, and every entry has a reason", () => {
    const stale = REVIEWED_ROLE_SITES.filter((entry) => !sites.some((site) => site.file === entry.file && site.text.includes(entry.needle)));
    expect(stale.map((entry) => `${entry.file} :: ${entry.needle}`)).toEqual([]);
    for (const entry of REVIEWED_ROLE_SITES) expect(entry.why.length, entry.needle).toBeGreaterThan(20);
  });

  it("the scan finds the shapes it is for, and ignores the safe ones and comments", () => {
    const shapes = (code: string) => roleSitesIn(code, "x.ts").map((site) => site.shape);
    // The dangerous shapes.
    expect(shapes('if (caller.orgRole !== "member") allow();')).toEqual(["member"]);
    expect(shapes('const tier = caller.orgRole === "member" ? low : high;')).toEqual(["member"]);
    expect(shapes('if ("member" === actor.role) go();')).toEqual(["member"]);
    expect(shapes('switch (x.role) { case "member": break; }')).toEqual(["member"]);
    expect(shapes('if (member.role === "admin") go();')).toEqual(["admin-only"]);
    expect(shapes('const r = await roleOf(x) ?? "member";')).toEqual(["default"]);
    expect(shapes('if (a.orgRole !== "owner" && a.orgRole !== "admin" && a.orgRole !== "member") throw x;')).toEqual(["member"]);
    // The shapes a first version of this scan missed (Opus review of the lane): each is a way to treat a role that is not owner or admin as a member.
    expect(shapes('const ok = ["member"].includes(caller.orgRole) ? checkGrant() : allowAll();')).toEqual(["member"]);
    expect(shapes('const MEMBER = "member";')).toEqual(["member"]);
    expect(shapes('if (caller.orgRole !== `member`) allow();')).toEqual(["member"]);
    expect(shapes('const { orgRole: r } = caller;')).toEqual(["alias"]);
    expect(shapes('const check = ({ role: r }) => r !== "member";')).toEqual(["alias"]);
    expect(shapes('const r = caller.orgRole || "member";')).toEqual(["default"]);
    expect(shapes('const r = caller.orgRole ?? "contributor";')).toEqual(["default"]);
    expect(shapes('const r = OrgRoleSchema.safeParse(item.role).success;')).toEqual(["schema"]);
    expect(shapes('if (caller.orgRole.startsWith("mem")) go();')).toEqual(["text"]);
    expect(shapes('if (/^m/.test(caller.orgRole)) go();')).toEqual(["text"]);
    // The safe shapes: owner/admin lists and owner alone.
    expect(shapes('if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw x;')).toEqual([]);
    expect(shapes('const admin = caller.orgRole === "owner" || caller.orgRole === "admin";')).toEqual([]);
    expect(shapes('if (caller.orgRole !== "owner") throw x;')).toEqual([]);
    // Not an org role, or not code.
    expect(shapes('if (principal.kind === "member") go();')).toEqual([]);
    expect(shapes('// if (caller.orgRole !== "member") allow();')).toEqual([]);
    expect(shapes('/* role === "member" */ const x = 1;')).toEqual([]);
  });
});
