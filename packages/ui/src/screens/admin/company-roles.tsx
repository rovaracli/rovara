// Who can do what in a company (guided onboarding design section 4; DEC 254l items 2 and 9), in one place: the visible table on the Members and
// Roles pages, and which role buttons a viewer sees. The buttons only follow the rules; Rovara Code checks every change itself and refuses the rest.
export type CompanyRole = "owner" | "admin" | "member";

export const ROLE_NAMES: Record<CompanyRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** The table's rows: what each role may do. */
export const WHO_CAN_DO_WHAT: ReadonlyArray<{ role: CompanyRole; can: string }> = [
 { role: "owner", can: "Everything an admin can, plus make or change owners and disconnect GitHub, Slack or Linear." },
 { role: "admin", can: "Connect GitHub, Slack and Linear, manage projects, invite people (as members) and make people members or admins." },
 { role: "member", can: "Work in the projects they're in." },
];

/**
 * The role changes `viewer` may start for `target`: none on their own row, none for a plain member viewer, and owner changes (making an owner or
 * changing an owner) only for an owner. The person's current role is never offered.
 */
export function roleChangesFor(viewer: string | undefined, target: string, self: boolean): CompanyRole[] {
 if (self || (viewer !== "owner" && viewer !== "admin")) return [];
 if (target !== "owner" && target !== "admin" && target !== "member") return [];
 if (viewer !== "owner" && target === "owner") return [];
 const allowed: CompanyRole[] = viewer === "owner" ? ["owner", "admin", "member"] : ["admin", "member"];
 return allowed.filter(role => role !== target);
}

export function WhoCanDoWhat() {
 return <table className="rv-admin-who" data-testid="who-can-do-what"><caption>Who can do what</caption><thead><tr><th scope="col">Role</th><th scope="col">Can</th></tr></thead>
  <tbody>{WHO_CAN_DO_WHAT.map(row => <tr key={row.role}><th scope="row">{ROLE_NAMES[row.role]}</th><td>{row.can}</td></tr>)}</tbody>
  <tfoot><tr><td colSpan={2} className="rv-muted">A company needs at least one owner. Nobody changes their own role. Invites are for members; make someone an admin here once they've joined.</td></tr></tfoot>
 </table>;
}
