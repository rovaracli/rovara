import { z } from "zod";
import { OrgIdSchema, type OrgId } from "./browser-ids.js";

// Defined in browser-ids.ts (the browser-safe Rovara Code contracts import it from there); re-exported here for everything else.
export { OrgIdSchema, type OrgId };

/**
 * `auditor` (Enterprise only, feature `auditorRole`): reads the audit log and exports it, and can write nothing anywhere. A person holding it has no project role,
 * starts no work, and changes no setting. Every check that names `owner`, `admin` or `member` stays a positive list, so a role that is not on it is refused.
 */
export const OrgRoleSchema = z.enum(["owner", "admin", "member", "auditor"]);

export type OrgRole = z.infer<typeof OrgRoleSchema>;
