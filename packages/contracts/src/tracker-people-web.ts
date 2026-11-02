// The admin page for Linear and Jira people (lane team-record-links): what `GET /v1/app/org/tracker-people` answers and what `POST` takes. Browser-safe (no Node import). The answer holds the name a tool showed,
// the tool's own id and, for a linked person, the company member's id: never an email.
import { z } from "zod";

const System = z.string().regex(/^(linear|jira:[a-z0-9][a-z0-9.-]{0,252})$/u);
const SourceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/u);
const Tool = z.enum(["Linear", "Jira"]);

export const TrackerPeopleReaderSchema = z.object({
  unmatched: z.array(z.object({ tool: Tool, system: System, sourceId: SourceId, displayName: z.string().max(100), reason: z.string().max(40).optional() })).max(500),
  linked: z.array(z.object({ tool: Tool, system: System, sourceId: SourceId, displayName: z.string().max(100), developerId: z.string().min(1).max(100), via: z.string().max(40), why: z.string().max(60).optional() })).max(500),
  truncated: z.boolean(),
  autoLink: z.object({ enabled: z.boolean(), verifiedDomainsRecorded: z.boolean() }),
});
export type TrackerPeople = z.infer<typeof TrackerPeopleReaderSchema>;

export const TrackerPeopleMutationBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("map"), requestId: z.string().uuid(), system: System, sourceId: SourceId, developerId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("unmap"), requestId: z.string().uuid(), system: System, sourceId: SourceId }).strict(),
  z.object({ action: z.literal("auto_link"), requestId: z.string().uuid(), enabled: z.boolean() }).strict(),
]);
export type TrackerPeopleMutationBody = z.infer<typeof TrackerPeopleMutationBodySchema>;
export const TrackerPeopleResultReaderSchema = z.object({ status: z.enum(["mapped", "unmapped", "auto_link_on", "auto_link_off"]) });
