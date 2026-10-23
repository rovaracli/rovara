import { z } from "zod";


export const OrgIdSchema = z.string().regex(/^org_[0-9a-z]{20}$/);

export type OrgId = z.infer<typeof OrgIdSchema>;
