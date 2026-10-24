import { createHash } from "node:crypto";
import type { OrgId } from "./org.js";
import { channel } from "./realtime.js";
const sha40 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 40);
export const userSegment = (developerId: string): string => `d-${sha40(developerId)}`;
export const projectSegment = (orgId: OrgId, project: string): string => `p-${sha40(`${orgId}\n${project}`)}`;
export const userChannel = (orgId: OrgId, developerId: string): string => channel(orgId, "u", userSegment(developerId));
export const projectChannel = (orgId: OrgId, project: string): string => channel(orgId, "p", projectSegment(orgId, project));
