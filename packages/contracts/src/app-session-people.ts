import { z } from "zod";
import { forwardReader } from "./forward-reader.js";

/**
 * Web task channel K3 (plan 4.2): the People panel on the session screen. Cloud answers these from Rovara Code's task People routes
 * (`/v1/dev/tasks/{id}/people...`) as the signed-in person, with the task id read from Cloud's own record of the session, never from the browser.
 * Code decides who may do what; Cloud passes its refusals through unchanged.
 */

/** Shown when Code answers 404 or 501 for a People route: this install's Code does not serve it yet. Fixed words, nothing echoed. */
export const PEOPLE_NOT_AVAILABLE_TEXT = "Adding people from the web isn't available on this install yet.";

/** At most this many people are offered to add (Code's TASK_PEOPLE_CANDIDATES_MAX), and each is proved again by Code when added. */
export const SESSION_PEOPLE_CANDIDATES_MAX = 200;

/** D4 (no account linking): the words that tell two sign-ins of one name apart. Code names the sign-in method on a person it knows. */
export const SESSION_PEOPLE_METHOD_LABELS = { slack: "Slack", oidc: "OIDC", github: "GitHub", cloud: "Cloud", saml: "SAML" } as const;

export const SessionPeopleRoleSchema = z.enum(["owner", "commenter", "viewer", "denied"]);
export type SessionPeopleRole = z.infer<typeof SessionPeopleRoleSchema>;

/** The role a person is added with (removing a person is the role `denied`). */
export const SessionPeopleAddRoleSchema = z.enum(["owner", "commenter", "viewer"]);

const DeveloperIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const SessionPeopleEntrySchema = z.object({
  personId: z.string().uuid(),
  name: z.string().min(1).max(80),
  role: SessionPeopleRoleSchema,
  you: z.boolean(),
  effectiveRole: z.enum(["owner", "commenter", "viewer"]).nullable(),
  /** How the person signs in, when Code says (the identity label next to the name). */
  method: z.enum(["slack", "oidc", "github", "cloud", "saml"]).optional(),
}).strict();

export const SessionPeopleViewSchema = z.object({
  revision: z.number().int().positive(),
  orphaned: z.boolean(),
  people: z.array(SessionPeopleEntrySchema).max(100),
  canManage: z.boolean(),
  canTakeOwnership: z.boolean(),
}).strict();
export type SessionPeopleView = z.infer<typeof SessionPeopleViewSchema>;

/**
 * A person the task was shared with before People (Code's task readers, spec 067), shown in the same list as a viewer. Only the owner sees them (Code answers the
 * readers to the owner only). They are removed with the existing share removal (`DELETE /v1/app/sessions/{id}/shares/MEMBER%23{developerId}`).
 */
export const SessionPeopleSharedSchema = z.object({ developerId: DeveloperIdSchema, name: z.string().min(1).max(80), role: z.enum(["owner", "commenter", "viewer"]) }).strict();

/** `GET /v1/app/sessions/{id}/people` */
export const SessionPeopleResponseSchema = z.object({ people: SessionPeopleViewSchema, sharedWith: z.array(SessionPeopleSharedSchema).max(200).optional() }).strict();
export const SessionPeopleResponseReaderSchema = forwardReader(SessionPeopleResponseSchema);

/** `POST /v1/app/sessions/{id}/people/role`: change one person's role. The ids are Code's, taken from the list the page read. */
export const SessionPeopleRoleBodySchema = z.object({
  requestId: z.string().uuid(),
  expectedPeopleRevision: z.number().int().positive(),
  personId: z.string().uuid(),
  role: SessionPeopleRoleSchema,
}).strict();
export type SessionPeopleRoleBody = z.infer<typeof SessionPeopleRoleBodySchema>;

/** `POST /v1/app/sessions/{id}/people/add`: add a person from the candidates list, then the usual confirm step. */
export const SessionPeopleAddBodySchema = z.object({
  requestId: z.string().uuid(),
  expectedPeopleRevision: z.number().int().positive(),
  developerId: DeveloperIdSchema,
  role: SessionPeopleAddRoleSchema,
}).strict();
export type SessionPeopleAddBody = z.infer<typeof SessionPeopleAddBodySchema>;

/** `POST /v1/app/sessions/{id}/people/take-ownership` */
export const SessionPeopleOwnershipBodySchema = z.object({
  requestId: z.string().uuid(),
  expectedPeopleRevision: z.number().int().positive(),
}).strict();
export type SessionPeopleOwnershipBody = z.infer<typeof SessionPeopleOwnershipBodySchema>;

/** `GET /v1/app/sessions/{id}/people/candidates`: names and opaque ids, owner only (Code decides). */
export const SessionPeopleCandidatesResponseSchema = z.object({
  candidates: z.array(z.object({ developerId: DeveloperIdSchema, name: z.string().min(1).max(80) }).strict()).max(SESSION_PEOPLE_CANDIDATES_MAX),
  complete: z.boolean(),
}).strict();
export const SessionPeopleCandidatesResponseReaderSchema = forwardReader(SessionPeopleCandidatesResponseSchema);

/**
 * What a People change answers: done (`COMMITTED`, with the list as it is now), or waiting for the person to confirm it in Code
 * (`PENDING`, with the address of the confirm page and when the proposal ends). Both answer HTTP 200 or 202; read the body, not the status.
 */
export const SessionPeopleChangeResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("COMMITTED"), people: SessionPeopleViewSchema }).strict(),
  z.object({ status: z.literal("PENDING"), requestId: z.string().uuid(), confirmUrl: z.string().url().max(2048), expiresAt: z.string().datetime() }).strict(),
]);
export const SessionPeopleChangeResponseReaderSchema = forwardReader(SessionPeopleChangeResponseSchema);
export type SessionPeopleChangeResponse = z.infer<typeof SessionPeopleChangeResponseSchema>;
