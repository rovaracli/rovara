// A-32 and A-33 (srv/project-people): what the web reads and sends to edit a project's people, and what it reads to know which code settings the viewer may change.
// `GET /v1/app/projects/{p}/people` is the roster with its revision and the viewer's own powers; `PUT|DELETE /v1/app/projects/{p}/people/{developerId}` change one person's
// project role, browser-session only, under the revision the viewer read. The writes go through the same store functions as the CLI's `.../members/...` routes
// (`setProjectMember`, `removeProjectMember`), so the rules are one: a maintainer of the project or a company owner or admin; only a company member can be named; never the
// project's last maintainer. Code settings are changed through the existing `PUT .../code-settings` (revision-fenced; self-approval ON waits for an owner or admin).
// Strict shapes for what the app sends, forward-compatible readers for what it reads. Browser-safe: nothing here imports a Node module.
import { z } from "zod";
import { ProjectMemberSchema, ProjectRoleSchema, forwardReader } from "@rovara-code/contracts";

/** The roster's revision: moved by every change of a project role made through the people routes, the CLI's member routes and an invite's accept. */
export const ProjectPeopleRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** What the viewer may do on the project's People and Code settings tabs, decided on the server from the viewer's live roles. */
export const ProjectPeopleViewerSchema = z.object({
  /** The viewer's own project role (an owner or admin is a maintainer by their company role). */
  role: ProjectRoleSchema,
  /** Add, change and remove people: a maintainer of the project, or a company owner or admin. */
  canManageMembers: z.boolean(),
  /** The roles the viewer may give someone here (empty when they cannot manage people). */
  assignableRoles: z.array(ProjectRoleSchema).max(3),
  /** Invite someone new straight into this project (A-31): owners and admins, and maintainers of this project. */
  canInvite: z.boolean(),
  /** The project roles such an invite may carry: any for an owner or admin; contributor or viewer for a maintainer. */
  invitableRoles: z.array(ProjectRoleSchema).max(3),
  /** Change the merge method and the reviewers, and turn self-approval off, at once: a maintainer. */
  canEditCodeSettings: z.boolean(),
  /** Confirm turning self-approval ON (the confirmation page): a company owner or admin. A maintainer's request waits for one of them. */
  canConfirmSelfApproval: z.boolean(),
}).strict();
export type ProjectPeopleViewer = z.infer<typeof ProjectPeopleViewerSchema>;

export const ProjectPeopleViewSchema = z.object({
  project: z.string(),
  members: z.array(ProjectMemberSchema),
  revision: ProjectPeopleRevisionSchema,
  viewer: ProjectPeopleViewerSchema,
}).strict();
export type ProjectPeopleView = z.infer<typeof ProjectPeopleViewSchema>;
export const ProjectPeopleViewReaderSchema = forwardReader(ProjectPeopleViewSchema);

/** `PUT /v1/app/projects/{p}/people/{developerId}`: give a company member this role in the project. */
export const PutProjectPersonBodySchema = z.object({ requestId: z.string().uuid(), role: ProjectRoleSchema, expectedRevision: ProjectPeopleRevisionSchema }).strict();
export type PutProjectPersonBody = z.infer<typeof PutProjectPersonBodySchema>;
/** `DELETE /v1/app/projects/{p}/people/{developerId}`: take a person's project role away. */
export const RemoveProjectPersonBodySchema = z.object({ requestId: z.string().uuid(), expectedRevision: ProjectPeopleRevisionSchema }).strict();
export type RemoveProjectPersonBody = z.infer<typeof RemoveProjectPersonBodySchema>;

export const ProjectPersonChangeResponseSchema = z.object({ member: z.object({ developerId: z.string(), role: ProjectRoleSchema }).strict(), revision: ProjectPeopleRevisionSchema }).strict();
export type ProjectPersonChangeResponse = z.infer<typeof ProjectPersonChangeResponseSchema>;
export const ProjectPersonChangeResponseReaderSchema = forwardReader(ProjectPersonChangeResponseSchema);
/** `removed` is false when the person had no project role to take away (an owner or admin, a Slack channel member). */
export const ProjectPersonRemoveResponseSchema = z.object({ developerId: z.string(), removed: z.boolean(), revision: ProjectPeopleRevisionSchema }).strict();
export type ProjectPersonRemoveResponse = z.infer<typeof ProjectPersonRemoveResponseSchema>;
export const ProjectPersonRemoveResponseReaderSchema = forwardReader(ProjectPersonRemoveResponseSchema);

export const PROJECT_PEOPLE_BROWSER_MESSAGE = "Use a live browser session to change a project's people.";
/** What a change under a revision someone else has since moved hears (CHANGE_STALE, 409). */
export const PROJECT_PEOPLE_STALE_MESSAGE = "Someone changed this project's people. Reload and try again.";
/** What taking the project's last maintainer away (removal or a lower role) hears (CONFIG_INVALID, 400): the CLI's routes hear it too. */
export const PROJECT_LAST_MAINTAINER_MESSAGE = "A project needs at least one maintainer. Make someone else a maintainer first.";
