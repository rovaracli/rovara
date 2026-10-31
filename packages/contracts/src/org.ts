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

/**
 * The roles that may write. The Auditor reads the audit log and nothing else, so a write path asks for a `WriterOrgRole`, not an `OrgRole`: a value of this type cannot be the
 * Auditor, and `requireWriterOrgRole` is the one place an unchecked role becomes one. A role this release does not know is not a writer either.
 */
export const WriterOrgRoleSchema = OrgRoleSchema.exclude(["auditor"]);
export type WriterOrgRole = z.infer<typeof WriterOrgRoleSchema>;
export const isWriterOrgRole = (role: unknown): role is WriterOrgRole => WriterOrgRoleSchema.safeParse(role).success;
