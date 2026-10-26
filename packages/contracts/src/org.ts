import { z } from "zod";
import { OrgIdSchema, type OrgId } from "./browser-ids.js";

// Defined in browser-ids.ts (the browser-safe Rovara Code contracts import it from there); re-exported here for everything else.
export { OrgIdSchema, type OrgId };

export const OrgRoleSchema = z.enum(["owner", "admin", "member"]);

export type OrgRole = z.infer<typeof OrgRoleSchema>;
